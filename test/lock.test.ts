import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'crypto'
import { startHub } from './helpers'

let ctx: ReturnType<typeof startHub>
afterEach(() => ctx?.hub.stop())

const hash = (t: string) => createHash('sha256').update(t).digest('hex')
const TOKEN = 'test-session-token-0123456789abcdef'

/** Turns the lock on with a stored passkey; WebAuthn itself is the library's job. */
function addPasskey() {
  ctx.hub.db.query('INSERT INTO passkeys (id, login, public_key, counter, created) VALUES (?, ?, ?, 0, ?)').run('cred-1', 'local', new Uint8Array([1, 2, 3]), Date.now())
}
function addSession(o: { seen?: number; stepup?: number } = {}) {
  const now = Date.now()
  ctx.hub.db.query('INSERT INTO auth_sessions (hash, login, created, seen, stepup) VALUES (?, ?, ?, ?, ?)').run(hash(TOKEN), 'local', now, o.seen ?? now, o.stepup ?? now)
}
const cookie = { cookie: `hub_session=${TOKEN}` }

test('off until a passkey exists: the API answers as before', async () => {
  ctx = startHub()
  expect((await ctx.user('/api/messages')).status).toBe(200)
  const st = await (await ctx.user('/api/auth/status')).json()
  expect(st).toMatchObject({ enabled: false, unlocked: true, passkeys: [] })
})

test('with a passkey, /api and /files need an unlocked session', async () => {
  ctx = startHub()
  addPasskey()
  const r = await ctx.user('/api/messages')
  expect(r.status).toBe(401)
  expect(await r.json()).toEqual({ error: 'locked' })
  expect((await ctx.user('/files/nope')).status).toBe(401)
  expect((await ctx.user('/api/events')).status).toBe(401)
  // The shell and the auth endpoints stay reachable, so the app can show its lock screen.
  expect((await ctx.user('/')).status).toBe(200)
  const st = await (await ctx.user('/api/auth/status')).json()
  expect(st).toMatchObject({ enabled: true, unlocked: false })
  expect(st.passkeys).toBeUndefined()
  // A made-up cookie doesn't help.
  expect((await ctx.user('/api/messages', { headers: { cookie: 'hub_session=xxxxxxxxxxxxxxxxxxxxxxxxxxxx' } })).status).toBe(401)

  addSession()
  expect((await ctx.user('/api/messages', { headers: cookie })).status).toBe(200)
  expect((await ctx.user('/api/auth/status', { headers: cookie }).then(r => r.json())).unlocked).toBe(true)
})

test('locks again after the idle time, unless the event stream is open', async () => {
  ctx = startHub({ lock: { idleMs: 60_000 } })
  addPasskey()
  addSession({ seen: Date.now() - 61_000 })
  expect((await ctx.user('/api/messages', { headers: cookie })).status).toBe(401)
  // Expired sessions are deleted, not just refused.
  expect(ctx.hub.db.query('SELECT COUNT(*) AS n FROM auth_sessions').get()).toEqual({ n: 0 })

  addSession()
  const ac = new AbortController()
  const es = await ctx.user('/api/events', { headers: cookie, signal: ac.signal })
  expect(es.status).toBe(200)
  ctx.hub.db.query('UPDATE auth_sessions SET seen = ?').run(Date.now() - 120_000)
  expect((await ctx.user('/api/messages', { headers: cookie })).status).toBe(200)
  ac.abort()
})

test('lock ends the session', async () => {
  ctx = startHub()
  addPasskey()
  addSession()
  const r = await ctx.user('/api/auth/lock', { method: 'POST', headers: cookie })
  expect(r.headers.get('set-cookie')).toContain('Max-Age=0')
  expect((await ctx.user('/api/messages', { headers: cookie })).status).toBe(401)
})

test('answering an approval needs a fresh unlock; a question does not', async () => {
  ctx = startHub({ lock: { stepupMs: 60_000 } })
  addPasskey()
  addSession({ stepup: Date.now() - 61_000 })
  const appr = await (await ctx.agent('/agent/send', { method: 'POST', body: JSON.stringify({ kind: 'approval', prompt: 'Deploy?' }) })).json()
  const ques = await (await ctx.agent('/agent/send', { method: 'POST', body: JSON.stringify({ kind: 'question', questions: [{ id: 'a', prompt: 'Which?', options: [{ label: 'x' }] }] }) })).json()
  const answer = (to: number, answers: unknown) => ctx.user('/api/messages', { method: 'POST', headers: cookie, body: JSON.stringify({ kind: 'answer', to, answers }) })

  const r = await answer(appr.id, { approval: ['Approve'] })
  expect(r.status).toBe(403)
  expect(await r.json()).toEqual({ error: 'stepup required' })
  expect((await answer(ques.id, { a: ['x'] })).status).toBe(201)

  ctx.hub.db.query('UPDATE auth_sessions SET stepup = ?').run(Date.now())
  expect((await answer(appr.id, { approval: ['Approve'] })).status).toBe(201)
})

test('a second passkey needs a fresh unlock; the first one does not', async () => {
  ctx = startHub()
  const first = await ctx.user('/api/auth/register/options', { method: 'POST', headers: { host: 'localhost' } })
  expect(first.status).toBe(200)
  const opts = await first.json()
  expect(opts.rp.id).toBe('localhost')
  expect(opts.authenticatorSelection.userVerification).toBe('required')

  addPasskey()
  expect((await ctx.user('/api/auth/register/options', { method: 'POST' })).status).toBe(403)
  addSession({ stepup: Date.now() - 10 * 60_000 })
  expect((await ctx.user('/api/auth/register/options', { method: 'POST', headers: cookie })).status).toBe(403)
  ctx.hub.db.query('UPDATE auth_sessions SET stepup = ?').run(Date.now())
  expect((await ctx.user('/api/auth/register/options', { method: 'POST', headers: cookie })).status).toBe(200)
})

test('unlock options list the stored passkeys and require user verification', async () => {
  ctx = startHub()
  expect((await ctx.user('/api/auth/login/options', { method: 'POST' })).status).toBe(409)
  addPasskey()
  const o = await (await ctx.user('/api/auth/login/options', { method: 'POST' })).json()
  expect(o.userVerification).toBe('required')
  expect(o.allowCredentials.map((c: any) => c.id)).toEqual(['cred-1'])
  // Verifying without a matching challenge or with garbage fails cleanly.
  expect((await ctx.user('/api/auth/login/verify', { method: 'POST', body: JSON.stringify({ response: { id: 'cred-1' } }) })).status).toBe(401)
  expect((await ctx.user('/api/auth/login/verify', { method: 'POST', body: '{}' })).status).toBe(400)
})

test('passkeys: rename and remove need a fresh unlock; the last one stays', async () => {
  ctx = startHub({ lock: { stepupMs: 60_000 } })
  addPasskey()
  ctx.hub.db.query('INSERT INTO passkeys (id, login, public_key, counter, name, created) VALUES (?, ?, ?, 0, ?, ?)').run('cred-2', 'local', new Uint8Array([4]), 'Mac', Date.now())
  const post = (path: string, body: unknown, headers: Record<string, string> = { ...cookie, 'x-hub-action': '1', 'content-type': 'application/json' }) =>
    ctx.user(path, { method: 'POST', body: JSON.stringify(body), headers })
  const names = () => (ctx.hub.db.query('SELECT id, name FROM passkeys ORDER BY created, id').all() as any[]).map(p => `${p.id}:${p.name}`)

  // Locked, stale, or without the action header: refused.
  expect((await post('/api/auth/passkeys/rename', { id: 'cred-2', name: 'x' }, { 'x-hub-action': '1', 'content-type': 'application/json' })).status).toBe(403)
  addSession({ stepup: Date.now() - 61_000 })
  expect((await post('/api/auth/passkeys/rename', { id: 'cred-2', name: 'x' })).status).toBe(403)
  ctx.hub.db.query('UPDATE auth_sessions SET stepup = ?').run(Date.now())
  expect((await post('/api/auth/passkeys/remove', { id: 'cred-2' }, cookie)).status).toBe(403)

  const r = await post('/api/auth/passkeys/rename', { id: 'cred-2', name: '  Work\nMac  ' })
  expect(await r.json()).toEqual({ ok: true, name: 'Work Mac' })
  expect((await post('/api/auth/passkeys/rename', { id: 'cred-2', name: '   ' })).status).toBe(400)
  expect((await post('/api/auth/passkeys/rename', { id: 'nope', name: 'a' })).status).toBe(404)
  expect((await post('/api/auth/passkeys/rename', { id: 'cred-2', name: 'x'.repeat(80) })).json().then(b => b.name.length)).resolves.toBe(60)

  expect((await post('/api/auth/passkeys/remove', { id: 'cred-2' })).status).toBe(200)
  expect(names()).toEqual(['cred-1:null'])
  const last = await post('/api/auth/passkeys/remove', { id: 'cred-1' })
  expect(last.status).toBe(409)
  expect((await last.json()).code).toBe('last_passkey')
  expect(names()).toEqual(['cred-1:null'])
})

test('passkeys: the user handle is this hub\'s own random id (never the login), the display name says which hub', async () => {
  ctx = startHub({ agentName: 'Faye' })
  const o = await (await ctx.user('/api/auth/register/options', { method: 'POST', body: '{}' })).json()
  const id = Buffer.from(o.user.id, 'base64url')
  expect(id.length).toBe(16)
  expect(id.toString()).not.toContain('local')
  expect(o.user.name).toBe('local')
  expect(o.user.displayName).toBe('local (Faye)')
  // Stable for this hub, different on another one.
  const o2 = await (await ctx.user('/api/auth/register/options', { method: 'POST', body: '{}' })).json()
  expect(o2.user.id).toBe(o.user.id)
  const other = startHub()
  try {
    const o3 = await (await other.user('/api/auth/register/options', { method: 'POST', body: '{}' })).json()
    expect(o3.user.id).not.toBe(o.user.id)
  } finally { other.hub.stop() }
})
