import { spawn } from 'child_process';
import type { Binaries } from './binaries.ts';

export interface CaptureResult {
  code: number | null;
  out: string;
}

/**
 * 运行一次性诊断命令(version/doctor),收集全部输出。
 * 超时(默认 30s)则 SIGKILL 子进程并以 code:null 返回——CLI 等锁挂起时命令不能再无限悬挂。
 */
export function captureOnce(bins: Binaries, args: string[], timeoutMs = 30_000): Promise<CaptureResult> {
  const cli = bins.cli;
  if (!cli) {
    return Promise.resolve({ code: null, out: `未找到 ZCode CLI。\n${bins.detail}` });
  }
  return new Promise((resolve) => {
    const child = spawn(bins.node, [cli, ...args, '--no-color'], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let settled = false;
    const finish = (r: CaptureResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已退出 */
      }
      finish({ code: null, out: `${bins.detail}\n\n超时(${timeoutMs}ms),已终止。` });
    }, timeoutMs);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => (out += d));
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (d: string) => (out += d));
    child.on('error', (err) => finish({ code: null, out: `${bins.detail}\n${err.message}` }));
    child.on('close', (code) => finish({ code, out: `${bins.detail}\n\n${out}` }));
  });
}
