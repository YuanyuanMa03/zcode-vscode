import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { captureOnce } from './capture.ts'
import type { Binaries } from './binaries.ts'

function scriptCli(source: string): Binaries {
  const file = path.join(os.tmpdir(), `zcode-capture-test-${Date.now()}-${Math.random().toString(36).slice(2)}.cjs`)
  fs.writeFileSync(file, source)
  return { node: process.execPath, cli: file, detail: 'test-bins' }
}

test('captureOnce:正常退出收集 stdout/stderr 并返回 code', async () => {
  const bins = scriptCli('process.stdout.write("ok-out"); process.stderr.write("ok-err");')
  const r = await captureOnce(bins, [], 10_000)
  assert.equal(r.code, 0)
  assert.ok(r.out.includes('ok-out'))
  assert.ok(r.out.includes('ok-err'))
  assert.ok(r.out.includes('test-bins'))
})

test('captureOnce:CLI 挂起时按超时 SIGKILL,不再无限悬挂', async () => {
  const bins = scriptCli('setInterval(() => {}, 3000);')
  const t0 = Date.now()
  const r = await captureOnce(bins, [], 400)
  assert.ok(Date.now() - t0 < 3000, '应按超时返回而非等满')
  assert.equal(r.code, null)
  assert.ok(r.out.includes('超时'))
})

test('captureOnce:cli 缺失时直接返回提示,不 spawn', async () => {
  const r = await captureOnce({ node: 'node', cli: null, detail: 'no cli' }, ['doctor'])
  assert.equal(r.code, null)
  assert.ok(r.out.includes('未找到 ZCode CLI'))
})
