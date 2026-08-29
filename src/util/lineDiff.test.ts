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

test('lineDiff: 大文件(2 万行改 1 行)在 1s 内完成且正确压缩', () => {
  const n = 20000
  const a = Array.from({ length: n }, (_, i) => `line-${i}`).join('\n')
  const b = a.replace('line-10000', 'line-10000-CHANGED')
  const t0 = Date.now()
  const out = lineDiff(a, b)
  const elapsed = Date.now() - t0
  assert.ok(out.some((l) => l === '-line-10000'), '应包含删除行')
  assert.ok(out.some((l) => l === '+line-10000-CHANGED'), '应包含新增行')
  assert.ok(out.length < 100, `应压缩上下文,实际 ${out.length} 行`)
  assert.ok(elapsed < 1000, `应在 1s 内完成(旧实现 3.4s + 3.2GB 堆),实际 ${elapsed}ms`)
})

test('lineDiff: 超限的完全不同大文件降级为整块替换,输出有界不 OOM', () => {
  const n = 10000
  const a = Array.from({ length: n }, (_, i) => `a-${i}`).join('\n')
  const b = Array.from({ length: n }, (_, i) => `b-${i}`).join('\n')
  const out = lineDiff(a, b)
  assert.ok(out.some((l) => l.startsWith('-a-0')), '应含删除侧首行')
  assert.ok(out.some((l) => l.startsWith('+b-0')), '应含新增侧首行')
  assert.ok(out.length <= 4100, `输出应有界,实际 ${out.length} 行`)
})
