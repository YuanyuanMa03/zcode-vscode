// ZCode Protocol 活体冒烟测试:create → subscribe → send → 事件流采集 → 权限自动应答 → stop
const { spawn } = require('child_process');
const WS = process.argv[2] || '/tmp/zc-ext-test/ws';
const PROMPT = process.argv[3] || 'Reply with exactly: ok';
const MODE = process.argv[4] || 'build';

const child = spawn('/Users/mayuanyuan/.zcode/server/node',
  ['/Users/mayuanyuan/.zcode/server/agents/glm/zcode.cjs', 'app-server', '--stdio'],
  { stdio: ['pipe', 'pipe', 'pipe'], cwd: WS });

let buf = '';
let nextId = 0;
const pending = new Map();
const events = [];
const serverReqs = new Map(); // requestId -> 最新帧
let turnDone = false;
let permAnswered = 0;

child.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let f; try { f = JSON.parse(line); } catch { console.log('!! NONJSON:', line.slice(0, 120)); continue; }
    if (f.id !== undefined && (f.result !== undefined || f.error !== undefined) && pending.has(String(f.id))) {
      pending.get(String(f.id))(f); pending.delete(String(f.id));
    } else if (f.method) {
      handleServerFrame(f);
    }
  }
});
child.stderr.on('data', (d) => process.stderr.write('[srv-err] ' + d));

function handleServerFrame(f) {
  if (f.method === 'session/event') {
    const p = f.params || {};
    events.push(p);
    const brief = p.type === 'part.delta' ? `delta(${(p.payload || {}).field} +${((p.payload || {}).delta || '').length}b)` :
      p.type === 'model.streaming' ? `stream(${(p.payload || {}).kind})` :
      JSON.stringify(p.payload || {}).slice(0, 160);
    console.log(`EVT seq=${p.seq} ${p.type} ${brief}`);
    if (p.type === 'turn.completed' || p.type === 'turn.failed') turnDone = true;
    if (p.type === 'permission.requested') handlePermissionEvent(p.payload || {});
  } else if (f.method === 'state.updated') {
    console.log(`NOTIFY state.updated scope=${f.params.scope} rev=${f.params.revision} reason=${f.params.reason || ''}`);
  } else if (f.method === 'interaction/requestPermission') {
    const key = `${f.params.sessionId}:${f.params.requestId}`;
    serverReqs.set(key, f); // 记录最新帧(重发时 id 更新)
    console.log(`PERM-REQ ${f.params.toolName} risk=${f.params.riskLevel} input=${JSON.stringify(f.params.input).slice(0, 100)} options=[${f.params.options.map(o => o.optionId).join(',')}]`);
    child.stdin.write(JSON.stringify({ id: f.id, result: { decision: 'allow' } }) + '\n');
    permAnswered++;
  } else if (f.method === 'interaction/requestUserInput') {
    console.log(`USER-INPUT ${JSON.stringify(f.params.questions || f.params.prompt || '').slice(0, 150)}`);
    child.stdin.write(JSON.stringify({ id: f.id, result: { action: 'accept', content: {} } }) + '\n');
  } else {
    console.log(`SRV-REQ ${f.method} id=${f.id}`);
    child.stdin.write(JSON.stringify({ id: f.id, error: { code: -32601, message: 'Method not found: ' + f.method } }) + '\n');
  }
}

function handlePermissionEvent() { /* 事件镜像,只用于统计 */ }

const req = (method, params, timeoutMs = 90000) => new Promise((res, rej) => {
  const mid = ++nextId;
  const t = setTimeout(() => { pending.delete(String(mid)); rej(new Error('timeout ' + method)); }, timeoutMs);
  pending.set(String(mid), (f) => { clearTimeout(t); f.error ? rej(new Error(method + ' → ' + JSON.stringify(f.error).slice(0, 400))) : res(f.result); });
  child.stdin.write(JSON.stringify({ id: mid, method, params }) + '\n');
});

(async () => {
  const t0 = Date.now();
  try {
    const created = await req('session/create', { workspace: { workspacePath: WS, workspaceKey: WS }, mode: MODE, persistence: 'immediate' });
    const sid = created.session.sessionId;
    console.log(`CREATE ok ${sid} mode=${created.session.mode} status=${created.session.status} protocol=${JSON.stringify(created.protocol)} msgs=${created.messages.length}`);

    await req('session/subscribe', { sessionId: sid, deliveryKind: 'desktop-continuous' });
    console.log('SUBSCRIBE ok');

    const r = await req('session/send', { sessionId: sid, content: PROMPT }, 120000);
    console.log('SEND accepted=' + r.accepted + ' stateRevision=' + r.stateRevision);

    // 等 turn 结束(最多 120s)
    while (!turnDone && Date.now() - t0 < 150000) await new Promise(r2 => setTimeout(r2, 1500));

    const summary = events.reduce((m, e) => (m[e.type] = (m[e.type] || 0) + 1, m), {});
    console.log('--- EVENT SUMMARY:', JSON.stringify(summary));
    console.log('--- permissions answered:', permAnswered);
    const lastResp = events.filter(e => e.type === 'turn.completed').pop();
    if (lastResp) console.log('--- TURN RESPONSE:', JSON.stringify(lastResp.payload).slice(0, 300));
    const failed = events.filter(e => e.type === 'turn.failed').pop();
    if (failed) console.log('--- TURN FAILED:', JSON.stringify(failed.payload).slice(0, 400));

    await req('session/close', { sessionId: sid }).catch(() => {});
    child.kill('SIGKILL');
    setTimeout(() => process.exit(0), 200);
  } catch (e) {
    console.error('FAIL:', e.message);
    child.kill('SIGKILL');
    setTimeout(() => process.exit(1), 200);
  }
})();
