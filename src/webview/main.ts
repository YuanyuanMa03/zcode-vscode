import { marked } from 'marked';

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
interface UIState {
  connection: 'connecting' | 'connected' | 'failed';
  connectionError?: string;
  sessions: UISessionSummary[];
  current: {
    sessionId: string | null; title: string; mode: string; modelLabel: string; status: string;
    contextUsed: number; contextWindow: number; messages: UIMessage[];
    live: { active: boolean; streamingText: string; reasoningText: string; toolCalls: UIToolCall[]; turnError?: string };
    pendingPermissions: UIPermission[];
    pendingUserInputs: UIUserInput[];
  };
}

declare const acquireVsCodeApi: () => { postMessage(m: unknown): void };

const vscode = acquireVsCodeApi();
marked.setOptions({ gfm: true, breaks: true });

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const chatEl = $('chat');
const inputEl = $('input') as HTMLTextAreaElement;
const sendBtn = $('send') as HTMLButtonElement;
const titleEl = $('title');
const bMode = $('b-mode');
const bModel = $('b-model');
const ctxFill = $('ctxfill') as HTMLDivElement;
const connEl = $('conn');
const stRun = $('st-run');
const stCtx = $('st-ctx');
const chipsEl = $('chips');
const sessionPick = $('sessionpick') as HTMLSelectElement;

let running = false;
let attachChips: string[] = [];

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function md(s: string): string {
  try {
    return marked.parse(escapeHtml(s)) as string;
  } catch {
    return `<p>${escapeHtml(s)}</p>`;
  }
}
function fileName(p: string): string {
  return p.split('/').pop() ?? p;
}

/* ---------- 部件渲染 ---------- */

function toolCardHTML(call: UIToolCall): string {
  const statusText =
    call.status === 'running' ? `运行中 ${call.progress?.elapsedMs ? Math.round(call.progress.elapsedMs / 1000) + 's' : ''}` :
    call.status === 'scheduled' ? '排队中' :
    call.status === 'failed' ? '失败' :
    call.duration !== undefined ? `完成 ${(call.duration / 1000).toFixed(1)}s` : '完成';
  const badge = call.subagent ? ' <span class="meta">subagent</span>' : '';
  const inputJson = call.input ? JSON.stringify(call.input, null, 1) : '';
  const resultJson = call.result !== undefined ? JSON.stringify(call.result, null, 1).slice(0, 4000) :
    call.error !== undefined ? JSON.stringify(call.error, null, 1).slice(0, 4000) : '';
  const filePath = extractPath(call.input) ?? extractPath(call.result);
  const fileLink = filePath
    ? `<div><span class="pfile" data-file="${escapeHtml(filePath)}">📄 ${escapeHtml(fileName(filePath))} — 打开</span></div>`
    : '';
  return `<div class="toolcard">
    <div class="trow"><span class="toolname">${escapeHtml(call.toolName)}</span>${badge}
      <span class="tstat ${call.status}">${statusText}</span></div>
    ${fileLink}
    ${inputJson ? `<details><summary>输入</summary><pre>${escapeHtml(inputJson)}</pre></details>` : ''}
    ${resultJson ? `<details${call.status === 'failed' ? ' open' : ''}><summary>${call.status === 'failed' ? '错误' : '结果'}</summary><pre>${escapeHtml(resultJson)}</pre></details>` : ''}
  </div>`;
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
  return `<div class="msg ${m.role === 'user' ? 'user' : 'assistant'}">
    <div class="who">${who}</div>
    <div class="bubble">${body || '<span class="meta">(空)</span>'}</div>
  </div>`;
}

function permissionHTML(p: UIPermission): string {
  const inputJson = p.input ? JSON.stringify(p.input, null, 1).slice(0, 1500) : '';
  const opts = p.options
    .map((o) => `<button data-perm="${escapeHtml(p.key)}" data-opt="${escapeHtml(o.optionId)}"
      title="${escapeHtml(o.description ?? '')}">${escapeHtml(o.name)}</button>`)
    .join('');
  return `<div class="perm risk-${p.riskLevel}">
    <span class="ptool">${escapeHtml(p.toolName)}</span>
    <span class="meta"> · 风险:${p.riskLevel}</span>
    <div class="preason">${escapeHtml(p.reason)}</div>
    ${inputJson ? `<div class="pinput">${escapeHtml(inputJson)}</div>` : ''}
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

/* ---------- 全量渲染 ---------- */

function render(state: UIState): void {
  running = state.current.live.active;

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

  sendBtn.textContent = running ? '停止' : '发送';
  sendBtn.className = running ? 'sec' : '';

  // 会话下拉
  const cur = state.current.sessionId;
  if (document.activeElement !== sessionPick) {
    sessionPick.innerHTML = '<option value="">— 会话列表 —</option>' +
      state.sessions.map((s) => `<option value="${escapeHtml(s.sessionId)}"${s.sessionId === cur ? ' selected' : ''}>${escapeHtml(s.title.slice(0, 28))} · ${s.mode}</option>`).join('');
  }

  // 消息区(权威消息 + live 层)
  const parts: string[] = [];
  if (!state.current.messages.length && !state.current.live.active && !state.current.pendingPermissions.length) {
    parts.push('<div class="empty"><div class="logo">Z</div>ZCode 就绪<br>输入问题开始对话</div>');
  }
  for (const m of state.current.messages) {
    parts.push(messageHTML(m));
  }
  const live = state.current.live;
  if (live.active) {
    let liveBody = '';
    if (live.reasoningText) {
      liveBody += `<div class="reasoning">${escapeHtml(live.reasoningText.slice(-2000))}</div>`;
    }
    for (const tc of live.toolCalls) {
      liveBody += toolCardHTML(tc);
    }
    if (live.streamingText) {
      liveBody += md(live.streamingText) + '<span class="cursor"></span>';
    } else if (!live.toolCalls.length) {
      liveBody += '<span class="cursor"></span>';
    }
    parts.push(`<div class="msg assistant"><div class="who">ZCode</div><div class="bubble">${liveBody}</div></div>`);
  }
  if (live.turnError) {
    parts.push(`<div class="perm risk-critical"><span class="ptool">出错</span><div class="preason">${escapeHtml(live.turnError)}</div></div>`);
  }
  for (const p of state.current.pendingPermissions) {
    parts.push(permissionHTML(p));
  }
  for (const u of state.current.pendingUserInputs) {
    parts.push(userInputHTML(u));
  }
  chatEl.innerHTML = parts.join('');
  scrollBottom();
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

/* ---------- 事件 ---------- */

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
  let content = text;
  if (attachChips.length) {
    content = `参考以下上下文:\n${attachChips.map((c) => `- ${c}`).join('\n')}\n\n${text}`;
  }
  inputEl.value = '';
  vscode.postMessage({ t: 'send', content });
}

sendBtn.addEventListener('click', sendOrStop);
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendOrStop();
  }
});

document.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
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
  const file = t.dataset.file ?? (t.classList.contains('pfile') ? t.textContent && t.dataset.file ? t.dataset.file : undefined : undefined);
  const openFile = t.dataset.openfile || file;
  if (openFile) {
    vscode.postMessage({ t: 'openFile', path: openFile });
  }
});

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

/* ---------- 宿主消息 ---------- */

declare const window: Window & { __zcodeState?: UIState };
window.addEventListener('message', (e: MessageEvent) => {
  const m = e.data as { t: string; state?: UIState; text?: string; label?: string; clear?: boolean };
  if (!m || typeof m !== 'object') {
    return;
  }
  switch (m.t) {
    case 'state':
      if (m.state) {
        window.__zcodeState = m.state;
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
    case 'attachChip':
      if (m.clear) {
        attachChips = [];
      } else if (m.label) {
        attachChips.push(m.label);
      }
      chipsEl.innerHTML = attachChips
        .map((c) => `<span class="chip" title="点击清空">📎 ${escapeHtml(c)}</span>`)
        .join('');
      chipsEl.querySelectorAll('.chip').forEach((el) => el.addEventListener('click', () => vscode.postMessage({ t: 'removeAttach' })));
      break;
  }
});

vscode.postMessage({ t: 'ready' });
