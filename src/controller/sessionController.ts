import * as crypto from 'crypto';
import * as fsSync from 'fs';
import * as os from 'os';
import * as pathMod from 'path';
import { ProtocolTransport, type TransportExitInfo } from '../protocol/transport.ts';
import { ProtocolClient, ProtocolRequestError } from '../protocol/client.ts';
import { resolveBinariesPure } from '../protocol/binaries.ts';

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
}

const DELIVERY_KIND = 'desktop-continuous';

export class SessionController {
  private readonly opts: SessionControllerOptions;
  private transport: ProtocolTransport | null = null;
  private client: ProtocolClient | null = null;
  private restartAttempts = 0;
  private disposed = false;

  private lastSeq = 0;
  private stateRevision = 0;
  private subscribedSessionId: string | null = null;
  private latestCheckpointId: string | null = null;
  private permSeq = 0;

  /** key → resolver(UI 应答权限/用户输入) */
  private readonly permissionResolvers = new Map<string, (v: unknown) => void>();
  private readonly userInputResolvers = new Map<string, (v: unknown) => void>();

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

    const bins = resolveBinariesPure({ nodePath: this.opts.nodePath, cliPath: this.opts.cliPath });
    if (!bins.cli) {
      this.state.connection = 'failed';
      this.state.connectionError = `未找到 ZCode CLI:${bins.detail}`;
      this.pushNow();
      throw new Error(this.state.connectionError);
    }
    const transport: ProtocolTransport = new ProtocolTransport({
      command: bins.node,
      args: [bins.cli, 'app-server', '--stdio'],
      cwd: this.opts.workspacePath,
      env: process.env,
    });
    const client = new ProtocolClient(transport);
    transport.setOnFrame((f) => client.handleFrame(f));
    transport.setOnStderrLine((l) => this.opts.onLogLine?.(l));
    transport.setOnExit((info) => this.handleTransportExit(info));
    transport.start();
    this.transport = transport;
    void this.transport;
    this.client = client;
    client.setOnNotification((method, params) => this.handleNotification(method, params));
    client.registerServerRequestHandler('interaction/requestPermission', (frame) =>
      this.handlePermissionRequest(asRec(frame.params))
    );
    client.registerServerRequestHandler('interaction/requestUserInput', (frame) =>
      this.handleUserInputRequest(asRec(frame.params))
    );
    client.registerServerRequestHandler('interaction/requestProviderRuntimeHeaders', () => ({
      headersApplied: false,
    }));
    this.state.connection = 'connected';
    this.pushNow();
    return client;
  }

  private handleTransportExit(info: TransportExitInfo): void {
    this.client = null;
    this.transport = null;
    if (this.disposed) {
      return;
    }
    // 结算所有挂起 UI 交互
    for (const p of this.state.current.pendingPermissions) {
      this.permissionResolvers.get(p.key)?.({ decision: 'deny', reason: 'connection lost' });
    }
    this.permissionResolvers.clear();
    this.state.current.pendingPermissions = [];
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
      } catch {
        /* 状态已在 ensureStarted 内标记 */
      }
    })();
  }

  dispose(): void {
    this.disposed = true;
    this.client?.dispose();
    this.client = null;
    this.transport = null;
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
    await this.adoptSnapshot(result);
    await this.subscribe(sessionId);
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
    await client.request('session/subscribe', {
      sessionId,
      deliveryKind: DELIVERY_KIND,
      ...(this.lastSeq > 0 ? { afterSeq: this.lastSeq } : {}),
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
    const opt = perm.options.find((o) => o.optionId === optionId) ?? perm.options[0];
    this.removePermission(key);
    this.permissionResolvers.get(key)?.(opt.response);
    this.permissionResolvers.delete(key);
    this.pushNow();
    return true;
  }

  dismissPermission(key: string): void {
    const perm = this.state.current.pendingPermissions.find((p) => p.key === key);
    this.removePermission(key);
    this.permissionResolvers.get(key)?.({ decision: 'deny', reason: 'dismissed' });
    this.permissionResolvers.delete(key);
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
    this.pushNow();
    return true;
  }

  private removePermission(key: string): void {
    this.state.current.pendingPermissions = this.state.current.pendingPermissions.filter((p) => p.key !== key);
  }

  /* ---------- 服务器交互请求 ---------- */

  private handlePermissionRequest(params: Rec): Promise<unknown> {
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
    return new Promise<unknown>((resolve) => this.permissionResolvers.set(key, resolve));
  }

  private handleUserInputRequest(params: Rec): Promise<unknown> {
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
      prompt: typeof params.prompt === 'string' ? params.prompt : undefined,
      questions,
      interaction: asStr(schema.interaction) || undefined,
    };
    this.state.current.pendingUserInputs.push(input);
    this.pushNow();
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
    if (env.seq > this.lastSeq) {
      this.lastSeq = env.seq;
    }
    if (env.sessionId && env.sessionId !== this.state.current.sessionId) {
      return; // 其他会话事件(如 fork 出的子会话)忽略
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
          this.permissionResolvers.delete(perm.key);
        }
        break;
      }
      case 'userInput.resolved': {
        const reqId = asStr(env.payload.requestId);
        const ui = this.state.current.pendingUserInputs.find((u) => u.key.endsWith(reqId));
        if (ui) {
          this.state.current.pendingUserInputs = this.state.current.pendingUserInputs.filter((u) => u !== ui);
          this.userInputResolvers.delete(ui.key);
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
    cur.sessionId = sessionId;
    cur.title = asStr(session.title);
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
    if (eventSeq > this.lastSeq) {
      this.lastSeq = eventSeq;
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
