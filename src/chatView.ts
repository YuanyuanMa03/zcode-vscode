import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { SessionController, type UIState } from './controller/sessionController';
import { lineDiff } from './util/lineDiff';

export type ToWebview =
  | { t: 'state'; state: UIState }
  | { t: 'prefill'; text: string }
  | { t: 'attachChip'; label: string; clear?: boolean }
  | { t: 'permDiff'; key: string; diff: string };

export type FromWebview =
  | { t: 'ready' }
  | { t: 'send'; content: string }
  | { t: 'steer'; content: string }
  | { t: 'stop' }
  | { t: 'newSession' }
  | { t: 'openSession'; sessionId: string }
  | { t: 'fork' }
  | { t: 'rewind' }
  | { t: 'rewindTo'; messageId: string }
  | { t: 'answerPermission'; key: string; optionId: string }
  | { t: 'dismissPermission'; key: string }
  | { t: 'answerUserInput'; key: string; action: 'accept' | 'decline'; value?: string }
  | { t: 'pickModel' }
  | { t: 'pickMode' }
  | { t: 'openFile'; path: string }
  | { t: 'removeAttach' };

/**
 * ZCode 聊天侧栏(v2,协议原生):webview 是纯渲染器,
 * 权威状态在扩展宿主 SessionController,经 {t:'state'} 全量推送。
 */
export class ZcodeChatView implements vscode.WebviewViewProvider {
  static readonly viewId = 'zcode.chat';

  private view?: vscode.WebviewView;
  private controller: SessionController | null = null;
  private unsubscribe?: () => void;
  private pendingPrefill?: string;
  private attachChips: { label: string }[] = [];
  private autoOpened = false;
  private readonly onStateChanged = new vscode.EventEmitter<void>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: (line: string) => void
  ) {
    context.subscriptions.push(this.onStateChanged);
  }

  get running(): boolean {
    return this.controller?.uiState.current.live.active ?? false;
  }

  get stateChanged(): vscode.Event<void> {
    return this.onStateChanged.event;
  }

  get currentSessionId(): string | null {
    return this.controller?.uiState.current.sessionId ?? null;
  }

  disposeController(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.controller?.dispose();
    this.controller = null;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')] };
    view.webview.onDidReceiveMessage((m: FromWebview) => this.onMessage(m));
    view.webview.html = this.html(view.webview);
    this.ensureController();
  }

  private ensureController(): SessionController {
    if (this.controller) {
      return this.controller;
    }
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
    const mode = vscode.workspace.getConfiguration('zcode').get<string>('mode', 'yolo');
    const ctl = new SessionController({
      workspacePath: ws,
      defaultMode: mode,
      onLogLine: (l) => this.log(l),
    });
    this.unsubscribe = ctl.onStateChange((state) => {
      this.post({ t: 'state', state });
      this.onStateChanged.fire();
      this.notifyFileChanges(state);
      void this.pushPermissionDiffs(state);
      // 首次会话列表到达后自动恢复最近会话(桌面体感)
      if (!this.autoOpened && state.connection === 'connected' && state.sessions.length > 0 && !state.current.sessionId) {
        this.autoOpened = true;
        void ctl.openSession(state.sessions[0].sessionId).catch(() => {});
      }
    });
    this.controller = ctl;
    void (async () => {
      try {
        await ctl.ensureStarted();
        await ctl.refreshSessions();
      } catch {
        /* 状态里已带 connectionError */
      }
    })();
    return ctl;
  }

  show(prefill?: string): void {
    if (prefill) {
      this.pendingPrefill = (this.pendingPrefill ?? '') + prefill;
    }
    if (this.view) {
      this.view.show?.(true);
      this.flushPrefill();
    } else {
      void vscode.commands.executeCommand(`${ZcodeChatView.viewId}.focus`);
    }
  }

  private flushPrefill(): void {
    if (this.pendingPrefill && this.view) {
      this.post({ t: 'prefill', text: this.pendingPrefill });
      this.pendingPrefill = undefined;
    }
  }

  /** 附加当前文件/选区到输入框(chip 形态) */
  addContextChip(label: string): void {
    this.attachChips.push({ label });
    this.post({ t: 'attachChip', label });
  }

  clearContextChips(): void {
    this.attachChips = [];
    this.post({ t: 'attachChip', label: '', clear: true });
  }

  /** 命令面板入口:新建会话 */
  newConversation(): void {
    void this.ensureController()
      .newSession()
      .catch((e) => vscode.window.showErrorMessage(`ZCode: ${e.message}`));
  }

  /** 命令面板入口:停止当前 turn */
  stopRunning(): void {
    void this.ensureController().stop().catch(() => {});
  }

  private wasLiveActive = false;
  private readonly seenPermKeys = new Set<string>();

  /** 新到的 Write/Edit 权限卡:生成改动预览并推送(批准前可见) */
  private async pushPermissionDiffs(state: UIState): Promise<void> {
    const jobs: Promise<void>[] = [];
    for (const perm of state.current.pendingPermissions) {
      if (this.seenPermKeys.has(perm.key)) {
        continue;
      }
      this.seenPermKeys.add(perm.key);
      if (!['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(perm.toolName)) {
        continue;
      }
      jobs.push(
        this.buildPermissionDiff(perm.toolName, perm.input)
          .then((diff) => { if (diff !== null) { this.post({ t: 'permDiff', key: perm.key, diff }); } })
          .catch(() => {})
      );
    }
    if (jobs.length) {
      await Promise.all(jobs);
    }
  }

  private async buildPermissionDiff(toolName: string, input: unknown): Promise<string | null> {
    const rec = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
    const file = typeof rec.file_path === 'string' ? rec.file_path : typeof rec.path === 'string' ? rec.path : null;
    if (!file) {
      return null;
    }
    const head = `${toolName} · ${path.basename(file)}` + '\n';
    if (toolName === 'Edit' && typeof rec.old_string === 'string' && typeof rec.new_string === 'string') {
      return head + '\n' + lineDiff(rec.old_string, rec.new_string).join('\n');
    }
    if (typeof rec.content === 'string') {
      let current = '';
      try {
        current = await fs.readFile(file, 'utf8');
      } catch {
        current = ''; // 新文件
      }
      const d = lineDiff(current, rec.content);
      return head + '\n' + (d.length ? d.join('\n') : '(内容未变化)');
    }
    return null;
  }

  /** turn 结束时,对 Write/Edit 落盘的文件弹通知(可一键看 diff) */
  private notifyFileChanges(state: { current: { live: { active: boolean; toolCalls: { toolName: string; status: string; input?: unknown; result?: unknown }[] } } }): void {
    const live = state.current.live;
    if (this.wasLiveActive && !live.active) {
      const paths = new Set<string>();
      for (const tc of live.toolCalls) {
        if (tc.status !== 'completed' || !['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tc.toolName)) {
          continue;
        }
        const p = extractFilePath(tc.input) ?? extractFilePath(tc.result);
        if (p) {
          paths.add(p);
        }
      }
      if (paths.size > 0) {
        const list = [...paths];
        const show = `ZCode 修改了 ${list.length} 个文件:${list.map((f) => path.basename(f)).join(', ')}`;
        void vscode.window.showInformationMessage(show, '查看改动').then((choice) => {
          if (choice !== '查看改动') {
            return;
          }
          void this.openDiffOrFile(list[0]);
        });
      }
    }
    this.wasLiveActive = live.active;
  }

  private async openDiffOrFile(file: string): Promise<void> {
    const uri = vscode.Uri.file(file);
    const gitExt = vscode.extensions.getExtension('vscode.git');
    if (gitExt?.isActive) {
      const ok = await vscode.commands.executeCommand('git.openChange', uri).then(
        () => true,
        () => false
      );
      if (ok) {
        return;
      }
    }
    await vscode.window.showTextDocument(uri, { preview: true }).then(undefined, () => {});
  }

  private post(m: ToWebview): void {
    void this.view?.webview.postMessage(m);
  }

  private onMessage(m: FromWebview): void {
    const ctl = this.ensureController();
    switch (m.t) {
      case 'ready':
        this.post({ t: 'state', state: ctl.uiState as UIState });
        this.flushPrefill();
        break;
      case 'send':
        void (async () => {
          if (!ctl.uiState.current.sessionId) {
            await ctl.newSession();
          }
          await ctl.send(m.content).catch((e) => vscode.window.showErrorMessage(`ZCode: ${e.message}`));
        })();
        break;
      case 'steer':
        void ctl.steer(m.content).catch(() => {});
        break;
      case 'stop':
        void ctl.stop().catch(() => {});
        break;
      case 'newSession':
        void ctl.newSession().catch((e) => vscode.window.showErrorMessage(`ZCode: ${e.message}`));
        break;
      case 'openSession':
        void ctl.openSession(m.sessionId).catch((e) => vscode.window.showErrorMessage(`ZCode: ${e.message}`));
        break;
      case 'fork':
        void ctl.fork().catch((e) => vscode.window.showErrorMessage(`ZCode: ${e.message}`));
        break;
      case 'rewind':
        // 顶栏按钮 = 回退到最近一轮用户消息之前(撤销上一轮)
        {
          const msgs = ctl.uiState.current.messages;
          const lastUser = [...msgs].reverse().find((m) => m.role === 'user' && !m.id.startsWith('local-'));
          if (lastUser) {
            void ctl.rewindToMessage(lastUser.id).catch((e) => vscode.window.showErrorMessage(`ZCode: ${e.message}`));
          }
        }
        break;
      case 'rewindTo':
        void ctl.rewindToMessage(m.messageId).catch((e) => vscode.window.showErrorMessage(`ZCode: ${e.message}`));
        break;
      case 'answerPermission':
        ctl.answerPermission(m.key, m.optionId);
        break;
      case 'dismissPermission':
        ctl.dismissPermission(m.key);
        break;
      case 'answerUserInput':
        ctl.answerUserInput(m.key, m.action, m.value ? { value: m.value } : undefined);
        break;
      case 'pickModel':
        void this.pickModel(ctl);
        break;
      case 'pickMode':
        void this.pickMode(ctl);
        break;
      case 'openFile':
        void vscode.window.showTextDocument(vscode.Uri.file(m.path), { preview: true }).then(
          undefined,
          () => {}
        );
        break;
      case 'removeAttach':
        this.clearContextChips();
        break;
    }
  }

  private async pickModel(ctl: SessionController): Promise<void> {
    const current = ctl.uiState.current.modelLabel;
    let models: { label: string; description: string; detail: string }[] = [];
    try {
      const catalog = await ctl.getWorkspaceModels();
      models = catalog.map((m) => ({
        label: m.label,
        description: m.providerLabel,
        detail: `${m.providerId}/${m.modelId}`,
      }));
    } catch {
      /* readState 失败时回退常用清单 */
    }
    if (!models.length) {
      models = [
        { label: 'GLM-5.3', description: 'BigModel Coding Plan', detail: 'builtin:bigmodel-coding-plan/GLM-5.3' },
        { label: 'GLM-5.2', description: 'BigModel Coding Plan', detail: 'builtin:bigmodel-coding-plan/GLM-5.2' },
      ];
    }
    const pick = await vscode.window.showQuickPick(models, { placeHolder: `当前:${current || '未设置'}` });
    if (!pick?.detail) {
      return;
    }
    const [providerId, ...rest] = pick.detail.split('/');
    const modelId = rest.join('/');
    await ctl.setModel({ providerId, modelId }).catch((e) => vscode.window.showErrorMessage(`ZCode: ${e.message}`));
  }

  private async pickMode(ctl: SessionController): Promise<void> {
    const mode = await vscode.window.showQuickPick(
      ['plan', 'build', 'edit', 'yolo'].map((m) => ({ label: m, description: m === 'yolo' ? '全自动(谨慎)' : '' })),
      { placeHolder: `当前:${ctl.uiState.current.mode || '未设置'}` }
    );
    if (mode) {
      await ctl.setMode(mode.label).catch((e) => vscode.window.showErrorMessage(`ZCode: ${e.message}`));
    }
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
  body { margin:0; padding:0 12px; font-family:var(--vscode-font-family); font-size:var(--vscode-font-size,13px);
    color:var(--vscode-foreground); background:var(--vscode-sideBar-background);
    display:flex; flex-direction:column; height:100vh; box-sizing:border-box; }
  header { padding:8px 0 6px; border-bottom:1px solid var(--vscode-input-border,#8883); }
  .hrow { display:flex; align-items:center; gap:6px; }
  .title { font-weight:600; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .badge { border:1px solid var(--vscode-input-border,#8884); border-radius:4px; padding:0 5px; font-size:11px;
    cursor:pointer; user-select:none; }
  .badge.mode { color:var(--vscode-charts-blue,#4fc1ff); }
  .ctxbar { height:3px; border-radius:2px; background:var(--vscode-input-background); margin-top:6px; overflow:hidden; }
  .ctxfill { height:100%; background:var(--vscode-charts-green,#89d185); transition:width .3s; }
  .conn { font-size:11px; opacity:.75; margin-top:4px; }
  .conn.err { color:var(--vscode-errorForeground); opacity:1; }
  #chat { flex:1; overflow-y:auto; padding:8px 0 12px; }
  .msg { margin:10px 0; line-height:1.55; word-break:break-word; }
.msg .who { font-size:11px; opacity:.7; margin-bottom:2px; }
  .rewindbtn { background:none; border:none; color:inherit; opacity:.5; cursor:pointer; padding:0 4px; font-size:11px; }
  .rewindbtn:hover { opacity:1; color:var(--vscode-focusBorder); }
  .msg.user .bubble { background:var(--vscode-input-background); border:1px solid var(--vscode-input-border,transparent);
    border-radius:8px; padding:8px 10px; white-space:pre-wrap; }
  .msg .bubble p { margin:.4em 0; }
  .msg pre { background:var(--vscode-textCodeBlock-background); border:1px solid var(--vscode-input-border,transparent);
    border-radius:6px; padding:8px 10px; overflow-x:auto; }
  .msg code { font-family:var(--vscode-editor-font-family,monospace); font-size:12px; }
  .msg :not(pre)>code { background:var(--vscode-textCodeBlock-background); border-radius:3px; padding:1px 4px; }
  .msg h1,.msg h2,.msg h3 { margin:.6em 0 .3em; font-size:1.05em; }
  .msg ul,.msg ol { padding-left:1.4em; margin:.4em 0; }
  .msg a { color:var(--vscode-textLink-foreground); }
  .reasoning { font-size:12px; opacity:.7; border-left:2px solid var(--vscode-input-border,#8886);
    padding:2px 8px; margin:4px 0; white-space:pre-wrap; }
  .toolcard { border:1px solid var(--vscode-input-border,#8884); border-radius:6px; padding:6px 9px; margin:6px 0;
    font-size:12px; }
  .toolcard .trow { display:flex; align-items:center; gap:6px; }
  .toolname { font-weight:600; }
  .tstat { font-size:11px; opacity:.75; }
  .tstat.running { color:var(--vscode-charts-blue,#4fc1ff); }
  .tstat.failed { color:var(--vscode-errorForeground); }
  .toolcard details { margin-top:4px; }
  .toolcard summary { cursor:pointer; opacity:.8; }
  .toolcard pre { margin:4px 0 0; max-height:220px; overflow:auto; }
  .patch { font-size:12px; border:1px dashed var(--vscode-input-border,#8886); border-radius:6px; padding:5px 9px; margin:6px 0; }
  .patch .pfile { cursor:pointer; color:var(--vscode-textLink-foreground); display:block; }
  .meta { font-size:11px; opacity:.6; }
  .cursor { display:inline-block; width:7px; height:14px; vertical-align:-2px;
    background:var(--vscode-foreground); animation:blink 1s step-end infinite; }
  @keyframes blink { 50% { opacity:0; } }
  .perm { border:1px solid var(--vscode-input-border,#8886); border-left-width:4px; border-radius:6px;
    padding:8px 10px; margin:10px 0; }
  .perm .ptool { font-weight:600; }
  .perm .preason { font-size:12px; opacity:.8; margin:2px 0 6px; }
  .perm .pinput { font-size:11px; background:var(--vscode-textCodeBlock-background); border-radius:4px;
    padding:4px 7px; margin-bottom:6px; max-height:140px; overflow:auto; white-space:pre-wrap; }
  .perm .popts { display:flex; flex-wrap:wrap; gap:6px; }
  .permdiff summary { cursor:pointer; color:var(--vscode-textLink-foreground); margin:4px 0; }
  .diffview { background:var(--vscode-textCodeBlock-background); border-radius:4px; padding:6px 8px;
    max-height:260px; overflow:auto; font-size:11px; line-height:1.5; }
  .dadd { color:var(--vscode-charts-green,#89d185); display:block; }
  .ddel { color:var(--vscode-errorForeground,#f66); display:block; }
  .risk-low { border-left-color:var(--vscode-charts-green,#89d185); }
  .risk-medium { border-left-color:var(--vscode-charts-yellow,#cca700); }
  .risk-high { border-left-color:#e06b2d; }
  .risk-critical { border-left-color:var(--vscode-errorForeground,#f66); }
  .uinput { border:1px solid var(--vscode-focusBorder,#0078d4); border-radius:6px; padding:8px 10px; margin:10px 0; }
  .uinput .q { font-weight:600; margin:6px 0 4px; }
  .uinput .opt { display:block; margin:2px 0; cursor:pointer; }
  footer { border-top:1px solid var(--vscode-input-border,#8883); padding:8px 0 10px; }
  .chips { display:flex; flex-wrap:wrap; gap:4px; margin-bottom:6px; }
  .chip { border:1px solid var(--vscode-input-border,#8884); border-radius:4px; padding:0 6px; font-size:11px;
    cursor:pointer; }
  .statusrow { display:flex; gap:6px; font-size:11px; opacity:.8; margin-bottom:6px; align-items:center; }
  #inputbox { display:flex; gap:6px; align-items:flex-end; }
  textarea { flex:1; resize:none; min-height:52px; max-height:180px; background:var(--vscode-input-background);
    color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border,transparent);
    border-radius:6px; padding:7px 9px; font-family:inherit; font-size:inherit; outline:none; }
  textarea:focus { border-color:var(--vscode-focusBorder); }
  button { background:var(--vscode-button-background); color:var(--vscode-button-foreground); border:none;
    border-radius:6px; padding:6px 14px; cursor:pointer; font-size:inherit; }
  button:hover { background:var(--vscode-button-hoverBackground); }
  button.sec { background:var(--vscode-button-secondaryBackground,#666); color:var(--vscode-button-secondaryForeground,#fff); }
  button:disabled { opacity:.45; cursor:default; }
  .empty { opacity:.65; text-align:center; margin-top:32px; line-height:1.8; }
  .empty .logo { font-size:34px; font-weight:700; letter-spacing:2px; color:var(--vscode-focusBorder); }
  select.sessionpick { background:var(--vscode-dropdown-background); color:var(--vscode-dropdown-foreground);
    border:1px solid var(--vscode-dropdown-border,#8884); border-radius:4px; font-size:11px; max-width:100%; }
</style>
</head>
<body>
  <header>
    <div class="hrow">
      <span class="title" id="title">ZCode</span>
      <span class="badge mode" id="b-mode" title="点击切换模式">--</span>
      <span class="badge" id="b-model" title="点击切换模型">--</span>
    </div>
    <div class="ctxbar"><div class="ctxfill" id="ctxfill" style="width:0%"></div></div>
    <div class="hrow" style="margin-top:5px">
      <select class="sessionpick" id="sessionpick" title="切换会话"></select>
      <span style="flex:1"></span>
      <button class="sec" id="btn-fork" title="从最近检查点分叉" style="padding:2px 8px">⑂</button>
      <button class="sec" id="btn-rewind" title="回退上一轮对话" style="padding:2px 8px">↺</button>
      <button class="sec" id="btn-new" title="新建会话" style="padding:2px 8px">＋</button>
    </div>
    <div class="conn" id="conn">连接中…</div>
  </header>
  <div id="chat"><div class="empty"><div class="logo">Z</div>ZCode 就绪<br>输入问题开始对话</div></div>
  <footer>
    <div class="chips" id="chips"></div>
    <div class="statusrow"><span id="st-run"></span><span id="st-ctx"></span></div>
    <div id="inputbox">
      <textarea id="input" placeholder="问点什么…(Enter 发送,Shift+Enter 换行;运行中 Enter 追加指令)"></textarea>
      <button id="send">发送</button>
    </div>
  </footer>
  <script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}

/** 短路径显示 */
export function shortPath(f: string): string {
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (ws && f.startsWith(ws + path.sep)) {
    return path.relative(ws, f);
  }
  return path.basename(f);
}

/** 从工具输入/结果中提取绝对文件路径 */
function extractFilePath(v: unknown): string | null {
  if (typeof v !== 'object' || v === null) {
    return null;
  }
  for (const k of ['file_path', 'path', 'absolute_path', 'notebook_path']) {
    const val = (v as Record<string, unknown>)[k];
    if (typeof val === 'string' && val.startsWith('/')) {
      return val;
    }
  }
  return null;
}
