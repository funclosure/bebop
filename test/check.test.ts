// The health check (channel/check.ts), the probe and listening state behind it, and the
// watcher and presence script saying what's wrong instead of retrying or failing silently.
import { test, expect, afterAll } from 'bun:test'
import { join } from 'path'
import { writeFileSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { startHub, readSSE } from './helpers'

const { hub, dataDir, agent, user } = startHub()
afterAll(() => hub.stop())
const token = join(dataDir, 'agent.token')
const run = async (script: string, args: string[], env: Record<string, string | undefined>) => {
  const p = Bun.spawn(['bun', join(import.meta.dir, '..', script), ...args], { env: { ...process.env, HUB_ENV_FILE: '', ...env } as any, stdout: 'pipe', stderr: 'pipe' })
  const code = await p.exited
  return { code, out: await new Response(p.stdout).text(), err: await new Response(p.stderr).text() }
}
const check = (args: string[], env: Record<string, string | undefined>) => run('channel/check.ts', args, env)
const dead = 'http://127.0.0.1:9' // nothing listens there

test('check: all good is three ok lines; --hello sends a real message', async () => {
  const r = await check(['--strict', '--hello', 'Sam is connected'], { HUB_URL: hub.url, HUB_TOKEN_FILE: token })
  expect(r.code).toBe(0)
  expect(r.out).toContain('ok   settings')
  expect(r.out).toContain('ok   hub: answers and takes the token')
  expect(r.out).toContain('ok   stream: a probe went through the hub and came back')
  const msgs = await (await user('/api/messages')).json()
  expect(JSON.stringify(msgs)).toContain('Sam is connected')
})

test('check: each failure says what to fix, with its own exit code', async () => {
  expect((await check(['--strict'], { HUB_URL: undefined, HUB_TOKEN_FILE: token })).code).toBe(2)
  const noToken = await check([], { HUB_URL: hub.url, HUB_TOKEN_FILE: '/nonexistent/agent.token' })
  expect(noToken.code).toBe(2)
  expect(noToken.err).toContain("can't read the token file /nonexistent/agent.token")
  const dir = mkdtempSync(join(tmpdir(), 'check-'))
  writeFileSync(join(dir, 'agent.token'), 'not-this-hubs-token-000000')
  const wrong = await check([], { HUB_URL: hub.url, HUB_TOKEN_FILE: join(dir, 'agent.token') })
  expect(wrong.code).toBe(4)
  expect(wrong.err).toContain('refused the token')
  const down = await check([], { HUB_URL: dead, HUB_TOKEN_FILE: token })
  expect(down.code).toBe(3)
  expect(down.err).toContain(`no hub at ${dead}`)
})

test('probe: reaches every open agent stream, stored nowhere; listening flips with the stream', async () => {
  expect((await agent('/agent/probe', { method: 'POST', body: '{}' })).status).toBe(400)
  expect(await (await agent('/agent/probe', { method: 'POST', body: '{"nonce":"x"}' })).json()).toEqual({ ok: true, listeners: 0 })
  expect((await (await user('/api/listening')).json()).listening).toBe(false)
  const events = user('/api/events').then(r => readSSE(r, e => e.filter(x => x.event === 'listening').length >= 2))
  await Bun.sleep(50)
  const ac = new AbortController()
  const s = await agent('/agent/stream', { signal: ac.signal })
  expect(s.status).toBe(200)
  await Bun.sleep(50)
  const st = await (await user('/api/listening')).json()
  expect(st.listening).toBe(true)
  expect(st.last).toBeGreaterThan(0)
  expect((await (await agent('/agent/probe', { method: 'POST', body: '{"nonce":"y"}' })).json()).listeners).toBe(1)
  ac.abort()
  await Bun.sleep(100)
  expect((await (await user('/api/listening')).json()).listening).toBe(false)
  const ev = (await events).filter(x => x.event === 'listening').map(x => x.data.listening)
  expect(ev.slice(0, 2)).toEqual([true, false])
  expect(hub.db.query("SELECT COUNT(*) AS n FROM messages WHERE body_json LIKE '%probe%'").get()).toEqual({ n: 0 })
})

test('watcher: stops after HUB_WATCH_FAIL_AFTER failed connects and says why; an unreadable token stops it at once', async () => {
  const down = await run('channel/watch.ts', [], { HUB_URL: dead, HUB_TOKEN_FILE: token, HUB_WATCH_FAIL_AFTER: '2' })
  expect(down.code).toBe(3)
  expect(down.out).toContain(`The hub watcher stopped: can't reach the hub at ${dead} (2 tries`)
  expect(down.out).toContain('bin/hub-watch --patient')
  const noTok = await run('channel/watch.ts', [], { HUB_URL: hub.url, HUB_TOKEN_FILE: '/nonexistent' })
  expect(noTok.code).toBe(2)
  expect(noTok.out).toContain("can't read the token file /nonexistent")
  const strict = await run('channel/watch.ts', [], { HUB_ENV_FILE: '/x/hub.env', HUB_URL: undefined, HUB_TOKEN_FILE: token })
  expect(strict.code).toBe(2)
  expect(strict.out).toContain('must set HUB_URL and HUB_TOKEN_FILE')
})

test('presence: always exits 0, but says on stderr what went wrong', async () => {
  const down = await run('scripts/presence.ts', ['working', 'x'], { HUB_URL: dead, HUB_TOKEN_FILE: token })
  expect(down.code).toBe(0)
  expect(down.out).toBe('')
  expect(down.err).toContain(`presence: no hub at ${dead}`)
  const strict = await run('scripts/presence.ts', ['working'], { HUB_ENV_FILE: '/x/hub.env', HUB_URL: undefined, HUB_TOKEN_FILE: token })
  expect(strict.err).toContain('must set HUB_URL and HUB_TOKEN_FILE')
  const ok = await run('scripts/presence.ts', ['working', 'Testing'], { HUB_URL: hub.url, HUB_TOKEN_FILE: token })
  expect(ok.err).toBe('')
  expect((await (await user('/api/presence')).json()).detail).toBe('Testing')
})

test('bin/companion: reads hub.env again before every start, checks the hub, and refuses a broken hub.env', async () => {
  const { cpSync, readFileSync, existsSync } = await import('fs')
  const other = startHub()
  try {
    const root = mkdtempSync(join(tmpdir(), 'companion-'))
    const folder = join(root, 'sam'), bin = join(root, 'fakebin')
    cpSync(join(import.meta.dir, '..', 'examples', 'companion'), folder, { recursive: true })
    const checkout = join(import.meta.dir, '..')
    const env = (url: string, tok: string) => writeFileSync(join(folder, 'hub.env'), `HUB_HOME="${checkout}"\nHUB_URL="${url}"\nHUB_TOKEN_FILE="${tok}"\n`)
    // A fake claude: logs the hub it was given; the first time it points hub.env at the other
    // hub and asks for a restart; the second time it stops the loop.
    const { mkdirSync, chmodSync } = await import('fs')
    mkdirSync(bin)
    writeFileSync(join(bin, 'claude'), `#!/bin/zsh\nprint -r -- "$HUB_URL" >> ${root}/runs\nif [[ $(wc -l < ${root}/runs) -eq 1 ]]; then\n  printf 'HUB_HOME="${checkout}"\\nHUB_URL="${other.hub.url}"\\nHUB_TOKEN_FILE="${join(other.dataDir, 'agent.token')}"\\n' > ${folder}/hub.env\n  touch ${folder}/.restart\nelse\n  kill $PPID\nfi\n`)
    chmodSync(join(bin, 'claude'), 0o755)
    const go = () => Bun.spawn(['zsh', join(folder, 'bin', 'companion'), '--fresh'], { cwd: folder, env: { ...process.env, COMPANION_CLAUDE: join(bin, 'claude'), HUB_HOME: '', HUB_URL: '', HUB_TOKEN_FILE: '' }, stdout: 'pipe', stderr: 'pipe' })

    writeFileSync(join(folder, 'hub.env'), `HUB_HOME="${checkout}"\n`) // no URL or token: refused, claude never starts
    const bad = go()
    expect(await bad.exited).toBe(2)
    expect(await new Response(bad.stderr).text()).toContain("doesn't set: HUB_URL HUB_TOKEN_FILE")
    expect(existsSync(join(root, 'runs'))).toBe(false)

    env(hub.url, join(dataDir, 'agent.token'))
    const p = go()
    await p.exited
    expect(readFileSync(join(root, 'runs'), 'utf8').trim().split('\n')).toEqual([hub.url, other.hub.url])
  } finally { other.hub.stop() }
}, 20000)
