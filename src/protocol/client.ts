import {
  isErrorResponseFrame,
  isNotificationFrame,
  isRequestFrame,
  isSuccessResponseFrame,
  type ErrorResponseFrame,
  type FrameId,
  type ProtocolErrorBody,
  type RequestFrame,
  type ProtocolFrame,
  type SuccessResponseFrame,
} from './types.ts'

/** client 对传输层的最小依赖(真实 ProtocolTransport 或测试用内存管道均可) */
export interface ClientTransport {
  send(frame: ProtocolFrame): void
  dispose?(): void
}

/**
 * 服务器请求 handler(§5 interaction 三类等)。
 * 返回 Promise/非 undefined 值:client 自动以「最新帧 id」应答该值;
 * 返回 undefined:handler 自行调用 respond/respondError(同样会路由到最新帧 id)。
 */
export type ServerRequestHandler = (frame: RequestFrame) => unknown

/** 服务器返回 error 帧时 request() 的 reject 值(§5.6 错误码) */
export class ProtocolRequestError extends Error {
  readonly code: number | undefined
  readonly data: unknown

  constructor(message: string, code?: number, data?: unknown) {
    super(message)
    this.name = 'ProtocolRequestError'
    this.code = code
    this.data = data
  }
}

interface PendingEntry {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout | undefined
}

/** 去重记录(§5.3):同一 requestId 的最新帧 + 见过的所有帧 id */
interface DedupRecord {
  frame: RequestFrame
  ids: Set<string>
}

const DEFAULT_TIMEOUT_MS = 60_000

function isPromiseLike(v: unknown): v is PromiseLike<unknown> {
  return typeof v === 'object' && v !== null && typeof (v as PromiseLike<unknown>).then === 'function'
}

function toErrorBody(err: unknown): ProtocolErrorBody {
  if (err instanceof ProtocolRequestError && typeof err.code === 'number') {
    return { code: err.code, message: err.message, data: err.data }
  }
  return { code: -32603, message: err instanceof Error ? err.message : String(err) }
}

/**
 * ZCode Protocol 客户端(§1):
 * - request:id 从 1 递增(§1.3),pending Map + 超时清理
 * - 收帧四分类:id+result/error → pending 结算;id+method → 服务器请求;仅 method → 通知(§11.2)
 * - interaction 去重(§5.3):服务器 1s 起指数重发,同一 requestId 以新 id 再达;
 *   只回调一次 handler,静默更新记录,应答一律路由到最新帧 id(答旧 id 会挂死)
 */
export class ProtocolClient {
  private readonly transport: ClientTransport
  private readonly defaultTimeoutMs: number
  private nextRequestId = 1
  private readonly pending = new Map<string, PendingEntry>()
  private onNotification: ((method: string, params: unknown) => void) | null = null
  private readonly serverRequestHandlers = new Map<string, ServerRequestHandler>()
  private readonly serverRequestsByDedupKey = new Map<string, DedupRecord>()
  /** 历史(含已被重发取代)帧 id → dedupKey:用旧 id 应答也能路由到最新帧 */
  private readonly dedupKeyByFrameId = new Map<string, string>()
  /** 已应答的服务器帧 id:双响应幂等 */
  private readonly answeredServerFrameIds = new Set<string>()
  /** 已应答的 interaction 去重键:应答后才到达的迟到重发帧直接忽略,不重复弹 UI(§5.3) */
  private readonly answeredDedupKeys = new Set<string>()
  private disposed = false

  constructor(transport: ClientTransport, options: { defaultTimeoutMs?: number } = {}) {
    this.transport = transport
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  /**
   * 发起请求。id 为从 1 递增的数字(§1.3)。
   * @param timeoutMs 覆盖默认超时;传 0 或负数表示不限时
   */
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new Error('ZCode protocol client disposed'))
    }
    const id = this.nextRequestId++
    const timeout = timeoutMs ?? this.defaultTimeoutMs
    return new Promise<unknown>((resolve, reject) => {
      const entry: PendingEntry = { resolve, reject, timer: undefined }
      if (timeout > 0) {
        entry.timer = setTimeout(() => {
          this.pending.delete(String(id))
          reject(new ProtocolRequestError(`ZCode protocol request timeout after ${timeout}ms: ${method} (id ${id})`))
        }, timeout)
      }
      this.pending.set(String(id), entry)
      try {
        this.transport.send({ id, method, params })
      } catch (err) {
        this.pending.delete(String(id))
        if (entry.timer) {
          clearTimeout(entry.timer)
        }
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    }) as Promise<T>
  }

  /** 发送通知(无 id) */
  notify(method: string, params?: unknown): void {
    if (this.disposed) {
      return
    }
    this.transport.send({ method, params })
  }

  /** 应答服务器请求(id 允许是重发前的旧 id,内部路由到最新帧;重复应答幂等) */
  respond(id: FrameId, result: unknown): void {
    const target = this.routeServerFrameId(id)
    if (target === null) {
      return
    }
    try {
      // 响应帧必须携带 result 键(§1.4 服务器按键存在性分类),undefined 归一为 null
      this.transport.send({ id: target, result: result === undefined ? null : result })
    } catch {
      /* transport 已关闭:应答无处可去,静默 */
    }
  }

  /** 以错误应答服务器请求(路由/幂等规则同 respond) */
  respondError(id: FrameId, error: ProtocolErrorBody): void {
    const target = this.routeServerFrameId(id)
    if (target === null) {
      return
    }
    try {
      this.transport.send({ id: target, error })
    } catch {
      /* transport 已关闭:应答无处可去,静默 */
    }
  }

  /** 通知回调(session/event | state.updated | prompt/enhance/result 等) */
  setOnNotification(cb: (method: string, params: unknown) => void): void {
    this.onNotification = cb
  }

  /**
   * 注册服务器请求 handler(如 'interaction/requestPermission')。
   * 未注册方法的请求会被回 -32601 Method not found(§5.6,参考客户端行为)。
   */
  registerServerRequestHandler(method: string, handler: ServerRequestHandler): void {
    this.serverRequestHandlers.set(method, handler)
  }

  /** 喂入一帧(已 JSON 解析的对象;与 ProtocolTransport.setOnFrame 对接) */
  handleFrame(frame: unknown): void {
    if (this.disposed) {
      return
    }
    if (isSuccessResponseFrame(frame) || isErrorResponseFrame(frame)) {
      this.settlePending(frame)
      return
    }
    if (isRequestFrame(frame)) {
      this.handleServerRequest(frame)
      return
    }
    if (isNotificationFrame(frame)) {
      this.onNotification?.(frame.method, frame.params)
    }
    // 其余形状:忽略(服务器保证 stdout 只有协议帧)
  }

  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    for (const entry of this.pending.values()) {
      if (entry.timer) {
        clearTimeout(entry.timer)
      }
      entry.reject(new Error('ZCode protocol client disposed'))
    }
    this.pending.clear()
    this.serverRequestsByDedupKey.clear()
    this.dedupKeyByFrameId.clear()
    this.answeredServerFrameIds.clear()
    this.answeredDedupKeys.clear()
    this.transport.dispose?.()
  }

  private settlePending(frame: SuccessResponseFrame | ErrorResponseFrame): void {
    const entry = this.pending.get(String(frame.id))
    if (!entry) {
      return
    }
    this.pending.delete(String(frame.id))
    if (entry.timer) {
      clearTimeout(entry.timer)
    }
    if (isErrorResponseFrame(frame)) {
      const err = frame.error
      entry.reject(new ProtocolRequestError(err.message, err.code, err.data))
    } else {
      entry.resolve(frame.result)
    }
  }

  private handleServerRequest(frame: RequestFrame): void {
    const handler = this.serverRequestHandlers.get(frame.method)
    if (!handler) {
      this.respondError(frame.id, { code: -32601, message: `Method not found: ${frame.method}` })
      return
    }
    const dedupKey = this.dedupKeyFor(frame)
    if (dedupKey !== null) {
      const existing = this.serverRequestsByDedupKey.get(dedupKey)
      if (existing) {
        // 重发帧(§5.3):静默更新映射到最新 id,不重复回调 handler
        existing.frame = frame
        existing.ids.add(String(frame.id))
        this.dedupKeyByFrameId.set(String(frame.id), dedupKey)
        return
      }
      if (this.answeredDedupKeys.has(dedupKey)) {
        // 该 requestId 已应答,迟到重发帧直接忽略
        return
      }
      this.serverRequestsByDedupKey.set(dedupKey, { frame, ids: new Set([String(frame.id)]) })
      this.dedupKeyByFrameId.set(String(frame.id), dedupKey)
    }
    let result: unknown
    try {
      result = handler(frame)
    } catch (err) {
      this.respondError(frame.id, toErrorBody(err))
      return
    }
    if (result !== undefined) {
      if (isPromiseLike(result)) {
        void result.then(
          (value) => this.respond(frame.id, value),
          (err) => this.respondError(frame.id, toErrorBody(err))
        )
      } else {
        this.respond(frame.id, result)
      }
    }
    // result === undefined:handler 自行应答
  }

  /** interaction/*(§5.3)按 method+sessionId+requestId 去重;其余服务器请求不去重 */
  private dedupKeyFor(frame: RequestFrame): string | null {
    if (!frame.method.startsWith('interaction/')) {
      return null
    }
    const params = frame.params
    if (typeof params !== 'object' || params === null) {
      return null
    }
    const { sessionId, requestId } = params as { sessionId?: unknown; requestId?: unknown }
    if (typeof sessionId !== 'string' || typeof requestId !== 'string') {
      return null
    }
    return `${frame.method}:${sessionId}:${requestId}`
  }

  /**
   * 应答 id 路由:去重记录存在 → 返回最新帧 id 并清理记录;已应答 → null(幂等);
   * 非去重请求 → 原样返回并标记已应答。
   */
  private routeServerFrameId(id: FrameId): FrameId | null {
    const idKey = String(id)
    if (this.answeredServerFrameIds.has(idKey)) {
      return null
    }
    const dedupKey = this.dedupKeyByFrameId.get(idKey)
    if (dedupKey === undefined) {
      this.answeredServerFrameIds.add(idKey)
      return id
    }
    const record = this.serverRequestsByDedupKey.get(dedupKey)
    if (!record) {
      // 记录已清理但旧 id 未标记(防御,正常路径不会到这)
      this.answeredServerFrameIds.add(idKey)
      return null
    }
    for (const seenId of record.ids) {
      this.answeredServerFrameIds.add(seenId)
      this.dedupKeyByFrameId.delete(seenId)
    }
    this.answeredDedupKeys.add(dedupKey)
    this.serverRequestsByDedupKey.delete(dedupKey)
    return record.frame.id
  }
}
