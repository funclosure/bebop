// Terminal screen → phone. Pure functions (no DOM), shared by app.js and the tests.
//
// A pane is read at its desk width (often 80–120 columns); a phone shows about 50.
// Cutting lines off or scrolling sideways reads badly, so the screen is reflowed:
//  1. parseAnsi: SGR escapes → styled spans per line (colors, bold, dim, italic…).
//  2. layoutScreen: lines → rows. Lines the agent wrapped at the pane edge are joined
//     back into one paragraph (so the phone wraps them once, at its own width), each
//     row keeps a hanging indent (bullets hang, continuations line up), horizontal
//     rules become a rule that spans whatever width there is, and tables (│ ┼ …) are
//     kept as is, to be shown unwrapped in their own sideways-scrolling block.

/** @typedef {{ fg?: number|number[], bg?: number|number[], b?: 1, d?: 1, i?: 1, u?: 1, s?: 1, inv?: 1 }} Style */
/** @typedef {{ t: string, st: Style|null }} Span */

const SGR = /\x1b\[([0-9;:]*)m/g

/** Text with SGR escapes → lines of spans. Other escapes should already be gone (the hub strips them). */
export function parseAnsi(src) {
  const lines = []
  let cur = []
  let st = {}
  const push = t => {
    if (!t) return
    const s = Object.keys(st).length ? { ...st } : null
    const last = cur[cur.length - 1]
    if (last && sameStyle(last.st, s)) last.t += t
    else cur.push({ t, st: s })
  }
  const text = String(src ?? '').replace(/\r/g, '')
  let i = 0
  for (const m of text.matchAll(/\x1b\[([0-9;:]*)m|\n/g)) {
    pushPlain(text.slice(i, m.index))
    i = m.index + m[0].length
    if (m[0] === '\n') { lines.push(cur); cur = [] }
    else st = applySgr(st, m[1])
  }
  pushPlain(text.slice(i))
  lines.push(cur)
  return lines
  function pushPlain(t) { push(t.replace(/\x1b\[[0-?]*[ -\/]*[@-~]|\x1b[@-_]|[\x00-\x08\x0b-\x1f\x7f]/g, '').replace(/\t/g, '    ')) }
}

function sameStyle(a, b) {
  if (!a || !b) return a === b
  const ka = Object.keys(a), kb = Object.keys(b)
  return ka.length === kb.length && ka.every(k => String(a[k]) === String(b[k]))
}

/** One SGR parameter list applied to a style; returns a new style. */
export function applySgr(prev, params) {
  const st = { ...prev }
  const p = String(params ?? '').split(/[;:]/).map(x => (x === '' ? 0 : Number(x)))
  for (let k = 0; k < p.length; k++) {
    const n = p[k]
    if (n === 0) { for (const key of Object.keys(st)) delete st[key] }
    else if (n === 1) st.b = 1
    else if (n === 2) st.d = 1
    else if (n === 3) st.i = 1
    else if (n === 4) st.u = 1
    else if (n === 7) st.inv = 1
    else if (n === 9) st.s = 1
    else if (n === 22) { delete st.b; delete st.d }
    else if (n === 23) delete st.i
    else if (n === 24) delete st.u
    else if (n === 27) delete st.inv
    else if (n === 29) delete st.s
    else if (n >= 30 && n <= 37) st.fg = n - 30
    else if (n >= 90 && n <= 97) st.fg = n - 90 + 8
    else if (n === 39) delete st.fg
    else if (n >= 40 && n <= 47) st.bg = n - 40
    else if (n >= 100 && n <= 107) st.bg = n - 100 + 8
    else if (n === 49) delete st.bg
    else if (n === 38 || n === 48) {
      const key = n === 38 ? 'fg' : 'bg'
      if (p[k + 1] === 5 && p[k + 2] != null) { st[key] = clampByte(p[k + 2]); k += 2 }
      else if (p[k + 1] === 2 && p[k + 4] != null) { st[key] = [p[k + 2], p[k + 3], p[k + 4]].map(clampByte); k += 4 }
      else break // malformed: ignore the rest
    }
  }
  return st
}
const clampByte = n => Math.max(0, Math.min(255, Number(n) || 0))

// ---------- width ----------

/** Display width of one code point: 2 for East Asian wide/fullwidth and emoji, 0 for combining marks. */
export function charWidth(cp) {
  if (cp < 0x300) return 1
  if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0
  if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0x303e) || (cp >= 0x3041 && cp <= 0x33ff) ||
      (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0xa000 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) ||
      (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1f64f) ||
      (cp >= 0x1f900 && cp <= 0x1f9ff) || (cp >= 0x20000 && cp <= 0x3fffd)) return 2
  return 1
}
export function strWidth(s) {
  let w = 0
  for (const ch of s) w += charWidth(ch.codePointAt(0))
  return w
}
const isWide = ch => ch != null && charWidth(ch.codePointAt(0)) === 2

// ---------- layout ----------

const lineText = spans => spans.map(s => s.t).join('')

// A bullet or marker that starts an item; continuation lines hang after it.
const MARKER = /^(?:[⏺●○◯◉•▪▸▶›❯>⎿✻✶✳✢✽※·*+\-☐☒✔✓✗✘⚠]|\d{1,3}[.)]|[a-z][.)])\s+/u
// Horizontal rule characters (box drawing and the plain ones Claude Code uses).
const RULE_CH = /[─━═╌╍┄┅┈┉╴╶╸╺]/
const CORNER = /[╭╮╰╯┌┐└┘]/
const TABLE_CH = /[┬┴┼├┤╞╡╪╤╧]/

/** Removes the first n display columns of leading spaces from spans. */
function dropLead(spans, n) {
  const out = []
  for (const s of spans) {
    if (n > 0) {
      const lead = s.t.match(/^ */)[0].length
      const k = Math.min(n, lead)
      n -= k
      if (k === s.t.length) continue
      out.push({ t: s.t.slice(k), st: s.st })
    } else out.push(s)
  }
  return out
}
function trimEnd(spans) {
  const out = spans.map(s => ({ ...s }))
  while (out.length) {
    const last = out[out.length - 1]
    const t = last.t.replace(/\s+$/, '')
    // Trailing spaces with a background are part of a drawn bar: keep them.
    if (t === last.t || (last.st && last.st.bg != null && !t)) break
    if (t) { last.t = t; break }
    out.pop()
  }
  return out
}

/** A rule: mostly rule characters, maybe a label inside ("──── weft ─"). Returns null if not. */
export function asRule(text) {
  const t = text.trim()
  if (!t || TABLE_CH.test(t)) return null
  const chars = [...t]
  if (!RULE_CH.test(chars[0]) && !CORNER.test(chars[0])) return null
  const ruleN = chars.filter(c => RULE_CH.test(c) || CORNER.test(c)).length
  if (ruleN < 6 || ruleN < chars.length * 0.6) return null
  const m = t.match(/^[─━═╌╍┄┅┈┉╴╶╸╺╭╮╰╯┌┐└┘]+\s*(.*?)\s*[─━═╌╍┄┅┈┉╴╶╸╺╭╮╰╯┌┐└┘]*$/u)
  const label = m ? m[1] : ''
  const at = label ? strWidth(t.slice(0, t.indexOf(label))) / Math.max(1, strWidth(t)) : 0
  return { label, align: at > 0.5 ? 'right' : 'left' }
}

/** `│ content │` (a drawn box, e.g. a dialog) → its content; null if not a box row. */
function boxInner(text) {
  const m = text.match(/^(\s*)│(.*?)│?\s*$/u)
  if (!m || m[2].includes('│')) return null
  return { pad: m[1].length + 1 }
}
const isTableRow = text => {
  const t = text.trim()
  return TABLE_CH.test(t) && /[│┃]|[─━]/.test(t) || (t.match(/[│┃]/g) ?? []).length >= 3
}

/**
 * Lines of spans → rows for the phone.
 *  - `{kind:'blank'}`
 *  - `{kind:'rule', label, align, st}` (st: the rule's own style, for its color)
 *  - `{kind:'table', spans}`: shown unwrapped, in a block that scrolls sideways
 *  - `{kind:'text', lead, indent, spans, box?}`: `lead` = columns before the first
 *    character, `indent` = where continuation lines start (after a bullet); `spans`
 *    without the leading spaces. `box` = a row of a drawn box (its left edge is drawn).
 * `cols`: the pane's width in columns (default: the widest line, which a rule usually spans).
 */
// Links: http(s) URLs up to whitespace or CJK punctuation, minus trailing sentence punctuation.
const URL_RE = /https?:\/\/[^\s<>"'`，。、；：！？）」』】]+/g
const URL_TAIL = /https?:\/\/[^\s<>"'`，。、；：！？）」』】]+$/
const URL_PART = /^[\w\-.~%!$&'()*+,;=:@/?#\[\]]+$/
/** Where the links are in a row's text: [{ start, end, href }]. */
export function findLinks(text) {
  const out = []
  for (const m of text.matchAll(URL_RE)) {
    let href = m[0]
    while (/[.,;:!?)\]>'"]$/.test(href) && !(href.endsWith(')') && href.includes('('))) href = href.slice(0, -1)
    if (href.length > 10) out.push({ start: m.index, end: m.index + href.length, href })
  }
  return out
}

export function layoutScreen(lines, opts = {}) {
  const items = lines.map(sp => trimEnd(sp)).map(spans => ({ spans, text: lineText(spans) }))
  const cols = opts.cols ?? Math.max(1, ...items.map(x => strWidth(x.text)))
  const rows = []
  let prev = null // the text row the next line may continue
  for (const { spans, text } of items) {
    if (!text.trim()) {
      if (spans.some(s => s.st?.bg != null)) { rows.push({ kind: 'text', lead: 0, indent: 0, spans, width: 0 }); prev = null; continue }
      rows.push({ kind: 'blank' }); prev = null; continue
    }
    const rule = asRule(text)
    if (rule) {
      rows.push({ kind: 'rule', ...rule, st: spans.find(s => RULE_CH.test(s.t) || CORNER.test(s.t))?.st ?? null })
      prev = null; continue
    }
    if (isTableRow(text)) { rows.push({ kind: 'table', spans }); prev = null; continue }

    let body = spans, lead = text.match(/^ */)[0].length, box = false
    const bx = boxInner(text)
    if (bx) {
      // Drop the box's left edge (drawn by CSS instead) and its right edge.
      box = true
      let s = dropFirstChars(spans, bx.pad)
      const t2 = lineText(s)
      if (/│\s*$/.test(t2)) s = trimEnd(dropLastChar(trimEnd(s)))
      body = s
      lead = lineText(body).match(/^ */)[0].length
    }
    const content = dropLead(body, lead)
    const ctext = lineText(content)
    const mk = ctext.match(MARKER)
    const indent = lead + (mk ? strWidth(mk[0]) : 0)

    // A continuation: same box-ness, starts where the previous row's text does (or at
    // its margin), is not a new item, and its first word would not have fit on the
    // previous line: the agent wrapped it at the pane edge.
    // `join: false` (a plain shell): its lines are what it printed, so none is joined.
    if (opts.join !== false && prev && prev.box === box && !mk && (lead === prev.indent || lead === prev.lead)) {
      const word = firstWord(ctext)
      const tail = prev.lastChar
      const widthBefore = prev.endCol
      // A link broken at the pane edge (the line runs to the last column) joins with no space.
      const inLink = widthBefore >= cols - 1 && URL_TAIL.test(prev.text) && URL_PART.test(word)
      const space = inLink || (isWide(tail) && isWide([...ctext][0])) ? 0 : 1
      if (widthBefore + space + strWidth(word) > cols - 2) {
        if (space) prev.spans.push({ t: ' ', st: null })
        prev.spans.push(...content)
        prev.endCol = lead + strWidth(ctext) + (box ? 2 : 0)
        prev.lastChar = [...ctext].pop()
        prev.text += (space ? ' ' : '') + ctext
        continue
      }
    }
    const row = { kind: 'text', lead, indent, spans: content }
    if (box) row.box = true
    rows.push(row)
    prev = { ...row, spans: row.spans, box, endCol: (box ? 2 : 0) + lead + strWidth(ctext), lastChar: [...ctext].pop(), text: ctext }
    // `prev.spans` is the row's own array, so a joined line lands in the row.
  }
  while (rows.length && rows[0].kind === 'blank') rows.shift()
  return { cols, rows: collapseBlanks(rows) }
}

function firstWord(t) {
  const first = [...t][0]
  if (isWide(first)) return first
  return t.match(/^\S+/)?.[0] ?? ''
}
function dropFirstChars(spans, n) {
  const out = []
  for (const s of spans) {
    if (n <= 0) { out.push(s); continue }
    const cs = [...s.t]
    if (cs.length <= n) { n -= cs.length; continue }
    out.push({ t: cs.slice(n).join(''), st: s.st }); n = 0
  }
  return out
}
function dropLastChar(spans) {
  const out = spans.map(s => ({ ...s }))
  const last = out[out.length - 1]
  if (!last) return out
  last.t = [...last.t].slice(0, -1).join('')
  if (!last.t) out.pop()
  return out
}
function collapseBlanks(rows) {
  return rows.filter((r, i) => !(r.kind === 'blank' && rows[i - 1]?.kind === 'blank'))
}

// ---------- color ----------

// The 16 basic colors, tuned for each theme (the app's own surfaces, not a black terminal).
const BASIC = {
  dark: ['#3a3a38', '#e5786d', '#8cc79f', '#e0b56a', '#86afe0', '#c99be0', '#7fc8c8', '#d6d4ce',
    '#75736e', '#f08f84', '#a4dcb4', '#f0ca85', '#a3c4ec', '#dab3ec', '#9adcdc', '#ffffff'],
  light: ['#1f1e1c', '#b8432f', '#2f7a45', '#8a5d0f', '#2f62a0', '#87459e', '#1d7a7a', '#6d6b66',
    '#6d6b66', '#c4553f', '#3f8d57', '#9a6a1b', '#3b6ea8', '#9a58b0', '#2a8c8c', '#3a3936'],
}

function xterm256(n) {
  if (n < 16) return null
  if (n >= 232) { const v = 8 + (n - 232) * 10; return [v, v, v] }
  const i = n - 16, steps = [0, 95, 135, 175, 215, 255]
  return [steps[Math.floor(i / 36)], steps[Math.floor(i / 6) % 6], steps[i % 6]]
}

function rgbToHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min, s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return [h * 60, s, l]
}
const hsl = (h, s, l) => `hsl(${Math.round(h)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%)`

/**
 * A terminal color → CSS for this theme. Basic colors use the theme palette; 256 and
 * truecolor keep their hue but get their lightness moved so they read on the app's
 * background: in light mode light colors are mirrored dark (white text → near black,
 * grey 153 → grey 102); in dark mode very dark text is mirrored light. Backgrounds
 * mirror the other way, so a dark bar stays a quiet bar in light mode.
 */
export function termColor(c, dark, isBg = false) {
  if (c == null) return null
  if (typeof c === 'number' && c < 16) return BASIC[dark ? 'dark' : 'light'][c]
  const rgb = Array.isArray(c) ? c : xterm256(c)
  if (!rgb) return null
  let [h, s, l] = rgbToHsl(rgb)
  if (isBg) {
    if (!dark) l = Math.max(1 - l, 0.82)
  } else if (dark) {
    if (l < 0.4) l = Math.max(1 - l, 0.6)
  } else {
    if (s < 0.2) { if (l > 0.45) l = Math.max(0.12, 1 - l - 0.05) } // greys: mirror
    else l = Math.min(l, 0.38) // colors: deepen for white
  }
  return hsl(h, s, l)
}

/** Inline CSS for a span's style, for this theme. */
export function spanCss(st, dark) {
  if (!st) return ''
  let fg = termColor(st.fg, dark), bg = termColor(st.bg, dark, true)
  if (st.inv) { [fg, bg] = [bg ?? 'var(--surface)', fg ?? 'var(--text)'] }
  const css = []
  if (fg) css.push(`color:${fg}`)
  if (bg) css.push(`background:${bg}`)
  if (st.b) css.push('font-weight:700')
  if (st.d) css.push('opacity:.6')
  if (st.i) css.push('font-style:italic')
  const deco = [st.u && 'underline', st.s && 'line-through'].filter(Boolean)
  if (deco.length) css.push(`text-decoration:${deco.join(' ')}`)
  return css.join(';')
}

/** Panes by state for the fleet line: done counts as idle, anything unknown as other. */
export function fleetCounts(panes) {
  const n = { blocked: 0, working: 0, idle: 0, other: 0 }
  for (const p of panes ?? []) n[p.status === 'done' ? 'idle' : p.status in n ? p.status : 'other']++
  return n
}

// A project conversation: a thread with no task, addressed to the project's session.
export const PROJECT_THREAD = 'project-'
export const projectThread = key => PROJECT_THREAD + key
export const projectOfThread = id => id?.startsWith(PROJECT_THREAD) ? id.slice(PROJECT_THREAD.length).split('~')[0] : null
/** A further conversation in the same project: `project-<key>~<stamp>`. */
export const newProjectThread = key => `${projectThread(key)}~${Date.now().toString(36)}`
/** The names the hub accepts for a peer, so the only ones the relay can address. */
export const validPeer = name => /^[\w.-]{1,64}$/.test(name ?? '')
/** The text the agent gets: `@peer …`, the relay's own syntax. Already addressed text stays. */
export const addressed = (text, peer) => text.startsWith(`@${peer} `) ? text : `@${peer} ${text}`
/** The text as it was typed, for the bubble. */
export const unaddressed = text => text.replace(/^@[\w.-]+ /, '')
