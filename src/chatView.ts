import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ZcodeRunner } from './zcodeRunner';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'error';
  text: string;
  attach?: string[];
}

type ToWebview =
  | { t: 'init'; messages: ChatMessage[]; running: boolean; attachedFile: string | null; mode: string; cwd: string }
  | { t: 'append'; text: string }
  | { t: 'message'; msg: ChatMessage }
  | { t: 'done'; stopped: boolean; ok: boolean }
  | { t: 'running'; on: boolean }
  | { t: 'clear' }
  | { t: 'attachChanged'; file: string | null }
  | { t: 'prefill'; text: string };

type FromWebview =
  | { t: 'ready' }
  | { t: 'send'; text: string }
  | { t: 'stop' }
  | { t: 'new' }
  | { t: 'removeAttach' };

export class ZcodeChatView implements vscode.WebviewViewProvider {
  static readonly viewId = 'zcode.chat';

  private view?: vscode.WebviewView;
  private runner = new ZcodeRunner();
  private messages: ChatMessage[] = [];
  /** 本轮对话是否已有历史(决定 --continue) */
  private hasHistory = false;
  private attachedFile: string | null = null;
  private streaming = false;
  /** webview 未就绪时暂存的首填文本 */
  private pendingPrefill?: string;
  private readonly onStateChanged = new vscode.EventEmitter<void>();

  constructor(private readonly context: vscode.ExtensionContext) {
    context.subscriptions.push(this.onStateChanged);
  }

  get running(): boolean {
    return this.runner.running;
  }

  get stateChanged(): vscode.Event<void> {
    return this.onStateChanged.event;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')] };
    view.webview.onDidReceiveMessage((m: FromWebview) => this.onMessage(m));
    view.webview.html = this.html(view.webview);
    view.onDidChangeVisibility(() => {
      if (view.visible) {
        this.post({ t: 'init', messages: this.messages, running: this.runner.running, attachedFile: this.attachedFile, mode: this.mode(), cwd: this.cwd() });
      }
    });
  }

  show(prefill?: string): void {
    if (prefill) {
      this.pendingPrefill = (this.pendingPrefill ?? '') + prefill;
    }
    if (this.view) {
      this.view.show?.(true);
      this.flushPrefill();
    } else {
      // 视图从未渲染(如活动栏溢出区)时,用内置 focus 命令强制解析
      void vscode.commands.executeCommand(`${ZcodeChatView.viewId}.focus`);
    }
  }

  private flushPrefill(): void {
    if (this.pendingPrefill && this.view) {
      this.post({ t: 'prefill', text: this.pendingPrefill });
      this.pendingPrefill = undefined;
    }
  }

  setAttachedFile(file: string | null): void {
    this.attachedFile = file;
    this.post({ t: 'attachChanged', file });
  }

  getAttachedFile(): string | null {
    return this.attachedFile;
  }

  newConversation(): void {
    if (this.streaming) {
      vscode.window.showWarningMessage('ZCode 正在运行,请先停止当前任务。');
      return;
    }
    this.messages = [];
    this.hasHistory = false;
    this.post({ t: 'clear' });
  }

  stop(): void {
    if (!this.runner.stop()) {
      vscode.window.showInformationMessage('ZCode: 当前没有运行中的任务。');
    }
  }

  private mode(): string {
    return vscode.workspace.getConfiguration('zcode').get<string>('mode', 'yolo');
  }

  private cwd(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
  }

  private post(m: ToWebview): void {
    void this.view?.webview.postMessage(m);
  }

  private onMessage(m: FromWebview): void {
    switch (m.t) {
      case 'ready':
        this.post({ t: 'init', messages: this.messages, running: this.runner.running, attachedFile: this.attachedFile, mode: this.mode(), cwd: this.cwd() });
        this.flushPrefill();
        break;
      case 'send':
        this.send(m.text.trim());
        break;
      case 'stop':
        this.stop();
        break;
      case 'new':
        this.newConversation();
        break;
      case 'removeAttach':
        this.setAttachedFile(null);
        break;
    }
  }

  private send(text: string): void {
    if (!text) {
      return;
    }
    if (this.streaming) {
      vscode.window.showWarningMessage('ZCode 正在回复,请先停止或等待。');
      return;
    }
    const cfg = vscode.workspace.getConfiguration('zcode');
    const attach: string[] = [];
    if (this.attachedFile) {
      attach.push(this.attachedFile);
    } else if (cfg.get<boolean>('autoAttachActiveFile', false)) {
      const f = vscode.window.activeTextEditor?.document.uri.fsPath;
      if (f && !f.startsWith('extension-output:')) {
        attach.push(f);
      }
    }

    const userMsg: ChatMessage = { role: 'user', text, attach: attach.length ? attach : undefined };
    this.messages.push(userMsg);
    this.post({ t: 'message', msg: userMsg });

    const assistantMsg: ChatMessage = { role: 'assistant', text: '' };
    this.messages.push(assistantMsg);
    this.streaming = true;
    this.post({ t: 'running', on: true });
    this.onStateChanged.fire();

    const resume = this.hasHistory;
    this.runner.run({
      cwd: this.cwd(),
      prompt: text,
      resume,
      attach,
      mode: this.mode(),
      onChunk: (chunk) => {
        assistantMsg.text += chunk;
        this.post({ t: 'append', text: chunk });
      },
      onDone: (code, stderr) => {
        this.streaming = false;
        this.post({ t: 'running', on: false });
        this.onStateChanged.fire();
        if (code === null && stderr === '已有任务在运行,请先停止。') {
          // 罕见竞态:丢弃这条空 assistant 消息
          this.messages = this.messages.filter((x) => x !== assistantMsg);
          this.post({ t: 'message', msg: { role: 'error', text: stderr } });
          return;
        }
        if (code === 0) {
          this.hasHistory = true;
          this.post({ t: 'done', stopped: false, ok: true });
        } else {
          const detail = stderr.trim() || assistantMsg.text.trim() || `进程退出码 ${code}`;
          const errMsg: ChatMessage = { role: 'error', text: `⚠ ${detail}` };
          // 流式过程可能已经把错误透出到 assistant 消息里,去重后改为 error 消息
          this.messages = this.messages.filter((x) => x !== assistantMsg || x.text.length > 0);
          if (!assistantMsg.text.trim()) {
            this.messages.pop();
          }
          this.messages.push(errMsg);
          this.post({ t: 'message', msg: errMsg });
          this.post({ t: 'done', stopped: false, ok: false });
        }
      },
    });
  }

  private html(webview: vscode.Webview): string {
    const js = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js')).toString();
    const nonce = Math.random().toString(36).slice(2);
    return /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} https: data:; font-src ${webview.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; padding: 0 12px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size, 13px);
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background);
    display: flex; flex-direction: column; height: 100vh; box-sizing: border-box;
  }
  #chat { flex: 1; overflow-y: auto; padding: 8px 0 12px; }
  .msg { margin: 10px 0; line-height: 1.55; word-break: break-word; }
  .msg .who { font-size: 11px; opacity: .7; margin-bottom: 2px; }
  .msg.user .bubble {
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 8px; padding: 8px 10px; white-space: pre-wrap;
  }
  .msg.error .bubble {
    color: var(--vscode-errorForeground);
    border: 1px solid var(--vscode-errorForeground);
    border-radius: 8px; padding: 8px 10px; white-space: pre-wrap;
  }
  .msg .attach-chip {
    display: inline-block; font-size: 11px; opacity: .8;
    border: 1px solid var(--vscode-input-border, #8884); border-radius: 4px;
    padding: 0 5px; margin-bottom: 4px;
  }
  .msg.assistant .bubble p { margin: .4em 0; }
  .msg.assistant pre {
    background: var(--vscode-textCodeBlock-background);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 6px; padding: 8px 10px; overflow-x: auto;
  }
  .msg.assistant code { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; }
  .msg.assistant :not(pre) > code {
    background: var(--vscode-textCodeBlock-background); border-radius: 3px; padding: 1px 4px;
  }
  .msg.assistant h1, .msg.assistant h2, .msg.assistant h3 { margin: .6em 0 .3em; font-size: 1.05em; }
  .msg.assistant ul, .msg.assistant ol { padding-left: 1.4em; margin: .4em 0; }
  .msg.assistant a { color: var(--vscode-textLink-foreground); }
  .msg.assistant table { border-collapse: collapse; }
  .msg.assistant th, .msg.assistant td { border: 1px solid var(--vscode-input-border, #8884); padding: 3px 8px; }
  .cursor { display: inline-block; width: 7px; height: 14px; vertical-align: -2px;
    background: var(--vscode-foreground); animation: blink 1s step-end infinite; }
  @keyframes blink { 50% { opacity: 0; } }
  footer { border-top: 1px solid var(--vscode-input-border, #8883); padding: 8px 0 10px; }
  .statusbar { display: flex; align-items: center; gap: 6px; font-size: 11px; opacity: .8;
    margin-bottom: 6px; flex-wrap: wrap; }
  .chip { border: 1px solid var(--vscode-input-border, #8884); border-radius: 4px;
    padding: 0 6px; cursor: pointer; user-select: none; }
  .chip.on { border-color: var(--vscode-focusBorder); color: var(--vscode-focusBorder); }
  #inputbox { display: flex; gap: 6px; align-items: flex-end; }
  textarea {
    flex: 1; resize: none; min-height: 52px; max-height: 180px;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent); border-radius: 6px;
    padding: 7px 9px; font-family: inherit; font-size: inherit; outline: none;
  }
  textarea:focus { border-color: var(--vscode-focusBorder); }
  button {
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; border-radius: 6px; padding: 6px 14px; cursor: pointer; font-size: inherit;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.sec { background: var(--vscode-button-secondaryBackground, #666);
    color: var(--vscode-button-secondaryForeground, #fff); }
  button:disabled { opacity: .45; cursor: default; }
  .empty { opacity: .65; text-align: center; margin-top: 32px; line-height: 1.8; }
  .empty .logo { font-size: 34px; font-weight: 700; letter-spacing: 2px;
    color: var(--vscode-focusBorder); }
</style>
</head>
<body>
  <div id="chat"><div class="empty"><div class="logo">Z</div>ZCode 就绪<br>输入问题开始对话,会自动在当前工作区运行</div></div>
  <footer>
    <div class="statusbar">
      <span id="st-mode"></span><span id="st-run"></span>
      <span id="st-attach" class="chip" title="点击移除附件"></span>
    </div>
    <div id="inputbox">
      <textarea id="input" placeholder="问点什么…(Enter 发送,Shift+Enter 换行)"></textarea>
      <button id="send">发送</button>
    </div>
  </footer>
  <script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}

/** 把相对 cwd 的文件名显示为短标签 */
export function shortPath(f: string): string {
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (ws && f.startsWith(ws + path.sep)) {
    return path.relative(ws, f);
  }
  return path.basename(f);
}
