// The Claude subscription's usage, as Claude Code reports it to its status line: one small JSON
// file per session in a folder (default <claudeDir>/rate-limits), written by an optional status
// line step (README, "Claude usage"). Each file: { at, rate_limits: { five_hour?, seven_day? } },
// a window being { used_percentage, resets_at } (epoch seconds). File reads only: no endpoint is
// called, and nothing in the folder is changed or deleted.
//
// Sessions write when their status line runs, so an idle one keeps an old number: within a window
// usage only rises, so the highest number of the current window is the truest. A window is current
// when its reset is still ahead and the latest any session reports; files from before a reset (or
// from ended sessions) drop out on their own.
import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'

export const USAGE_WINDOWS = ['five_hour', 'seven_day'] as const
export type UsageKey = (typeof USAGE_WINDOWS)[number]
/** One window: percent used (0–100), when it resets and when the session that reported that
 *  percent last wrote (both epoch seconds). The percent may be older than `updated`. */
export type UsageWindow = { used: number; resets_at: number; updated: number }
export type Usage = { windows: Partial<Record<UsageKey, UsageWindow>> }

const SAME_WINDOW_S = 600 // resets this close together are the same window (rounding)
const MAX_AGE_MS = 8 * 864e5 // a file not written for longer than a week can't hold a current window
const MAX_FILES = 500
const MAX_BYTES = 64 << 10

type Report = { at: number; windows: Partial<Record<UsageKey, { used: number; resets_at: number }>> }

function readReport(path: string, mtimeS: number): Report | null {
  let j: any
  try { j = JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
  const rl = j?.rate_limits
  if (!rl || typeof rl !== 'object') return null
  const at = Number.isFinite(j.at) ? j.at : mtimeS
  const windows: Report['windows'] = {}
  for (const k of USAGE_WINDOWS) {
    const w = rl[k]
    if (!w || !Number.isFinite(w.used_percentage) || !Number.isFinite(w.resets_at)) continue
    windows[k] = { used: Math.max(0, Math.min(100, w.used_percentage)), resets_at: w.resets_at }
  }
  return { at, windows }
}

export function readUsage(dir: string, now = Date.now()): Usage {
  const out: Usage = { windows: {} }
  let names: string[]
  try { names = readdirSync(dir).filter(n => n.endsWith('.json')) } catch { return out }
  const files: { path: string; mtime: number; size: number }[] = []
  for (const n of names) {
    try {
      const s = statSync(join(dir, n))
      if (s.isFile() && s.size <= MAX_BYTES && now - s.mtimeMs <= MAX_AGE_MS) files.push({ path: join(dir, n), mtime: s.mtimeMs, size: s.size })
    } catch {}
  }
  files.sort((a, b) => b.mtime - a.mtime)
  const reports = files.slice(0, MAX_FILES).map(f => readReport(f.path, Math.floor(f.mtime / 1000))).filter(r => r != null)
  const nowS = now / 1000
  for (const k of USAGE_WINDOWS) {
    const live = reports.flatMap(r => r.windows[k] && r.windows[k]!.resets_at > nowS ? [{ at: r.at, ...r.windows[k]! }] : [])
    if (!live.length) continue
    const resets = Math.max(...live.map(w => w.resets_at))
    const current = live.filter(w => resets - w.resets_at <= SAME_WINDOW_S)
    const used = Math.max(...current.map(w => w.used))
    const updated = Math.max(...current.filter(w => w.used === used).map(w => w.at))
    out.windows[k] = { used, resets_at: resets, updated }
  }
  return out
}

/** readUsage, read again at most every `everyMs`. dir null: always nothing. */
export function usageReader(dir: string | null, everyMs = 15_000) {
  let last: { at: number; usage: Usage } | null = null
  return (now = Date.now()): Usage => {
    if (!dir) return { windows: {} }
    if (!last || now - last.at >= everyMs) last = { at: now, usage: readUsage(dir, now) }
    return last.usage
  }
}
