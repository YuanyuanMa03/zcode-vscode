import test from 'node:test';
import assert from 'node:assert/strict';
import { lineDiff } from './lineDiff.ts';

test('lineDiff: 相同文本无变更', () => {
  assert.deepEqual(lineDiff('a\nb', 'a\nb'), []);
});

test('lineDiff: 纯新增文件(空 → 内容)', () => {
  const d = lineDiff('', 'hello\nworld');
  assert.deepEqual(d, ['+hello', '+world']);
});

test('lineDiff: 修改一行保留上下文', () => {
  const a = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7'].join('\n');
  const b = ['l1', 'l2', 'l3x', 'l4', 'l5', 'l6', 'l7'].join('\n');
  const d = lineDiff(a, b);
  assert.ok(d.includes('-l3'), '含删除行');
  assert.ok(d.includes('+l3x'), '含新增行');
  assert.ok(d.includes(' l1'), '含上文');
  assert.ok(!d.some((l) => l === ' l7'), '远端上下文被省略');
  assert.ok(d.includes('⋯'), '有省略标记');
});

test('lineDiff: 全删', () => {
  const d = lineDiff('x\ny', '');
  assert.deepEqual(d, ['-x', '-y']);
});
