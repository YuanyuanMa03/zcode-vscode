import { spawn, type ChildProcess } from 'child_process'
import type { ProtocolFrame } from './types.ts'

/** 可注入的底层 IO(单测用内存管道;生产由 spawn 提供) */
export interface TransportIO {
  /** 向对端写入原始字符串(NDJSON 行) */
  write: (data: string) => void
  /** 注册对端→本端数据回调 */
  onData: (cb: (chunk: string) => void) => void
  /** 注册对端 stderr 行回调(可选;注入模式下由测试直接给整行) */
  onStderrLine?: (cb: (line: string) => void) => void
  /** 注册数据流结束回调(可选):触发尾部残行 flush */
  onEnd?: (cb: () => void) => void
}

export interface TransportExitInfo {
  code: number | null
  signal: NodeJS.Signals | null
}

export interface ProtocolTransportOptions {
  /** 可执行命令(生产:resolveBinaries() 的 node) */
  command: string
  /** 参数(生产:[cliPath, 'app-server', '--stdio']) */
  args: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** 注入 IO 时不 spawn(可测试) */
  io?: TransportIO
}

/**
 * NDJSON stdio 传输(§1):每帧一行 `JSON.stringify(frame) + "\n"`;
 * 接收侧按行切分,残行缓冲,尾部无换行的最后一帧在流结束时也会处理(§1.2)。
 * stderr 不是协议通道(日志),按行回调给上层(§11.8)。
 */
export class ProtocolTransport {
  private readonly options: ProtocolTransportOptions
  private child: ChildProcess | null = null
  private sink: ((data: string) => void) | null = null
  private onFrame: ((frame: unknown) => void) | null = null
  private onStderrLine: ((line: string) => void) | null = null
  private onExit: ((info: TransportExitInfo) => void) | null = null
  private buffer = ''
  private stderrBuffer = ''
  private started = false
  private disposed = false

  constructor(options: ProtocolTransportOptions) {
    this.options = options
  }

  /** spawn(或接管注入 IO)。只允许调用一次 */
  start(): void {
    if (this.started) {
      throw new Error('ProtocolTransport already started')
    }
    this.started = true
    if (this.options.io) {
      this.sink = this.options.io.write
      this.options.io.onData((chunk) => this.handleData(chunk))
      this.options.io.onStderrLine?.((line) => this.onStderrLine?.(line))
      this.options.io.onEnd?.(() => this.flushTail())
      return
    }
    const child = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env: this.options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child
    this.sink = (data) => {
      child.stdin?.write(data)
    }
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (d: string) => this.handleData(d))
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (d: string) => this.handleStderrChunk(d))
    child.on('error', () => {
      // spawn 失败(如 ENOENT)等价为退出
      this.flushTail()
      this.onExit?.({ code: null, signal: null })
    })
    child.on('close', (code, signal) => {
      this.flushTail()
      this.onExit?.({ code, signal })
    })
  }

  /** 序列化并写入一帧(§1.2:`JSON.stringify(message) + "\n"`) */
  send(frame: ProtocolFrame): void {
    if (this.disposed) {
      throw new Error('ProtocolTransport disposed')
    }
    if (!this.sink) {
      throw new Error('ProtocolTransport not started')
    }
    this.sink(`${JSON.stringify(frame)}\n`)
  }

  setOnFrame(cb: (frame: unknown) => void): void {
    this.onFrame = cb
  }

  setOnStderrLine(cb: (line: string) => void): void {
    this.onStderrLine = cb
  }

  setOnExit(cb: (info: TransportExitInfo) => void): void {
    this.onExit = cb
  }

  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    const child = this.child
    this.child = null
    this.sink = null
    if (!child || child.pid === undefined) {
      return
    }
    // 与 ZcodeRunner.stop() 同策略:SIGTERM,3s 后兜底 SIGKILL
    try {
      child.stdin?.end()
      child.kill('SIGTERM')
    } catch {
      /* 已退出 */
    }
    const pid = child.pid
    setTimeout(() => {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* 已退出 */
      }
    }, 3000).unref()
  }

  private handleData(chunk: string): void {
    this.buffer += chunk
    for (;;) {
      const idx = this.buffer.indexOf('\n')
      if (idx < 0) {
        return
      }
      const line = this.buffer.slice(0, idx)
      this.buffer = this.buffer.slice(idx + 1)
      this.handleLine(line)
    }
  }

  /** 流结束:处理尾部无换行的残帧(§1.2) */
  private flushTail(): void {
    if (this.buffer.length > 0) {
      const rest = this.buffer
      this.buffer = ''
      this.handleLine(rest)
    }
  }

  private handleLine(line: string): void {
    const s = line.trim()
    if (!s) {
      return
    }
    let frame: unknown
    try {
      frame = JSON.parse(s)
    } catch {
      // 服务器保证 stdout 只有协议帧(§11.8);此处非 JSON 行直接丢弃
      return
    }
    this.onFrame?.(frame)
  }

  private handleStderrChunk(chunk: string): void {
    this.stderrBuffer += chunk
    for (;;) {
      const idx = this.stderrBuffer.indexOf('\n')
      if (idx < 0) {
        return
      }
      const line = this.stderrBuffer.slice(0, idx)
      this.stderrBuffer = this.stderrBuffer.slice(idx + 1)
      if (line.trim()) {
        this.onStderrLine?.(line)
      }
    }
  }
}
