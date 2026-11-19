// The clock's arithmetic: what a timer's `at` and `repeat` mean, and when a repeat is due next.
// Pure (the time comes in as an argument), so tests can pin it. Local time is this machine's.

export type TimerRow = {
  id: number; text: string; due: number; repeat: string | null; thread: string | null; key: string | null
  state: 'scheduled' | 'done' | 'cancelled'; created: number; changed_by: string | null; changed: number | null
  fired: number | null; fires: number
}

/** Each firing costs the agent a turn: repeats closer than this are refused. */
export const MIN_EVERY_MS = 15 * 60_000
export const REPEAT_HELP = 'repeat must be daily, weekdays, weekly or "every N m|h|d" (at least 15 minutes apart)'

/**
 * `at`: ms since the epoch, or an ISO 8601 date with a time ("2026-11-18T09:00", seconds optional).
 * With no offset it's local time; "Z" or "+08:00" pin it. A date with no time is refused rather than
 * guessed. null when it can't be read.
 */
export function parseAt(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? Math.round(v) : null
  if (typeof v !== 'string') return null
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3})\d*)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i.exec(v.trim())
  if (!m) return null
  const [y, mo, d, h, mi, s] = [+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] ?? 0)]
  const ms = m[7] ? Math.round(+`0.${m[7]}` * 1000) : 0
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null
  let t: number
  if (m[8]) {
    const off = m[8].toUpperCase() === 'Z' ? 0 : (m[8][0] === '-' ? -1 : 1) * (+m[8].slice(1, 3) * 60 + +m[8].slice(-2))
    t = Date.UTC(y, mo - 1, d, h, mi, s, ms) - off * 60_000
    if (new Date(Date.UTC(y, mo - 1, d)).getUTCDate() !== d) return null // 30 February
  } else {
    const local = new Date(y, mo - 1, d, h, mi, s, ms)
    if (local.getDate() !== d) return null
    t = local.getTime()
  }
  return Number.isFinite(t) ? t : null
}

/** A repeat in its one spelling ("daily", "weekdays", "weekly", "every 30m", "every 2h", "every 3d"), or null for none. Throws REPEAT_HELP. */
export function parseRepeat(v: unknown): string | null {
  if (v == null || v === '' || v === false) return null
  if (typeof v !== 'string') throw new Error(REPEAT_HELP)
  const s = v.trim().toLowerCase()
  if (s === 'daily' || s === 'weekdays' || s === 'weekly') return s
  const m = /^every\s+(\d{1,4})\s*(m|mins?|minutes?|h|hrs?|hours?|d|days?)$/.exec(s)
  if (!m || +m[1] < 1) throw new Error(REPEAT_HELP)
  const n = +m[1], unit = m[2][0]
  if (unit !== 'd' && n * (unit === 'm' ? 60_000 : 3_600_000) < MIN_EVERY_MS) throw new Error(REPEAT_HELP)
  return `every ${n}${unit}`
}

/**
 * The first time after `now` that a timer due at `due` comes round again. Day-based repeats keep the
 * wall-clock time (09:00 stays 09:00 across a clock change); minutes and hours are plain intervals.
 * Firings missed in between are skipped, not stacked.
 */
export function nextDue(due: number, repeat: string, now: number): number {
  const m = /^every (\d+)([mhd])$/.exec(repeat)
  if (m && m[2] !== 'd') {
    const step = +m[1] * (m[2] === 'm' ? 60_000 : 3_600_000)
    return due + Math.max(1, Math.floor((now - due) / step) + 1) * step
  }
  const days = m ? +m[1] : repeat === 'weekly' ? 7 : 1
  const b = new Date(due)
  const at = (i: number) => new Date(b.getFullYear(), b.getMonth(), b.getDate() + i * days, b.getHours(), b.getMinutes(), b.getSeconds(), b.getMilliseconds())
  // Start just before now rather than walking every day of a long gap.
  let i = Math.max(1, Math.floor((now - due) / (days * 86_400_000)) - 1)
  for (;; i++) {
    const d = at(i)
    if (repeat === 'weekdays' && (d.getDay() === 0 || d.getDay() === 6)) continue
    if (d.getTime() > now) return d.getTime()
  }
}

/** Local time with its offset, to the second: "2026-11-18T09:00:00+08:00". */
export function localIso(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(Math.abs(n)).padStart(2, '0')
  const off = -d.getTimezoneOffset()
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${off < 0 ? '-' : '+'}${p(Math.trunc(off / 60))}:${p(off % 60)}`
}
