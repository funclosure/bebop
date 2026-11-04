// Passkey lock (WebAuthn): a second layer on top of the Tailscale login.
// Off until the first passkey is registered. From then on /api/* (except /api/auth/*)
// and /files/* need an unlocked session: a cookie set after a passkey assertion with
// user verification (Face ID / Touch ID), which locks again after `idleMs` without
// requests or an open event stream. Answers to approval cards also need a fresh
// assertion (step-up), even while unlocked.
import type { Database } from 'bun:sqlite'
import { createHash, randomBytes } from 'crypto'
import {
  generateAuthenticationOptions, generateRegistrationOptions,
  verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticatorTransportFuture,
} from '@simplewebauthn/server'

const COOKIE = 'hub_session'
const SESSION_MAX_MS = 30 * 24 * 3600_000
const CHALLENGE_MS = 5 * 60_000

type PasskeyRow = { id: string; login: string; public_key: Uint8Array; counter: number; transports: string | null; name: string | null; created: number; last_used: number | null }
type SessionRow = { hash: string; login: string; created: number; seen: number; stepup: number }

export type LockOptions = { idleMs?: number; stepupMs?: number; rpName?: string; rpId?: string }

const hashToken = (t: string) => createHash('sha256').update(t).digest('hex')

export function createLock(db: Database, opts: LockOptions = {}) {
  const idleMs = opts.idleMs ?? 5 * 60_000
  const stepupMs = opts.stepupMs ?? 2 * 60_000
  db.exec(`
    CREATE TABLE IF NOT EXISTS passkeys (
      id TEXT PRIMARY KEY, login TEXT NOT NULL, public_key BLOB NOT NULL, counter INTEGER NOT NULL,
      transports TEXT, name TEXT, created INTEGER NOT NULL, last_used INTEGER
    );
    CREATE TABLE IF NOT EXISTS auth_sessions (
      hash TEXT PRIMARY KEY, login TEXT NOT NULL, created INTEGER NOT NULL, seen INTEGER NOT NULL, stepup INTEGER NOT NULL
    );
  `)
  const q = {
    count: db.query('SELECT COUNT(*) AS n FROM passkeys'),
    all: db.query('SELECT * FROM passkeys ORDER BY created'),
    get: db.query('SELECT * FROM passkeys WHERE id = ?'),
    insert: db.query('INSERT INTO passkeys (id, login, public_key, counter, transports, name, created) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    used: db.query('UPDATE passkeys SET counter = ?, last_used = ? WHERE id = ?'),
    session: db.query('SELECT * FROM auth_sessions WHERE hash = ?'),
    putSession: db.query('INSERT INTO auth_sessions (hash, login, created, seen, stepup) VALUES (?, ?, ?, ?, ?)'),
    touch: db.query('UPDATE auth_sessions SET seen = ? WHERE hash = ?'),
    stepup: db.query('UPDATE auth_sessions SET seen = ?, stepup = ? WHERE hash = ?'),
    drop: db.query('DELETE FROM auth_sessions WHERE hash = ?'),
    rename: db.query('UPDATE passkeys SET name = ? WHERE id = ?'),
    remove: db.query('DELETE FROM passkeys WHERE id = ?'),
    prune: db.query('DELETE FROM auth_sessions WHERE created < ? OR seen < ?'), // seen: a day, so a long-open stream isn't cut
  }
  // Outstanding challenges, in memory (a restart just means asking again). Several at once,
  // so the phone and the Mac don't cancel each other's; each one works once.
  const challenges = new Map<string, { purpose: 'reg' | 'auth'; at: number }>()
  // Sessions with an open event stream count as active: the app is on screen.
  const streams = new Map<string, number>()

  const enabled = () => (q.count.get() as { n: number }).n > 0

  // 16 random bytes made once per hub (kept with the passkeys), so its passkeys never share a
  // user handle with another hub's.
  db.exec('CREATE TABLE IF NOT EXISTS lock_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  function hubUserId(): Uint8Array {
    const row = db.query("SELECT value FROM lock_meta WHERE key = 'user_id'").get() as { value: string } | null
    if (row) return new Uint8Array(Buffer.from(row.value, 'base64url'))
    const id = randomBytes(16)
    db.query("INSERT INTO lock_meta (key, value) VALUES ('user_id', ?)").run(id.toString('base64url'))
    return new Uint8Array(id)
  }

  function cookieToken(req: Request): string | null {
    const m = /(?:^|;\s*)hub_session=([A-Za-z0-9_-]{20,})/.exec(req.headers.get('cookie') ?? '')
    return m ? m[1] : null
  }

  function session(req: Request): SessionRow | null {
    const t = cookieToken(req)
    if (!t) return null
    const s = q.session.get(hashToken(t)) as SessionRow | null
    if (!s) return null
    const now = Date.now()
    const live = streams.has(s.hash)
    if (now - s.created > SESSION_MAX_MS || (!live && now - s.seen > idleMs)) { q.drop.run(s.hash); return null }
    if (now - s.seen > 15_000) { q.touch.run(now, s.hash); s.seen = now }
    return s
  }

  function newSession(login: string): string {
    const t = randomBytes(32).toString('base64url')
    const now = Date.now()
    q.prune.run(now - SESSION_MAX_MS, now - 24 * 3600_000)
    q.putSession.run(hashToken(t), login, now, now, now)
    return `${COOKIE}=${t}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_MAX_MS / 1000}`
  }

  /** The relying party is the host the app was opened on (tailscale serve keeps the Host header). */
  function rp(req: Request) {
    const host = (req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? 'localhost').split(',')[0].trim()
    const rpID = opts.rpId ?? host.replace(/:\d+$/, '')
    const local = rpID === 'localhost'
    const origin = req.headers.get('origin') ?? ''
    // Browsers only allow plain http for WebAuthn on localhost.
    const expectedOrigin = local ? origin.startsWith('http://localhost') || origin.startsWith('https://localhost') ? origin : `https://${host}` : `https://${host}`
    return { rpID, expectedOrigin }
  }

  const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } })
  const fail = (status: number, error: string) => json({ error }, status)

  function issue(challenge: string, purpose: 'reg' | 'auth') {
    const now = Date.now()
    for (const [k, c] of challenges) if (now - c.at > CHALLENGE_MS) challenges.delete(k)
    if (challenges.size > 100) challenges.delete(challenges.keys().next().value!)
    challenges.set(challenge, { purpose, at: now })
  }
  const take = (purpose: 'reg' | 'auth') => (challenge: string) => {
    const c = challenges.get(challenge)
    challenges.delete(challenge)
    return !!c && c.purpose === purpose && Date.now() - c.at < CHALLENGE_MS
  }

  function status(req: Request) {
    const on = enabled()
    const s = on ? session(req) : null
    const unlocked = !on || !!s
    return {
      enabled: on,
      unlocked,
      idle_min: Math.round(idleMs / 60_000),
      passkeys: unlocked ? (q.all.all() as PasskeyRow[]).map(p => ({ id: p.id, name: p.name, created: p.created, last_used: p.last_used })) : undefined,
    }
  }

  /** /api/auth/*: answered before the lock check. */
  async function handle(req: Request, path: string, login: string): Promise<Response> {
    const method = req.method
    if (method === 'GET' && path === '/api/auth/status') return json(status(req))
    if (method !== 'POST') return fail(405, 'method not allowed')

    if (path === '/api/auth/lock') {
      const t = cookieToken(req)
      if (t) q.drop.run(hashToken(t))
      return json({ ok: true }, 200, { 'set-cookie': `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0` })
    }

    if (path === '/api/auth/register/options') {
      // The first passkey turns the lock on; adding another one needs a fresh unlock.
      if (enabled()) {
        const s = session(req)
        if (!s || Date.now() - s.stepup > stepupMs) return fail(403, 'stepup required')
      }
      const { rpID } = rp(req)
      const existing = q.all.all() as PasskeyRow[]
      const options = await generateRegistrationOptions({
        rpName: opts.rpName ?? 'Bebop',
        rpID,
        // The user handle is this hub's own, never the login: two hubs on one host (say a test
        // hub next to the main one) share the relying party, and a password manager keeps one
        // passkey per relying party and user handle, so a shared handle made a new hub's
        // passkey replace the other hub's. The display name says which hub it's for.
        userName: login,
        userDisplayName: `${login} (${opts.rpName ?? 'Bebop'})`,
        userID: hubUserId(),
        attestationType: 'none',
        excludeCredentials: existing.map(p => ({ id: p.id, transports: p.transports ? JSON.parse(p.transports) : undefined })),
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
      })
      issue(options.challenge, 'reg')
      return json(options)
    }

    if (path === '/api/auth/register/verify') {
      const b = await req.json().catch(() => null) as { response?: any; name?: string } | null
      if (!b?.response) return fail(400, 'response required')
      if (enabled()) {
        const s = session(req)
        if (!s || Date.now() - s.stepup > stepupMs) return fail(403, 'stepup required')
      }
      const { rpID, expectedOrigin } = rp(req)
      let v
      try {
        v = await verifyRegistrationResponse({ response: b.response, expectedChallenge: take('reg'), expectedOrigin, expectedRPID: rpID, requireUserVerification: true })
      } catch (e) { return fail(400, `registration failed: ${(e as Error).message}`) }
      if (!v.verified || !v.registrationInfo) return fail(400, 'registration not verified')
      const c = v.registrationInfo.credential
      const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim().slice(0, 60) : null
      q.insert.run(c.id, login, c.publicKey, c.counter, c.transports ? JSON.stringify(c.transports) : null, name, Date.now())
      return json({ ok: true, id: c.id }, 201, { 'set-cookie': newSession(login) })
    }

    if (path === '/api/auth/login/options') {
      const { rpID } = rp(req)
      const keys = q.all.all() as PasskeyRow[]
      if (!keys.length) return fail(409, 'no passkeys')
      const options = await generateAuthenticationOptions({
        rpID,
        userVerification: 'required',
        allowCredentials: keys.map(p => ({ id: p.id, transports: p.transports ? JSON.parse(p.transports) as AuthenticatorTransportFuture[] : undefined })),
      })
      issue(options.challenge, 'auth')
      return json(options)
    }

    if (path === '/api/auth/login/verify') {
      const b = await req.json().catch(() => null) as { response?: any } | null
      if (!b?.response?.id) return fail(400, 'response required')
      const key = q.get.get(b.response.id) as PasskeyRow | null
      if (!key) return fail(400, 'unknown passkey')
      const { rpID, expectedOrigin } = rp(req)
      let v
      try {
        v = await verifyAuthenticationResponse({
          response: b.response, expectedChallenge: take('auth'), expectedOrigin, expectedRPID: rpID, requireUserVerification: true,
          credential: { id: key.id, publicKey: new Uint8Array(key.public_key), counter: key.counter, transports: key.transports ? JSON.parse(key.transports) : undefined },
        })
      } catch (e) { return fail(401, `unlock failed: ${(e as Error).message}`) }
      if (!v.verified) return fail(401, 'unlock not verified')
      const now = Date.now()
      q.used.run(v.authenticationInfo.newCounter, now, key.id)
      // An unlocked session is refreshed in place; otherwise a new one starts.
      const s = session(req)
      // `id`: the passkey that unlocked, so the app can mark it "This device".
      if (s) { q.stepup.run(now, now, s.hash); return json({ ok: true, id: key.id }) }
      return json({ ok: true, id: key.id }, 200, { 'set-cookie': newSession(login) })
    }

    // Managing passkeys: a fresh Face ID, like adding one. The last passkey can't be removed
    // here (that would turn the lock off); `bun scripts/passkeys.ts off` on the hub machine does that.
    if (path === '/api/auth/passkeys/rename' || path === '/api/auth/passkeys/remove') {
      if (req.headers.get('x-hub-action') !== '1' || !(req.headers.get('content-type') ?? '').startsWith('application/json')) return fail(403, 'X-Hub-Action header and a JSON body required')
      const s = session(req)
      if (!enabled() || !s || Date.now() - s.stepup > stepupMs) return fail(403, 'stepup required')
      const b = await req.json().catch(() => null) as { id?: unknown; name?: unknown } | null
      const id = typeof b?.id === 'string' ? b.id : ''
      if (!id || !q.get.get(id)) return json({ error: 'no such passkey', code: 'not_found' }, 404)
      if (path.endsWith('/rename')) {
        const name = typeof b?.name === 'string' ? b.name.replace(/[\x00-\x1f\x7f\s]+/g, ' ').trim().slice(0, 60) : ''
        if (!name) return fail(400, 'name: 1 to 60 characters')
        q.rename.run(name, id)
        return json({ ok: true, name })
      }
      if ((q.count.get() as { n: number }).n <= 1) return json({ error: 'the last passkey cannot be removed here', code: 'last_passkey' }, 409)
      q.remove.run(id)
      return json({ ok: true })
    }

    return fail(404, 'not found')
  }

  return {
    enabled,
    handle,
    /** null when the request may go on, else the 401 to send. */
    check(req: Request): Response | null {
      if (!enabled() || session(req)) return null
      return fail(401, 'locked')
    },
    /** For actions that need a fresh Face ID even while unlocked. */
    steppedUp(req: Request): boolean {
      if (!enabled()) return true
      const s = session(req)
      return !!s && Date.now() - s.stepup <= stepupMs
    },
    streamOpened(req: Request) {
      const t = cookieToken(req)
      if (!t) return
      const h = hashToken(t)
      streams.set(h, (streams.get(h) ?? 0) + 1)
    },
    streamClosed(req: Request) {
      const t = cookieToken(req)
      if (!t) return
      const h = hashToken(t)
      const n = (streams.get(h) ?? 1) - 1
      if (n > 0) streams.set(h, n)
      else { streams.delete(h); q.touch.run(Date.now(), h) }
    },
  }
}
