import { expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { ToolManifest } from '../hub/tools'

const dir = join(import.meta.dir, '..', 'examples', 'tools', 'sketch')

test('sketch tool: manifest is valid, a topic tool with a frame per instance', () => {
  const m = ToolManifest.parse(JSON.parse(readFileSync(join(dir, 'bebop-tool.json'), 'utf8')))
  expect(m.id).toBe('sketch')
  expect(m.scope).toBe('topic')
  expect(m.frame.url).toContain('{instance}')
})

test('sketch tool: serves the board page, saves and loads strokes, refuses bad boards', async () => {
  const port = 20000 + Math.floor(Math.random() * 20000)
  const data = join(process.env.TMPDIR ?? '/tmp', `sketch-test-${port}`)
  const p = Bun.spawn(['bun', 'server.ts'], { cwd: dir, env: { ...process.env, PORT: String(port), SKETCH_DATA: data, BEBOP_HUB_ORIGIN: 'https://hub.example' }, stdout: 'ignore', stderr: 'ignore' })
  const base = `http://127.0.0.1:${port}`
  try {
    for (let i = 0; i < 50; i++) { try { if ((await fetch(base + '/healthz')).ok) break } catch {} await Bun.sleep(100) }
    const page = await fetch(base + '/s/topic-one')
    expect(page.status).toBe(200)
    expect(page.headers.get('content-security-policy')).toContain('https://hub.example')
    expect(await page.text()).toContain('bebop-tool')
    expect(await (await fetch(base + '/api/topic-one')).json()).toEqual({ strokes: [] })
    const board = { strokes: [{ c: '#1f1f1f', w: 0.01, p: [0.1, 0.1, 0.2, 0.2] }] }
    expect((await fetch(base + '/api/topic-one', { method: 'PUT', body: JSON.stringify(board) })).status).toBe(204)
    expect(await (await fetch(base + '/api/topic-one')).json()).toEqual(board)
    expect((await fetch(base + '/api/topic-one', { method: 'PUT', body: '{"nope":1}' })).status).toBe(400)
    expect((await fetch(base + '/api/../etc')).status).toBe(404)
  } finally { p.kill() }
})
