import { marked } from 'marked';

interface ChatMessage {
  role: 'user' | 'assistant' | 'error';
  text: string;
  attach?: string[];
}

type ToWebview =
  | { t: 'init'; messages: ChatMessage[]; running: boolean; attachedFile: string | null; mode: string; cwd: string }
  | { t: 'append'; text: string }
  | { t: 'message'; msg: ChatMessage }
  | { t: 'done'; stopped: boolean; ok: boolean }
  | { t: 'running'; on: boolean }
  | { t: 'clear' }
  | { t: 'attachChanged'; file: string | null }
  | { t: 'prefill'; text: string };

declare const acquireVsCodeApi: () => { postMessage(m: unknown): void };

const vscode = acquireVsCodeApi();
marked.setOptions({ gfm: true, breaks: true });

const chatEl = document.getElementById('chat') as HTMLDivElement;
const inputEl = document.getElementById('input') as HTMLTextAreaElement;
const sendBtn = document.getElementById('send') as HTMLButtonElement;
const stMode = document.getElementById('st-mode') as HTMLSpanElement;
const stRun = document.getElementById('st-run') as HTMLSpanElement;
const stAttach = document.getElementById('st-attach') as HTMLSpanElement;

let running = false;
let mode = '';
let cwd = '';
let streamBuf = '';
let renderQueued = false;

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** markdown 渲染:先整体转义,模型输出中的裸 HTML/脚本不会被执行 */
function md(s: string): string {
  try {
    return marked.parse(escapeHtml(s)) as string;
  } catch {
    return `<p>${escapeHtml(s)}</p>`;
  }
}

function displayName(f: string): string {
  const parts = f.split('/');
  return parts[parts.length - 1];
}

function msgNode(msg: ChatMessage, streaming = false): HTMLElement {
  const div = document.createElement('div');
  div.className = `msg ${msg.role}`;
  const who = document.createElement('div');
  who.className = 'who';
  who.textContent = msg.role === 'user' ? '你' : msg.role === 'error' ? '错误' : 'ZCode';
  div.appendChild(who);
  if (msg.attach?.length) {
    for (const a of msg.attach) {
      const chip = document.createElement('span');
      chip.className = 'attach-chip';
      chip.textContent = `📎 ${displayName(a)}`;
      div.appendChild(chip);
    }
  }
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  if (msg.role === 'assistant') {
    bubble.innerHTML = streaming ? md(msg.text) + '<span class="cursor"></span>' : md(msg.text);
  } else {
    bubble.textContent = msg.text;
  }
  div.appendChild(bubble);
  return div;
}

function clearChat(): void {
  chatEl.innerHTML = `<div class="empty"><div class="logo">Z</div>ZCode 就绪<br>输入问题开始对话,会自动在当前工作区运行</div>`;
}

function scrollBottom(): void {
  chatEl.scrollTop = chatEl.scrollHeight;
}

function appendMessage(msg: ChatMessage): void {
  const empty = chatEl.querySelector('.empty');
  if (empty) {
    empty.remove();
  }
  chatEl.appendChild(msgNode(msg));
  scrollBottom();
}

/** 流式更新:重渲染最后一条 assistant(节流到动画帧) */
function appendStream(text: string): void {
  streamBuf += text;
  const nodes = chatEl.querySelectorAll('.msg.assistant');
  const last = nodes[nodes.length - 1];
  if (last) {
    if (!renderQueued) {
      renderQueued = true;
      requestAnimationFrame(() => {
        renderQueued = false;
        const bubble = last.querySelector('.bubble');
        if (bubble) {
          bubble.innerHTML = md(streamBuf) + '<span class="cursor"></span>';
          scrollBottom();
        }
      });
    }
    return;
  }
  // 没有可用的 assistant 气泡(如异常路径),补一条
  appendMessage({ role: 'assistant', text: '' });
}

function finalizeStream(): void {
  const nodes = chatEl.querySelectorAll('.msg.assistant');
  const last = nodes[nodes.length - 1] as HTMLElement | undefined;
  if (last) {
    const bubble = last.querySelector('.bubble');
    if (bubble) {
      bubble.innerHTML = md(streamBuf);
    }
    scrollBottom();
  }
  streamBuf = '';
}

function setRunning(on: boolean): void {
  running = on;
  sendBtn.textContent = on ? '停止' : '发送';
  sendBtn.className = on ? 'sec' : '';
  stRun.textContent = on ? '⏳ 运行中…' : '';
  inputEl.disabled = false;
}

function setAttach(f: string | null): void {
  stAttach.textContent = f ? `📎 ${displayName(f)} ✕` : '';
  stAttach.style.display = f ? '' : 'none';
}

setRunning(false);
setAttach(null);

sendBtn.addEventListener('click', () => {
  if (running) {
    vscode.postMessage({ t: 'stop' });
    return;
  }
  const text = inputEl.value.trim();
  if (!text) {
    return;
  }
  inputEl.value = '';
  vscode.postMessage({ t: 'send', text });
});

inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendBtn.click();
  }
});

stAttach.addEventListener('click', () => vscode.postMessage({ t: 'removeAttach' }));

window.addEventListener('message', (e: MessageEvent) => {
  const m = e.data as ToWebview;
  if (!m || typeof m !== 'object' || !('t' in m)) {
    return;
  }
  switch (m.t) {
    case 'init':
      clearChat();
      mode = m.mode;
      cwd = m.cwd;
      stMode.textContent = `📁 ${displayName(cwd)} · ${m.mode}`;
      setAttach(m.attachedFile);
      for (const msg of m.messages) {
        appendMessage(msg);
      }
      setRunning(m.running);
      break;
    case 'message':
      if (m.msg.role === 'assistant') {
        streamBuf = m.msg.text;
        appendMessage(m.msg);
      } else {
        appendMessage(m.msg);
      }
      break;
    case 'append':
      appendStream(m.text);
      break;
    case 'running':
      if (m.on) {
        streamBuf = '';
        appendMessage({ role: 'assistant', text: '' });
      } else {
        finalizeStream();
      }
      setRunning(m.on);
      break;
    case 'done':
      if (m.stopped) {
        appendMessage({ role: 'error', text: '已停止。' });
      }
      break;
    case 'clear':
      clearChat();
      stMode.textContent = `📁 ${displayName(cwd)} · ${mode}`;
      break;
    case 'attachChanged':
      setAttach(m.file);
      break;
    case 'prefill':
      inputEl.value += m.text;
      inputEl.focus();
      inputEl.selectionStart = inputEl.selectionEnd = inputEl.value.length;
      break;
  }
});

vscode.postMessage({ t: 'ready' });
