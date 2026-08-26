import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ProtocolClient, ProtocolRequestError } from './client.ts'
import { isErrorResponseFrame, isNotificationFrame, isRequestFrame, isSuccessResponseFrame } from './types.ts'
import type { ProtocolFrame, RequestFrame } from './types.ts'

/** 内存管道假传输:只记录发送帧 */
class MemoryTransport {
  readonly sent: ProtocolFrame[] = []
  disposed = false

  send(frame: ProtocolFrame): void {
    this.sent.push(frame)
  }

  dispose(): void {
    this.disposed = true
  }
}

function setup(options?: { defaultTimeoutMs?: number }): { client: ProtocolClient; transport: MemoryTransport } {
  const transport = new MemoryTransport()
  const client = new ProtocolClient(transport, options)
  return { client, transport }
}

function permissionFrame(id: string, requestId: string): RequestFrame {
  return {
    id,
    method: 'interaction/requestPermission',
    params: {
      requestId,
      sessionId: 'sess_1',
      toolCallId: 'tc_1',
      toolName: 'Bash',
      reason: 'run tests',
      riskLevel: 'medium',
      input: { command: 'npm test' },
      options: [{ optionId: 'opt_allow', kind: 'allow_once', name: 'Allow', response: { decision: 'allow' } }],
    },
  }
}

function userInputFrame(id: string, requestId: string): RequestFrame {
  return {
    id,
    method: 'interaction/requestUserInput',
    params: {
      requestId,
      sessionId: 'sess_1',
      questions: [{ question: 'q?', header: 'H', options: [{ value: 'v', label: 'V' }] }],
    },
  }
}

function sentRequests(transport: MemoryTransport): RequestFrame[] {
  return transport.sent.filter(isRequestFrame)
}

test('请求-响应:id 从 1 递增,乱序完成按 id 配对;重复响应幂等', async () => {
  const { client, transport } = setup()
  const p1 = client.request<{ value: number }>('a/method')
  const p2 = client.request<string>('b/method', { x: 1 })
  const reqs = sentRequests(transport)
  assert.equal(reqs.length, 2)
  assert.equal(reqs[0].id, 1)
  assert.equal(reqs[0].method, 'a/method')
  assert.equal(reqs[1].id, 2)
  assert.deepEqual(reqs[1].params, { x: 1 })
  client.handleFrame({ id: 2, result: 'second' })
  client.handleFrame({ id: 1, result: { value: 42 } })
  // 迟到/重复的响应帧被忽略
  client.handleFrame({ id: 1, result: { value: 99 } })
  assert.deepEqual(await p1, { value: 42 })
  assert.equal(await p2, 'second')
  client.dispose()
})

test('超时:reject 并清理 pending,迟到响应被忽略', async () => {
  const { client } = setup()
  await assert.rejects(
    client.request('slow/method', undefined, 15),
    (err: unknown) => err instanceof ProtocolRequestError && err.message.includes('timeout') && err.message.includes('slow/method')
  )
  client.handleFrame({ id: 1, result: 'late' })
  client.dispose()
})

test('错误帧:reject 为 ProtocolRequestError 且携带 code', async () => {
  const { client } = setup()
  const p = client.request('no/such')
  client.handleFrame({ id: 1, error: { code: -32601, message: 'Method not found: no/such' } })
  await assert.rejects(
    p,
    (err: unknown) => err instanceof ProtocolRequestError && err.code === -32601 && err.message.includes('no/such')
  )
  client.dispose()
})

test('通知分发:setOnNotification 收到 method+params', () => {
  const { client } = setup()
  const seen: Array<[string, unknown]> = []
  client.setOnNotification((method, params) => seen.push([method, params]))
  client.handleFrame({ method: 'session/event', params: { eventId: 'evt_1', sessionId: 's', seq: 1, timestamp: 1, type: 'turn.started', payload: { turnNumber: 1, input: 'hi' } } })
  client.handleFrame({ method: 'state.updated', params: { type: 'state.updated', scope: 'session', revision: 7, patch: {} } })
  assert.equal(seen.length, 2)
  assert.equal(seen[0][0], 'session/event')
  assert.equal(seen[1][0], 'state.updated')
  client.dispose()
})

test('notify:发送无 id 通知帧', () => {
  const { client, transport } = setup()
  client.notify('session/stop', { sessionId: 'sess_1' })
  const notifications = transport.sent.filter(isNotificationFrame)
  assert.equal(notifications.length, 1)
  assert.equal(notifications[0].method, 'session/stop')
  assert.deepEqual(notifications[0].params, { sessionId: 'sess_1' })
  client.dispose()
})

test('interaction 去重:同 requestId 两帧只回调一次 handler,应答路由到最新帧 id;双响应幂等', () => {
  const { client, transport } = setup()
  let calls = 0
  let firstFrameId = ''
  client.registerServerRequestHandler('interaction/requestPermission', (frame) => {
    calls++
    firstFrameId = String(frame.id)
    // 不立即应答(UI 等待用户),返回 undefined 自行管理应答
    return undefined
  })
  // 服务器 1s 起指数重发(§5.3):同 requestId 以新 id 再达
  client.handleFrame(permissionFrame('server-1', 'perm_1'))
  client.handleFrame(permissionFrame('server-2', 'perm_1'))
  assert.equal(calls, 1)
  assert.equal(firstFrameId, 'server-1')
  // 用户批准:handler 持有的是旧帧,用旧 id 应答也必须路由到最新帧 id
  client.respond(firstFrameId, { decision: 'allow' })
  const responses = transport.sent.filter(isSuccessResponseFrame)
  assert.equal(responses.length, 1)
  assert.equal(responses[0].id, 'server-2')
  assert.deepEqual(responses[0].result, { decision: 'allow' })
  // 双响应幂等:再次应答(无论新旧 id)不再发帧
  client.respond('server-1', { decision: 'deny' })
  client.respond('server-2', { decision: 'deny' })
  assert.equal(transport.sent.filter(isSuccessResponseFrame).length, 1)
  // 应答后才到达的迟到重发帧被忽略,不再回调 handler
  client.handleFrame(permissionFrame('server-3', 'perm_1'))
  assert.equal(calls, 1)
  client.dispose()
})

test('handler 返回 Promise:client 自动以最新帧 id 应答', async () => {
  const { client, transport } = setup()
  client.registerServerRequestHandler('interaction/requestUserInput', (frame) =>
    Promise.resolve({ action: 'accept', content: { answeredFrame: String(frame.id) } })
  )
  client.handleFrame(userInputFrame('server-1', 'ui_1'))
  client.handleFrame(userInputFrame('server-2', 'ui_1'))
  await new Promise((resolve) => setTimeout(resolve, 5))
  const responses = transport.sent.filter(isSuccessResponseFrame)
  assert.equal(responses.length, 1)
  assert.equal(responses[0].id, 'server-2')
  assert.deepEqual(responses[0].result, { action: 'accept', content: { answeredFrame: 'server-1' } })
  client.dispose()
})

test('handler 同步抛错:以 -32603 回错误帧', () => {
  const { client, transport } = setup()
  client.registerServerRequestHandler('interaction/requestPermission', () => {
    throw new Error('boom')
  })
  client.handleFrame(permissionFrame('server-1', 'perm_1'))
  const errors = transport.sent.filter(isErrorResponseFrame)
  assert.equal(errors.length, 1)
  assert.equal(errors[0].id, 'server-1')
  assert.equal(errors[0].error.code, -32603)
  assert.equal(errors[0].error.message, 'boom')
  client.dispose()
})

test('未注册的 server request:回 -32601 Method not found', () => {
  const { client, transport } = setup()
  client.handleFrame({ id: 'server-9', method: 'foo/bar', params: {} })
  const errors = transport.sent.filter(isErrorResponseFrame)
  assert.equal(errors.length, 1)
  assert.equal(errors[0].id, 'server-9')
  assert.equal(errors[0].error.code, -32601)
  assert.equal(errors[0].error.message, 'Method not found: foo/bar')
  client.dispose()
})

test('非 interaction 服务器请求:不去重,逐帧回调', () => {
  const { client, transport } = setup()
  let calls = 0
  client.registerServerRequestHandler('custom/ping', (frame) => {
    calls++
    client.respond(frame.id, 'pong')
    return undefined
  })
  client.handleFrame({ id: 'server-1', method: 'custom/ping', params: { requestId: 'r', sessionId: 's' } })
  client.handleFrame({ id: 'server-2', method: 'custom/ping', params: { requestId: 'r', sessionId: 's' } })
  assert.equal(calls, 2)
  const responses = transport.sent.filter(isSuccessResponseFrame)
  assert.equal(responses.length, 2)
  client.dispose()
})

test('respond 归一化:undefined result 发送 result:null', () => {
  const { client, transport } = setup()
  client.respond('server-5', undefined)
  assert.deepEqual(transport.sent, [{ id: 'server-5', result: null }])
  client.dispose()
})

test('dispose:pending 全部 reject,级联 transport,后续请求拒绝', async () => {
  const { client, transport } = setup()
  const p = client.request('pending/one')
  client.dispose()
  await assert.rejects(p, /disposed/)
  assert.equal(transport.disposed, true)
  await assert.rejects(client.request('after/dispose'), /disposed/)
})
