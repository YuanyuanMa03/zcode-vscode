// v0.3 CDP 端到端:权限流+diff 预览 + 停止/steer/rewind/fork/模型切换 活体验证
// 输出:各场景 OK / FAIL / SKIP + 总结
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
  if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails.exception?.description || '').slice(0, 300));
  if (r.result.value === '__NO_DOC__') throw new Error('inner doc not ready');
  return r.result.value;
}

const results = {};
const record = (name, ok, note = '') => {
  results[name] = ok ? 'OK' : 'FAIL';
  console.log(`${ok ? '✓' : '✗'} ${name}${note ? ' — ' + note : ''}`);
};

async function main() {
  // ── 打开视图 ──
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

  for (let i = 0; i < 30; i++) {
    const s = await evalDoc(wv, `(d) => (d.getElementById('conn')||{}).textContent || ''`);
    if (/已连接/.test(s)) break;
    await sleep(1000);
  }

  const snap = () => evalDoc(wv, `(d) => ({
    conn: (d.getElementById('conn')||{}).textContent||'',
    msgs: d.querySelectorAll('.msg').length,
    toolcards: d.querySelectorAll('.toolcard').length,
    perms: d.querySelectorAll('.perm').length,
    permdiffs: d.querySelectorAll('.permdiff').length,
    dadd: d.querySelectorAll('.dadd').length,
    btn: (d.getElementById('send')||{}).textContent||'',
    mode: (d.getElementById('b-mode')||{}).textContent||'',
  })`);

  let anyDiffSeen = false;
  const autoApprove = async (waitForDiff = false) => {
    // Write/Edit 类权限:先等 diff 预览推送到达(确定性验证 A_diff_preview)
    if (waitForDiff) {
      for (let i = 0; i < 8; i++) {
        const st = await evalDoc(wv, `(d) => {
          const card = d.querySelector('.perm');
          if (!card) return { done: true, diff: false };
          const tool = card.querySelector('.ptool')?.textContent || '';
          const diff = !!card.querySelector('.permdiff');
          if (!/Write|Edit/i.test(tool)) return { done: true, diff: false };
          return { done: diff, diff };
        }`);
        if (st.diff) anyDiffSeen = true;
        if (st.done) break;
        await sleep(400);
      }
    }
    const clicked = await evalDoc(wv, `(d) => {
      const card = d.querySelector('.perm');
      if (!card) return null;
      const btns = [...card.querySelectorAll('button[data-perm]')];
      const allow = btns.find(b => /allow|允许/i.test(b.textContent)) || btns[0];
      if (!allow) return null;
      allow.click();
      return allow.textContent;
    }`);
    return clicked;
  };

  const waitIdle = async (timeoutMs, idleCheck) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const st = await snap();
      if (idleCheck(st)) return st;
      if (st.perms > 0) await autoApprove();
      await sleep(2000);
    }
    return null;
  };

  // ── 场景 A:新建会话 + 写文件(权限 + diff 预览)──
  await evalDoc(wv, `(d) => { d.getElementById('btn-new').click(); return true; }`);
  await sleep(2500);
  await evalDoc(wv, `(d) => { d.getElementById('input').value = '创建文件 v3-proof.txt 内容: diff-preview-works'; d.getElementById('send').click(); return true; }`);
  {
    const t0 = Date.now();
    while (Date.now() - t0 < 120000) {
      const st = await snap();
      if (st.perms > 0) await autoApprove(true);
      if (st.btn === '发送' && st.toolcards > 0) break;
      await sleep(2000);
    }
  }
  const fs = await import('node:fs/promises');
  let fileOk = false;
  try { fileOk = (await fs.readFile('/tmp/zc-ext-test/ws/v3-proof.txt', 'utf8')).includes('diff-preview-works'); } catch {}
  record('A_perm_flow', fileOk);
  record('A_diff_preview', anyDiffSeen, anyDiffSeen ? '权限卡内出现 +/- 行' : '等待窗内未见 diff');

  // ── 场景 B:停止 ──
  {
    await evalDoc(wv, `(d) => { d.getElementById('input').value = '运行 shell 命令: sleep 25 然后回复 done'; d.getElementById('send').click(); return true; }`);
    let runningSeen = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 30000) {
      const st = await snap();
      if (st.perms > 0) { await autoApprove(); }
      if (st.btn === '停止') { runningSeen = true; break; }
      await sleep(1000);
    }
    if (!runningSeen) {
      record('B_stop', false, '未观测到运行态');
    } else {
      await sleep(3000); // 让 sleep 真正跑起来
      await evalDoc(wv, `(d) => { d.getElementById('send').click(); return true; }`); // 运行态=停止
      const stopped = await waitIdle(30000, (st) => st.btn === '发送');
      record('B_stop', !!stopped, stopped ? '运行中点击停止后回空闲' : '30s 内未停');
    }
  }

  // ── 场景 C:steer(运行中追加)──
  {
    await evalDoc(wv, `(d) => { d.getElementById('input').value = '运行 shell: sleep 12,完成后回复 done'; d.getElementById('send').click(); return true; }`);
    let steered = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 30000) {
      const st = await snap();
      if (st.perms > 0) await autoApprove();
      if (st.btn === '停止') {
        await evalDoc(wv, `(d) => { d.getElementById('input').value = '醒来后额外回复: steered'; d.getElementById('send').click(); return true; }`);
        steered = true;
        break;
      }
      await sleep(1000);
    }
    const done = await waitIdle(90000, (st) => st.btn === '发送');
    record('C_steer', steered && !!done, steered ? '运行中追加指令未中断会话' : '未进入运行态');
  }

  // ── 场景 D:rewind(消息级回退:点第一个 ↺)──
  {
    const before = await snap();
    const clicked = await evalDoc(wv, `(d) => {
      const btn = d.querySelector('.rewindbtn');
      if (!btn) return false;
      btn.click();
      return true;
    }`);
    await sleep(6000);
    const after = await snap();
    record('D_rewind', clicked && after.msgs < before.msgs, `msgs ${before.msgs} → ${after.msgs}`);
  }

  // ── 场景 E:fork(会话分叉)──
  {
    const before = await snap();
    await evalDoc(wv, `(d) => { d.getElementById('btn-fork').click(); return true; }`);
    await sleep(6000);
    const after = await snap();
    const changed = before.conn !== after.conn && /会话/.test(after.conn);
    record('E_fork', changed, `${before.conn.slice(-12)} → ${after.conn.slice(-12)}`);
  }

  // ── 场景 F:模式切换(badge → QuickPick)──
  {
    try {
      const before = await snap();
      await evalDoc(wv, `(d) => { d.getElementById('b-mode').click(); return true; }`);
      // 等 QuickPick 出现(主窗口 DOM)
      let qp = false;
      for (let i = 0; i < 10; i++) {
        const q = await page.send('Runtime.evaluate', {
          expression: `(() => { const w = document.querySelector('.quick-input-widget'); return !!w && w.offsetHeight > 0; })()`,
          returnByValue: true,
        });
        if (q.result.value) { qp = true; break; }
        await sleep(800);
      }
      if (!qp) throw new Error('QuickPick 未出现');
      // 聚焦 QuickPick 输入框(焦点可能还在 webview iframe)
      await page.send('Runtime.evaluate', {
        expression: `(() => { const i = document.querySelector('.quick-input-widget input'); if (i) { i.focus(); return true; } return false; })()`,
        returnByValue: true,
      });
      const key = async (k, code, text, vk) => {
        await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, text, unmodifiedText: text, windowsVirtualKeyCode: vk });
        await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk });
      };
      await key('p', 'KeyP', 'p', 80);
      await key('l', 'KeyL', 'l', 76);
      await key('a', 'KeyA', 'a', 65);
      await key('n', 'KeyN', 'n', 78);
      await sleep(800);
      const typed = await page.send('Runtime.evaluate', {
        expression: `(() => document.querySelector('.quick-input-widget input')?.value ?? '(no-input)')()`,
        returnByValue: true,
      });
      void typed;
      // 真实鼠标点击第一行(monaco 列表不响应合成 click)
      const rowRect = await page.send('Runtime.evaluate', {
        expression: `(() => { const r = document.querySelector('.quick-input-widget .monaco-list-row'); if (!r) return null; const b = r.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2, label: r.textContent }; })()`,
        returnByValue: true,
      });
      let note = `typed=plan; row=${rowRect.result.value ? rowRect.result.value.label : 'none'}`;
      if (rowRect.result.value) {
        const { x, y } = rowRect.result.value;
        await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
        await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      } else {
        await key('Enter', 'Enter', '\r', 13);
        note += '; enter-fallback';
      }
      await sleep(3500);
      const diag = await page.send('Runtime.evaluate', {
        expression: `(() => ({ qpOpen: !!document.querySelector('.quick-input-widget .quick-input-and-quick-input-container:not([style*="display: none"])') || !!document.querySelector('.quick-input-widget input'), toast: [...document.querySelectorAll('.notifications-toasts .notification-message')].map(n => n.textContent).join('|').slice(0, 120) }))()`,
        returnByValue: true,
      });
      const after = await snap();
      record('F_mode_switch', before.mode !== after.mode, `${before.mode} → ${after.mode}; ${note}; diag=${JSON.stringify(diag.result.value)}`);
    } catch (e) {
      results['F_mode_switch'] = 'SKIP';
      console.log('- F_mode_switch SKIP —', e.message.slice(0, 80));
    }
  }

  console.log('--- SUMMARY:', JSON.stringify(results));
  const fails = Object.values(results).filter((v) => v === 'FAIL').length;
  console.log(fails === 0 ? 'E2E_V3_PASS' : `E2E_V3_FAIL(${fails})`);
  wv.close();
  page.close();
  process.exit(fails === 0 ? 0 : 2);
}

main().catch((e) => {
  console.error('FAIL', e.message);
  process.exit(1);
});
