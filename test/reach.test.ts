// When the hub can't be reached (Tailscale off, no connection, hub down), the app says so with
// Retry, instead of an empty "No messages yet." (web/app.js).
import { test, expect } from 'bun:test'
import { join } from 'path'
import { readFileSync } from 'fs'

const web = (f: string) => readFileSync(join(import.meta.dir, '..', 'web', f), 'utf8')

test('reach: a failed request says why; an answer clears it and loads what was missing', () => {
  const app = web('app.js')
  const api = app.slice(app.indexOf('async function api('), app.indexOf('// ---------- reaching the hub'))
  expect(api).toContain("setReach(navigator.onLine === false ? 'offline' : 'network')") // fetch threw: never reached the hub
  expect(api).toContain("res.status >= 502 && res.status <= 504 ? 'hub' : null")     // the proxy answered for a hub that's down
  expect(api).toContain("e?.name !== 'AbortError'")                                   // a cancelled request is not an outage
  const reach = app.slice(app.indexOf('// ---------- reaching the hub'), app.indexOf('const qs ='))
  expect(reach).toContain('if (was && !why) recoverHub()')
  expect(reach).toContain('if (!state.historyLoaded) loadLatest()')
  // The empty list says the hub is out of reach, not that there's nothing.
  const empty = app.slice(app.indexOf('function paintEmpty('), app.indexOf('function paintEmpty(') + 600)
  expect(empty).toContain('reach.down && !state.historyLoaded')
  // The live stream reopening counts as the hub answering.
  expect(app).toContain("setConn('on', S.connected); setReach(null)")
  expect(web('index.html')).toContain('id="hub-down"')
  const S = web('strings.js')
  expect(S).toContain('Is Tailscale on?')
  expect(S).toContain("retry: 'Retry'")
})

test('own session: the agent stopped on a prompt shows a band in its chat that opens the prompt card; its push carries its name', () => {
  const app = web('app.js')
  const fn = app.slice(app.indexOf('const ownPane ='), app.indexOf('async function loadPanes('))
  expect(fn).toContain("projectKey(p.project) === selfName()")
  expect(fn).toContain("p.status === 'blocked'")
  expect(fn).toContain('openPanes(p.id)')
  expect(web('index.html')).toContain('id="agent-ask"')
  const server = readFileSync(join(import.meta.dir, '..', 'hub', 'server.ts'), 'utf8')
  expect(server).toContain("(p.project ?? '').toLowerCase() === agentName.toLowerCase() ? agentName : p.title")
})
