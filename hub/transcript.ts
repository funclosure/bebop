// Transcripts: the earlier turns of a Claude Code session, read from its own transcript file.
// A session that draws on the alternate screen only ever shows one screen through its
// multiplexer, so the Sessions view loads what came before from here, a page at a time,
// going back from the end of the file (transcripts reach hundreds of MB).
import { openSync, readSync, closeSync, fstatSync, readFileSync, readdirSync, existsSync } from 'fs'
import { join } from 'path'

export type TranscriptItem = {
  /** user: a prompt; assistant: a reply; tool: one tool call, in one line; peer: another
   *  session's message (`name` is who sent it); note: compaction, a background task. */
  kind: 'user' | 'assistant' | 'tool' | 'peer' | 'note'
  text: string
  ts?: string
  name?: string
  /** A tool call whose result was an error. */
  error?: boolean
  /** The text was cut at TEXT_MAX. */
  cut?: boolean
}
export type TranscriptPage = { items: TranscriptItem[]; next: number | null }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
export const TEXT_MAX = 8000
const TOOL_MAX = 160
const LINE_MAX = 4 << 20 // a longer line (an image, a huge tool result) is skipped unread
const CHUNK = 256 << 10

/** Claude Code's folder name for a project: every character but letters and digits is a '-'. */
export const projectSlug = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/g, '-')

const isAlive = (pid: number) => {
  try { process.kill(pid, 0); return true } catch (e: any) { return e?.code === 'EPERM' }
}
const readJson = (path: string) => { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null } }

/**
 * The transcript of the Claude Code process `pid` (from `<claudeDir>/sessions/<pid>.json`,
 * which Claude Code keeps current, so a /clear or /resume moves with it). Without a pid,
 * the one live session started in `cwd`; none or several → null, never a guess.
 */
export function findTranscript(o: { claudeDir: string; pid?: number | null; cwd?: string | null; alive?: (pid: number) => boolean }): { session: string; path: string } | null {
  const alive = o.alive ?? isAlive
  let rec: any = null
  if (o.pid != null && Number.isInteger(o.pid) && o.pid > 0) rec = readJson(join(o.claudeDir, 'sessions', `${o.pid}.json`))
  if (!rec && o.cwd) {
    let names: string[] = []
    try { names = readdirSync(join(o.claudeDir, 'sessions')).filter(n => /^\d+\.json$/.test(n)) } catch {}
    const live = names.map(n => readJson(join(o.claudeDir, 'sessions', n)))
      .filter(r => r && r.cwd === o.cwd && Number.isInteger(r.pid) && alive(r.pid))
    if (live.length === 1) rec = live[0]
  }
  const session = rec?.sessionId
  if (typeof session !== 'string' || !UUID.test(session)) return null
  const file = `${session}.jsonl`
  const projects = join(o.claudeDir, 'projects')
  const cwd = typeof rec.cwd === 'string' ? rec.cwd : o.cwd
  if (cwd) {
    const p = join(projects, projectSlug(cwd), file)
    if (existsSync(p)) return { session, path: p }
  }
  let dirs: string[] = []
  try { dirs = readdirSync(projects) } catch {}
  for (const d of dirs) {
    const p = join(projects, d, file)
    if (existsSync(p)) return { session, path: p }
  }
  return null
}

/** The file's lines from `end` back to the start, newest first, each with the byte offset it starts at. Too long → `line` null. */
export function* linesBackward(fd: number, end: number, chunk = CHUNK, maxLine = LINE_MAX): Generator<{ line: string | null; start: number }> {
  let pos = end
  let parts: Buffer[] = [], len = 0, tooLong = false
  const take = (head: Buffer) => {
    if (tooLong) return null
    const s = Buffer.concat([head, ...parts]).toString('utf8')
    return s
  }
  while (pos > 0) {
    const size = Math.min(chunk, pos)
    pos -= size
    const buf = Buffer.alloc(size)
    readSync(fd, buf, 0, size, pos)
    let curEnd = size
    for (let i = size - 1; i >= 0; i--) {
      if (buf[i] !== 0x0a) continue
      const head = buf.subarray(i + 1, curEnd)
      if (len + head.length > maxLine) tooLong = true
      if (len + head.length > 0) yield { line: take(head), start: pos + i + 1 }
      parts = []; len = 0; tooLong = false
      curEnd = i
    }
    const rest = buf.subarray(0, curEnd)
    if (len + rest.length > maxLine) { tooLong = true; parts = []; len = 0 }
    else if (!tooLong && rest.length) { parts.unshift(Buffer.from(rest)); len += rest.length }
  }
  if (len > 0 || tooLong) yield { line: tooLong ? null : Buffer.concat(parts).toString('utf8'), start: 0 }
}

const cut = (s: string, max: number) => s.length > max ? { text: s.slice(0, max).trimEnd() + '…', cut: true } : { text: s }
const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g
const tidy = (s: string) => s.replace(REMINDER, '').trim()

function userText(s: string, meta: boolean, ts?: string): TranscriptItem[] {
  const peer = /^Another Claude session sent a message:\s*<cross-session-message\b([^>]*)>([\s\S]*?)<\/cross-session-message>/.exec(s)
  if (peer) {
    const name = /from-name="([^"]*)"/.exec(peer[1])?.[1] || 'another session'
    return [{ kind: 'peer', name, ts, ...cut(peer[2].trim(), TEXT_MAX) }]
  }
  if (meta) return [] // image notes, skill bodies, reminders: not something anyone typed
  if (/^\s*<local-command-(stdout|stderr|caveat)>/.test(s)) return []
  const task = /^\s*<task-notification>([\s\S]*?)<\/task-notification>/.exec(s)
  if (task) {
    const summary = /<summary>([\s\S]*?)<\/summary>/.exec(task[1])?.[1]?.trim()
    return [{ kind: 'note', ts, ...cut(summary ? `Background task: ${summary}` : 'Background task update', TOOL_MAX * 2) }]
  }
  const cmd = /<command-name>([^<]*)<\/command-name>/.exec(s)
  if (cmd) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(s)?.[1]?.trim() ?? ''
    return [{ kind: 'user', ts, ...cut(`${cmd[1].trim()} ${args}`.trim(), TEXT_MAX) }]
  }
  const channel = /<channel\b[^>]*>([\s\S]*?)<\/channel>/.exec(s)
  const text = tidy(channel ? channel[1] : s)
  return text ? [{ kind: 'user', ts, ...cut(text, TEXT_MAX) }] : []
}

const SUMMARY_KEYS = ['description', 'command', 'file_path', 'notebook_path', 'path', 'pattern', 'url', 'query', 'skill', 'subject', 'prompt', 'to', 'message', 'text']
/** One line for a tool call: its name and the input that says most (a description, a command, a path). */
export function toolLine(name: string, input: any): string {
  const m = /^mcp__(.+?)__(.+)$/.exec(name)
  const label = m ? `${m[2]} (${m[1].replace(/^claude_ai_/, '').replace(/_/g, ' ')})` : name
  let what = ''
  for (const k of SUMMARY_KEYS) {
    const v = input?.[k]
    if (typeof v === 'string' && v.trim()) { what = v.trim().split('\n')[0].replace(/\s+/g, ' '); break }
  }
  return cut(what ? `${label}: ${what}` : label, TOOL_MAX).text
}

/** One transcript line → what the Sessions view shows of it (often nothing). */
export function itemsOf(rec: any, errors: Set<string>): TranscriptItem[] {
  if (!rec || typeof rec !== 'object' || rec.isSidechain) return []
  const ts = typeof rec.timestamp === 'string' ? rec.timestamp : undefined
  if (rec.type === 'system') return rec.subtype === 'compact_boundary' ? [{ kind: 'note', text: 'Conversation compacted', ts }] : []
  const c = rec.message?.content
  if (rec.type === 'user') {
    if (rec.isCompactSummary || rec.isVisibleInTranscriptOnly) return []
    if (typeof c === 'string') return userText(c, !!rec.isMeta, ts)
    if (!Array.isArray(c)) return []
    const texts: string[] = []
    let images = 0
    for (const b of c) {
      if (b?.type === 'tool_result') { if (b.is_error && typeof b.tool_use_id === 'string') errors.add(b.tool_use_id) }
      else if (b?.type === 'text' && typeof b.text === 'string') texts.push(b.text)
      else if (b?.type === 'image') images++
    }
    if (rec.isMeta || (!texts.length && !images)) return []
    const joined = texts.join('\n\n')
    if (texts.length && !images) return userText(joined, false, ts)
    const text = [tidy(joined), images ? (images === 1 ? '[image]' : `[${images} images]`) : ''].filter(Boolean).join('\n\n')
    return [{ kind: 'user', ts, ...cut(text, TEXT_MAX) }]
  }
  if (rec.type === 'assistant' && Array.isArray(c)) {
    const out: TranscriptItem[] = []
    for (const b of c) {
      if (b?.type === 'text' && typeof b.text === 'string') {
        const t = b.text.trim()
        if (t && t !== '(no content)') out.push({ kind: 'assistant', ts, ...cut(t, TEXT_MAX) })
      } else if (b?.type === 'tool_use' && typeof b.name === 'string') {
        out.push({ kind: 'tool', ts, text: toolLine(b.name, b.input), ...(errors.has(b.id) ? { error: true } : {}) })
      }
    }
    return out
  }
  return []
}

/**
 * The page of the transcript that ends at byte `before` (default: the end of the file),
 * oldest first: at least `limit` prompts and replies (back to the prompt that starts the
 * turn), with the tool calls and notes between them. `next` is the offset to pass as `before` for the page before it; null at the start.
 * At most `budget` bytes are read per page, so a page can come back short (but `next` moves).
 */
export function readTranscript(path: string, o: { before?: number | null; limit?: number; budget?: number } = {}): TranscriptPage {
  const limit = Math.min(Math.max(o.limit ?? 20, 1), 100)
  const budget = o.budget ?? (32 << 20)
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    const end = o.before == null ? size : Math.min(Math.max(0, Math.floor(o.before)), size)
    const errors = new Set<string>()
    const pages: TranscriptItem[][] = []
    let count = 0, next: number | null = end, turn = false
    for (const { line, start } of linesBackward(fd, end)) {
      next = start
      turn = false
      if (line) {
        let rec: any = null
        try { rec = JSON.parse(line) } catch {} // a line still being written, or not JSON
        const items = itemsOf(rec, errors)
        if (items.length) {
          pages.push(items)
          count += items.filter(i => i.kind !== 'tool' && i.kind !== 'note').length
          turn = items[0].kind === 'user' || items[0].kind === 'peer'
        }
      }
      // A page starts at a prompt, so a turn isn't split (unless one runs on very long).
      if ((count >= limit && turn) || count >= limit * 3 || end - start >= budget) break
    }
    if (next === 0) next = null
    return { items: pages.reverse().flat(), next }
  } finally { closeSync(fd) }
}
