import { escapeHtml, renderMarkdown } from './markdown.ts';
import { liveViewAction } from './liveView.ts';
import { composePrompt } from './compose.ts';

/* ---------- 宿主推送的状态类型(与 sessionController 对应) ---------- */

interface UIToolCall {
  toolCallId: string;
  toolName: string;
  status: 'scheduled' | 'running' | 'completed' | 'failed';
  input?: unknown;
  result?: unknown;
  error?: unknown;
  duration?: number;
  progress?: { elapsedMs?: number; stdoutTail?: string; stderrTail?: string };
  subagent?: boolean;
}
interface UIPart {
  kind: 'text' | 'reasoning' | 'tool' | 'patch' | 'meta';
  text?: string;
  call?: UIToolCall;
  files?: string[];
  label?: string;
}
interface UIMessage {
  id: string;
  role: string;
  parts: UIPart[];
}
interface UIPermissionOption { optionId: string; kind: string; name: string; description?: string; response: unknown }
interface UIPermission {
  key: string; requestId: string; toolName: string; reason: string;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  input?: unknown; options: UIPermissionOption[]; requestedAt: number;
}
interface UIUserInputQuestion {
  question: string; header?: string;
  options?: { value: string; label: string; description?: string }[]; multiSelect?: boolean;
}
interface UIUserInput { key: string; prompt?: string; questions: UIUserInputQuestion[]; interaction?: string }
interface UISessionSummary { sessionId: string; title: string; mode: string; status: string; updatedAt: number }
interface UISlashCommand { name: string; description?: string }
interface UIState {
  connection: 'connecting' | 'connected' | 'failed';
  connectionError?: string;
  sessions: UISessionSummary[];
  current: {
    sessionId: string | null; title: string; mode: string; modelLabel: string; status: string;
    contextUsed: number; contextWindow: number; messages: UIMessage[]; slashCommands: UISlashCommand[];
    live: { active: boolean; streamingText: string; reasoningText: string; toolCalls: UIToolCall[]; turnError?: string };
    pendingPermissions: UIPermission[];
    pendingUserInputs: UIUserInput[];
  };
}

declare const acquireVsCodeApi: () => { postMessage(m: unknown): void };
declare const window: Window & { __zcodeState?: UIState };

const vscode = acquireVsCodeApi();

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const chatEl = $('chat');
const historyEl = $('history');
const liveEl = $('livearea');
const interEl = $('interactions');
const inputEl = $('input') as HTMLTextAreaElement;
const sendBtn = $('send') as HTMLButtonElement;
const enhanceBtn = $('btn-enhance') as HTMLButtonElement;
const compactBtn = $('btn-compact') as HTMLButtonElement;
const titleEl = $('title');
const bMode = $('b-mode');
const bModel = $('b-model');
const ctxFill = $('ctxfill') as HTMLDivElement;
const connEl = $('conn');
const stRun = $('st-run');
const stCtx = $('st-ctx');
const chipsEl = $('chips');
const sessionPick = $('sessionpick') as HTMLSelectElement;
const popupEl = $('popup');

let running = false;
let attachChips: { label: string; path?: string }[] = [];
const permDiffs = new Map<string, string>();
const openDetails = new Set<string>();

/* ---------- 工具函数 ---------- */

const md = renderMarkdown;
function fileName(p: string): string {
  return p.split('/').pop() ?? p;
}
function extractPath(v: unknown): string | null {
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

/* ---------- 部件渲染 ---------- */

function toolCardHTML(call: UIToolCall): string {
  if (call.status === 'failed') {
    openDetails.add(call.toolCallId + ':out');
  }
  const statusText =
    call.status === 'running' ? `运行中 ${call.progress?.elapsedMs ? Math.round(call.progress.elapsedMs / 1000) + 's' : ''}` :
    call.status === 'scheduled' ? '排队中' :
    call.status === 'failed' ? '失败' :
    call.duration !== undefined ? `完成 ${(call.duration / 1000).toFixed(1)}s` : '完成';
  const badge = call.subagent ? ' <span class="meta">subagent</span>' : '';
  const previewJson = (v: unknown): string => {
    if (v === undefined || v === null) {
      return '';
    }
    const s = JSON.stringify(v, null, 1) ?? '';
    return s.length > 4000 ? s.slice(0, 4000) + '\n⋯(截断)' : s;
  };
  const inputJson = previewJson(call.input);
  const resultJson = call.result !== undefined ? previewJson(call.result) : previewJson(call.error);
  const filePath = extractPath(call.input) ?? extractPath(call.result);
  const fileLink = filePath
    ? `<div><span class="pfile" data-file="${escapeHtml(filePath)}">📄 ${escapeHtml(fileName(filePath))} — 打开</span></div>`
    : '';
  return `<div class="toolcard">
    <div class="trow"><span class="toolname">${escapeHtml(call.toolName)}</span>${badge}
      <span class="tstat ${call.status}">${statusText}</span></div>
    ${fileLink}
    ${inputJson ? `<details data-dkey="${escapeHtml(call.toolCallId)}:in"><summary>输入</summary><pre>${escapeHtml(inputJson)}</pre></details>` : ''}
    ${resultJson ? `<details data-dkey="${escapeHtml(call.toolCallId)}:out"><summary>${call.status === 'failed' ? '错误' : '结果'}</summary><pre>${escapeHtml(resultJson)}</pre></details>` : ''}
  </div>`;
}

function partHTML(p: UIPart): string {
  switch (p.kind) {
    case 'text':
      return md(p.text ?? '');
    case 'reasoning':
      return `<div class="reasoning">${escapeHtml(p.text ?? '')}</div>`;
    case 'tool':
      return p.call ? toolCardHTML(p.call) : '';
    case 'patch':
      return `<div class="patch">改动文件:${(p.files ?? []).map((f) => `<span class="pfile" data-file="${escapeHtml(f)}">${escapeHtml(fileName(f))}</span>`).join(' ')}<button class="sec" style="padding:0 6px;margin-left:6px" data-openfile="${escapeHtml(p.files?.[0] ?? '')}">查看 diff</button></div>`;
    case 'meta':
      return `<div class="meta">${escapeHtml(p.label ?? '')}</div>`;
    default:
      return '';
  }
}

function messageHTML(m: UIMessage): string {
  const who = m.role === 'user' ? '你' : 'ZCode';
  const body = m.parts.map(partHTML).join('');
  const rewindBtn =
    m.role === 'user' && !m.id.startsWith('local-')
      ? `<button class="rewindbtn" data-rewind="${escapeHtml(m.id)}" title="回退到这条消息之前">↺</button>`
      : '';
  return `<div class="msg ${m.role === 'user' ? 'user' : 'assistant'}">
    <div class="who">${who}${rewindBtn}</div>
    <div class="bubble">${body || '<span class="meta">(空)</span>'}</div>
  </div>`;
}

function permissionHTML(p: UIPermission): string {
  const inputJson = p.input ? JSON.stringify(p.input, null, 1).slice(0, 1500) : '';
  const opts = p.options
    .map((o) => `<button data-perm="${escapeHtml(p.key)}" data-opt="${escapeHtml(o.optionId)}"
      title="${escapeHtml(o.description ?? '')}">${escapeHtml(o.name)}</button>`)
    .join('');
  const diff = permDiffs.get(p.key);
  const diffHtml = diff
    ? `<details data-dkey="permdiff:${escapeHtml(p.key)}" class="permdiff"><summary>预览改动</summary><pre class="diffview">${diff
        .split('\n')
        .map((l) => (l.startsWith('+') ? `<span class="dadd">${escapeHtml(l)}</span>` : l.startsWith('-') ? `<span class="ddel">${escapeHtml(l)}</span>` : escapeHtml(l)))
        .join('\n')}</pre></details>`
    : '';
  return `<div class="perm risk-${p.riskLevel}">
    <span class="ptool">${escapeHtml(p.toolName)}</span>
    <span class="meta"> · 风险:${p.riskLevel}</span>
    <div class="preason">${escapeHtml(p.reason)}</div>
    ${diffHtml}
    ${inputJson ? `<details data-dkey="permin:${escapeHtml(p.key)}"><summary>原始输入</summary><div class="pinput">${escapeHtml(inputJson)}</div></details>` : ''}
    <div class="popts">${opts}<button class="sec" data-dismiss="${escapeHtml(p.key)}">忽略</button></div>
  </div>`;
}

function userInputHTML(u: UIUserInput): string {
  const questions = u.questions.map((q) => {
    const opts = q.options?.length
      ? q.options.map((o) => `<label class="opt"><input type="radio" name="q-${escapeHtml(u.key)}"
            value="${escapeHtml(o.value)}"> ${escapeHtml(o.label)}${o.description ? ` <span class="meta">${escapeHtml(o.description)}</span>` : ''}</label>`).join('')
      : '';
    return `<div class="q">${escapeHtml(q.question)}</div>${opts}`;
  }).join('');
  return `<div class="uinput">
    ${u.interaction === 'plan_approval' ? '<div class="q">📋 计划审批</div>' : ''}
    ${u.prompt ? `<div class="q">${escapeHtml(u.prompt)}</div>` : ''}
    ${questions}
    <div style="margin-top:6px">
      <button data-uinput="${escapeHtml(u.key)}" data-action="accept">确认</button>
      <button class="sec" data-uinput="${escapeHtml(u.key)}" data-action="decline">拒绝</button>
    </div>
  </div>`;
}

function failedPanelHTML(state: UIState): string {
  if (state.connection !== 'failed') {
    return '';
  }
  return `<div class="failpanel">
    <div style="font-weight:600">⚠ ZCode 连接失败</div>
    <div class="meta" style="margin-top:4px;white-space:pre-wrap">${escapeHtml(state.connectionError ?? '未知错误')}</div>
    <div class="fbtns">
      <button data-fail="doctor">运行诊断</button>
      <button class="sec" data-fail="settings">打开设置</button>
      <button class="sec" data-fail="retry">重试</button>
    </div>
  </div>`;
}

/* ---------- 分层渲染(指纹跳过,历史区不再随流式闪烁) ---------- */

let historyFp = '';
let interFp = '';
let sessionPickFp = '';

function renderHistory(state: UIState): void {
  const msgs = state.current.messages;
  const fp = `${state.current.sessionId}|${msgs.length}|${msgs.map((m) => m.parts.length).join(',')}|${msgs[msgs.length - 1]?.id ?? ''}`;
  if (fp === historyFp) {
    return;
  }
  historyFp = fp;
  if (!msgs.length) {
    historyEl.innerHTML = '<div class="empty"><div class="logo">Z</div>ZCode 就绪<br>输入问题开始对话(@ 引用文件)</div>';
    return;
  }
  historyEl.innerHTML = msgs.map(messageHTML).join('');
  applyOpenDetails(historyEl);
  scrollBottom();
}

function renderLive(state: UIState): void {
  const live = state.current.live;
  const action = liveViewAction(live);
  if (action === 'clear') {
    if (liveEl.innerHTML !== '') {
      liveEl.innerHTML = '';
    }
    return;
  }
  if (action === 'error') {
    // turn 失败:错误面板驻留到下一轮开始/会话切换(turnError 由 controller 清除)
    liveEl.innerHTML = `<div class="perm risk-critical"><span class="ptool">出错</span><div class="preason">${escapeHtml(live.turnError ?? '')}</div></div>`;
    return;
  }
  let body = '';
  if (live.reasoningText) {
    body += `<div class="reasoning">${escapeHtml(live.reasoningText.slice(-2000))}</div>`;
  }
  for (const tc of live.toolCalls) {
    body += toolCardHTML(tc);
  }
  if (live.streamingText) {
    body += md(live.streamingText) + '<span class="cursor"></span>';
  } else if (!live.toolCalls.length) {
    body += '<span class="cursor"></span>';
  }
  liveEl.innerHTML = `<div class="msg assistant"><div class="who">ZCode</div><div class="bubble">${body}</div></div>`;
  applyOpenDetails(liveEl);
  scrollBottom();
}

function renderInteractions(state: UIState): void {
  const fp = [
    state.connection,
    state.connectionError ?? '',
    ...state.current.pendingPermissions.map((p) => p.key + permDiffs.has(p.key)),
    ...state.current.pendingUserInputs.map((u) => u.key),
  ].join('|');
  if (fp === interFp) {
    return;
  }
  interFp = fp;
  const parts: string[] = [failedPanelHTML(state)];
  for (const p of state.current.pendingPermissions) {
    parts.push(permissionHTML(p));
  }
  for (const u of state.current.pendingUserInputs) {
    parts.push(userInputHTML(u));
  }
  interEl.innerHTML = parts.join('');
  applyOpenDetails(interEl);
  if (parts.length) {
    scrollBottom();
  }
}

function applyOpenDetails(root: HTMLElement): void {
  root.querySelectorAll('details[data-dkey]').forEach((el) => {
    if (openDetails.has((el as HTMLElement).dataset.dkey ?? '')) {
      (el as HTMLDetailsElement).open = true;
    }
  });
}

function render(state: UIState): void {
  running = state.current.live.active;
  window.__zcodeState = state;

  titleEl.textContent = state.current.title || 'ZCode';
  bMode.textContent = state.current.mode || '--';
  bModel.textContent = state.current.modelLabel ? fileName(state.current.modelLabel) : '--';
  const pct = state.current.contextWindow > 0 ? Math.min(100, Math.round((state.current.contextUsed / state.current.contextWindow) * 100)) : 0;
  ctxFill.style.width = pct + '%';
  ctxFill.style.background = pct > 85 ? 'var(--vscode-errorForeground,#f66)' : pct > 60 ? 'var(--vscode-charts-yellow,#cca700)' : 'var(--vscode-charts-green,#89d185)';
  connEl.textContent = state.connection === 'connected' ? (state.current.status === 'running' ? '运行中…' : '已连接 · ' + (state.current.sessionId ? '会话 ' + state.current.sessionId.slice(5, 13) : '无会话')) : state.connection === 'connecting' ? '连接中…' : (state.connectionError ?? '连接失败');
  connEl.className = 'conn' + (state.connection === 'failed' ? ' err' : '');
  stRun.textContent = running ? '⏳ 运行中(Enter 追加指令,停止按钮中断)' : '';
  stCtx.textContent = state.current.contextWindow > 0 ? `${(state.current.contextUsed / 1000).toFixed(1)}k / ${(state.current.contextWindow / 1000).toFixed(0)}k` : '';
  compactBtn.style.display = pct >= 60 && state.current.sessionId ? '' : 'none';

  sendBtn.textContent = running ? '停止' : '发送';
  sendBtn.className = running ? 'sec' : '';

  const cur = state.current.sessionId;
  const pickFp = `${cur}|${state.sessions.map((s) => s.sessionId + '\t' + s.title + '\t' + s.updatedAt).join('|')}`;
  if (document.activeElement !== sessionPick && pickFp !== sessionPickFp) {
    sessionPickFp = pickFp;
    sessionPick.innerHTML = '<option value="">— 会话列表 —</option>' +
      state.sessions.map((s) => `<option value="${escapeHtml(s.sessionId)}"${s.sessionId === cur ? ' selected' : ''}>${escapeHtml(s.title.slice(0, 28))} · ${s.mode}</option>`).join('');
  }

  renderHistory(state);
  renderLive(state);
  renderInteractions(state);
}

let stickBottom = true;
function scrollBottom(): void {
  if (stickBottom) {
    chatEl.scrollTop = chatEl.scrollHeight;
  }
}
chatEl.addEventListener('scroll', () => {
  stickBottom = chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 40;
});

/* ---------- 发送 / 停止 / steer ---------- */

function sendOrStop(): void {
  const text = inputEl.value.trim();
  if (running) {
    if (text) {
      vscode.postMessage({ t: 'steer', content: text });
      inputEl.value = '';
    } else {
      vscode.postMessage({ t: 'stop' });
    }
    return;
  }
  if (!text) {
    return;
  }
  const content = composePrompt(text, attachChips);
  inputEl.value = '';
  closePopup();
  vscode.postMessage({ t: 'send', content });
}

sendBtn.addEventListener('click', sendOrStop);
inputEl.addEventListener('keydown', (e) => {
  // IME 组合输入中(选字/确认候选词)不拦截 Enter,否则中文输入法选字即发送
  if (e.isComposing || e.keyCode === 229) {
    return;
  }
  if (popupOpen && ['ArrowDown', 'ArrowUp', 'Enter', 'Escape', 'Tab'].includes(e.key)) {
    e.preventDefault();
    popupKey(e.key);
    return;
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendOrStop();
  }
});

/* ---------- @ 文件 / 斜杠命令 补全 ---------- */

let popupOpen = false;
let popupMode: 'file' | 'slash' | null = null;
let popupItems: { label: string; detail?: string; insert: string; kind: string }[] = [];
let popupSel = 0;
let popupAnchorStart = 0; // 触发词(@或/)在输入框中的起点

function closePopup(): void {
  popupOpen = false;
  popupMode = null;
  popupEl.style.display = 'none';
  popupEl.innerHTML = '';
}

function showPopup(items: { label: string; detail?: string; insert: string; kind: string }[]): void {
  if (!items.length) {
    closePopup();
    return;
  }
  popupItems = items;
  popupSel = 0;
  popupOpen = true;
  popupEl.style.display = '';
  renderPopup();
}

function renderPopup(): void {
  popupEl.innerHTML = popupItems
    .map((it, i) => `<div class="pitem${i === popupSel ? ' sel' : ''}" data-pidx="${i}">
      <span class="plabel">${escapeHtml(it.kind === 'file' ? '📄 ' + it.label : '/' + it.label)}</span>
      ${it.detail ? `<span class="pdetail">${escapeHtml(it.detail.slice(0, 40))}</span>` : ''}
    </div>`)
    .join('');
}

function popupKey(key: string): void {
  if (key === 'ArrowDown') {
    popupSel = (popupSel + 1) % popupItems.length;
    renderPopup();
  } else if (key === 'ArrowUp') {
    popupSel = (popupSel - 1 + popupItems.length) % popupItems.length;
    renderPopup();
  } else if (key === 'Enter' || key === 'Tab') {
    pickPopupItem(popupSel);
  } else if (key === 'Escape') {
    closePopup();
  }
}

function pickPopupItem(idx: number): void {
  const it = popupItems[idx];
  if (!it) {
    closePopup();
    return;
  }
  const pos = inputEl.selectionStart;
  if (it.kind === 'file') {
    // 删除 @query,文件转为 chip
    inputEl.value = inputEl.value.slice(0, popupAnchorStart) + inputEl.value.slice(pos);
    attachChips.push({ label: it.label.split('/').pop() ?? it.label, path: it.insert });
    renderChips();
  } else {
    inputEl.value = '/' + it.insert + ' ' + inputEl.value.slice(pos);
  }
  closePopup();
  inputEl.focus();
  const p = it.kind === 'file' ? popupAnchorStart : it.insert.length + 2;
  inputEl.selectionStart = inputEl.selectionEnd = p;
}

function renderChips(): void {
  chipsEl.innerHTML = attachChips
    .map((c) => `<span class="chip" title="${escapeHtml(c.path ?? c.label)}">📎 ${escapeHtml(c.label)}${c.path ? '' : '(仅引用)'}</span>`)
    .join('');
  chipsEl.querySelectorAll('.chip').forEach((el) => el.addEventListener('click', () => vscode.postMessage({ t: 'removeAttach' })));
}

inputEl.addEventListener('input', () => {
  const pos = inputEl.selectionStart;
  const before = inputEl.value.slice(0, pos);
  const at = before.match(/(?:^|\s)@([\w\-./]*)$/);
  const slash = before.match(/^\/(\w*)$/);
  if (at) {
    popupMode = 'file';
    popupAnchorStart = before.lastIndexOf('@');
    popupOpen = true;
    popupEl.style.display = '';
    popupEl.innerHTML = '<div class="pitem">🔍 搜索文件…</div>';
    vscode.postMessage({ t: 'suggestFiles', query: at[1] });
  } else if (slash && window.__zcodeState) {
    const cmds = (window.__zcodeState.current.slashCommands || [])
      .filter((c) => c.name.startsWith(slash[1]))
      .slice(0, 12)
      .map((c) => ({ label: c.name, detail: c.description, insert: c.name, kind: 'slash' }));
    popupMode = 'slash';
    popupAnchorStart = 0;
    showPopup(cmds);
  } else if (popupOpen) {
    closePopup();
  }
});

popupEl.addEventListener('click', (e) => {
  const item = (e.target as HTMLElement).closest('.pitem') as HTMLElement | null;
  if (item?.dataset.pidx !== undefined) {
    pickPopupItem(Number(item.dataset.pidx));
  }
});

/* ---------- 其余按钮 ---------- */

enhanceBtn.addEventListener('click', () => {
  const text = inputEl.value.trim();
  if (!text) {
    return;
  }
  enhanceBtn.disabled = true;
  vscode.postMessage({ t: 'enhance', text });
});

compactBtn.addEventListener('click', () => vscode.postMessage({ t: 'compact' }));
bMode.addEventListener('click', () => vscode.postMessage({ t: 'pickMode' }));
bModel.addEventListener('click', () => vscode.postMessage({ t: 'pickModel' }));
$('btn-new').addEventListener('click', () => vscode.postMessage({ t: 'newSession' }));
$('btn-fork').addEventListener('click', () => vscode.postMessage({ t: 'fork' }));
$('btn-rewind').addEventListener('click', () => vscode.postMessage({ t: 'rewind' }));
sessionPick.addEventListener('change', () => {
  if (sessionPick.value) {
    vscode.postMessage({ t: 'openSession', sessionId: sessionPick.value });
  }
});

document.addEventListener(
  'toggle',
  (e) => {
    const el = e.target as HTMLElement;
    const key = el?.dataset?.dkey;
    if (!key) {
      return;
    }
    if ((el as HTMLDetailsElement).open) {
      openDetails.add(key);
    } else {
      openDetails.delete(key);
    }
  },
  true
);

document.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const fail = t.dataset.fail;
  if (fail) {
    vscode.postMessage({ t: fail === 'doctor' ? 'doctor' : fail === 'settings' ? 'openSettings' : 'retry' });
    return;
  }
  const rewind = t.dataset.rewind;
  if (rewind !== undefined && rewind) {
    vscode.postMessage({ t: 'rewindTo', messageId: rewind });
    return;
  }
  const perm = t.dataset.perm;
  if (perm !== undefined && t.dataset.opt) {
    vscode.postMessage({ t: 'answerPermission', key: perm, optionId: t.dataset.opt });
    return;
  }
  const dismiss = t.dataset.dismiss;
  if (dismiss !== undefined) {
    vscode.postMessage({ t: 'dismissPermission', key: dismiss });
    return;
  }
  const uinput = t.dataset.uinput;
  if (uinput !== undefined) {
    const selected = document.querySelector(`input[name="q-${CSS.escape(uinput)}"]:checked`) as HTMLInputElement | null;
    vscode.postMessage({ t: 'answerUserInput', key: uinput, action: t.dataset.action === 'decline' ? 'decline' : 'accept', value: selected?.value });
    return;
  }
  const file = t.dataset.file;
  const openFile = t.dataset.openfile || file || undefined;
  if (openFile) {
    vscode.postMessage({ t: 'openFile', path: openFile });
  }
});

/* ---------- 宿主消息 ---------- */

window.addEventListener('message', (e: MessageEvent) => {
  const m = e.data as {
    t: string; state?: UIState; text?: string; label?: string; path?: string; clear?: boolean;
    key?: string; diff?: string; query?: string; items?: { label: string; detail: string }[];
  };
  if (!m || typeof m !== 'object') {
    return;
  }
  switch (m.t) {
    case 'state':
      if (m.state) {
        render(m.state);
      }
      break;
    case 'prefill':
      if (m.text) {
        inputEl.value += m.text;
        inputEl.focus();
        inputEl.selectionStart = inputEl.selectionEnd = inputEl.value.length;
      }
      break;
    case 'replaceInput':
      if (typeof m.text === 'string') {
        inputEl.value = m.text;
        enhanceBtn.disabled = false;
        inputEl.focus();
        inputEl.selectionStart = inputEl.selectionEnd = inputEl.value.length;
      }
      break;
    case 'suggestFilesResult':
      if (popupOpen && popupMode === 'file') {
        showPopup((m.items ?? []).map((it) => ({ label: it.label, detail: it.detail, insert: it.detail, kind: 'file' })));
      }
      break;
    case 'attachChip':
      if (m.clear) {
        attachChips = [];
      } else if (m.label) {
        attachChips.push({ label: m.label, path: m.path });
      }
      renderChips();
      break;
    case 'permDiff':
      if (m.key !== undefined) {
        permDiffs.set(m.key, m.diff ?? '');
        interFp = ''; // 强制重渲染交互区
        if (window.__zcodeState) {
          renderInteractions(window.__zcodeState);
        }
      }
      break;
  }
});

vscode.postMessage({ t: 'ready' });
