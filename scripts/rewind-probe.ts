// rewind 语义探测:两轮对话后 rewind latestCheckpoint,对比消息列表
import { SessionController } from '../src/controller/sessionController.ts';

const WS = process.argv[2] ?? '/tmp/zc-ext-test/ws';
const ctl = new SessionController({ workspacePath: WS, defaultMode: 'build' });

let turnDone = false;
ctl.onStateChange((s) => {
  if (!s.current.live.active && s.current.status !== 'running' && s.current.messages.length) {
    turnDone = true;
  }
});
const waitTurn = async () => {
  turnDone = false;
  const t0 = Date.now();
  while (!turnDone && Date.now() - t0 < 120000) {
    await new Promise((r) => setTimeout(r, 800));
  }
};

const digest = (s: ReturnType<() => Readonly<import('../src/controller/sessionController').UIState>>) =>
  s.current.messages.map((m) => `${m.role[0]}:${(m.parts.find((p) => p.kind === 'text') as { text?: string } | undefined)?.text?.slice(0, 24) ?? `(${m.parts.map((p) => p.kind).join('+')})`}`);

const ctlAny = ctl as unknown as { uiState: import('../src/controller/sessionController').UIState };

try {
  await ctl.newSession();
  await ctl.send('Reply with exactly: one');
  await waitTurn();
  await ctl.send('Reply with exactly: two');
  await waitTurn();
  console.log('BEFORE msgs=', ctlAny.uiState.current.messages.length, JSON.stringify(digest(ctlAny.uiState)));
  console.log('checkpointId =', ctl.checkpointId);

  await ctl.rewindToLatestCheckpoint();
  await new Promise((r) => setTimeout(r, 1500));
  console.log('AFTER  msgs=', ctlAny.uiState.current.messages.length, JSON.stringify(digest(ctlAny.uiState)));

  // 再试按消息回退:回退到第一条 assistant 消息之前(即第一条 user 消息)
  const firstUser = ctlAny.uiState.current.messages.find((m) => m.role === 'user');
  if (firstUser) {
    const c2 = ctl as never as { clientOrThrow?: unknown };
    void c2;
    const client = (ctl as unknown as { client: unknown }).client;
    console.log('client available:', !!client);
  }
  ctl.dispose();
  process.exit(0);
} catch (e) {
  console.error('FAIL', e instanceof Error ? e.message : e);
  ctl.dispose();
  process.exit(1);
}
