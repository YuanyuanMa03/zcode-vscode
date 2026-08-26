import * as vscode from 'vscode';
import { spawn, type ChildProcess } from 'child_process';
import { resolveBinariesPure, type Binaries } from './protocol/binaries';

export type { Binaries };


export interface RunOptions {
  /** CLI 工作目录 */
  cwd: string;
  /** 用户输入 */
  prompt: string;
  /** 续接当前 cwd 最新会话(--continue) */
  resume: boolean;
  /** 附加文件(--attach) */
  attach?: string[];
  /** 权限模式 build/edit/plan/yolo */
  mode: string;
  onChunk?: (text: string) => void;
  /** 进程结束(code 为 null 表示被终止) */
  onDone?: (code: number | null, stderr: string) => void;
}

export function resolveBinaries(): Binaries {
  const cfg = vscode.workspace.getConfiguration('zcode');
  return resolveBinariesPure({
    nodePath: cfg.get<string>('nodePath', ''),
    cliPath: cfg.get<string>('cliPath', ''),
  });
}

/**
 * 管理 zcode headless 子进程。
 * 注意:--max-turns 在 CLI 0.15.2 会触发参数解析 bug(打印帮助),故不使用。
 */
export class ZcodeRunner {
  private child: ChildProcess | null = null;
  private killed = false;

  get running(): boolean {
    return this.child !== null;
  }

  stop(): boolean {
    if (!this.child || this.child.pid === undefined) {
      return false;
    }
    this.killed = true;
    // POSIX:detached 启动形成进程组,负 pid 一次性杀掉 CLI 及其 MCP 子进程
    try {
      process.kill(-this.child.pid, 'SIGTERM');
    } catch {
      this.child.kill('SIGTERM');
    }
    setTimeout(() => {
      if (this.child && this.child.pid !== undefined) {
        try {
          process.kill(-this.child.pid, 'SIGKILL');
        } catch {
          /* 已退出 */
        }
      }
    }, 3000);
    return true;
  }

  /**
   * 启动一轮 headless 请求。同一 Runner 同时只允许一个进程。
   * 返回 false 表示环境未就绪或已有任务在跑(已通过 onDone 报错)。
   */
  run(o: RunOptions): boolean {
    if (this.child) {
      o.onDone?.(null, '已有任务在运行,请先停止。');
      return false;
    }
    const bins = resolveBinaries();
    if (!bins.cli) {
      o.onDone?.(null, `未找到 ZCode CLI。请安装 ZCode 桌面版,或在设置中配置 zcode.cliPath。\n${bins.detail}`);
      return false;
    }

    const args: string[] = ['--cwd', o.cwd];
    if (o.resume) {
      args.push('--continue');
    }
    for (const f of o.attach ?? []) {
      args.push('--attach', f);
    }
    args.push('--mode', o.mode, '--no-color', '--prompt', o.prompt);

    this.killed = false;
    const child = spawn(bins.node, [bins.cli, ...args], {
      cwd: o.cwd,
      env: process.env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;

    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => o.onChunk?.(d));
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (d: string) => {
      stderr += d;
      // 部分 CLI 报错只走 stderr,流式透出便于观察
      o.onChunk?.(d);
    });
    child.on('error', (err) => {
      this.child = null;
      o.onDone?.(null, `无法启动进程: ${err.message}\n${bins.detail}`);
    });
    child.on('close', (code) => {
      this.child = null;
      o.onDone?.(this.killed ? null : code, stderr);
    });
    return true;
  }

  /** 运行一次性诊断命令(version/doctor),返回全部输出 */
  async capture(args: string[]): Promise<{ code: number | null; out: string }> {
    const bins = resolveBinaries();
    const cli = bins.cli;
    if (!cli) {
      return { code: null, out: `未找到 ZCode CLI。\n${bins.detail}` };
    }
    return new Promise((resolve) => {
      const child = spawn(bins.node, [cli, ...args, '--no-color'], {
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (d: string) => (out += d));
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (d: string) => (out += d));
      child.on('error', (err) => resolve({ code: null, out: `${bins.detail}\n${err.message}` }));
      child.on('close', (code) => resolve({ code, out: `${bins.detail}\n\n${out}` }));
    });
  }
}
