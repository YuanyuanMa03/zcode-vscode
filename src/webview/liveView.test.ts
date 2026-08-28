import { test } from 'node:test'
import assert from 'node:assert/strict'
import { liveViewAction } from './liveView.ts'

test('liveView: turn 失败后错误面板驻留,不被后续状态推送擦掉', () => {
  // 序列还原 bug 场景:turn.failed 那一帧显示错误,紧随其后的普通推送(列表刷新/快照)
  // 在旧分支顺序下走"不活跃且上一帧也不活跃 → 清空",错误只存活约 0.4s
  assert.equal(liveViewAction({ active: true }), 'stream')
  assert.equal(liveViewAction({ active: false, turnError: 'boom' }), 'error')
  assert.equal(liveViewAction({ active: false, turnError: 'boom' }), 'error', '后续推送必须保持错误面板')
  assert.equal(liveViewAction({ active: false, turnError: 'still-here' }), 'error')
})

test('liveView: 无错误时正常清空;新一轮 turn 开始替换错误;会话切换(turnError 已清)也清空', () => {
  assert.equal(liveViewAction({ active: false }), 'clear')
  assert.equal(liveViewAction({ active: false }), 'clear')
  assert.equal(liveViewAction({ active: true }), 'stream', '新一轮 turn 替换错误面板')
})
