import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SessionController, type SessionControllerOptions } from './sessionController.ts'
import { ProtocolTransport, type TransportExitInfo } from '../protocol/transport.ts'
import { ProtocolClient } from '../protocol/client.ts'
import type { ProtocolFrame, RequestFrame } from '../protocol/types.ts'

/* ---------- 测试基座:io 注入的 transport+client + 脚本化假服务器 ---------- */

class TestTransport extends ProtocolTransport {
  exitHandler: ((info: TransportExitInfo) => void) | null = null
  override setOnExit(cb: (info: TransportExitInfo) => void): void {
    this.exitHandler = cb
    super.setOnExit(cb)
  }
}

interface TestConn {
  transport: TestTransport
  client: ProtocolClient
  /** 模拟服务器→宿主方向喂入一帧 */
  feed: (frame: unknown) => void
  /** 宿主→服务器方向已发送的全部帧 */
  sent: ProtocolFrame[]
  triggerExit: (info: TransportExitInfo) => void
}

type Responder = (params: unknown) => unknown

function makeConn(responders: Record<string, Responder>): TestConn {
  const sent: ProtocolFrame[] = []
  let dataCb: ((chunk: string) => void) | null = null
  const transport = new TestTransport({
    command: 'unused',
    args: [],
    io: {
      write: (data) => {
        for (const line of data.split('\n')) {
          if (!line.trim()) continue
          const frame = JSON.parse(line) as ProtocolFrame
          sent.push(frame)
          const req = frame as Partial<RequestFrame>
          if (req.method !== undefined && req.id !== undefined) {
            const respond = responders[req.method]
            feed({ id: req.id, result: respond ? respond(req.params) : {} })
          }
        }
      },
      onData: (cb) => {
        dataCb = cb
      },
    },
  })
  const client = new ProtocolClient(transport)
  function feed(frame: unknown): void {
    dataCb?.(JSON.stringify(frame) + '\n')
  }
  return {
    transport,
    client,
    feed,
    sent,
    triggerExit: (info) => transport.exitHandler?.(info),
  }
}

function snapshot(sessionId: string, updatedAt: number, eventSeq: number): unknown {
  return {
    session: { sessionId, title: `t-${sessionId}`, updatedAt, status: 'idle', mode: 'build' },
    messages: [],
    runtime: { eventSeq },
    settings: {},
    projection: { contextUsed: 0, contextWindow: 0 },
  }
}

function makeController(responders: Record<string, Responder>): { ctl: SessionController; conn: () => TestConn } {
  let current: TestConn | null = null
  const opts: SessionControllerOptions = {
    workspacePath: '/ws',
    defaultMode: 'build',
    createConnection: () => {
      current = makeConn(responders)
      return { transport: current.transport, client: current.client }
    },
  }
  return { ctl: new SessionController(opts), conn: () => current as TestConn }
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 25))

function sentRequests(conn: TestConn, method: string): RequestFrame[] {
  return conn.sent.filter((f) => (f as Partial<RequestFrame>).method === method) as RequestFrame[]
}

/* ---------- 测试 ---------- */

test('协议进程中途退出:live 层复位、挂起交互结算、重启自愈后预算清零', async () => {
  const responders: Record<string, Responder> = {
    'session/resume': (p) => snapshot((p as { sessionId: string }).sessionId, 1000, 10),
    'session/subscribe': () => ({}),
    'session/send': () => ({}),
    'session/list': () => ({ sessions: [] }),
    'session/updateRuntimeModelConfig': () => ({}),
  }
  const { ctl, conn } = makeController(responders)
  await ctl.openSession('sA')
  await ctl.send('hi')
  conn().feed({ method: 'session/event', params: { sessionId: 'sA', seq: 11, type: 'turn.started', payload: {} } })
  assert.equal(ctl.uiState.current.live.active, true)

  // 挂起一个用户输入卡片,随连接中断一起结算
  conn().feed({
    id: 'srv-ui-1',
    method: 'interaction/requestUserInput',
    params: { requestId: 'r-ui', sessionId: 'sA', questions: [{ question: 'q?' }] },
  })
  assert.equal(ctl.uiState.current.pendingUserInputs.length, 1)

  // 连续 4 次崩溃、每次自愈成功:不得进入 failed 终态(修复前第 4 次烧光预算)
  for (let i = 0; i < 4; i++) {
    conn().triggerExit({ code: 1, signal: null })
    await flush()
    assert.equal(ctl.uiState.connection, 'connected', `第 ${i + 1} 次崩溃后应自愈`)
  }

  // 崩溃瞬间:live 层复位(修复前永久卡 true,轮询冻结、Enter 退化为 steer)
  assert.equal(ctl.uiState.current.live.active, false)
  assert.equal(ctl.uiState.current.pendingUserInputs.length, 0)
  ctl.dispose()
})

test('seq 水位按会话隔离:切会话后 subscribe 不得携带旧会话的 afterSeq;同一会话只订阅一次', async () => {
  const responders: Record<string, Responder> = {
    'session/resume': (p) => {
      const sid = (p as { sessionId: string }).sessionId
      return snapshot(sid, 1000, sid === 'sA' ? 200 : 50)
    },
    'session/subscribe': () => ({}),
    'session/list': () => ({ sessions: [] }),
    'session/updateRuntimeModelConfig': () => ({}),
  }
  const { ctl, conn } = makeController(responders)
  await ctl.openSession('sA')
  await ctl.openSession('sB')
  const subscribes = sentRequests(conn(), 'session/subscribe')
  assert.equal(subscribes.length, 2) // sA 一次 + sB 一次(修复前 sB 会订阅两次)
  const bParams = subscribes[1].params as { sessionId: string; afterSeq?: number }
  assert.equal(bParams.sessionId, 'sB')
  assert.equal(bParams.afterSeq, 50) // 修复前:携带 sA 的 200
  ctl.dispose()
})

test('updatedAt 水位按会话隔离:切到较旧会话后,桌面端更新仍能被轮询拉取', async () => {
  let listPayload = { sessions: [] as unknown[] }
  const responders: Record<string, Responder> = {
    'session/resume': (p) => {
      const sid = (p as { sessionId: string }).sessionId
      return snapshot(sid, sid === 'sA' ? 1000 : 500, 10)
    },
    'session/subscribe': () => ({}),
    'session/list': () => listPayload,
    'session/read': () => snapshot('sB', 600, 12),
    'session/updateRuntimeModelConfig': () => ({}),
  }
  const { ctl, conn } = makeController(responders)
  await ctl.openSession('sA')
  await ctl.openSession('sB') // sB 较旧(updatedAt 500 < sA 的 1000)
  // 桌面端在 sB 上产生了新消息(updatedAt 500 → 600)
  listPayload = { sessions: [{ sessionId: 'sB', title: 't', mode: 'build', status: 'idle', updatedAt: 600 }] }
  await ctl.pollOnce()
  const reads = sentRequests(conn(), 'session/read')
  assert.equal(reads.length, 1) // 修复前:全局水位 1000 压住 600,永不拉取
  assert.equal((reads[0].params as { sessionId: string }).sessionId, 'sB')
  ctl.dispose()
})

test('运行中切换会话:live 层复位、旧会话挂起权限卡清空', async () => {
  const responders: Record<string, Responder> = {
    'session/resume': (p) => snapshot((p as { sessionId: string }).sessionId, 1000, 10),
    'session/subscribe': () => ({}),
    'session/send': () => ({}),
    'session/list': () => ({ sessions: [] }),
    'session/updateRuntimeModelConfig': () => ({}),
  }
  const { ctl, conn } = makeController(responders)
  await ctl.openSession('sA')
  await ctl.send('hi')
  conn().feed({ method: 'session/event', params: { sessionId: 'sA', seq: 11, type: 'turn.started', payload: {} } })
  conn().feed({
    id: 'srv-perm-1',
    method: 'interaction/requestPermission',
    params: {
      requestId: 'r-perm',
      sessionId: 'sA',
      toolName: 'Bash',
      reason: 'run',
      riskLevel: 'low',
      input: { command: 'ls' },
      options: [{ optionId: 'allow', kind: 'allow_once', name: 'Allow', response: { decision: 'allow' } }],
    },
  })
  assert.equal(ctl.uiState.current.live.active, true)
  assert.equal(ctl.uiState.current.pendingPermissions.length, 1)

  await ctl.openSession('sB')
  // 修复前:live 永久卡 true(旧会话 turn.completed 被 sessionId 过滤),权限卡残留
  assert.equal(ctl.uiState.current.live.active, false)
  assert.equal(ctl.uiState.current.pendingPermissions.length, 0)
  ctl.dispose()
})

test('answerPermission 无效 optionId:抛错且卡片保留,不得静默回退到第一个选项', async () => {
  const { ctl, conn } = makeController({})
  await ctl.ensureStarted()
  conn().feed({
    id: 'srv-perm-2',
    method: 'interaction/requestPermission',
    params: {
      requestId: 'r-bogus',
      sessionId: 'sA',
      toolName: 'Bash',
      reason: 'run',
      riskLevel: 'high',
      input: { command: 'rm -rf' },
      options: [
        { optionId: 'allow', kind: 'allow_once', name: 'Allow', response: { decision: 'allow' } },
        { optionId: 'deny', kind: 'deny', name: 'Deny', response: { decision: 'deny' } },
      ],
    },
  })
  const key = ctl.uiState.current.pendingPermissions[0]?.key
  assert.ok(key)
  // 修复前:静默选中 options[0](Allow)并返回 true —— 权限旁路
  assert.throws(() => ctl.answerPermission(key, 'nonexistent-option'), /无效|optionId|选项/)
  assert.equal(ctl.uiState.current.pendingPermissions.length, 1)
  ctl.dispose()
})

test('userInput.resolved 按精确 requestId 匹配:后缀碰撞不再误删兄弟卡片', async () => {
  const { ctl, conn } = makeController({})
  await ctl.ensureStarted()
  conn().feed({
    id: 'srv-ui-13',
    method: 'interaction/requestUserInput',
    params: { requestId: '13', sessionId: 'sA', questions: [{ question: 'a?' }] },
  })
  conn().feed({
    id: 'srv-ui-3',
    method: 'interaction/requestUserInput',
    params: { requestId: '3', sessionId: 'sA', questions: [{ question: 'b?' }] },
  })
  assert.equal(ctl.uiState.current.pendingUserInputs.length, 2)
  // 服务器结算了 requestId='3':只应移除它;'13' 不受影响(修复前 endsWith('3') 先命中 '13')
  conn().feed({ method: 'session/event', params: { seq: 1, type: 'userInput.resolved', payload: { requestId: '3' } } })
  const rest = ctl.uiState.current.pendingUserInputs
  assert.equal(rest.length, 1)
  assert.equal(rest[0].requestId, '13')
  ctl.dispose()
})
