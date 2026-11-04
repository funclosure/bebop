import { test, expect, afterAll } from 'bun:test'
import { spawn } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { startHub } from './helpers'
import { makeTool, superviseTools, toolBaseEnv, ToolManifest, type Supervisor, type ToolEntry } from '../hub/tools'

// A tiny fake tool: serves /healthz on PORT, writes its environment to env.json, and misbehaves on request.
const FAKE = `
const fs = require('fs')
fs.writeFileSync('env.json', JSON.stringify(process.env))
fs.appendFileSync('starts.txt', Date.now() + '\\n')
if (process.env.FAKE_IGNORE_TERM) process.on('SIGTERM', () => console.log('ignoring SIGTERM'))
if (process.env.FAKE_CHILD) {
  const c = require('child_process').spawn('sleep', ['30'], { stdio: 'ignore' })
  fs.writeFileSync('child.pid', String(c.pid))
}
if (process.env.FAKE_EXIT_AFTER_MS) setTimeout(() => process.exit(3), Number(process.env.FAKE_EXIT_AFTER_MS))
Bun.serve({ port: Number(process.env.PORT), hostname: '127.0.0.1', fetch: req => new URL(req.url).pathname === '/healthz' ? new Response('ok') : new Response('no', { status: 404 }) })
console.log('fake tool listening on', process.env.PORT)
setInterval(() => {}, 1000)
`
const RESERVED = new Set([8787, 5173, 5180, 8443])
/** A free port (never one of the live ones). */
function freePort(): number {
  for (;;) {
    const s = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response() })
    const p = s.port!
    s.stop(true)
    if (!RESERVED.has(p)) return p
  }
}
function fakeTool(id = 'fake') {
  const dir = mkdtempSync(join(tmpdir(), `hub-run-${id}-`))
  writeFileSync(join(dir, 'server.js'), FAKE)
  const manifest = { bebop: 1, id, name: 'Fake', frame: { url: '/t/{instance}' }, serve: { command: ['bun', 'server.js'], health: '/healthz' } }
  writeFileSync(join(dir, 'bebop-tool.json'), JSON.stringify(manifest))
  return { dir, manifest }
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const until = async (f: () => boolean | Promise<boolean>, ms = 5000) => {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await f()) return true; await Bun.sleep(25) }
  return false
}
const fast = { minBackoffMs: 100, maxBackoffMs: 400, healthStartMs: 50, healthEveryMs: 50, killAfterMs: 300 }
const running: Supervisor[] = []
afterAll(() => Promise.all(running.map(s => s.stop())))

function supervise(env: Record<string, string> = {}, extra: Partial<Parameters<typeof superviseTools>[1]> = {}) {
  const { dir, manifest } = fakeTool()
  const port = freePort()
  const entry: ToolEntry = { source: dir, origin: `http://localhost:${port}`, port, run: true, env }
  const tool = makeTool(manifest, entry, dir)
  tool.entry = entry
  const logsDir = mkdtempSync(join(tmpdir(), 'hub-run-logs-'))
  const sup = superviseTools([tool], { logsDir, hubOrigins: ['https://hub.example'], baseEnv: { PATH: process.env.PATH }, ...fast, ...extra })
  running.push(sup)
  const log = () => { try { return readFileSync(join(logsDir, 'fake.log'), 'utf8') } catch { return '' } }
  const starts = () => { try { return readFileSync(join(dir, 'starts.txt'), 'utf8').trim().split('\n').length } catch { return 0 } }
  return { sup, dir, port, logsDir, log, starts }
}

test('run:true through the hub: started with PORT, BEBOP_* and the entry env (no HUB_*), up in /api/config, logged, stopped with the hub', async () => {
  const { dir, manifest } = fakeTool()
  const port = freePort()
  const data = mkdtempSync(join(tmpdir(), 'hub-run-data-'))
  writeFileSync(join(data, 'tools.json'), JSON.stringify([{ source: dir, origin: `http://localhost:${port}`, port, run: true, env: { GREETING: 'hi' } }]))
  process.env.HUB_SECRET_FOR_TEST = 'not for tools'
  process.env.OTHER_SECRET_FOR_TEST = 'not listed in the manifest'
  const { hub, user } = startHub({ toolsFile: join(data, 'tools.json'), dataDir: data, publicOrigins: ['https://hub.example.ts.net'], toolRun: fast })
  delete process.env.HUB_SECRET_FOR_TEST
  delete process.env.OTHER_SECRET_FOR_TEST
  const up = async () => (await (await user('/api/config')).json()).tools[0].up
  expect(await until(async () => (await up()) === true)).toBe(true)
  const env = JSON.parse(readFileSync(join(dir, 'env.json'), 'utf8'))
  expect(env.PORT).toBe(String(port))
  expect(env.BEBOP_TOOL_ID).toBe('fake')
  expect(env.GREETING).toBe('hi')
  expect(env.BEBOP_HUB_ORIGIN.split(' ')).toEqual(['https://hub.example.ts.net', `http://127.0.0.1:${hub.server.port}`, `http://localhost:${hub.server.port}`])
  expect(env.HUB_SECRET_FOR_TEST).toBeUndefined()
  expect(env.OTHER_SECRET_FOR_TEST).toBeUndefined()
  expect(env.PATH).toBeTruthy()
  const logFile = join(data, 'logs', 'tools', 'fake.log')
  expect(readFileSync(logFile, 'utf8')).toContain('fake tool listening on')
  expect(readFileSync(logFile, 'utf8')).toContain(`up on port ${port}`)
  const pid = JSON.parse(readFileSync(join(data, 'logs', 'tools', 'fake.pid'), 'utf8')).pid
  expect(alive(pid)).toBe(true)
  await hub.stop()
  expect(alive(pid)).toBe(false)
  expect(existsSync(join(data, 'logs', 'tools', 'fake.pid'))).toBe(false)
  expect(readFileSync(logFile, 'utf8')).toContain('stopped (signal SIGTERM)')
  void manifest
})

test('a tool without run, or with nothing to run, is not supervised (up stays null)', async () => {
  const { dir } = fakeTool()
  const data = mkdtempSync(join(tmpdir(), 'hub-run-data-'))
  writeFileSync(join(data, 'tools.json'), JSON.stringify([{ source: dir, origin: 'http://localhost:5999' }]))
  const { hub, user } = startHub({ toolsFile: join(data, 'tools.json'), dataDir: data })
  expect((await (await user('/api/config')).json()).tools[0].up).toBeNull()
  expect(existsSync(join(data, 'logs', 'tools'))).toBe(false)
  await hub.stop()
})

test('restarts with backoff (doubling to the cap), and back to the minimum after a healthy stretch', async () => {
  const quick = supervise({ FAKE_EXIT_AFTER_MS: '50' })
  expect(await until(() => quick.starts() >= 5, 6000)).toBe(true)
  const waits = [...quick.log().matchAll(/restarting in ([\d.]+) s/g)].map(m => Number(m[1]))
  expect(waits.slice(0, 4)).toEqual([0.1, 0.2, 0.4, 0.4])
  expect(quick.log()).toContain('exited (code 3)')
  await quick.sup.stop()

  // Healthy for longer than resetAfterMs before each exit → every restart waits the minimum.
  const steady = supervise({ FAKE_EXIT_AFTER_MS: '500' }, { resetAfterMs: 150 })
  expect(await until(() => steady.starts() >= 4, 8000)).toBe(true)
  const w2 = [...steady.log().matchAll(/restarting in ([\d.]+) s/g)].map(m => Number(m[1]))
  expect(w2.length).toBeGreaterThanOrEqual(3)
  expect(w2.every(w => w === 0.1)).toBe(true)
  await steady.sup.stop()
}, 20000)

test('up follows the health check; stop() SIGKILLs a server that ignores SIGTERM, and its children go with it', async () => {
  const t = supervise({ FAKE_IGNORE_TERM: '1', FAKE_CHILD: '1' })
  expect(await until(() => t.sup.up('fake') === true)).toBe(true)
  expect(t.sup.up('other')).toBeNull()
  const pid = JSON.parse(readFileSync(join(t.logsDir, 'fake.pid'), 'utf8')).pid
  const child = Number(readFileSync(join(t.dir, 'child.pid'), 'utf8'))
  expect(alive(child)).toBe(true)
  const t0 = Date.now()
  await t.sup.stop()
  expect(Date.now() - t0).toBeGreaterThanOrEqual(250)
  expect(Date.now() - t0).toBeLessThan(3000)
  expect(alive(pid)).toBe(false)
  expect(await until(() => !alive(child), 1000)).toBe(true)
  expect(t.log()).toContain('ignoring SIGTERM')
  expect(t.log()).toContain('SIGKILL')
  expect(t.sup.up('fake')).toBe(false)
})

test('a server left running by a crashed hub (pid file, same command) is stopped before starting again', async () => {
  const { dir, manifest } = fakeTool()
  const port = freePort()
  const logsDir = mkdtempSync(join(tmpdir(), 'hub-run-logs-'))
  mkdirSync(logsDir, { recursive: true })
  // The "old" server: same command, holding the port.
  const old = spawn('bun', ['server.js'], { cwd: dir, env: { PATH: process.env.PATH, PORT: String(port) }, stdio: 'ignore', detached: true })
  writeFileSync(join(logsDir, 'fake.pid'), JSON.stringify({ pid: old.pid, cmd: ['bun', 'server.js'] }))
  expect(await until(async () => { try { return (await fetch(`http://127.0.0.1:${port}/healthz`)).ok } catch { return false } })).toBe(true)
  const entry: ToolEntry = { source: dir, origin: `http://localhost:${port}`, port, run: true }
  const tool = makeTool(manifest, entry, dir)
  tool.entry = entry
  const sup = superviseTools([tool], { logsDir, hubOrigins: [], baseEnv: { PATH: process.env.PATH }, ...fast })
  running.push(sup)
  expect(await until(() => !alive(old.pid!))).toBe(true)
  expect(await until(() => sup.up('fake') === true)).toBe(true)
  const log = readFileSync(join(logsDir, 'fake.log'), 'utf8')
  expect(log).toContain(`stopping pid ${old.pid}, left over from an earlier hub`)
  expect(log).not.toContain('exited')
  await sup.stop()
})

test('a port another process already holds: not started, retried with backoff, never marked up', async () => {
  const port = freePort()
  const other = Bun.serve({ port, hostname: '127.0.0.1', fetch: () => new Response('someone else') })
  const { dir, manifest } = fakeTool()
  const logsDir = mkdtempSync(join(tmpdir(), 'hub-run-logs-'))
  const entry: ToolEntry = { source: dir, origin: `http://localhost:${port}`, port, run: true }
  const tool = makeTool(manifest, entry, dir)
  tool.entry = entry
  const sup = superviseTools([tool], { logsDir, hubOrigins: [], baseEnv: { PATH: process.env.PATH }, ...fast })
  running.push(sup)
  const log = () => { try { return readFileSync(join(logsDir, 'fake.log'), 'utf8') } catch { return '' } }
  expect(await until(() => (log().match(/already in use/g) ?? []).length >= 2)).toBe(true)
  expect(sup.up('fake')).toBe(false)
  expect(existsSync(join(dir, 'starts.txt'))).toBe(false)
  other.stop(true)
  expect(await until(() => sup.up('fake') === true)).toBe(true)
  await sup.stop()
})

test('toolBaseEnv: the allowlist, the manifest\'s secrets, the Claude login only when asked; never HUB_*', () => {
  const from = { PATH: '/bin', HOME: '/h', LC_ALL: 'C', MISE_SHELL: 'zsh', AWS_SECRET_ACCESS_KEY: 'x', HUB_TOKEN: 't', MY_KEY: 'k', CLAUDE_CODE_OAUTH_TOKEN: 'c', ANTHROPIC_API_KEY: 'a' }
  const base = { bebop: 1, id: 'fake', name: 'Fake', frame: { url: '/x/{instance}' } } as const
  expect(toolBaseEnv(ToolManifest.parse(base), from)).toEqual({ PATH: '/bin', HOME: '/h', LC_ALL: 'C', MISE_SHELL: 'zsh' })
  const asks = ToolManifest.parse({ ...base, secrets: ['MY_KEY'], requires: { claudeLogin: true } })
  expect(toolBaseEnv(asks, from)).toEqual({ PATH: '/bin', HOME: '/h', LC_ALL: 'C', MISE_SHELL: 'zsh', MY_KEY: 'k', CLAUDE_CODE_OAUTH_TOKEN: 'c', ANTHROPIC_API_KEY: 'a' })
  expect(ToolManifest.safeParse({ ...base, secrets: ['HUB_TOKEN'] }).success).toBe(false)
})
