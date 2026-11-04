import { test, expect, afterAll } from 'bun:test'
import { join } from 'path'
import { startHub } from './helpers'

const { hub, dataDir, user, agent } = startHub()
afterAll(() => hub.stop())

const post = (text: string) => user('/api/messages', { method: 'POST', body: JSON.stringify({ kind: 'text', text }) }).then(r => r.json())
const delivered = (id: number) => (hub.db.query('SELECT delivered_at FROM messages WHERE id = ?').get(id) as any)?.delivered_at

function watch() {
  return Bun.spawn(['bun', join(import.meta.dir, '..', 'channel', 'watch.ts')], {
    env: { ...process.env, HUB_URL: hub.url, HUB_TOKEN_FILE: join(dataDir, 'agent.token'), HUB_WATCH_SETTLE_MS: '300' },
    stdout: 'pipe', stderr: 'ignore',
  })
}

const signOfLife = () => agent('/agent/presence', { method: 'POST', body: JSON.stringify({ state: 'working', detail: 'Reading' }) })

test('prints waiting messages as channel tags, hands them over, exits; the next sign of life confirms them', async () => {
  const a = await post('first')
  const b = await post('second part')
  const p = watch()
  expect(await p.exited).toBe(0)
  const out = await new Response(p.stdout).text()
  expect(out).toContain(`<channel source="hub" chat_id="hub" message_id="${a.id}"`)
  expect(out).toContain('first\n</channel>')
  expect(out).toContain('second part\n</channel>')
  expect(out).toContain('Start the hub watcher again')
  expect(delivered(a.id)).toBeFalsy()   // handed over, not yet read
  await signOfLife()
  expect(delivered(a.id)).toBeTruthy()
  expect(delivered(b.id)).toBeTruthy()
})

test('waits for a message that arrives later', async () => {
  const p = watch()
  await Bun.sleep(300)
  const c = await post('later')
  expect(await p.exited).toBe(0)
  const out = await new Response(p.stdout).text()
  expect(out).toContain(`message_id="${c.id}"`)
  expect(out).not.toContain('first')
  await signOfLife()
  expect(delivered(c.id)).toBeTruthy()
})

test('hand-off: a new watcher right after a wake gets nothing again; no sign of life → offered again, flagged', async () => {
  const h = startHub({ redeliverMs: 400 })
  try {
    const run = () => Bun.spawn(['bun', join(import.meta.dir, '..', 'channel', 'watch.ts')], {
      env: { ...process.env, HUB_URL: h.hub.url, HUB_TOKEN_FILE: join(h.dataDir, 'agent.token'), HUB_WATCH_SETTLE_MS: '100', HUB_ENV_FILE: '' },
      stdout: 'pipe', stderr: 'ignore',
    })
    const m = await (await h.user('/api/messages', { method: 'POST', body: JSON.stringify({ kind: 'text', text: 'hello once' }) })).json()
    const w1 = run()
    expect(await w1.exited).toBe(0)
    expect(await new Response(w1.stdout).text()).toContain('hello once')
    // The agent restarts its watcher before reading: that must not count, and must not get it again.
    const w2 = run()
    await Bun.sleep(150)
    // A stream connecting is not a sign of life, and the hand-off is still waiting.
    expect((h.hub.db.query('SELECT delivered_at FROM messages WHERE id = ?').get(m.id) as any).delivered_at).toBeNull()
    // No sign of life within redeliverMs: the open watcher gets it again, flagged.
    expect(await w2.exited).toBe(0)
    const again = await new Response(w2.stdout).text()
    expect(again).toContain('hello once')
    expect(again).toContain('redelivered="1"')
    // Now the agent acts: confirmed, and not offered again.
    await h.agent('/agent/send', { method: 'POST', body: JSON.stringify({ kind: 'text', text: 'got it' }) })
    expect((h.hub.db.query('SELECT delivered_at FROM messages WHERE id = ?').get(m.id) as any).delivered_at).toBeGreaterThan(0)
    await Bun.sleep(600)
    const w3 = run()
    const quiet = await Promise.race([w3.exited.then(() => 'exited'), Bun.sleep(700).then(() => 'waiting')])
    expect(quiet).toBe('waiting')
    w3.kill()
  } finally { h.hub.stop() }
}, 15000)

test('hand-off: a channel inside the session still acks directly; probes and hand-offs are no sign of life', async () => {
  const h = startHub()
  try {
    const m = await (await h.user('/api/messages', { method: 'POST', body: JSON.stringify({ kind: 'text', text: 'x' }) })).json()
    const del = () => (h.hub.db.query('SELECT delivered_at FROM messages WHERE id = ?').get(m.id) as any).delivered_at
    expect(await (await h.agent('/agent/handed', { method: 'POST', body: JSON.stringify({ ids: [m.id, 99999] }) })).json()).toEqual({ ok: true, handed: 1 })
    await h.agent('/agent/probe', { method: 'POST', body: '{"nonce":"n"}' })
    await h.agent('/agent/presence', { method: 'POST', body: '{"state":"idle"}' }) // a Stop or SessionEnd hook
    expect(del()).toBeNull()
    await h.agent('/agent/ack', { method: 'POST', body: JSON.stringify({ ids: [m.id] }) })
    expect(del()).toBeGreaterThan(0)
  } finally { h.hub.stop() }
})
