#!/usr/bin/env bun
/**
 * Is this agent wired to its hub? Checks, in order, and stops at the first that fails:
 *   1. the settings: HUB_URL set, the token file readable;
 *   2. the hub answers and takes this token (a real authenticated request);
 *   3. a round trip on the agent stream: a probe sent through the hub comes back on a stream
 *      this script opened (the same path hub messages take to the watcher);
 *   4. with --hello TEXT: a real message to the user, which shows in the app.
 * Prints one line per step, and a plain-English reason when one fails. No fallbacks: with
 * --strict (bin/companion and setup use it) HUB_URL and HUB_TOKEN_FILE must be set, not defaulted.
 *
 * Exit: 0 all good; 2 settings (fix hub.env); 3 hub not reachable (start it, or wait for it);
 * 4 the hub refused the token (it belongs to another hub, or the hub was reset).
 *   bun channel/check.ts [--strict] [--hello TEXT] [--quiet]
 */
import { readFileSync } from 'fs'
import { join } from 'path'

const args = process.argv.slice(2)
const strict = args.includes('--strict'), quiet = args.includes('--quiet')
const hello = args.includes('--hello') ? args[args.indexOf('--hello') + 1] : null

const say = (m: string) => { if (!quiet) process.stdout.write(m + '\n') }
const fail = (code: number, m: string): never => { process.stderr.write(`hub check: ${m}\n`); process.exit(code) }

const envUrl = process.env.HUB_URL, envToken = process.env.HUB_TOKEN_FILE
if (strict && !envUrl) fail(2, 'HUB_URL is not set. Put HUB_URL="http://127.0.0.1:<port>" in hub.env.')
if (strict && !envToken) fail(2, 'HUB_TOKEN_FILE is not set. Put HUB_TOKEN_FILE="<the hub\'s data folder>/agent.token" in hub.env.')
const url = (envUrl || 'http://127.0.0.1:8787').replace(/\/+$/, '')
const tokenFile = envToken || join(import.meta.dir, '..', 'data', 'agent.token')

let token = ''
try { token = readFileSync(tokenFile, 'utf8').trim() } catch (e: any) {
  fail(2, `can't read the token file ${tokenFile} (${e?.code ?? e}). It's agent.token in the hub's data folder (HUB_DATA_DIR); the hub writes it when it first starts.`)
}
if (!token) fail(2, `the token file ${tokenFile} is empty`)
say(`ok   settings: ${url}, token from ${tokenFile}`)

const auth = { authorization: `Bearer ${token}` }
let res: Response
try { res = await fetch(`${url}/agent/history?limit=1`, { headers: auth, signal: AbortSignal.timeout(3000) }) } catch (e: any) {
  fail(3, `no hub at ${url} (${e?.cause?.code ?? e?.name ?? e}). Is it running, on this port? Check HUB_URL in hub.env and the hub's log.`)
}
if (res!.status === 401) fail(4, `the hub at ${url} refused the token from ${tokenFile}: it belongs to another hub (check HUB_TOKEN_FILE and the port in hub.env).`)
if (!res!.ok) fail(3, `the hub at ${url} answered HTTP ${res!.status}`)
say(`ok   hub: answers and takes the token`)

// Is the running hub this checkout's code? (Older hubs have no /agent/version.)
const here = Bun.spawnSync(['git', '-C', join(import.meta.dir, '..'), 'rev-parse', '--short', 'HEAD'], { stderr: 'ignore' })
const mine = here.exitCode === 0 ? here.stdout.toString().trim() : null
const ver = await fetch(`${url}/agent/version`, { headers: auth }).then(r => r.ok ? r.json() : null).catch(() => null) as { commit?: string | null } | null
if (!ver) say(`note hub: older than this checkout (no /agent/version): restart the hub`)
else if (mine && ver.commit && ver.commit !== mine) say(`note hub: runs ${ver.commit}, this checkout is ${mine}: restart the hub`)

// The round trip: open a stream, send a probe, wait for it to come back on that stream.
const nonce = crypto.randomUUID()
const abort = new AbortController()
const timer = setTimeout(() => abort.abort(), 5000)
try {
  const stream = await fetch(`${url}/agent/stream`, { headers: { ...auth, accept: 'text/event-stream' }, signal: abort.signal })
  if (!stream.ok || !stream.body) fail(3, `the agent stream answered HTTP ${stream.status}`)
  const reader = stream.body!.getReader(), dec = new TextDecoder()
  let buf = '', sent = false, back = false
  while (!back) {
    if (!sent) {
      sent = true
      const p = await fetch(`${url}/agent/probe`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ nonce }) })
      if (!p.ok) fail(3, `the hub refused the probe (HTTP ${p.status}): is it older than this checkout? Restart it.`)
    }
    const r = await reader.read()
    if (r.done) break
    buf += dec.decode(r.value, { stream: true })
    for (let i; (i = buf.indexOf('\n\n')) >= 0; buf = buf.slice(i + 2)) {
      const block = buf.slice(0, i)
      if (/^event: probe$/m.test(block) && block.includes(nonce)) back = true
    }
  }
  if (!back) fail(3, 'the agent stream closed before the probe came back')
} catch (e: any) {
  if (e?.name === 'AbortError') fail(3, `the probe didn't come back on the agent stream within 5 s`)
  throw e
} finally { clearTimeout(timer); abort.abort() }
say(`ok   stream: a probe went through the hub and came back`)

if (hello) {
  const r = await fetch(`${url}/agent/send`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'text', text: hello }) })
  if (!r.ok) fail(3, `sending the hello failed: HTTP ${r.status}`)
  say(`ok   hello: sent to the app ("${hello}")`)
}
process.exit(0)
