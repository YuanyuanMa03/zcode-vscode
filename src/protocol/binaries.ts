import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface Binaries {
  /** 可执行 node 路径或命令名(null 表示完全不可用) */
  node: string;
  /** zcode.cjs 入口绝对路径 */
  cli: string | null;
  /** 实际采用的来源说明,用于诊断 */
  detail: string;
}

export function expandHome(p: string): string {
  if (!p) {
    return p;
  }
  if (p === '~') {
    return os.homedir();
  }
  if (p.startsWith('~/')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

const DEFAULT_NODE = path.join(os.homedir(), '.zcode', 'server', 'node');
const DEFAULT_CLI = path.join(os.homedir(), '.zcode', 'server', 'agents', 'glm', 'zcode.cjs');

/** 纯函数版二进制定位(无 vscode 依赖,smoke 脚本可复用) */
export function resolveBinariesPure(overrides: { nodePath?: string; cliPath?: string } = {}): Binaries {
  const userNode = expandHome(overrides.nodePath ?? '');
  const userCli = expandHome(overrides.cliPath ?? '');

  let node: string;
  let detail: string;
  if (userNode && fs.existsSync(userNode)) {
    node = userNode;
    detail = `node ← 设置(${userNode})`;
  } else if (fs.existsSync(DEFAULT_NODE)) {
    node = DEFAULT_NODE;
    detail = `node ← 默认(${DEFAULT_NODE})`;
  } else {
    node = 'node';
    detail = 'node ← 系统 PATH(~/.zcode/server/node 不存在)';
  }

  let cli: string | null = null;
  if (userCli && fs.existsSync(userCli)) {
    cli = userCli;
    detail += `; cli ← 设置(${userCli})`;
  } else if (fs.existsSync(DEFAULT_CLI)) {
    cli = DEFAULT_CLI;
    detail += `; cli ← 默认(${DEFAULT_CLI})`;
  } else {
    detail += `; cli 未找到(设置值:${userCli || '未设置'},默认:${DEFAULT_CLI})`;
  }

  return { node, cli, detail };
}
