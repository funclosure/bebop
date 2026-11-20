// Claude usage: the hub reads the files the optional status line step writes (hub/usage.ts) and
// serves the current windows at /api/usage; the app shows them as meters in three places.
import { test, expect, afterAll } from 'bun:test'
import { writeFileSync, mkdtempSync, mkdirSync, utimesSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { readUsage, usageReader } from '../hub/usage'
import { startHub } from './helpers'

const NOW = Date.UTC(2026, 10, 19, 16, 0) // a fixed clock for the reader
const S = (ms: number) => Math.floor(ms / 1000)
const WEEK_END = S(NOW) + 2.5 * 86400, OLD_WEEK_END = S(NOW) - 4.5 * 86400
const freshDir = () => mkdtempSync(join(tmpdir(), 'usage-test-'))
function report(dir: string, session: string, at: number, rate_limits: object, mtime = NOW) {
  const p = join(dir, `${session}.json`)
  writeFileSync(p, JSON.stringify({ at, session, version: '2.1.328', rate_limits }))
  utimesSync(p, mtime / 1000, mtime / 1000)
  return p
}
const week = (used: number, resets_at = WEEK_END) => ({ seven_day: { used_percentage: used, resets_at } })

test('no folder, or an empty one: no windows', () => {
  expect(readUsage(join(tmpdir(), 'no-such-usage-folder'), NOW)).toEqual({ windows: {} })
  expect(readUsage(freshDir(), NOW)).toEqual({ windows: {} })
})

test('the highest percent of the current window wins: idle sessions keep older, lower numbers', () => {
  const dir = freshDir()
  report(dir, 'idle-a', S(NOW) - 30, week(3))
  report(dir, 'busy', S(NOW) - 600, week(47)) // the highest, written 10 min ago
  report(dir, 'idle-b', S(NOW) - 30, week(45))
  report(dir, 'busy-too', S(NOW) - 120, week(47)) // the same highest, written later
  expect(readUsage(dir, NOW)).toEqual({ windows: { seven_day: { used: 47, resets_at: WEEK_END, updated: S(NOW) - 120 } } })
})

test('a window whose reset has passed is ignored, however high; resets a few minutes apart are one window', () => {
  const dir = freshDir()
  report(dir, 'before-reset', S(NOW) - 86400, week(96, OLD_WEEK_END))
  report(dir, 'after-a', S(NOW) - 60, week(4))
  report(dir, 'after-b', S(NOW) - 50, week(6, WEEK_END + 300))
  expect(readUsage(dir, NOW).windows).toEqual({ seven_day: { used: 6, resets_at: WEEK_END + 300, updated: S(NOW) - 50 } })
  // Only the old window: nothing current.
  const old = freshDir()
  report(old, 'before-reset', S(NOW) - 86400, week(96, OLD_WEEK_END))
  expect(readUsage(old, NOW)).toEqual({ windows: {} })
})

test('each window on its own; the 5-hour one only when some session reports it', () => {
  const dir = freshDir()
  report(dir, 'a', S(NOW) - 10, { ...week(40), five_hour: { used_percentage: 12.5, resets_at: S(NOW) + 3600 } })
  report(dir, 'b', S(NOW) - 5, week(41))
  expect(readUsage(dir, NOW).windows).toEqual({
    five_hour: { used: 12.5, resets_at: S(NOW) + 3600, updated: S(NOW) - 10 },
    seven_day: { used: 41, resets_at: WEEK_END, updated: S(NOW) - 5 },
  })
})

test('skipped: broken or odd files, other names, big files, files not written for over a week; out-of-range percents are clamped', () => {
  const dir = freshDir()
  writeFileSync(join(dir, 'broken.json'), '{"at": 1, "rate_limits": ')
  writeFileSync(join(dir, 'odd.json'), JSON.stringify({ at: 1, rate_limits: { seven_day: { used_percentage: '90', resets_at: WEEK_END } } }))
  writeFileSync(join(dir, 'notes.txt'), JSON.stringify({ at: 1, rate_limits: week(99) }))
  writeFileSync(join(dir, 'big.json'), JSON.stringify({ at: 1, rate_limits: week(98), pad: 'x'.repeat(70_000) }))
  report(dir, 'stale', S(NOW) - 9 * 86400, week(97), NOW - 9 * 864e5)
  mkdirSync(join(dir, 'folder.json'))
  report(dir, 'fine', S(NOW) - 20, week(30))
  expect(readUsage(dir, NOW).windows).toEqual({ seven_day: { used: 30, resets_at: WEEK_END, updated: S(NOW) - 20 } })
  report(dir, 'over', S(NOW) - 10, week(140))
  expect(readUsage(dir, NOW).windows.seven_day?.used).toBe(100)
})

test('no `at`: the file\'s own time stands in', () => {
  const dir = freshDir()
  const p = join(dir, 'no-at.json')
  writeFileSync(p, JSON.stringify({ rate_limits: week(20) }))
  utimesSync(p, (NOW - 90_000) / 1000, (NOW - 90_000) / 1000)
  expect(readUsage(dir, NOW).windows.seven_day?.updated).toBe(S(NOW - 90_000))
})

test('the reader reads again at most every so often; no folder given: always nothing', () => {
  const dir = freshDir()
  report(dir, 'a', S(NOW) - 10, week(10))
  const read = usageReader(dir, 15_000)
  expect(read(NOW).windows.seven_day?.used).toBe(10)
  report(dir, 'b', S(NOW) - 5, week(20))
  expect(read(NOW + 10_000).windows.seven_day?.used).toBe(10)
  expect(read(NOW + 15_000).windows.seven_day?.used).toBe(20)
  expect(usageReader(null)(NOW)).toEqual({ windows: {} })
})

// The hub's route, with a folder of today's files (the real clock).
const dir = freshDir()
const { hub, user } = startHub({ usageDir: dir })
const off = startHub({ usageDir: 'off' })
const none = startHub({ usageDir: join(dir, 'missing') })
afterAll(() => { hub.stop(); off.hub.stop(); none.hub.stop() })

test('GET /api/usage: the current windows; off, or no folder: none', async () => {
  const now = Date.now(), resets = S(now) + 86400
  report(dir, 's1', S(now) - 60, week(33, resets), now)
  report(dir, 's2', S(now) - 30, week(35, resets), now)
  const res = await user('/api/usage')
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ windows: { seven_day: { used: 35, resets_at: resets, updated: S(now) - 30 } } })
  expect(await (await off.user('/api/usage')).json()).toEqual({ windows: {} })
  expect(await (await none.user('/api/usage')).json()).toEqual({ windows: {} })
})

const web = (f: string) => Bun.file(join(import.meta.dir, '..', 'web', f)).text()
const body = (src: string, name: string) => { const i = src.indexOf(name); return src.slice(i, src.indexOf('\n}\n', i)) }

test('the app: a meter per current window in the sidebar, Sessions and the Topics sheet, hidden without one', async () => {
  const app = await web('app.js'), html = await web('index.html'), css = await web('style.css')
  for (const id of ['side-usage', 'panes-usage', 'topics-usage']) expect(html).toContain(`id="${id}" hidden`)
  // The sidebar's sits above Settings; the Topics sheet's under its list.
  expect(html.indexOf('id="side-usage"')).toBeLessThan(html.indexOf('id="side-settings"'))
  expect(html).toContain('<nav class="sheet-body topics-list" id="topics-list"></nav>\n      <!-- Claude usage')
  const render = body(app, 'function renderUsage(')
  expect(render).toContain("for (const id of ['side-usage', 'panes-usage', 'topics-usage'])")
  expect(render).toContain('el.hidden = !ws.length')
  // A window whose reset has passed shows nothing, even before the next fetch.
  expect(app).toContain('return w && w.resets_at * 1000 > now ? [[k, w]] : []')
  const meter = body(app, 'function usageMeter(')
  expect(meter).toContain("role: 'meter'")
  expect(meter).toContain('const gone = ') // the pace mark
  expect(meter).toContain('ago > USAGE_STALE ? S.usageAsOf(ago) : null')
  expect(app).toContain("const usageLevel = pct => pct >= 90 ? ' alert' : pct >= 75 ? ' warn' : ''")
  // On wide windows Sessions doesn't repeat the sidebar's; a hidden foot leaves the sheet's list to the bottom edge.
  expect(css).toContain('@media (min-width: 900px) { .panes-usage { display: none; } }')
  expect(css).toContain('.sheet:has(> .sheet-body + .sheet-foot[hidden]:last-child) { padding-bottom: 0; }')
  // Sessions on the phone: no card, lined up with the rows (the list's 8px + 6px), two lines.
  expect(css).toContain('.panes-usage { margin: 0 6px; padding: 10px 0 11px; border-bottom: 1px solid var(--line); }')
  expect(css).toContain('.panes-usage .usage-top { display: contents; }')
  expect(css).toContain('.panes-usage .usage-bar { grid-area: 2 / 1 / 3 / -1; }')
  expect(css).toContain('.panes-usage .usage.stale .usage-sub { grid-area: 3 / 1 / 4 / -1; margin-top: -2px; }')
  expect(meter).toContain("${ago > USAGE_STALE ? ' stale' : ''}")
})

test('the app\'s words for it', async () => {
  const { S: words } = await import('../web/strings.js')
  expect(words.usageWindow.seven_day).toBe('Claude this week')
  expect(words.usageResetsIn(40 * 60e3)).toBe('Resets in 40 min')
  expect(words.usageResetsIn(5 * 36e5)).toBe('Resets in 5 h')
  expect(words.usageAsOf(3 * 36e5)).toBe('as of 3 h ago')
})
