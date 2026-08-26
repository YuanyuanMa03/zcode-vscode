// 跨进程会话同步探针(模仿 CC 共享存储模式的协议层证明):
// 进程 A 创建会话并发一轮;进程 B(独立 app-server)必须能看到该会话、读到消息、并续聊。
import { SessionController } from '../src/controller/sessionController.ts';

const WS = process.argv[2] ?? '/tmp/zc-ext-test/ws';
const pass = (msg) => console.log('✓', msg);
const fail = (msg) => {
  console.error('✗', msg);
  process.exit(1);
};

const mkCtl = () => new SessionController({ workspacePath: WS, defaultMode: 'build' });
const waitAssistant = async (ctl, n, tag) => {
  let seen = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 120000) {
    seen = ctl.uiState.current.messages.filter((m) => m.role === 'assistant').length;
    if (seen >= n) {
      return;
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  fail(`${tag}: 等待第 ${n} 条 assistant 超时(见到 ${seen})`);
};

const a = mkCtl();
await a.newSession();
await a.send('Reply with exactly: alpha');
await waitAssistant(a, 1, 'A-turn1');
const sid = (a.uiState as { current: { sessionId: string } }).current.sessionId;
pass(`A 创建会话 ${sid.slice(5, 13)} 并完成一轮`);
a.dispose();

// B:全新进程
const b = mkCtl();
await b.ensureStarted();
await b.refreshSessions();
const listed = (b.uiState as { sessions: { sessionId: string }[] }).sessions.find((s) => s.sessionId === sid);
if (!listed) {
  fail('B 的 session/list 看不到 A 创建的会话(共享存储同步失败)');
}
pass('B(独立进程)在列表中看到 A 的会话');

await b.openSession(sid);
const msgs1 = (b.uiState as { current: { messages: { role: string; parts: { kind: string; text?: string }[] }[] } }).current.messages;
const sawAlpha = msgs1.some((m) => m.role === 'assistant' && m.parts.some((p) => p.kind === 'text' && (p.text ?? '').includes('alpha')));
if (!sawAlpha) {
  fail('B resume 后读不到 A 的对话内容');
}
pass('B resume 并读到 A 的完整对话');

await b.send('What did I ask you? Reply in under 8 words.');
await waitAssistant(b, 2, 'B-turn2');
const msgs2 = (b.uiState as typeof b.uiState).current.messages;
const last = msgs2[msgs2.length - 1];
const ctxOk = JSON.stringify(last).toLowerCase().includes('alpha');
pass(`B 续聊成功(上下文引用: ${ctxOk ? '是' : '否(仅提示)'})`);
b.dispose();
console.log('CROSS_PROCESS_SYNC_PASS');
process.exit(0);
