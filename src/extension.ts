import * as vscode from 'vscode';
import { ZcodeChatView, shortPath } from './chatView';
import { resolveBinaries, ZcodeRunner } from './zcodeRunner';

export function activate(context: vscode.ExtensionContext): void {
  const out = vscode.window.createOutputChannel('ZCode');
  context.subscriptions.push(out);

  const chat = new ZcodeChatView(context, (line) => out.appendLine(line));
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ZcodeChatView.viewId, chat, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    { dispose: () => chat.disposeController() }
  );

  const runner = new ZcodeRunner();

  // 状态栏:未配置/运行中/就绪
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  status.command = 'zcode.openChat';
  status.name = 'ZCode';
  context.subscriptions.push(
    status,
    chat.stateChanged(refreshStatus),
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('zcode') && refreshStatus())
  );
  function refreshStatus(): void {
    if (!resolveBinaries().cli) {
      status.text = '$(warning) ZCode';
      status.tooltip = 'ZCode: 未找到 CLI,点击打开聊天查看详情';
      status.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else if (chat.running) {
      status.text = '$(sync~spin) ZCode';
      status.tooltip = 'ZCode: 任务运行中,点击查看';
      status.backgroundColor = undefined;
    } else {
      status.text = '$(sparkle) ZCode';
      status.tooltip = 'ZCode: 就绪,点击打开聊天';
      status.backgroundColor = undefined;
    }
    status.show();
  }
  refreshStatus();

  const register = (id: string, cb: (...a: never[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, cb));

  register('zcode.openChat', (prefill?: string) => chat.show(prefill));
  register('zcode.newConversation', () => chat.newConversation());
  register('zcode.stop', () => chat.stopRunning());
  register('zcode.openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:mayuanyuan.zcode-vscode'));

  register('zcode.attachActiveFile', () => {
    const ed = vscode.window.activeTextEditor;
    const f = ed?.document.uri.fsPath;
    if (!f) {
      vscode.window.showWarningMessage('ZCode: 没有活跃的编辑器文件。');
      return;
    }
    chat.show();
    chat.addContextChip(shortPath(f));
  });

  register('zcode.askAboutSelection', () => {
    const ed = vscode.window.activeTextEditor;
    if (!ed) {
      return;
    }
    const sel = ed.selection;
    const text = sel.isEmpty ? ed.document.lineAt(sel.active.line).text : ed.document.getText(sel);
    if (!text.trim()) {
      vscode.window.showWarningMessage('ZCode: 选区为空。');
      return;
    }
    const rel = vscode.workspace.asRelativePath(ed.document.uri);
    chat.show(`关于 ${rel} 中的这段代码:\n\n\`\`\`\n${text}\n\`\`\`\n\n`);
  });

  register('zcode.showDoctor', async () => {
    out.show(true);
    out.appendLine('=== zcode doctor ===');
    const r = await runner.capture(['doctor']);
    out.appendLine(r.out);
    vscode.window.showInformationMessage(r.code === 0 ? 'ZCode: 诊断完成,详见输出面板。' : 'ZCode: 诊断异常,详见输出面板。');
  });
}

export function deactivate(): void {
  /* 控制器在 activate 注入的 dispose 中清理 */
}
