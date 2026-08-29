import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ProtocolTransport } from './transport.ts'

function memoryIO() {
  const state = {
    written: '',
    dataCb: null as null | ((c: string) => void),
    endCb: null as null | (() => void),
  }
  return {
    write: (d: string) => {
      state.written += d
    },
    onData: (cb: (c: string) => void) => {
      state.dataCb = cb
    },
    onEnd: (cb: () => void) => {
      state.endCb = cb
    },
    state,
  }
}

test('NDJSON 分帧:残行缓冲 + 尾部无换行残帧在流结束时处理', () => {
  const io = memoryIO()
  const t = new ProtocolTransport({ command: 'unused', args: [], io })
  const frames: unknown[] = []
  t.setOnFrame((f) => frames.push(f))
  t.start()
  t.send({ id: 1, method: 'm' })
  assert.ok(io.state.written.endsWith('{"id":1,"method":"m"}\n'))
  io.state.dataCb?.('{"id":1,"res')
  io.state.dataCb?.('ult":"ok"}\n{"method":"n"}')
  assert.deepEqual(frames, [{ id: 1, result: 'ok' }])
  io.state.endCb?.()
  assert.deepEqual(frames, [{ id: 1, result: 'ok' }, { method: 'n' }])
})

test('写入读端已失效的 stdin 不产生未捕获异常(EPIPE 守卫回归)', async () => {
  // Node 26 实测:读端销毁后的写入静默失败、不崩;本测试守护该行为不回退,
  // 并为旧版扩展宿主(Node 18-22)的已知 EPIPE uncaught 行为兜底(空 error 监听)。
  const t = new ProtocolTransport({
    command: process.execPath,
    args: ['-e', 'process.stdin.destroy(); setInterval(() => {}, 1000)'],
  })
  let exited = false
  t.setOnExit(() => {
    exited = true
  })
  t.start()
  await new Promise((r) => setTimeout(r, 200))
  t.send({ id: 1, method: 'x' })
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(exited, false) // 子进程仍存活,证明不是"退出后写"路径
  t.dispose()
  const deadline = Date.now() + 5000
  while (!exited && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25))
  }
  assert.equal(exited, true)
})

test('spawn 失败(ENOENT):onExit 恰好触发一次(error/close 双路径互斥)', async () => {
  const t = new ProtocolTransport({ command: '/nonexistent/zcode-test-binary', args: [] })
  let exits = 0
  t.setOnExit(() => {
    exits++
  })
  t.start()
  const deadline = Date.now() + 5000
  while (exits === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25))
  }
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(exits, 1)
})

test('dispose 后 send 同步抛错(不得写入已死管道)', () => {
  const io = memoryIO()
  const t = new ProtocolTransport({ command: 'unused', args: [], io })
  t.start()
  t.dispose()
  assert.throws(() => t.send({ id: 1, method: 'm' }), /disposed/)
})
