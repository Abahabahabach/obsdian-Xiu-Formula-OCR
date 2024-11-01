import { App, Editor, MarkdownView, Notice, Plugin, PluginSettingTab, Setting, TFile, EventRef, WorkspaceLeaf } from 'obsidian';
import * as CodeMirror from 'codemirror';

interface EditorWithCM extends Editor {
  cm: CodeMirror.Editor;
}

interface OCRPluginSettings {
  appId: string;
  appKey: string;
}

const DEFAULT_SETTINGS: OCRPluginSettings = {
  appId: '',
  appKey: ''
};

export default class OCRPlugin extends Plugin {
  settings: OCRPluginSettings;

  private autoOCRMode: boolean = false;
  private ribbonIconEl: HTMLElement;
  private processedImages: Set<string> = new Set();
  private cmEditor: CodeMirror.Editor | null = null;
  private changeHandler: ((cm: CodeMirror.Editor, changes: CodeMirror.EditorChange[]) => void) | null = null;

  async onload() {
    console.log('Loading OCR Plugin');

    await this.loadSettings();

    this.addCommand({
      id: 'ocr-selected-image',
      name: 'OCR selected image',
      editorCallback: async (editor: Editor, view: MarkdownView) => {
        await this.ocrSelectedImage(editor, view);
      }
    });

    this.addCommand({
      id: 'ocr-all-images',
      name: 'OCR all images in current note',
      editorCallback: async (editor: Editor, view: MarkdownView) => {
        await this.ocrAllImagesInNote(editor, view);
      }
    });

    // 添加 Ribbon 按钮
    this.ribbonIconEl = this.addRibbonIcon('camera', 'Toggle automatic OCR mode', (evt: MouseEvent) => {
      // 切换自动 OCR 模式
      this.toggleAutoOCRMode();
    });
    // 设置初始状态的图标样式
    this.updateRibbonIcon();

    this.addSettingTab(new OCRSettingTab(this.app, this));
  }

  onunload() {
    console.log('Unloading OCR Plugin');
    // 在插件卸载时，确保注销事件监听器
    this.stopListeningForChanges();
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  private toggleAutoOCRMode() {
    this.autoOCRMode = !this.autoOCRMode;
    this.updateRibbonIcon();

    if (this.autoOCRMode) {
      new Notice('Automatic OCR mode is enabled.');
      this.startListeningForChanges();
    } else {
      new Notice('Automatic OCR mode is disabled.');
      this.stopListeningForChanges();
    }
  }

  private updateRibbonIcon() {
    if (this.autoOCRMode) {
      // 激活状态，添加样式
      this.ribbonIconEl.addClass('is-active');
    } else {
      // 未激活状态，移除样式
      this.ribbonIconEl.removeClass('is-active');
    }
  }

  private startListeningForChanges() {
    console.log('startListeningForChanges called');
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', this.onActiveLeafChange.bind(this))
    );
    this.onActiveLeafChange(this.app.workspace.activeLeaf);
  }

  private onActiveLeafChange(leaf: WorkspaceLeaf | null) {
    console.log('onActiveLeafChange called', leaf);
    if (this.cmEditor && this.changeHandler) {
      (this.cmEditor as any).off('changes', this.changeHandler);
    }
    if (leaf && leaf.view instanceof MarkdownView) {
      const editor = leaf.view.editor;
      const cm = (editor as EditorWithCM).cm;

      this.cmEditor = cm;
      this.changeHandler = this.handleEditorChanges.bind(this);
      (cm as any).on('changes', this.changeHandler);
    } else {
      if (this.cmEditor && this.changeHandler) {
        (this.cmEditor as any).off('changes', this.changeHandler);
      }
      this.cmEditor = null;
      this.changeHandler = null;
    }
  }

  private stopListeningForChanges() {
    console.log('stopListeningForChanges called');
    if (this.cmEditor && this.changeHandler) {
      (this.cmEditor as any).off('changes', this.changeHandler);
      this.cmEditor = null;
      this.changeHandler = null;
    }
    this.processedImages.clear(); // 清空已处理图片集合
  }

  private handleEditorChanges(cm: CodeMirror.Editor, changes: CodeMirror.EditorChange[]) {
    console.log('handleEditorChanges called');
    for (const change of changes) {
      if (change.origin === 'setValue') {
        continue; // 忽略整个内容被替换的情况
      }

      if (change.text) {
        const addedText = change.text.join('\n');
        const imageLinkRegex = /!\[\[([^\]]+)\]\]|!\[.*?\]\((.*?)\)/g;
        let match;

        while ((match = imageLinkRegex.exec(addedText)) !== null) {
          const fullMatch = match[0];
          const imagePath = match[1] || match[2];
          const matchStartIndex = match.index;
          const matchEndIndex = match.index + fullMatch.length;

          // 如果图片已经处理过，跳过
          if (this.processedImages.has(fullMatch)) {
            continue;
          }
          this.processedImages.add(fullMatch);

          const currentFilePath = this.app.workspace.getActiveFile()?.path;
          if (!currentFilePath) {
            continue;
          }

          this.processImage(fullMatch, imagePath, currentFilePath).then(result => {
            if (result) {
              // 计算图片链接在编辑器中的位置
              const changeStartIndex = cm.indexFromPos(change.from);
              const fromIndex = changeStartIndex + matchStartIndex;
              const toIndex = changeStartIndex + matchEndIndex;

              const fromPos = cm.posFromIndex(fromIndex);
              const toPos = cm.posFromIndex(toIndex);

              // 替换图片链接为 OCR 结果
              cm.replaceRange(result.ocrText, fromPos, toPos);
            }
          });
        }
      }
    }
  }


  private async processImage(imageLink: string, imagePath: string, currentFilePath: string) {
    // 等待图片文件加载完成
    const imageFile = await this.waitForImageFile(imagePath, currentFilePath);

    if (!imageFile) {
      new Notice(`Unable to find the image file: ${imagePath}`);
      return null;
    }

    // 读取图片数据
    const arrayBuffer = await this.app.vault.readBinary(imageFile);
    const base64Image = this.arrayBufferToBase64(arrayBuffer);

    // 调用 OCR 处理
    const processedText = await this.processImageData(base64Image);

    if (!processedText) {
      return null;
    }

    return { imageLink, ocrText: processedText };
  }

  private async waitForImageFile(imagePath: string, currentFilePath: string): Promise<TFile | null> {
    const maxRetries = 10; // 最大重试次数
    const retryInterval = 500; // 每次重试间隔，毫秒

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const imageFile = this.app.metadataCache.getFirstLinkpathDest(imagePath, currentFilePath) as TFile;
      if (imageFile) {
        return imageFile;
      }
      // 等待一段时间后重试
      await new Promise(resolve => setTimeout(resolve, retryInterval));
    }
    return null;
  }

  private async processImageData(base64Image: string): Promise<string | null> {
    // 调用 Mathpix API
    const response = await fetch('https://api.mathpix.com/v3/text', {
      method: 'POST',
      headers: {
        'app_id': this.settings.appId,
        'app_key': this.settings.appKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        src: `data:image/png;base64,${base64Image}`,
        formats: ['text']
      })
    });

    if (!response.ok) {
      new Notice('OCR request failed');
      return null;
    }

    const result = await response.json();
    const ocrText = result.text;

    if (!ocrText) {
      new Notice('Failed to OCR.');
      return null;
    }

    // 调用 removeBlanks 函数处理 OCR 结果
    const processedText = this.removeBlanks(ocrText);

    return processedText;
  }

  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  private removeBlanks(input: string): string {
    let result = input;
    result = result.replace(/\$(.*?)\$/g, (_match, p1) => `$${p1.trim()}$`);
    // 将 "\[" 或 "\]" 替换为 "$$"
    result = result.replace(/\\\[/g, '$$$').replace(/\\\]/g, '$$$');
    // 将 "\(" 或 "\)" 替换为 "$"
    result = result.replace(/\\\(\s/g, '$$').replace(/\s\\\)/g, '$$');
    result = result.replace(/\\\(/g, '$$').replace(/\\\)/g, '$$');
    return result;
  }

  private async ocrSelectedImage(editor: Editor, view: MarkdownView) {
    const selectedText = editor.getSelection();

    if (!selectedText) {
      new Notice('Select the link of an image first.');
      return;
    }

    // 检查选中的文本是否为图片链接
    const imageLinkRegex = /!\[\[([^\]]+)\]\]|!\[.*?\]\((.*?)\)/;
    const match = selectedText.match(imageLinkRegex);

    if (!match) {
      new Notice('Invalid image link.');
      return;
    }

    const imagePath = match[1] || match[2];

    const currentFilePath = view.file?.path;
    if (!currentFilePath) {
      new Notice('Unable to obtain the current file path.');
      return;
    }

    // 等待图片文件加载完成
    const imageFile = await this.waitForImageFile(imagePath, currentFilePath);
    if (!imageFile) {
      new Notice(`Unable to find image file: ${imagePath}`);
      return;
    }

    // 读取图片数据
    const arrayBuffer = await this.app.vault.readBinary(imageFile);
    const base64Image = this.arrayBufferToBase64(arrayBuffer);

    // 调用 OCR 处理
    const processedText = await this.processImageData(base64Image);

    if (processedText) {
      // 替换选中的内容为 OCR 结果
      editor.replaceSelection(processedText);
    }
  }

  private async ocrAllImagesInNote(editor: Editor, view: MarkdownView) {
    const content = editor.getValue();

    const currentFilePath = view.file?.path;
    if (!currentFilePath) {
      new Notice('Unable to obtain the current file path.');
      return;
    }

    // 正则表达式匹配所有图片链接
    const imageLinkRegex = /(!\[\[([^\]]+)\]\])|(!\[[^\]]*\]\(([^)]+)\))/g;
    let match;
    const promises = [];

    while ((match = imageLinkRegex.exec(content)) !== null) {
      const fullMatch = match[0];
      const imagePath = match[2] || match[4];

      promises.push(this.processImage(fullMatch, imagePath, currentFilePath));
    }

    const results = await Promise.all(promises);

    // 将内容中的图片链接替换为 OCR 结果
    let newContent = content;
    for (const result of results) {
      if (result) {
        newContent = newContent.replace(result.imageLink, () => result.ocrText);
      }
    }

    editor.setValue(newContent);

    new Notice('All images have been processed.');
  }
}

class OCRSettingTab extends PluginSettingTab {
  plugin: OCRPlugin;

  constructor(app: App, plugin: OCRPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;

    containerEl.empty();

    containerEl.createEl('h2', { text: 'OCR Plugin Settings' });

    new Setting(containerEl)
      .setName('Mathpix App ID')
      .setDesc('Your Mathpix API App ID')
      .addText(text => text
        .setPlaceholder('Please enter your App ID.')
        .setValue(this.plugin.settings.appId)
        .onChange(async (value) => {
          this.plugin.settings.appId = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Mathpix App Key')
      .setDesc('Your Mathpix API App Key')
      .addText(text => text
        .setPlaceholder('Please enter your App Key')
        .setValue(this.plugin.settings.appKey)
        .onChange(async (value) => {
          this.plugin.settings.appKey = value;
          await this.plugin.saveSettings();
        }));
  }
}