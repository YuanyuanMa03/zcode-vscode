// ZCode Protocol v1 类型定义。
// 字段名逐字对齐协议逆向文档 /Users/mayuanyuan/Desktop/zcode-vscode-research/zcode-app-server-protocol.md(§ 引用均指该文档)。
// 宽松策略:接收侧类型(payload/result)一律带 `[k: string]: unknown` 兼容字段漂移(§11.7),
// 解析层不做运行时校验;发送侧 params 保持精确,借编译器保证"只发文档内字段"(§11.4)。

// ---------- 帧格式(§1.2) ----------

/** 帧 id:字符串或整数。客户端请求为从 1 递增的数字,服务器请求为 "server-N" 字符串(§1.3) */
export type FrameId = string | number

/** 可选 trace 透传(§1.2 Vkt) */
export interface TraceInfo {
  traceId?: string
  parentId?: string
  spanId?: string
  traceparent?: string
}

/** 请求帧(双向) */
export interface RequestFrame {
  id: FrameId
  method: string
  params?: unknown
  trace?: TraceInfo
}

/** 通知帧(双向,无 id) */
export interface NotificationFrame {
  method: string
  params?: unknown
  trace?: TraceInfo
}

/** 成功响应帧 */
export interface SuccessResponseFrame {
  id: FrameId
  result: unknown
}

/** 错误响应体(§1.2 Ien.error、§5.6 错误码表) */
export interface ProtocolErrorBody {
  code: number
  message: string
  data?: unknown
}

/** 错误响应帧 */
export interface ErrorResponseFrame {
  id: FrameId
  error: ProtocolErrorBody
}

export type ProtocolFrame = RequestFrame | NotificationFrame | SuccessResponseFrame | ErrorResponseFrame

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/**
 * 四元分类(§11.2):id+result/error → 响应;id+method → 服务器请求;仅 method → 通知。
 * 分类顺序与服务器一致:先判响应,再判请求,最后判通知(§1.4)。
 */
export function isSuccessResponseFrame(frame: unknown): frame is SuccessResponseFrame {
  return isRecord(frame) && 'id' in frame && 'result' in frame
}

export function isErrorResponseFrame(frame: unknown): frame is ErrorResponseFrame {
  return isRecord(frame) && 'id' in frame && 'error' in frame
}

export function isRequestFrame(frame: unknown): frame is RequestFrame {
  return isRecord(frame) && 'id' in frame && 'method' in frame && !('result' in frame) && !('error' in frame)
}

export function isNotificationFrame(frame: unknown): frame is NotificationFrame {
  return isRecord(frame) && !('id' in frame) && 'method' in frame
}

// ---------- 通用枚举与子 schema(§3.4) ----------

export type SessionMode = 'plan' | 'build' | 'edit' | 'yolo' | 'auto'
export type SessionStatus = 'idle' | 'running' | 'waiting' | 'paused' | 'completed' | 'error'
export type SessionKind =
  | 'interactive'
  | 'fork'
  | 'workflow_parent'
  | 'workflow_child'
  | 'subagent_child'
  | 'nested_workflow_child'
export type DeliveryKind = 'desktop-continuous' | 'web-remote-replayable'
export type Persistence = 'immediate' | 'deferred'
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical'
export type InputSource =
  | 'background_task'
  | 'fork'
  | 'goal_state_change'
  | 'goal-continuation'
  | 'rewind'
  | 'subagent'
  | 'subagent_message'
  | 'todo_reminder'
export type InputVisibility = 'user-visible' | 'model-only'

/** §3.4 workspaceRef */
export interface WorkspaceRef {
  workspacePath: string
  workspaceIdentity?: string
  workspaceKey: string
}

/** §3.4 modelRef */
export interface ModelRef {
  providerId: string
  modelId: string
  variant?: string
}

/** §3.4 runtimeModel(provider 形状未转录,按宽松处理) */
export interface RuntimeModel {
  revision: string
  generatedAt: number
  model: ModelRef
  provider: unknown
  thoughtLevel?: string
}

/** §3.4 mcpServers stdio 分支 */
export interface StdioMcpServer {
  name: string
  command: string
  args: string[]
  env: Array<{ name: string; value: string }>
  timeoutMs?: number
}

/** §3.4 mcpServers http/sse 分支(headers 元素形状未转录,按宽松处理) */
export interface RemoteMcpServer {
  name: string
  type: 'http' | 'sse'
  url: string
  headers: unknown[]
  oauth?: unknown
  timeoutMs?: number
}

export type McpServerConfig = StdioMcpServer | RemoteMcpServer

/** §3.4 importedHistory */
export interface ImportedHistoryMessage {
  role: 'user' | 'assistant'
  content: string
  timestamp?: unknown
}

export interface ImportedHistory {
  source: 'claudeCode'
  title?: string
  createdAt?: unknown
  updatedAt?: unknown
  /** 至少 1 条(zod .min(1)) */
  messages: ImportedHistoryMessage[]
}

/** §7.2 rewind/fork target */
export type RewindTarget =
  | { kind: 'turn'; turnIndex: number }
  | { kind: 'message'; messageId: string }
  | { kind: 'checkpoint'; checkpointId: string }
  | { kind: 'latestCheckpoint' }

/** §4.2 turn.failed 的 error / §6.2 tool.updated error 共用 */
export interface ProtocolErrorDetail {
  [k: string]: unknown
  type: string
  message: string
  stack?: string
  code?: unknown
  detail?: unknown
  retryable?: boolean
  data?: unknown
}

// ---------- 消息与部件(§6.1) ----------

interface MessagePartBase {
  [k: string]: unknown
  partId: string
  sessionId: string
  messageId: string
}

export interface TextMessagePart extends MessagePartBase {
  type: 'text'
  text: string
  synthetic?: boolean
  ignored?: boolean
  metadata?: unknown
}

export interface ReasoningMessagePart extends MessagePartBase {
  type: 'reasoning'
  text: string
  metadata?: unknown
}

export interface FileMessagePart extends MessagePartBase {
  type: 'file'
  mime: string
  filename?: string
  url: string
  metadata?: unknown
}

export interface ToolMessagePart extends MessagePartBase {
  type: 'tool'
  callId: string
  tool: string
  state: ToolState
  metadata?: unknown
}

export interface StepStartMessagePart extends MessagePartBase {
  type: 'step-start'
  snapshot?: unknown
}

export interface StepFinishMessagePart extends MessagePartBase {
  type: 'step-finish'
  reason: unknown
  snapshot?: unknown
  cost: unknown
  tokens: unknown
}

export interface SnapshotMessagePart extends MessagePartBase {
  type: 'snapshot'
  snapshot: unknown
}

/** 文件编辑 diff 的载体:变更后文件列表 + 哈希(§6.1) */
export interface PatchMessagePart extends MessagePartBase {
  type: 'patch'
  hash: string
  files: string[]
}

export interface CompactionMessagePart extends MessagePartBase {
  type: 'compaction'
  auto: boolean
  reason?: string
  summaryMessageId?: string
  metadata?: unknown
}

export interface SubagentMessagePart extends MessagePartBase {
  type: 'subagent'
  prompt: string
  description: string
  agent: string
  model?: unknown
  command?: unknown
}

export interface AgentMessagePart extends MessagePartBase {
  type: 'agent'
  name: string
}

export interface RetryMessagePart extends MessagePartBase {
  type: 'retry'
  attempt: number
  error: Record<string, unknown>
}

export type MessagePart =
  | TextMessagePart
  | ReasoningMessagePart
  | FileMessagePart
  | ToolMessagePart
  | StepStartMessagePart
  | StepFinishMessagePart
  | SnapshotMessagePart
  | PatchMessagePart
  | CompactionMessagePart
  | SubagentMessagePart
  | AgentMessagePart
  | RetryMessagePart

/** §6.1 ToolState(discriminatedUnion("status");completed 之后切片截断,按宽松处理) */
export type ToolState =
  | { [k: string]: unknown; status: 'pending'; input: unknown; raw: unknown }
  | { [k: string]: unknown; status: 'running'; input: unknown; title?: string; metadata?: unknown; startedAt: unknown }
  | { [k: string]: unknown; status: 'completed'; input: unknown }

// ---------- 会话快照(§6.3) ----------

export interface SessionInfo {
  [k: string]: unknown
  sessionId: string
  workspace: WorkspaceRef
  parentSessionId?: string
  traceId?: string
  sessionKind: SessionKind
  title: string
  titleSource?: string
  mode: SessionMode
  status: SessionStatus
  model?: ModelRef
  target?: unknown
  createdAt: unknown
  updatedAt: unknown
  archivedAt?: unknown
}

/** §6.3 projection.pendingPermissions 元素 */
export interface PendingPermissionInfo {
  [k: string]: unknown
  requestId: string
  toolCallId: string
  toolName: string
  reason: string
  riskLevel: RiskLevel
  input?: unknown
  origin?: SubagentOrigin
  options: PermissionOption[]
  requestedAt: unknown
}

/** §6.3 projection.activeToolCalls 元素 */
export interface ActiveToolCallInfo {
  [k: string]: unknown
  toolCallId: string
  toolName: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'denied'
  startedAt?: unknown
}

export interface SessionProjection {
  [k: string]: unknown
  sessionId: string
  status: SessionStatus
  mode: SessionMode
  turnCount: number
  totalTokenCount: number
  contextUsed: number
  contextWindow: number
  currentTurnId?: string
  pendingPermissions: PendingPermissionInfo[]
  activeToolCalls: ActiveToolCallInfo[]
  backgroundJobs: unknown[]
}

export interface SessionRuntimeState {
  [k: string]: unknown
  eventSeq: number
  stateRevision: number
  deliveryKind?: DeliveryKind
  activeTurnId?: string
  activeTurnKind?: 'regular' | 'compact' | 'rewind'
  mainActive?: boolean
  pendingRequestIds: string[]
  apiRetry?: unknown
  contextUsage?: unknown
}

/** MessageInfo / SessionSettingsState / TokenUsage 完整 zod 未转录(§11.7),按宽松 JSON 对象处理 */
export type MessageInfo = Record<string, unknown>

export interface MessageWithParts {
  [k: string]: unknown
  info: MessageInfo
  parts: MessagePart[]
}

/** §6.3 SessionStateSnapshot(create/resume/read/setModel/setMode/setThoughtLevel 的 result) */
export interface SessionStateSnapshot {
  [k: string]: unknown
  protocol: { name: string; version: number }
  session: SessionInfo
  settings: Record<string, unknown>
  projection: SessionProjection
  runtime: SessionRuntimeState
  messages: MessageWithParts[]
  goalStats?: unknown
  todos?: unknown
  todoGroups?: unknown
  slashCommands?: unknown
}

/** WorkspaceStateSnapshot 未逐字转录(§11.7),按宽松 JSON 对象处理 */
export type WorkspaceStateSnapshot = Record<string, unknown>

// ---------- session/event 通知(§4.2) ----------

/** §4.2 信封(strict) */
export interface SessionEventEnvelope {
  eventId: string
  sessionId: string
  turnId?: string
  seq: number
  traceId?: string
  timestamp: number
  deliveryKind?: DeliveryKind
}

/** 25 种 type(§4.2 逐字) */
export type SessionEventType =
  | 'session.created'
  | 'session.resumed'
  | 'session.updated'
  | 'session.titleUpdated'
  | 'session.closed'
  | 'turn.started'
  | 'turn.steerQueued'
  | 'turn.steerDrained'
  | 'turn.completed'
  | 'turn.failed'
  | 'message.upserted'
  | 'message.removed'
  | 'part.started'
  | 'part.delta'
  | 'part.upserted'
  | 'part.removed'
  | 'model.streaming'
  | 'tool.updated'
  | 'permission.requested'
  | 'permission.resolved'
  | 'userInput.requested'
  | 'userInput.resolved'
  | 'checkpoint.created'
  | 'rewind.triggered'
  | 'streamRecovery.updated'

export interface SessionCreatedPayload {
  [k: string]: unknown
  mode: SessionMode
  contextWindow: number
}

export interface SessionResumedPayload {
  [k: string]: unknown
  directory: string
  interruptedToolCount: number
  messageCount: number
  partCount: number
  recoveredCompactTimelineCount?: number
  recoveredSteerInputCount?: number
  resumedTodoCount?: number
}

export interface SessionTitleUpdatedPayload {
  [k: string]: unknown
  /** 字段名为 messageID(大写 ID,协议原文) */
  messageID?: string
  modelRef?: ModelRef
  previousTitle: string
  source: 'default' | 'first_input' | 'generated' | 'custom'
  title: string
}

export interface SessionClosedPayload {
  [k: string]: unknown
  reason?: string
}

export interface TurnStartedPayload {
  [k: string]: unknown
  turnNumber: number
  input: string
  inputId?: string
  queryId?: string
  inputSource?: InputSource
  inputVisibility?: InputVisibility
  targetId?: string
}

export interface TurnSteerQueuedPayload {
  [k: string]: unknown
  pendingInputId: string
  inputId?: string
  queryId?: string
  input: string
  inputPreview: string
  inputSize: number
  source?: string
  targetTurnId: string
  queueLength: number
}

export interface TurnSteerDrainedPayload {
  [k: string]: unknown
  pendingInputIds: string[]
  queryIds?: string[]
  targetTurnId: string
  injectedMessageIds: string[]
}

/** usage 形状(TokenUsage)未转录(§11.7) */
export interface TurnCompletedPayload {
  [k: string]: unknown
  response: unknown
  tokenCount: number
  usage?: unknown
  toolCallCount: number
  duration: number
}

export interface TurnFailedPayload {
  [k: string]: unknown
  error: ProtocolErrorDetail
  turnPhase: string
  inputId?: string
}

export interface MessageUpsertedPayload {
  [k: string]: unknown
  content: unknown
  attachments?: unknown
  toolCalls?: unknown
  type?: unknown
  compactBoundary?: unknown
}

export interface MessageRemovedPayload {
  [k: string]: unknown
  messageId: string
  reason?: string
}

export interface PartDeltaPayload {
  [k: string]: unknown
  messageId: string
  partId: string
  field?: 'text' | 'reasoning' | 'input' | 'output'
  delta: string
}

export interface PartUpsertedPayload {
  [k: string]: unknown
  part: MessagePart
}

export interface PartRemovedPayload {
  [k: string]: unknown
  messageId: string
  partId: string
  reason?: string
}

export interface ModelStreamingPayload {
  [k: string]: unknown
  assistantMessageId?: string
  delta?: string
  done?: boolean
  input?: unknown
  kind: string
  partId?: string
  providerExecuted?: unknown
  toolCallId?: string
  toolName?: string
}

/**
 * §6.2 tool.updated payload(discriminatedUnion("kind"))。
 * 除 batch 外各 kind 共有 base 字段;为避免重复书写直接内联(batch 分支无 base 字段)。
 */
export type ToolUpdatedPayload =
  | {
      [k: string]: unknown
      kind: 'scheduled'
      toolCallId: string
      toolName: string
      parentToolCallId?: string
      source?: string
      agentId?: string
      agentType?: string
      childSessionId?: string
      childToolCallId?: string
      description?: string
      input?: unknown
      inputByteLength?: number
      inputOmitted?: boolean
      inputRef?: string
      dependencies?: unknown
      parallelGroupIndex?: number
      canRunParallel?: boolean
      schedule?: unknown
    }
  | {
      [k: string]: unknown
      kind: 'started'
      toolCallId: string
      toolName?: string
      parentToolCallId?: string
      source?: string
      agentId?: string
      agentType?: string
      childSessionId?: string
      childToolCallId?: string
      description?: string
      startedAt: number | string | Date
    }
  | {
      [k: string]: unknown
      kind: 'progress'
      toolCallId: string
      toolName?: string
      parentToolCallId?: string
      source?: string
      agentId?: string
      agentType?: string
      childSessionId?: string
      childToolCallId?: string
      description?: string
      elapsedMs?: number
      pid?: number
      stdoutBytes?: number
      stderrBytes?: number
      outputBytes?: number
      stdoutTail?: string
      stderrTail?: string
    }
  | {
      [k: string]: unknown
      kind: 'result'
      toolCallId: string
      toolName?: string
      parentToolCallId?: string
      source?: string
      agentId?: string
      agentType?: string
      childSessionId?: string
      childToolCallId?: string
      description?: string
      result: Record<string, unknown>
      duration: number
    }
  | {
      [k: string]: unknown
      kind: 'error'
      toolCallId: string
      toolName?: string
      parentToolCallId?: string
      source?: string
      agentId?: string
      agentType?: string
      childSessionId?: string
      childToolCallId?: string
      description?: string
      error: ProtocolErrorDetail
    }
  | {
      [k: string]: unknown
      kind: 'batch'
      toolCallIds: string[]
      successCount: number
      errorCount: number
    }
  | {
      [k: string]: unknown
      kind: 'raw'
      toolCallId: string
      toolName?: string
      parentToolCallId?: string
      source?: string
      agentId?: string
      agentType?: string
      childSessionId?: string
      childToolCallId?: string
      description?: string
      payload: Record<string, unknown>
    }

/** §5.6 事件镜像:requested 与 interaction 请求 params 同形;resolved 形状未逐字转录,按宽松 JSON */
export type PermissionRequestedPayload = InteractionRequestPermissionParams
export type PermissionResolvedPayload = Record<string, unknown>
export type UserInputRequestedPayload = InteractionRequestUserInputParams
export type UserInputResolvedPayload = Record<string, unknown>

export interface SessionEventPayloadMap {
  'session.created': SessionCreatedPayload
  'session.resumed': SessionResumedPayload
  /** 宽松 jsonObject(§4.2) */
  'session.updated': Record<string, unknown>
  'session.titleUpdated': SessionTitleUpdatedPayload
  'session.closed': SessionClosedPayload
  'turn.started': TurnStartedPayload
  'turn.steerQueued': TurnSteerQueuedPayload
  'turn.steerDrained': TurnSteerDrainedPayload
  'turn.completed': TurnCompletedPayload
  'turn.failed': TurnFailedPayload
  'message.upserted': MessageUpsertedPayload
  'message.removed': MessageRemovedPayload
  'part.started': PartUpsertedPayload
  'part.delta': PartDeltaPayload
  'part.upserted': PartUpsertedPayload
  'part.removed': PartRemovedPayload
  'model.streaming': ModelStreamingPayload
  'tool.updated': ToolUpdatedPayload
  'permission.requested': PermissionRequestedPayload
  'permission.resolved': PermissionResolvedPayload
  'userInput.requested': UserInputRequestedPayload
  'userInput.resolved': UserInputResolvedPayload
  /** 宽松 jsonObject(§4.2) */
  'checkpoint.created': Record<string, unknown>
  /** 宽松 jsonObject(§4.2) */
  'rewind.triggered': Record<string, unknown>
  /** 宽松 jsonObject(§4.2) */
  'streamRecovery.updated': Record<string, unknown>
}

/** session/event 通知的 params(信封 + type + payload,payload 可省略) */
export type SessionEvent = {
  [K in SessionEventType]: SessionEventEnvelope & { type: K; payload?: SessionEventPayloadMap[K] }
}[SessionEventType]

// ---------- state.updated / prompt enhance result 通知(§4.3、§4.4) ----------

export interface StateUpdatedParams {
  [k: string]: unknown
  type: 'state.updated'
  scope: 'server' | 'workspace' | 'session'
  workspace?: WorkspaceRef
  sessionId?: string
  revision: number
  reason?: string
  patch: unknown
}

export interface PromptEnhanceResultParams {
  [k: string]: unknown
  requestId: string
  status: 'completed' | 'failed' | 'cancelled'
  enhanced?: string
  errorMessage?: string
}

// ---------- interaction 服务器请求(§5) ----------

/** 子代理来源(§5.2 origin) */
export interface SubagentOrigin {
  [k: string]: unknown
  kind: 'subagent'
  agentId: string
  agentType: string
  childSessionId: string
  childTurnId?: string
  description?: string
  parentSessionId: string
  parentToolCallId?: string
  parentTurnId?: string
}

export type PermissionDecision = 'allow' | 'deny' | 'escalate' | 'modify'

export interface PermissionRule {
  toolName: string
  ruleContent?: string
}

/** 记住规则:后续同类不再询问(§5.2) */
export interface PermissionUpdate {
  type: 'addRules'
  behavior: 'allow' | 'deny' | 'ask'
  rules: PermissionRule[]
}

/** 权限应答(§5.2 zcodePermissionResponseSchema,发送侧保持精确) */
export interface PermissionResponse {
  decision: PermissionDecision
  reason?: string
  /** decision==="modify" 时的新输入 */
  modifiedInput?: unknown
  permissionUpdates?: PermissionUpdate[]
}

/** §5.2 option:预携带完整 response,客户端选中后原样(或改造后)发回 */
export interface PermissionOption {
  [k: string]: unknown
  optionId: string
  kind: string
  name: string
  description?: string
  response: PermissionResponse
}

/** §5.2 interaction/requestPermission params */
export interface InteractionRequestPermissionParams {
  [k: string]: unknown
  requestId: string
  sessionId: string
  turnId?: string
  toolCallId: string
  toolName: string
  reason: string
  riskLevel: RiskLevel
  /** 原始工具输入 */
  input: unknown
  origin?: SubagentOrigin
  options: PermissionOption[]
}

export interface UserInputOption {
  [k: string]: unknown
  value: string
  label: string
  description?: string
  preview?: string
}

export interface UserInputQuestion {
  [k: string]: unknown
  question: string
  header: string
  options: UserInputOption[]
  multiSelect?: boolean
}

/** §5.4 interaction/requestUserInput params */
export interface InteractionRequestUserInputParams {
  [k: string]: unknown
  requestId: string
  sessionId: string
  turnId?: string
  toolCallId?: string
  toolName?: string
  prompt?: string
  questions?: UserInputQuestion[]
  input?: unknown
  origin?: SubagentOrigin
  schema?: unknown
}

/** §5.4 应答(发送侧精确) */
export interface UserInputResponse {
  action: 'accept' | 'decline' | 'cancel'
  content?: Record<string, unknown>
  reason?: string
}

/** §5.5 interaction/requestProviderRuntimeHeaders params */
export interface InteractionRequestProviderRuntimeHeadersParams {
  [k: string]: unknown
  requestId: string
  sessionId: string
  turnId?: string
  workspace: WorkspaceRef
  modelRef: ModelRef
  providerId: string
  reason: 'model-request' | 'captcha-retry'
}

/** §5.5 应答(发送侧精确) */
export interface ProviderRuntimeHeadersResponse {
  headersApplied: boolean
  errorMessage?: string
  providerRevision?: string
}

// ---------- 常用方法 params/result(§3) ----------

/** §3.1 session/create */
export interface SessionCreateParams {
  sessionId?: string
  workspace: WorkspaceRef
  parentSessionId?: string
  mode?: SessionMode
  model?: ModelRef
  runtimeModel?: RuntimeModel
  persistence?: Persistence
  thoughtLevel?: string
  mcpServers?: McpServerConfig[]
  /** 元素为工具名(形状未转录,按名称推断为 string) */
  toolAllowlist?: string[]
  toolDenylist?: string[]
  importedHistory?: ImportedHistory
}

export type SessionCreateResult = SessionStateSnapshot

/** §3.1 session/resume */
export interface SessionResumeParams {
  sessionId: string
  workspace?: WorkspaceRef
  runtimeModel?: RuntimeModel
  mcpServers?: McpServerConfig[]
  toolAllowlist?: string[]
  toolDenylist?: string[]
}

export type SessionResumeResult = SessionStateSnapshot

/** §3.1 session/list */
export interface SessionListParams {
  workspace?: WorkspaceRef
  includeArchived?: boolean
  limit?: number
}

export interface SessionListResult {
  [k: string]: unknown
  sessions: SessionInfo[]
}

/** §3.1 session/send */
export interface SessionSendParams {
  sessionId: string
  inputId?: string
  queryId?: string
  /** 内容(§10 示例为 string) */
  content: string
  attachments?: unknown
  expectedRevision?: number
  expectedProviderRevision?: number
  expectedModelRuntimeRevision?: number
  runtimeModel?: RuntimeModel
  integratedTerminalShell?: unknown
}

export interface SessionSendResult {
  [k: string]: unknown
  sessionId: string
  accepted: true
  stateRevision: number
  modelRuntimeRevision?: number
}

/** §3.1 session/steer */
export interface SessionSteerParams {
  sessionId: string
  inputId?: string
  queryId?: string
  content: string
  expectedTurnId?: string
}

/** §3.1:discriminatedUnion("kind")(kind 含 queued 等,推断)→ 宽松处理 */
export interface SessionSteerResult {
  [k: string]: unknown
  kind: string
}

/** §3.1 session/stop(旁路队列,§1.4) */
export interface SessionStopParams {
  sessionId: string
}

export type SessionStopResult = Record<string, unknown>

/** §3.1 session/subscribe */
export interface SessionSubscribeParams {
  sessionId: string
  deliveryKind: DeliveryKind
  /** 断线重连续传 */
  afterSeq?: number
  includeSnapshot?: boolean
}

export interface SessionSubscribeResult {
  [k: string]: unknown
  sessionId: string
  eventSeq: number
  events: SessionEvent[]
  snapshot?: SessionStateSnapshot
}

/** §3.1 session/setMode */
export interface SessionSetModeParams {
  sessionId: string
  mode: SessionMode
  expectedRevision?: number
}

export type SessionSetModeResult = SessionStateSnapshot

/** §3.1 session/setModel */
export interface SessionSetModelParams {
  sessionId: string
  model: ModelRef
  runtimeModel?: RuntimeModel
  expectedRevision?: number
  persistAsWorkspaceLastUsed?: boolean
}

export type SessionSetModelResult = SessionStateSnapshot

/** §3.1 session/setThoughtLevel */
export interface SessionSetThoughtLevelParams {
  sessionId: string
  thoughtLevel?: string
  runtimeModel?: RuntimeModel
  expectedRevision?: number
  persistAsWorkspaceLastUsed?: boolean
}

export type SessionSetThoughtLevelResult = SessionStateSnapshot

/** §3.1 session/fork */
export interface SessionForkParams {
  sessionId: string
  target?: RewindTarget
  expectedRevision?: number
}

export interface SessionForkResult {
  [k: string]: unknown
  forkedSessionId: string
  parentSessionId?: string
  targetMessageId?: string
  targetCheckpointId?: string
  response: unknown
  snapshot: SessionStateSnapshot
}

/** §3.1 session/rewind / rewindCascade */
export interface SessionRewindParams {
  sessionId: string
  inputId?: string
  target: RewindTarget
  scope?: 'conversation' | 'workspace' | 'both'
  expectedRevision?: number
}

export interface SessionRewindResult {
  [k: string]: unknown
  response: unknown
  snapshot: SessionStateSnapshot
}

/** §3.1 session/close */
export interface SessionCloseParams {
  sessionId: string
}

export type SessionCloseResult = Record<string, unknown>

/** §3.2 workspace/readState */
export interface WorkspaceReadStateParams {
  workspace: WorkspaceRef
  runtimeModel?: RuntimeModel
}

export type WorkspaceReadStateResult = WorkspaceStateSnapshot
