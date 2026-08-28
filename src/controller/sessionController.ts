import * as crypto from 'crypto';
import * as fsSync from 'fs';
import * as os from 'os';
import * as pathMod from 'path';
import { ProtocolTransport, type TransportExitInfo } from '../protocol/transport.ts';
import { ProtocolClient, ProtocolRequestError } from '../protocol/client.ts';
import { resolveBinariesPure } from '../protocol/binaries.ts';
import type { FrameId } from '../protocol/types.ts';

/* ---------- UI 状态模型(可结构化克隆,webview 纯渲染) ---------- */

export interface UIToolCall {
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

export interface UIPermissionOption {
  optionId: string;
  kind: string;
  name: string;
  description?: string;
  response: unknown;
}

export interface UIPermission {
  key: string;
  requestId: string;
  toolName: string;
  reason: string;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  input?: unknown;
  options: UIPermissionOption[];
  requestedAt: number;
}

export interface UIUserInputQuestion {
  question: string;
  header?: string;
  options?: { value: string; label: string; description?: string }[];
  multiSelect?: boolean;
}

export interface UIUserInput {
  key: string;
  requestId: string;
  prompt?: string;
  questions: UIUserInputQuestion[];
  interaction?: string;
}

export type UIPart =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'tool'; call: UIToolCall }
  | { kind: 'patch'; files: string[] }
  | { kind: 'meta'; label: string };

export interface UIMessage {
  id: string;
  role: string;
  parts: UIPart[];
}

export interface UISessionSummary {
  sessionId: string;
  title: string;
  mode: string;
  status: string;
  updatedAt: number;
}

export interface UISlashCommand {
  name: string;
  description?: string;
}

export interface UIState {
  connection: 'connecting' | 'connected' | 'failed';
  connectionError?: string;
  sessions: UISessionSummary[];
  current: {
    sessionId: string | null;
    title: string;
    mode: string;
    modelLabel: string;
    status: string;
    contextUsed: number;
    contextWindow: number;
    messages: UIMessage[];
    /** 会话可用斜杠命令(宽松投影) */
    slashCommands: UISlashCommand[];
    /** 运行中的 turn 叠加层 */
    live: {
      active: boolean;
      streamingText: string;
      reasoningText: string;
      toolCalls: UIToolCall[];
      turnError?: string;
    };
    pendingPermissions: UIPermission[];
    pendingUserInputs: UIUserInput[];
  };
}

/* ---------- 宽松的协议载荷访问 ---------- */

type Rec = Record<string, unknown>;

function asRec(v: unknown): Rec {
  return typeof v === 'object' && v !== null ? (v as Rec) : {};
}
function asStr(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}
function asNum(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
function modelLabel(modelRef: unknown): string {
  const r = asRec(modelRef);
  const provider = asStr(r.providerId);
  const id = asStr(r.modelId);
  if (!id) {
    return '';
  }
  const short = provider.replace(/^builtin:/, '');
  return short ? `${id} (${short})` : id;
}

/* ---------- 事件信封 ---------- */

interface EventEnvelope {
  eventId?: string;
  sessionId?: string;
  seq: number;
  type: string;
  payload: Rec;
}

/* ---------- Controller ---------- */

export interface SessionControllerOptions {
  /** 协议进程 cwd,亦是 workspace 路径 */
  workspacePath: string;
  /** 初始权限模式(会话创建用) */
  defaultMode: string;
  /** 二进制覆盖(默认自动探测) */
  nodePath?: string;
  cliPath?: string;
  /** 日志行(stderr)回调 */
  onLogLine?: (line: string) => void;
  /** 测试注入口:替换默认的 transport+client 装配(生产为 spawn 真实 CLI 进程) */
  createConnection?: () => { transport: ProtocolTransport; client: ProtocolClient };
}

const DELIVERY_KIND = 'desktop-continuous';

export class SessionController {
  private readonly opts: SessionControllerOptions;
  private client: ProtocolClient | null = null;
  private restartAttempts = 0;
  private disposed = false;

  private lastSeqBySession = new Map<string, number>();
  private stateRevision = 0;
  /** 跨端同步轮询(CC 式共享存储 + 轮询):桌面端产生的新会话/新消息及时出现 */
  private syncTimer: NodeJS.Timeout | null = null;
  private lastSeenUpdatedAtBySession = new Map<string, number>();
  private subscribedSessionId: string | null = null;
  private latestCheckpointId: string | null = null;
  private permSeq = 0;

  /** key → resolver(UI 应答权限/用户输入) */
  private readonly permissionResolvers = new Map<string, (v: unknown) => void>();
  private readonly userInputResolvers = new Map<string, (v: unknown) => void>();
  /** key → 服务器请求帧 id(resolved-elsewhere 时调用 abandonServerRequest 防泄漏) */
  private readonly permissionFrameIds = new Map<string, FrameId>();
  private readonly userInputFrameIds = new Map<string, FrameId>();

  private readonly listeners = new Set<(state: UIState) => void>();
  private pushTimer: NodeJS.Timeout | null = null;
  private readonly state: UIState = {
    connection: 'connecting',
    sessions: [],
    current: {
      sessionId: null,
      title: '',
      mode: '',
      modelLabel: '',
      status: 'idle',
      contextUsed: 0,
      contextWindow: 0,
      messages: [],
      slashCommands: [],
      live: { active: false, streamingText: '', reasoningText: '', toolCalls: [] },
      pendingPermissions: [],
      pendingUserInputs: [],
    },
  };

  constructor(opts: SessionControllerOptions) {
    this.opts = opts;
    this.state.current.mode = opts.defaultMode;
  }

  /* ---------- 生命周期 ---------- */

  async ensureStarted(): Promise<ProtocolClient> {
    if (this.disposed) {
      throw new Error('controller disposed');
    }
    if (this.client) {
      return this.client;
    }
    this.state.connection = 'connecting';
    this.state.connectionError = undefined;
    this.pushNow();

    if (this.opts.createConnection) {
      const { transport, client } = this.opts.createConnection();
      return this.wireConnection(transport, client);
    }

    const bins = resolveBinariesPure({ nodePath: this.opts.nodePath, cliPath: this.opts.cliPath });
    if (!bins.cli) {
      this.state.connection = 'failed';
      this.state.connectionError = `未找到 ZCode CLI:${bins.detail}`;
      this.pushNow();
      throw new Error(this.state.connectionError);
    }
    const transport = new ProtocolTransport({
      command: bins.node,
      args: [bins.cli, 'app-server', '--stdio'],
      cwd: this.opts.workspacePath,
      env: process.env,
    });
    const client = new ProtocolClient(transport);
    return this.wireConnection(transport, client);
  }

  /** 装配帧/退出回调与服务器请求 handler(真实 spawn 与测试注入共用) */
  private wireConnection(transport: ProtocolTransport, client: ProtocolClient): ProtocolClient {
    transport.setOnFrame((f) => client.handleFrame(f));
    transport.setOnStderrLine((l) => this.opts.onLogLine?.(l));
    transport.setOnExit((info) => this.handleTransportExit(info));
    transport.start();
    this.client = client;
    client.setOnNotification((method, params) => this.handleNotification(method, params));
    client.registerServerRequestHandler('interaction/requestPermission', (frame) =>
      this.handlePermissionRequest(asRec(frame.params), frame.id)
    );
    client.registerServerRequestHandler('interaction/requestUserInput', (frame) =>
      this.handleUserInputRequest(asRec(frame.params), frame.id)
    );
    client.registerServerRequestHandler('interaction/requestProviderRuntimeHeaders', () => ({
      headersApplied: false,
    }));
    this.state.connection = 'connected';
    this.pushNow();
    return client;
  }

  private handleTransportExit(info: TransportExitInfo): void {
    const oldClient = this.client;
    this.client = null;
    // 立即结算在途请求(否则各自等满 60s 超时才失败,期间 UI 无反馈)
    oldClient?.dispose();
    if (this.disposed) {
      return;
    }
    // 连接已断,订阅随之失效;重启恢复后由 adoptSnapshot 重新订阅
    this.subscribedSessionId = null;
    this.settlePendingInteractions('连接中断');
    if (this.state.current.live.active) {
      this.state.current.live.turnError = '协议进程退出,本轮已中断';
      this.endLive();
    }
    if (this.restartAttempts >= 3) {
      this.state.connection = 'failed';
      this.state.connectionError = `协议进程退出(code=${info.code} signal=${info.signal}),已达重启上限`;
      this.pushNow();
      return;
    }
    this.restartAttempts++;
    this.state.connection = 'connecting';
    this.state.connectionError = `协议进程退出,重启中(${this.restartAttempts}/3)…`;
    this.pushNow();
    void (async () => {
      try {
        await this.ensureStarted();
        if (this.subscribedSessionId) {
          await this.openSession(this.subscribedSessionId);
        }
        // 自愈成功:预算清零(否则一天内 3 次瞬时崩溃后,第 4 次直接永久 failed)
        this.restartAttempts = 0;
      } catch {
        /* 状态已在 ensureStarted 内标记 */
      }
    })();
  }

  /** 结算所有挂起的权限/用户输入(连接中断或会话切换):一律 deny/decline,避免 Promise 悬挂与跨会话错答 */
  private settlePendingInteractions(reason: string): void {
    for (const p of this.state.current.pendingPermissions) {
      this.permissionResolvers.get(p.key)?.({ decision: 'deny', reason });
    }
    this.permissionResolvers.clear();
    this.permissionFrameIds.clear();
    for (const u of this.state.current.pendingUserInputs) {
      this.userInputResolvers.get(u.key)?.({ action: 'decline' });
    }
    this.userInputResolvers.clear();
    this.userInputFrameIds.clear();
    this.state.current.pendingPermissions = [];
    this.state.current.pendingUserInputs = [];
  }

  dispose(): void {
    this.disposed = true;
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
    this.client?.dispose();
    this.client = null;
  }

  /** 启动跨端同步轮询(默认 15s;幂等) */
  startSyncPolling(intervalMs = 15_000): void {
    if (this.syncTimer) {
      return;
    }
    this.syncTimer = setInterval(() => void this.pollOnce(), intervalMs);
  }

  /** 立即同步一次:刷新列表;若打开的会话在别处(桌面端)有更新则拉取新消息 */
  async pollOnce(): Promise<void> {
    const client = this.client;
    if (!client || this.disposed) {
      return;
    }
    try {
      await this.refreshSessions();
      const sid = this.state.current.sessionId;
      if (!sid || this.state.current.live.active) {
        return;
      }
      const meta = this.state.sessions.find((x) => x.sessionId === sid);
      const seen = this.lastSeenUpdatedAtBySession.get(sid) ?? 0;
      if (meta && meta.updatedAt > seen) {
        const grew = seen > 0;
        this.lastSeenUpdatedAtBySession.set(sid, meta.updatedAt);
        if (grew) {
          await client
            .request('session/read', { sessionId: sid, deliveryKind: DELIVERY_KIND })
            .then((snap) => this.adoptSnapshot(asRec(snap)))
            .catch(() => {});
        }
      }
    } catch {
      /* 断连/竞态:下一轮再试 */
    }
  }

  /* ---------- 公共 API ---------- */

  get uiState(): Readonly<UIState> {
    return this.state;
  }

  /** 最近一次 checkpoint.created 的 id(rewind 预留) */
  get checkpointId(): string | null {
    return this.latestCheckpointId;
  }

  onStateChange(cb: (state: UIState) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private clientOrThrow(): ProtocolClient {
    if (!this.client) {
      throw new Error('协议未连接');
    }
    return this.client;
  }

  private runtimeModelCache: Rec | null | undefined;

  /**
   * 从 ~/.zcode/cli/config.json 构建 runtimeModel(完整 provider 注册表注入)。
   * 背景(实测):resume 之后 prompt/enhance 的 provider 解析会被会话内注册表污染而报
   * "Model provider is not configured";create/resume 携带 runtimeModel 可让会话自洽。
   */
  private buildRuntimeModel(): Rec | null {
    if (this.runtimeModelCache !== undefined) {
      return this.runtimeModelCache;
    }
    try {
      const cfgPath = pathMod.join(os.homedir(), '.zcode', 'cli', 'config.json');
      const cfg = JSON.parse(fsSync.readFileSync(cfgPath, 'utf8')) as Rec;
      const modelStr = typeof cfg.model === 'string' ? cfg.model : asStr(asRec(cfg.model).main);
      const slash = modelStr.indexOf('/');
      const providerId = modelStr.slice(0, slash);
      const modelId = modelStr.slice(slash + 1);
      const prov = asRec(asRec(cfg.provider)[providerId]);
      const options = asRec(prov.options);
      if (!providerId || !modelId || !prov.options) {
        return (this.runtimeModelCache = null);
      }
      const payload = { providerId, modelId, baseURL: options.baseURL };
      const revision = 'model-runtime:' + crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 24);
      this.runtimeModelCache = {
        revision,
        generatedAt: Date.now(),
        model: { providerId, modelId },
        provider: {
          providerId,
          kind: asStr(prov.kind, 'anthropic'),
          ...(typeof prov.name === 'string' ? { label: prov.name } : {}),
          source: 'workspace',
          ...(typeof options.baseURL === 'string' ? { baseURL: options.baseURL } : {}),
          ...(typeof options.apiKey === 'string' ? { apiKey: { source: 'inline', value: options.apiKey } } : {}),
          models: [{ modelId, label: modelId }],
        },
      };
    } catch {
      this.runtimeModelCache = null;
    }
    return this.runtimeModelCache;
  }

  private workspaceRef(): Rec {
    return { workspacePath: this.opts.workspacePath, workspaceKey: this.opts.workspacePath };
  }

  async newSession(mode?: string, model?: { providerId: string; modelId: string; variant?: string }): Promise<void> {
    const client = await this.ensureStarted();
    const runtimeModel = this.buildRuntimeModel();
    const result = asRec(
      await client.request('session/create', {
        workspace: this.workspaceRef(),
        mode: mode ?? this.opts.defaultMode,
        ...(model ? { model } : {}),
        ...(runtimeModel ? { runtimeModel } : {}),
        persistence: 'immediate',
      })
    );
    await this.adoptSnapshot(result);
    this.restartAttempts = 0;
    await this.refreshSessions();
  }

  async refreshSessions(): Promise<void> {
    const client = this.client;
    if (!client) {
      return;
    }
    const result = asRec(await client.request('session/list', { workspace: this.workspaceRef(), limit: 50 }));
    const sessions = Array.isArray(result.sessions) ? result.sessions : [];
    this.state.sessions = sessions
      .map((s): UISessionSummary => {
        const r = asRec(s);
        return {
          sessionId: asStr(r.sessionId),
          title: asStr(r.title, '(untitled)'),
          mode: asStr(r.mode),
          status: asStr(r.status),
          updatedAt: asNum(r.updatedAt),
        };
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
    this.push();
  }

  async openSession(sessionId: string): Promise<void> {
    const client = await this.ensureStarted();
    const result = asRec(await client.request('session/resume', { sessionId, workspace: this.workspaceRef() }));
    // adoptSnapshot 内部在会话变化时完成 subscribe(且带该会话自己的 afterSeq 水位)
    await this.adoptSnapshot(result);
    // 恢复旧会话后补注 provider 注册表(否则 prompt/enhance 会报 provider 未配置,实测)
    const runtimeModel = this.buildRuntimeModel();
    if (runtimeModel) {
      await client
        .request('session/updateRuntimeModelConfig', { sessionId, runtimeModel, applyModelSelection: true })
        .catch(() => {});
    }
    await this.refreshSessions();
  }

  private async subscribe(sessionId: string): Promise<void> {
    const client = this.clientOrThrow();
    const afterSeq = this.lastSeqBySession.get(sessionId) ?? 0;
    await client.request('session/subscribe', {
      sessionId,
      deliveryKind: DELIVERY_KIND,
      ...(afterSeq > 0 ? { afterSeq } : {}),
    });
    this.subscribedSessionId = sessionId;
  }

  /** 发送一轮输入;乐观追加用户消息,turn 结束后以快照刷新 */
  async send(content: string): Promise<void> {
    const client = this.clientOrThrow();
    const sid = this.state.current.sessionId;
    if (!sid) {
      throw new Error('没有活动会话');
    }
    this.state.current.messages.push({ id: `local-${Date.now()}`, role: 'user', parts: [{ kind: 'text', text: content }] });
    this.beginLive();
    this.pushNow();
    try {
      await client.request('session/send', { sessionId: sid, content });
    } catch (err) {
      // 请求本身失败(如超时/断连):结束 live 层避免 UI 永久"运行中"
      this.state.current.live.turnError = err instanceof Error ? err.message : String(err);
      this.endLive();
      this.pushNow();
      throw err;
    }
  }

  /** 运行中追加指令 */
  async steer(content: string): Promise<void> {
    const client = this.clientOrThrow();
    const sid = this.state.current.sessionId;
    if (!sid) {
      throw new Error('没有活动会话');
    }
    try {
      await client.request('session/steer', { sessionId: sid, content });
    } catch (err) {
      if (err instanceof ProtocolRequestError && err.code === -32602) {
        // steer schema 不明(文档风险 #7):退化为排队,turn 结束后再发
        const wait = setInterval(() => {
          if (this.disposed || !this.state.current.live.active) {
            clearInterval(wait);
            if (!this.disposed) {
              void this.send(content).catch(() => {});
            }
          }
        }, 500);
        return;
      }
      throw err;
    }
  }

  async stop(): Promise<void> {
    const client = this.clientOrThrow();
    const sid = this.state.current.sessionId;
    if (!sid) {
      return;
    }
    await client.request('session/stop', { sessionId: sid });
  }

  async setMode(mode: string): Promise<void> {
    const client = this.clientOrThrow();
    const sid = this.state.current.sessionId;
    if (!sid) {
      return;
    }
    await this.adoptSnapshot(asRec(await client.request('session/setMode', { sessionId: sid, mode })));
  }

  async setModel(model: { providerId: string; modelId: string; variant?: string }): Promise<void> {
    const client = this.clientOrThrow();
    const sid = this.state.current.sessionId;
    if (!sid) {
      return;
    }
    await this.adoptSnapshot(asRec(await client.request('session/setModel', { sessionId: sid, model })));
  }

  async fork(): Promise<string | null> {
    const client = this.clientOrThrow();
    const sid = this.state.current.sessionId;
    if (!sid) {
      return null;
    }
    if (this.state.current.live.active) {
      throw new Error('提示运行中无法分叉,请先等待或停止');
    }
    let r: Rec;
    try {
      r = asRec(await client.request('session/fork', { sessionId: sid }));
    } catch (err) {
      // 无可用 checkpoint(纯文本轮 / 已回退)→ 用最后一条消息作分叉点
      const msg = err instanceof Error ? err.message : String(err);
      const last = this.state.current.messages[this.state.current.messages.length - 1];
      if (!last || !/checkpoint/i.test(msg)) {
        throw err;
      }
      r = asRec(await client.request('session/fork', { sessionId: sid, target: { kind: 'message', messageId: last.id } }));
    }
    const forked = asStr(r.forkedSessionId);
    if (forked) {
      await this.openSession(forked);
    }
    return forked || null;
  }

  /** 回退到某条消息(对话维度);UI 从消息列表选目标 */
  async rewindToMessage(messageId: string): Promise<void> {
    const client = this.clientOrThrow();
    const sid = this.state.current.sessionId;
    if (!sid) {
      return;
    }
    const r = asRec(
      await client.request('session/rewind', {
        sessionId: sid,
        target: { kind: 'message', messageId },
        scope: 'conversation',
      })
    );
    await this.adoptSnapshot(asRec(r.snapshot));
    await this.refreshSessions();
  }

  async rewindToLatestCheckpoint(): Promise<void> {
    const client = this.clientOrThrow();
    const sid = this.state.current.sessionId;
    if (!sid) {
      return;
    }
    const r = asRec(
      await client.request('session/rewind', {
        sessionId: sid,
        target: { kind: 'latestCheckpoint' },
        scope: 'conversation',
      })
    );
    await this.adoptSnapshot(asRec(r.snapshot));
    await this.refreshSessions();
  }

  async usage(): Promise<Rec | null> {
    const client = this.client;
    const sid = this.state.current.sessionId;
    if (!client || !sid) {
      return null;
    }
    return asRec(await client.request('session/usage', { sessionId: sid }));
  }

  /** 工作区可选模型目录(workspace/readState → modelCatalog.available) */
  async getWorkspaceModels(): Promise<{ label: string; providerLabel: string; providerId: string; modelId: string }[]> {
    const client = await this.ensureStarted();
    const state = asRec(await client.request('workspace/readState', { workspace: this.workspaceRef() }));
    const catalog = asRec(state.modelCatalog);
    const available = Array.isArray(catalog.available) ? catalog.available : [];
    return available
      .map((m) => {
        const r = asRec(m);
        const ref = asRec(r.ref);
        return {
          label: asStr(r.label, asStr(ref.modelId)),
          providerLabel: asStr(r.providerLabel),
          providerId: asStr(ref.providerId),
          modelId: asStr(ref.modelId),
        };
      })
      .filter((m) => m.modelId && m.providerId);
  }

  /** UI 应答权限:原样回传选中 option 的预嵌 response(文档 §12 实测) */
  answerPermission(key: string, optionId: string): boolean {
    const perm = this.state.current.pendingPermissions.find((p) => p.key === key);
    if (!perm) {
      return false;
    }
    const opt = perm.options.find((o) => o.optionId === optionId);
    if (!opt) {
      // 过期/错误 optionId 不得静默回退到 options[0](通常是"允许")——那是权限旁路
      throw new Error(`权限选项无效或已过期:${optionId}`);
    }
    this.removePermission(key);
    this.permissionResolvers.get(key)?.(opt.response);
    this.permissionResolvers.delete(key);
    this.permissionFrameIds.delete(key);
    this.pushNow();
    return true;
  }

  dismissPermission(key: string): void {
    const perm = this.state.current.pendingPermissions.find((p) => p.key === key);
    this.removePermission(key);
    this.permissionResolvers.get(key)?.({ decision: 'deny', reason: 'dismissed' });
    this.permissionResolvers.delete(key);
    this.permissionFrameIds.delete(key);
    this.pushNow();
    void perm;
  }

  answerUserInput(key: string, action: 'accept' | 'decline', content?: Rec): boolean {
    const ui = this.state.current.pendingUserInputs.find((u) => u.key === key);
    if (!ui) {
      return false;
    }
    this.state.current.pendingUserInputs = this.state.current.pendingUserInputs.filter((u) => u.key !== key);
    this.userInputResolvers.get(key)?.(action === 'accept' ? { action: 'accept', content: content ?? {} } : { action: 'decline' });
    this.userInputResolvers.delete(key);
    this.userInputFrameIds.delete(key);
    this.pushNow();
    return true;
  }

  private removePermission(key: string): void {
    this.state.current.pendingPermissions = this.state.current.pendingPermissions.filter((p) => p.key !== key);
  }

  /* ---------- 服务器交互请求 ---------- */

  private handlePermissionRequest(params: Rec, frameId: FrameId): Promise<unknown> {
    const key = `perm:${++this.permSeq}:${asStr(params.requestId)}`;
    const options = Array.isArray(params.options) ? params.options : [];
    const perm: UIPermission = {
      key,
      requestId: asStr(params.requestId),
      toolName: asStr(params.toolName, '?'),
      reason: asStr(params.reason),
      riskLevel: (['low', 'medium', 'high', 'critical'].includes(asStr(params.riskLevel))
        ? asStr(params.riskLevel)
        : 'medium') as UIPermission['riskLevel'],
      input: params.input,
      options: options.map((o) => {
        const r = asRec(o);
        return {
          optionId: asStr(r.optionId),
          kind: asStr(r.kind),
          name: asStr(r.name, asStr(r.optionId)),
          description: typeof r.description === 'string' ? r.description : undefined,
          response: r.response,
        };
      }),
      requestedAt: Date.now(),
    };
    this.state.current.pendingPermissions.push(perm);
    this.pushNow();
    this.permissionFrameIds.set(key, frameId);
    return new Promise<unknown>((resolve) => this.permissionResolvers.set(key, resolve));
  }

  private handleUserInputRequest(params: Rec, frameId: FrameId): Promise<unknown> {
    const key = `ui:${++this.permSeq}:${asStr(params.requestId)}`;
    const schema = asRec(params.schema);
    const questions = Array.isArray(params.questions)
      ? params.questions.map((q) => {
          const r = asRec(q);
          return {
            question: asStr(r.question),
            header: typeof r.header === 'string' ? r.header : undefined,
            options: Array.isArray(r.options)
              ? r.options.map((o) => {
                  const or = asRec(o);
                  return {
                    value: asStr(or.value),
                    label: asStr(or.label, asStr(or.value)),
                    description: typeof or.description === 'string' ? or.description : undefined,
                  };
                })
              : undefined,
            multiSelect: r.multiSelect === true,
          };
        })
      : [];
    const input: UIUserInput = {
      key,
      requestId: asStr(params.requestId),
      prompt: typeof params.prompt === 'string' ? params.prompt : undefined,
      questions,
      interaction: asStr(schema.interaction) || undefined,
    };
    this.state.current.pendingUserInputs.push(input);
    this.pushNow();
    this.userInputFrameIds.set(key, frameId);
    return new Promise<unknown>((resolve) => this.userInputResolvers.set(key, resolve));
  }

  /* ---------- 通知与投影 ---------- */

  private handleNotification(method: string, params: unknown): void {
    if (method === 'session/event') {
      this.handleSessionEvent(asRec(params));
    } else if (method === 'state.updated') {
      const r = asRec(params);
      if (r.scope === 'session' && asStr(r.sessionId) === this.state.current.sessionId) {
        this.scheduleSnapshotRefresh();
      } else if (r.scope === 'workspace') {
        void this.refreshSessions().catch(() => {});
      }
    }
  }

  private snapshotRefreshTimer: NodeJS.Timeout | null = null;

  private scheduleSnapshotRefresh(): void {
    if (this.snapshotRefreshTimer) {
      return;
    }
    this.snapshotRefreshTimer = setTimeout(() => {
      this.snapshotRefreshTimer = null;
      const sid = this.state.current.sessionId;
      const client = this.client;
      if (!sid || !client) {
        return;
      }
      void client
        .request('session/read', { sessionId: sid, deliveryKind: DELIVERY_KIND })
        .then((snap) => this.adoptSnapshot(asRec(snap)))
        .catch(() => {});
    }, 400);
  }

  private handleSessionEvent(params: Rec): void {
    const payload = asRec(params.payload);
    const env: EventEnvelope = {
      seq: asNum(params.seq),
      type: asStr(params.type),
      payload,
      sessionId: asStr(params.sessionId) || undefined,
    };
    if (env.sessionId && env.sessionId !== this.state.current.sessionId) {
      return; // 其他会话事件(如 fork 出的子会话)忽略
    }
    // seq 是每会话的事件序号(types.ts §3.1 session/subscribe):水位必须按会话维度推进,
    // 否则切会话时会把 A 会话的 seq 当作 B 的 afterSeq(事件丢失/订阅失败)
    const sid = this.state.current.sessionId;
    if (sid && env.seq > (this.lastSeqBySession.get(sid) ?? 0)) {
      this.lastSeqBySession.set(sid, env.seq);
    }
    switch (env.type) {
      case 'turn.started':
        this.beginLive();
        break;
      case 'model.streaming': {
        const kind = asStr(env.payload.kind);
        if (kind === 'text_delta' && typeof env.payload.delta === 'string') {
          this.state.current.live.streamingText += env.payload.delta;
        }
        break;
      }
      case 'part.delta': {
        const field = asStr(env.payload.field);
        if (field === 'reasoning' && typeof env.payload.delta === 'string') {
          this.state.current.live.reasoningText += env.payload.delta;
        }
        break;
      }
      case 'tool.updated':
        this.applyToolUpdate(env.payload);
        break;
      case 'permission.resolved': {
        const reqId = asStr(env.payload.requestId);
        const perm = this.state.current.pendingPermissions.find((p) => p.requestId === reqId);
        if (perm) {
          this.removePermission(perm.key);
          this.abandonInteraction(perm.key, this.permissionFrameIds, this.permissionResolvers);
        }
        break;
      }
      case 'userInput.resolved': {
        const reqId = asStr(env.payload.requestId);
        const ui = this.state.current.pendingUserInputs.find((u) => u.requestId === reqId);
        if (ui) {
          this.state.current.pendingUserInputs = this.state.current.pendingUserInputs.filter((u) => u !== ui);
          this.abandonInteraction(ui.key, this.userInputFrameIds, this.userInputResolvers);
        }
        break;
      }
      case 'checkpoint.created': {
        const cp = asStr(env.payload.checkpointId) || asStr(env.payload.id);
        if (cp) {
          this.latestCheckpointId = cp;
        }
        break;
      }
      case 'turn.completed':
      case 'turn.failed': {
        if (env.type === 'turn.failed') {
          const err = asRec(env.payload.error);
          this.state.current.live.turnError = asStr(err.message, 'turn failed');
        }
        this.endLive();
        this.scheduleSnapshotRefresh();
        void this.refreshSessions().catch(() => {});
        break;
      }
      default:
        break;
    }
    this.push();
  }

  private beginLive(): void {
    const live = this.state.current.live;
    live.active = true;
    live.streamingText = '';
    live.reasoningText = '';
    live.toolCalls = [];
    live.turnError = undefined;
    this.state.current.status = 'running';
  }

  private endLive(): void {
    this.state.current.live.active = false;
    this.state.current.status = 'idle';
  }

  /** 服务器已在别处结算该交互:先标记其服务器请求"已应答"(后续 respond 不再发帧),
   *  再结算本地 handler Promise——只删不调会让 client 内的 Promise 永久悬挂(泄漏) */
  private abandonInteraction(
    key: string,
    frameIds: Map<string, FrameId>,
    resolvers: Map<string, (v: unknown) => void>
  ): void {
    const fid = frameIds.get(key);
    if (fid !== undefined) {
      this.client?.abandonServerRequest(fid);
      frameIds.delete(key);
    }
    resolvers.get(key)?.({ decision: 'deny', reason: 'resolved elsewhere' });
    resolvers.delete(key);
  }

  private applyToolUpdate(payload: Rec): void {
    const kind = asStr(payload.kind);
    const toolCallId = asStr(payload.toolCallId);
    if (!toolCallId) {
      return;
    }
    const calls = this.state.current.live.toolCalls;
    let call = calls.find((c) => c.toolCallId === toolCallId);
    if (!call && (kind === 'scheduled' || kind === 'started')) {
      call = { toolCallId, toolName: asStr(payload.toolName, '?'), status: 'scheduled' };
      calls.push(call);
    }
    if (!call) {
      return;
    }
    switch (kind) {
      case 'scheduled':
        call.status = 'scheduled';
        call.toolName = asStr(payload.toolName, call.toolName);
        call.input = payload.input ?? call.input;
        call.subagent = asStr(payload.source) === 'subagent' || !!payload.agentId;
        break;
      case 'started':
        call.status = 'running';
        break;
      case 'progress':
        call.progress = {
          elapsedMs: asNum(payload.elapsedMs, call.progress?.elapsedMs ?? 0),
          stdoutTail: asStr(payload.stdoutTail) || call.progress?.stdoutTail,
          stderrTail: asStr(payload.stderrTail) || call.progress?.stderrTail,
        };
        break;
      case 'result':
        call.status = 'completed';
        call.result = payload.result;
        call.duration = asNum(payload.duration);
        break;
      case 'error':
        call.status = 'failed';
        call.error = payload.error;
        break;
      default:
        break;
    }
  }

  /* ---------- 快照采纳 ---------- */

  private async adoptSnapshot(snapshot: Rec): Promise<void> {
    const session = asRec(snapshot.session);
    const sessionId = asStr(session.sessionId);
    if (!sessionId) {
      return;
    }
    const cur = this.state.current;
    const sessionChanged = cur.sessionId !== null && cur.sessionId !== sessionId;
    if (sessionChanged) {
      // 旧会话的事件流不再属于当前视图(其 turn.completed 会被 sessionId 过滤丢弃):
      // 结算挂起交互、复位 live 层,否则 UI 永久卡"运行中"、跨端同步轮询被冻结
      this.settlePendingInteractions('会话已切换');
      if (cur.live.active) {
        cur.live.turnError = undefined;
        this.endLive();
      }
    }
    cur.sessionId = sessionId;
    cur.title = asStr(session.title);
    const seenUpdatedAt = asNum(session.updatedAt);
    if (seenUpdatedAt > 0 && seenUpdatedAt > (this.lastSeenUpdatedAtBySession.get(sessionId) ?? 0)) {
      this.lastSeenUpdatedAtBySession.set(sessionId, seenUpdatedAt);
    }
    cur.mode = asStr(asRec(asRec(snapshot.settings).mode).current) || asStr(session.mode, cur.mode);
    cur.status = asStr(session.status, 'idle');
    cur.messages = this.projectMessages(snapshot);
    cur.slashCommands = this.projectSlashCommands(snapshot);
    const projection = asRec(snapshot.projection);
    cur.contextUsed = asNum(projection.contextUsed);
    cur.contextWindow = asNum(projection.contextWindow);
    const settings = asRec(snapshot.settings);
    // settings.model = {available:[], current:{providerId,modelId}};session.mode 为创建时静态值
    cur.modelLabel = modelLabel(asRec(settings.model).current) || modelLabel(settings.modelRef) || cur.modelLabel;
    const runtime = asRec(snapshot.runtime);
    this.stateRevision = asNum(runtime.stateRevision, this.stateRevision);
    const eventSeq = asNum(runtime.eventSeq);
    if (eventSeq > 0 && eventSeq > (this.lastSeqBySession.get(sessionId) ?? 0)) {
      this.lastSeqBySession.set(sessionId, eventSeq);
    }
    if (this.subscribedSessionId !== sessionId) {
      await this.subscribe(sessionId);
    }
    this.pushNow();
  }

  private projectSlashCommands(snapshot: Rec): UISlashCommand[] {
    const raw = snapshot.slashCommands;
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw
      .map((c) => {
        if (typeof c === 'string') {
          return { name: c };
        }
        const r = asRec(c);
        const name = asStr(r.name) || asStr(r.command) || asStr(r.id);
        return name ? { name, description: typeof r.description === 'string' ? r.description : undefined } : null;
      })
      .filter((c): c is UISlashCommand => c !== null);
  }

  /** 提示词增强(prompt/enhance,同步版;失败返回原文) */
  async enhancePrompt(prompt: string): Promise<string> {
    const client = await this.ensureStarted();
    const r = asRec(
      await client.request('prompt/enhance', { workspace: this.workspaceRef(), prompt, context: [] }, 60_000)
    );
    const enhanced = asStr(r.enhanced);
    return enhanced.trim() ? enhanced : prompt;
  }

  /** 压缩会话上下文(session/compact) */
  async compact(): Promise<void> {
    const client = this.clientOrThrow();
    const sid = this.state.current.sessionId;
    if (!sid) {
      return;
    }
    const r = asRec(await client.request('session/compact', { sessionId: sid }, 180_000));
    const snap = asRec(r.snapshot);
    if (snap.session) {
      await this.adoptSnapshot(snap);
    }
  }

  private projectMessages(snapshot: Rec): UIMessage[] {
    const messages = Array.isArray(snapshot.messages) ? snapshot.messages : [];
    const out: UIMessage[] = [];
    for (const m of messages) {
      const rec = asRec(m);
      const info = asRec(rec.info);
      const parts = Array.isArray(rec.parts) ? rec.parts : [];
      const uiParts: UIPart[] = [];
      for (const p of parts) {
        const pr = asRec(p);
        switch (asStr(pr.type)) {
          case 'text':
            if (asStr(pr.text)) {
              uiParts.push({ kind: 'text', text: asStr(pr.text) });
            }
            break;
          case 'reasoning':
            if (asStr(pr.text)) {
              uiParts.push({ kind: 'reasoning', text: asStr(pr.text) });
            }
            break;
          case 'tool': {
            const state = asRec(pr.state);
            const call: UIToolCall = {
              toolCallId: asStr(pr.callId),
              toolName: asStr(pr.tool, '?'),
              status: (['scheduled', 'running', 'completed', 'failed'].includes(asStr(state.status))
                ? asStr(state.status)
                : 'completed') as UIToolCall['status'],
              input: state.input,
              result: state.result ?? state.output,
            };
            uiParts.push({ kind: 'tool', call });
            break;
          }
          case 'patch': {
            const files = Array.isArray(pr.files) ? pr.files.map(String) : [];
            if (files.length) {
              uiParts.push({ kind: 'patch', files });
            }
            break;
          }
          case 'step-finish': {
            const tokens = asRec(pr.tokens);
            const total = asNum(tokens.total);
            if (total > 0) {
              uiParts.push({ kind: 'meta', label: `${total.toLocaleString()} tokens` });
            }
            break;
          }
          default:
            break;
        }
      }
      if (uiParts.length) {
        out.push({ id: asStr(info.messageId, `msg-${out.length}`), role: asStr(info.role, 'assistant'), parts: uiParts });
      }
    }
    return out;
  }

  /* ---------- 渲染推送(节流) ---------- */

  private push(): void {
    if (this.pushTimer) {
      return;
    }
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      this.pushNow();
    }, 33);
  }

  private pushNow(): void {
    const snapshot = JSON.parse(JSON.stringify(this.state)) as UIState;
    for (const cb of this.listeners) {
      cb(snapshot);
    }
  }
}
