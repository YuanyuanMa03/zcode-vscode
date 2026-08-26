// T2 集成冒烟:用真实 SessionController 驱动协议进程
// 用法:node scripts/protocol-smoke.ts [workspace] [prompt] [mode]
import { SessionController } from '../src/controller/sessionController.ts';

const WS = process.argv[2] ?? '/tmp/zc-ext-test/ws';
const PROMPT = process.argv[3] ?? 'Reply with exactly: ok';
const MODE = process.argv[4] ?? 'build';

const deadline = Date.now() + 180_000;
const fail = (msg: string): never => {
  console.error('SMOKE FAIL:', msg);
  process.exit(1);
};

const ctl = new SessionController({
  workspacePath: WS,
  defaultMode: MODE,
  onLogLine: (l) => {
    if (process.env.SMOKE_VERBOSE) {
      process.stderr.write('[srv] ' + l + '\n');
    }
  },
});

let permissionCount = 0;
let turnEnded = false;
ctl.onStateChange((s) => {
  if (s.current.pendingPermissions.length > permissionCount) {
    // 自动批准:选第一个 allow 类 option
    for (const p of s.current.pendingPermissions) {
      const allowOpt = p.options.find((o) => o.response && (o.response as { decision?: string }).decision === 'allow');
      const pick = allowOpt ?? p.options[0];
      if (pick && ctl.answerPermission(p.key, pick.optionId)) {
        permissionCount++;
        console.log(`PERM auto-allowed #${permissionCount}: ${p.toolName} risk=${p.riskLevel} → ${pick.optionId}`);
      }
    }
  }
  if (s.current.live.active && s.current.live.streamingText) {
    process.stdout.write('\r[text] ' + s.current.live.streamingText.slice(-60).replace(/\n/g, ' '));
  }
  const lastMsg = s.current.messages[s.current.messages.length - 1];
  if (!s.current.live.active && lastMsg && s.current.messages.length >= 2 && lastMsg.role === 'assistant' && !turnEnded) {
    turnEnded = true;
  }
});

const waitTurnEnd = async () => {
  while (!turnEnded && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!turnEnded) {
    fail('turn 未在时限内结束');
  }
};

try {
  await ctl.newSession();
  console.log('CREATE ok, sessionId =', ctl.uiState.current.sessionId);
  if (ctl.uiState.connection !== 'connected') {
    fail('connection=' + ctl.uiState.connection);
  }

  await ctl.send(PROMPT);
  console.log('\nSEND ok');
  await waitTurnEnd();

  const st = ctl.uiState.current;
  console.log('--- status =', st.status, '| messages =', st.messages.length, '| toolCalls =', st.live.toolCalls.length);
  const assistant = st.messages.filter((m) => m.role === 'assistant').pop();
  const text = assistant?.parts.filter((p) => p.kind === 'text').map((p) => (p as { text: string }).text).join('') ?? '';
  console.log('--- assistant text:', JSON.stringify(text.slice(0, 200)));

  const usage = await ctl.usage();
  console.log('--- usage totalTokens =', usage ? (usage as { totalTokens?: number }).totalTokens : 'n/a');

  // 第二轮:验证免重启续聊
  turnEnded = false;
  await ctl.send('What did I ask you? Reply in under 10 words.');
  await waitTurnEnd();
  const assistant2 = ctl.uiState.current.messages.filter((m) => m.role === 'assistant').pop();
  const text2 = assistant2?.parts.filter((p) => p.kind === 'text').map((p) => (p as { text: string }).text).join('') ?? '';
  console.log('--- turn2 text:', JSON.stringify(text2.slice(0, 200)));
  if (!/ok|exactly/i.test(text2)) {
    console.log('!! 第二轮未引用第一轮内容(上下文验证仅提示,不判失败)');
  }

  await ctl.refreshSessions();
  console.log('--- sessions =', ctl.uiState.sessions.length, 'first =', JSON.stringify(ctl.uiState.sessions[0] ?? null));

  ctl.dispose();
  console.log('SMOKE PASS');
  process.exit(0);
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}
