import { Marked, Renderer, type Tokens } from 'marked';

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 链接 scheme 白名单(http/https/mailto + 相对路径);模型输出是不可信内容 */
function isSafeHref(href: string): boolean {
  if (!href) {
    return false;
  }
  const m = href.match(/^\s*([a-zA-Z][a-zA-Z0-9+.-]*):/);
  if (!m) {
    return true; // 相对路径 / 锚点
  }
  return ['http', 'https', 'mailto'].includes(m[1].toLowerCase());
}

/** 图片仅允许 data: 与相对路径:远程图片是信标面(prompt injection 可利用),且 CSP 已收紧 */
function isSafeImageHref(href: string): boolean {
  if (!href) {
    return false;
  }
  const m = href.match(/^\s*([a-zA-Z][a-zA-Z0-9+.-]*):/);
  if (!m) {
    return true;
  }
  return m[1].toLowerCase() === 'data';
}

const renderer: Partial<Renderer> = {
  // 原始 HTML 一律转义为可见文本(不进入 DOM);marked 自身会对代码块/行内代码正确转义,
  // 因此整体管线不再预转义——预转义正是代码块双重转义乱码的根因
  html(token: Tokens.HTML): string {
    return escapeHtml(token.text ?? '');
  },
  link(this: Renderer, token: Tokens.Link): string {
    if (!isSafeHref(token.href)) {
      return escapeHtml(token.text ?? '');
    }
    const title = token.title ? ` title="${escapeHtml(token.title)}"` : '';
    return `<a href="${escapeHtml(token.href)}"${title}>${this.parser.parseInline(token.tokens)}</a>`;
  },
  image(this: Renderer, token: Tokens.Image): string {
    if (!isSafeImageHref(token.href)) {
      return escapeHtml(token.text ? `${token.text}(远程图片已屏蔽)` : '(远程图片已屏蔽)');
    }
    const title = token.title ? ` title="${escapeHtml(token.title)}"` : '';
    return `<img src="${escapeHtml(token.href)}"${title} alt="${escapeHtml(token.text ?? '')}">`;
  },
};

const marked = new Marked({ gfm: true, breaks: true, renderer });

/** 模型输出(不可信)→ 安全 HTML:无预转义(代码块正确),原始 HTML/危险链接中和 */
export function renderMarkdown(s: string): string {
  try {
    return marked.parse(s) as string;
  } catch {
    return `<p>${escapeHtml(s)}</p>`;
  }
}
