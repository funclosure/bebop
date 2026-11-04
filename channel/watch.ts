#!/usr/bin/env bun
/**
 * Bebop watcher: the channel without the channel flag.
 *
 * Claude Code only registers our own channel behind
 * --dangerously-load-development-channels, which asks for confirmation on
 * every launch and so blocks an unattended relaunch. Instead the agent runs
 * this in the background (Bash run_in_background): it waits on the hub's
 * stream, prints the first user message(s) as <channel> tags, acks them once
 * they are written, and exits. The exit wakes the agent, which reads the
 * output and starts the watcher again. Run server.ts with HUB_INBOUND=off
 * alongside, so the two don't both consume the stream.
 *
 * Env: HUB_URL, HUB_TOKEN_FILE (as server.ts), HUB_WATCH_SETTLE_MS (default
 * 2000: after the first message, wait this long for more before exiting),
 * HUB_WATCH_FAIL_AFTER (default 5): after that many failed connects in a row it stops
 * and says so (exit 3), instead of retrying out of sight. --patient keeps retrying:
 * for when the agent knows the hub is down and wants to be woken once it's back.
 * With HUB_ENV_FILE set (bin/hub-env loaded a hub.env), HUB_URL and HUB_TOKEN_FILE must be
 * set: no defaults. A token file that can't be read stops it at once (exit 2).
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { renderContent, buildMeta } from './server'

const HUB_URL = (process.env.HUB_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '')
const TOKEN_FILE = process.env.HUB_TOKEN_FILE || join(import.meta.dir, '..', 'data', 'agent.token')
const SETTLE = Number(process.env.HUB_WATCH_SETTLE_MS ?? 2000)
const FAIL_AFTER = Number(process.env.HUB_WATCH_FAIL_AFTER ?? 5)

const log = (m: string) => process.stderr.write(`hub watch: ${m}\n`)
const token = () => readFileSync(TOKEN_FILE, 'utf8').trim()

export function renderTag(m: any): string {
  const attrs = Object.entries({ source: 'hub', ...buildMeta(m) }).map(([k, v]) => `${k}="${v}"`).join(' ')
  return `<channel ${attrs}>\n${renderContent(m)}\n</channel>`
}

/** Resolves with the messages that arrived: the first one, plus any within SETTLE ms of it. */
async function waitForMessages(): Promise<any[]> {
  const abort = new AbortController()
  const res = await fetch(`${HUB_URL}/agent/stream`, {
    headers: { authorization: `Bearer ${token()}`, accept: 'text/event-stream' },
    signal: abort.signal,
  })
  if (!res.ok || !res.body) throw new Error(`stream HTTP ${res.status}`)
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  const got: any[] = []
  let buf = ''
  let deadline = Infinity
  try {
    for (;;) {
      const left = deadline - Date.now()
      if (left <= 0) return got
      const r = await (left === Infinity ? reader.read() : Promise.race([reader.read(), Bun.sleep(left).then(() => null)]))
      if (!r) return got
      if (r.done) { if (got.length) return got; throw new Error('stream closed') }
      buf += dec.decode(r.value, { stream: true })
      let i: number
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i)
        buf = buf.slice(i + 2)
        let event = 'message', data = ''
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim()
          else if (line.startsWith('data:')) data += line.slice(5).trimStart()
        }
        if (event !== 'message' || !data) continue
        got.push(JSON.parse(data))
        if (deadline === Infinity) deadline = Date.now() + SETTLE
      }
    }
  } finally {
    abort.abort()
  }
}

/** Stops with a message the agent reads in the watcher's output. */
function stop(code: number, why: string): never {
  process.stdout.write(`The hub watcher stopped: ${why}\n` + (code === 3
    ? `Messages wait in the hub, nothing is lost. Run bun "$HUB_HOME/channel/check.ts" to see what's wrong. When the hub is being restarted or fixed, start bin/hub-watch --patient in the background: it waits for the hub and wakes you with the next message.\n`
    : `Fix hub.env (or the hub), then start bin/hub-watch again.\n`))
  process.exit(code)
}

if (import.meta.main) {
  const patient = process.argv.includes('--patient')
  if (process.env.HUB_ENV_FILE && (!process.env.HUB_URL || !process.env.HUB_TOKEN_FILE))
    stop(2, `hub.env (${process.env.HUB_ENV_FILE}) must set HUB_URL and HUB_TOKEN_FILE`)
  try { token() } catch (e: any) { stop(2, `can't read the token file ${TOKEN_FILE} (${e?.code ?? e})`) }
  let attempt = 0
  for (;;) {
    try {
      const msgs = await waitForMessages()
      process.stdout.write(msgs.map(renderTag).join('\n\n') + '\n\nStart the hub watcher again (run_in_background) before replying.\n')
      const ack = await fetch(`${HUB_URL}/agent/ack`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ids: msgs.map(m => m.id) }),
      })
      if (!ack.ok) log(`ack failed: HTTP ${ack.status}`)
      process.exit(0)
    } catch (err) {
      attempt++
      const msg = err instanceof Error ? err.message : String(err)
      if (/HTTP 401/.test(msg)) stop(2, `the hub at ${HUB_URL} refused the token from ${TOKEN_FILE} (it belongs to another hub)`)
      if (!patient && attempt >= FAIL_AFTER) stop(3, `can't reach the hub at ${HUB_URL} (${attempt} tries: ${msg})`)
      const delay = Math.min(1000 * 2 ** Math.min(attempt - 1, 5), 30000)
      log(`${err instanceof Error ? err.message : err}; reconnecting in ${delay / 1000}s`)
      await Bun.sleep(delay)
    }
  }
}
