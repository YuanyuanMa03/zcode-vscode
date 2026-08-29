import { test } from 'node:test'
import assert from 'node:assert/strict'
import { composePrompt } from './compose.ts'

test('composePrompt: 带 path 的 chip 注入文件引用;无 path 的不注入', () => {
  const out = composePrompt('看看这个', [
    { label: 'a.ts', path: '/ws/src/a.ts' },
    { label: '(仅引用)', path: undefined },
    { label: 'b.ts', path: '/ws/src/b.ts' },
  ])
  assert.equal(out, '参考以下文件:\n- /ws/src/a.ts\n- /ws/src/b.ts\n\n看看这个')
})

test('composePrompt: 无有效 chip 时原样返回', () => {
  assert.equal(composePrompt('hi', []), 'hi')
  assert.equal(composePrompt('hi', [{ label: 'x' }]), 'hi')
})
