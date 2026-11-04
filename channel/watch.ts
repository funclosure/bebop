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
 * 2000: after the first message, wait this long for more before exiting).
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { renderContent, buildMeta } from './server'

const HUB_URL = (process.env.HUB_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '')
const TOKEN_FILE = process.env.HUB_TOKEN_FILE || join(import.meta.dir, '..', 'data', 'agent.token')
const SETTLE = Number(process.env.HUB_WATCH_SETTLE_MS ?? 2000)

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

if (import.meta.main) {
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
      const delay = Math.min(1000 * 2 ** Math.min(attempt - 1, 5), 30000)
      log(`${err instanceof Error ? err.message : err}; reconnecting in ${delay / 1000}s`)
      await Bun.sleep(delay)
    }
  }
}
