// v0.2 CDP 端到端:穿透双层 iframe,驱动真实 webview UI 走完整协议链路
// 场景:状态渲染 → 发消息流式 → 权限批准(写文件)→ 会话状态
const BASE = 'http://127.0.0.1:9333';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(wsUrl) {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let id = 0;
    ws.onopen = () =>
      resolve({
        send(method, params = {}) {
          return new Promise((res, rej) => {
            const mid = ++id;
            pending.set(mid, { res, rej });
            ws.send(JSON.stringify({ id: mid, method, params }));
          });
        },
        close: () => ws.close(),
      });
    ws.onerror = () => {};
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id);
        pending.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      }
    };
  });
}

async function evalDoc(ws, expr) {
  const r = await ws.send('Runtime.evaluate', {
    expression: `(() => { const f = document.querySelector('iframe'); const d = f && f.contentDocument; if (!d) return '__NO_DOC__'; const fn = ${expr}; return fn(d); })()`,
    returnByValue: true,
  });
  if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails.exception?.description || '').slice(0, 400));
  if (r.result.value === '__NO_DOC__') throw new Error('inner doc not ready');
  return r.result.value;
}

async function main() {
  // 打开视图(状态栏 DOM 点击,重试)
  const list0 = await (await fetch(`${BASE}/json/list`)).json();
  const pt = list0.find((x) => x.type === 'page' && x.url.includes('electron-browser'));
  const page = await connect(pt.webSocketDebuggerUrl);
  for (let i = 0; i < 10; i++) {
    const c = await page.send('Runtime.evaluate', {
      expression: `(() => { const els = [...document.querySelectorAll('.statusbar-item *')].filter(e => (e.textContent||'').includes('ZCode')); els.forEach(e => e.click()); return els.length; })()`,
      returnByValue: true,
    });
    if (c.result.value > 0) break;
    await sleep(1500);
  }
  await sleep(3000);

  // 找到我们的 webview(双层 iframe 内含 #chat)
  let wv = null;
  for (let i = 0; i < 30 && !wv; i++) {
    const l = await (await fetch(`${BASE}/json/list`)).json();
    for (const v of l.filter((x) => x.url.startsWith('vscode-webview://'))) {
      try {
        const ws = await connect(v.webSocketDebuggerUrl);
        const ok = await evalDoc(ws, `(d) => !!d.getElementById('chat')`);
        if (ok) { wv = ws; break; }
        ws.close();
      } catch {}
    }
    if (!wv) await sleep(1000);
  }
  if (!wv) throw new Error('zcode webview not found');
  console.log('WEBVIEW_CONNECTED');
  page.close();

  // 等协议连接就绪 + 会话自动恢复
  for (let i = 0; i < 30; i++) {
    const s = await evalDoc(wv, `(d) => (d.getElementById('conn')||{}).textContent || ''`);
    if (/已连接/.test(s)) { console.log('CONN:', s); break; }
    await sleep(1000);
  }

  const snapshot = () => evalDoc(wv, `(d) => ({
    conn: (d.getElementById('conn')||{}).textContent||'',
    title: (d.getElementById('title')||{}).textContent||'',
    mode: (d.getElementById('b-mode')||{}).textContent||'',
    msgs: d.querySelectorAll('.msg').length,
    toolcards: d.querySelectorAll('.toolcard').length,
    perms: d.querySelectorAll('.perm').length,
    lastText: (() => { const ms=[...d.querySelectorAll('.msg')]; const l=ms[ms.length-1]; return l ? (l.querySelector('.bubble')||{}).textContent||'' : ''; })(),
    btn: (d.getElementById('send')||{}).textContent||'',
    sessions: (d.getElementById('sessionpick')||{options:[]}).options.length,
  })`);

  let st = await snapshot();
  console.log('INITIAL', JSON.stringify(st));

  // 新会话,发"创建文件"触发权限流
  await evalDoc(wv, `(d) => { d.getElementById('btn-new').click(); return true; }`);
  await sleep(2000);
  await evalDoc(wv, `(d) => {
    d.getElementById('input').value = '创建文件 e2e-proof.txt,内容: protocol-native-ok';
    d.getElementById('send').click();
    return true;
  }`);
  console.log('SENT file-creation prompt');

  // 等权限卡出现并批准(allow_once / 或第一个 allow)
  let permHandled = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 120000) {
    st = await snapshot();
    if (st.perms > 0 && !permHandled) {
      const clicked = await evalDoc(wv, `(d) => {
        const card = d.querySelector('.perm');
        if (!card) return null;
        const btns = [...card.querySelectorAll('button[data-perm]')];
        const allow = btns.find(b => /allow|允许/i.test(b.textContent)) || btns[0];
        if (!allow) return null;
        allow.click();
        return allow.textContent;
      }`);
      if (clicked) { permHandled = true; console.log('PERM clicked:', clicked); }
    }
    if (permHandled && st.btn === '发送' && st.msgs >= 2 && /protocol-native-ok|创建|e2e/.test(st.lastText)) break;
    await sleep(2500);
  }
  st = await snapshot();
  console.log('AFTER_TURN', JSON.stringify(st));

  // 断言
  const fs = await (await import('node:fs')).promises;
  let fileOk = false;
  try { fileOk = (await fs.readFile('/tmp/zc-ext-test/ws/e2e-proof.txt', 'utf8')).trim() === 'protocol-native-ok'; } catch {}
  console.log('FILE_EXISTS_OK =', fileOk);
  console.log('PERM_FLOW_OK =', permHandled);
  const toolOk = (await evalDoc(wv, `(d) => d.querySelectorAll('.toolcard').length > 0`));
  console.log('TOOLCARD_OK =', toolOk);
  wv.close();

  const allOk = fileOk && permHandled && toolOk;
  console.log(allOk ? 'E2E_V2_PASS' : 'E2E_V2_INCOMPLETE');
  process.exit(allOk ? 0 : 2);
}

main().catch((e) => {
  console.error('FAIL', e.message);
  process.exit(1);
});
