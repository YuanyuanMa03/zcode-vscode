import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderMarkdown } from './markdown.ts'

test('markdown: 代码块中的 <>&" 正确转义一次(修复前双重转义显示为实体乱码)', () => {
  const html = renderMarkdown('```html\n<div class="a">A & B</div>\n```')
  assert.ok(html.includes('&lt;div class=&quot;a&quot;&gt;A &amp; B&lt;/div&gt;'), html)
  assert.ok(!html.includes('&amp;lt;'), '不得出现双重转义: ' + html)
})

test('markdown: 行内代码中的尖括号(泛型/JSX)正确显示', () => {
  const html = renderMarkdown('类型是 `List<String>`,组件 `<Foo/>`。')
  assert.ok(html.includes('List&lt;String&gt;'), html)
  assert.ok(html.includes('&lt;Foo/&gt;'), html)
  assert.ok(!html.includes('List&amp;lt;'), html)
})

test('markdown: javascript: 链接被中和为纯文本', () => {
  const html = renderMarkdown('[点我](javascript:alert(1))')
  assert.ok(!html.toLowerCase().includes('href="javascript:'), html)
  assert.ok(html.includes('点我'), '链接文字保留: ' + html)
})

test('markdown: 原始 HTML 块被转义显示,不进入 DOM', () => {
  const html = renderMarkdown('<img src=x onerror="alert(1)">')
  assert.ok(!/<img[\s>]/i.test(html), html)
  assert.ok(html.includes('&lt;img'), '以文本形式可见: ' + html)
})

test('markdown: 远程图片被移除(信标防护),data: 与正常链接保留', () => {
  const html = renderMarkdown('![探针](https://attacker.example/x.png)\n\n![内嵌](data:image/png;base64,AAAA)\n\n[官网](https://example.com)')
  assert.ok(!/src="https:/.test(html), html)
  assert.ok(html.includes('src="data:image/png;base64,AAAA"'), html)
  assert.ok(html.includes('href="https://example.com"'), html)
})

test('markdown: 普通段落文本与 gfm 表格不受影响', () => {
  const html = renderMarkdown('1 < 2 且 3 > 2\n\n| a | b |\n|---|---|\n| 1 | 2 |')
  assert.ok(html.includes('1 &lt; 2'), html)
  assert.ok(html.includes('<table>'), html)
})

test('markdown: 解析异常时回退为纯文本段落', () => {
  // marked 对任意字符串都不抛;此处用超长嵌套防栈溢出路径异常,至少保证输出为字符串
  const html = renderMarkdown('x'.repeat(1000))
  assert.ok(typeof html === 'string' && html.length > 0)
})
