import * as vscode from 'vscode';
import { resolveBinariesPure, type Binaries } from './protocol/binaries';
import { captureOnce } from './protocol/capture';

export type { Binaries };

export function resolveBinaries(): Binaries {
  const cfg = vscode.workspace.getConfiguration('zcode');
  return resolveBinariesPure({
    nodePath: cfg.get<string>('nodePath', ''),
    cliPath: cfg.get<string>('cliPath', ''),
  });
}

/** 一次性诊断命令入口(doctor 等);进程逻辑见 protocol/capture.ts(可单测) */
export class ZcodeRunner {
  async capture(args: string[]): Promise<{ code: number | null; out: string }> {
    return captureOnce(resolveBinaries(), args);
  }
}
