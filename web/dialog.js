// A Claude Code selection dialog, read off a pane's screen. Pure (no DOM), shared by
// app.js and the tests.
//
// While a session waits on a question (AskUserQuestion) or a permission prompt, the
// bottom of its screen is a dialog of a known shape:
//
//    ☐ Undo scope                                  ← header chips (several = several questions)
//   How should undo treat a move?                  ← the question (a wrapped paragraph)
//   ❯ 1. Same as a move (Recommended)              ← numbered options, ❯ on the focused one
//        Undo reverts the whole move in one step.  ← its description, indented
//     2. Per node
//        …
//     3. Type something.                           ← a free-text option
//   ────────────────────
//     4. Chat about this
//   Enter to select · ↑/↓ to navigate · Esc to cancel
//
// parseDialog finds that block and returns it as data for a native card, or null when
// the screen doesn't end in one it can read with confidence (the app then falls back to
// the raw screen and the key bar). keysFor says which keys choose an option.

import { strWidth } from './term.js'

const OPTION = /^(\s*)(?:([❯›>▸])\s*)?(\d{1,2})[.)]\s+(.*\S)\s*$/u
const RULE = /^\s*[─━═╌╍┄┅┈┉╴╶╸╺╭╮╰╯┌┐└┘]{6,}.*$/u
const BOX_TOP_OR_BOTTOM = /^\s*[╭╰┌└]/u
const FOOTER = /(Enter to (?:select|confirm|submit|continue)|Esc to (?:cancel|exit|go back)|to navigate|Tab to amend|ctrl\+e to explain|Space to (?:select|toggle))/i
const CHECKBOX = /^(?:\[([ xX✔✓×])\]|([☐☑☒✔✓]))\s+/u
const RECOMMENDED = /\s*\((?:Recommended|recommended)\)\s*$/
const INPUT = /^(?:Type something|Type here|Other)\b\.?/i
const CHAT = /^Chat about this\b/i
const MAX_SCAN = 80 // lines from the bottom the dialog may start within

/** A box row `│ … │` → its inside; a plain line as is. Trailing spaces go either way. */
function unbox(line) {
  const m = line.match(/^\s*[│┃](.*?)(?:[│┃])?\s*$/u)
  return (m ? m[1] : line).replace(/\s+$/, '')
}
const indentOf = s => s.match(/^ */)[0].length
const isBlank = s => !s.trim()
const isRule = s => RULE.test(s) || BOX_TOP_OR_BOTTOM.test(s)
/** A raw line's width up to its last character, without a right box border or the padding before it. */
const contentWidth = l => strWidth(l.replace(/\s*[│┃]?\s*$/u, ''))
const firstWord = s => s.trim().match(/^\S+/)?.[0] ?? ''

/**
 * Screen text (plain, ANSI already stripped) → the dialog at its bottom, or null.
 * `opts.cols`: the pane's width (default: the widest line), to tell a wrapped label
 * from a description under it.
 *
 * Returns `{ kind: 'question'|'permission', prompt, header, title, context, tabs, multi,
 * options, cursor, footer, top }`. `top`: the index of the dialog's first line (the
 * screen above it is what led up to it). `header`: a one-question dialog's chip ("Undo scope"). `options[]`: `{ n, label, description, recommended, input, chat,
 * separated, checked }`; `cursor` is the focused option's number (null if none shows);
 * `tabs` the header chips of a multi-question dialog (`{label, done}`), else null;
 * `multi` a multi-select (checkboxes); `title`/`context` the lines a permission prompt
 * shows above its question (what it wants to run or edit); `plain` a menu without
 * numbers (chosen with arrows).
 */
export function parseDialog(text, opts = {}) {
  const raw = String(text ?? '').replace(/\r/g, '').split('\n')
  const lines = raw.map(unbox)
  const cols = opts.cols ?? Math.max(1, ...raw.map(l => strWidth(l.replace(/\s+$/, ''))))

  // 1. From the bottom: skip the footer, rules and blanks; the last option comes next.
  let end = lines.length - 1
  while (end >= 0 && isBlank(lines[end])) end--
  if (end < 0) return null
  let footer = ''
  let b = end
  for (; b >= 0 && b > end - 8; b--) {
    const l = lines[b]
    if (isBlank(l) || isRule(l)) continue
    if (FOOTER.test(l)) { footer = footer || l.trim(); continue }
    break
  }
  if (b < 0) return null

  // 2. The options: numbered lines counting down to 1, with only descriptions, blanks
  // and one separator rule between them. The last option is at or just above `b`.
  const optAt = i => { const m = lines[i]?.match(OPTION); return m ? { i, lead: m[1].length, mark: m[2] ?? null, n: Number(m[3]), rest: m[4] } : null }
  let last = null
  for (let i = b; i >= 0 && i > b - 12; i--) {
    const o = optAt(i)
    if (o) { last = o; break }
    if (isRule(lines[i]) || FOOTER.test(lines[i])) break
  }
  if (!last) return plainMenu(lines, b, end, footer)
  if (last.n < 2) return null
  const found = [last]
  for (let i = last.i - 1, want = last.n - 1; want >= 1; i--) {
    if (i < 0 || i < end - MAX_SCAN) return null
    const o = optAt(i)
    if (o && o.n === want) { found.unshift(o); want--; continue }
    if (o) return null // a number out of order: a list in the output, not a dialog
  }
  // Lines after the last option must be its description, blanks, rules or the footer.
  const optLead = Math.min(...found.map(o => o.lead))
  for (let i = last.i + 1; i <= end; i++) {
    const l = lines[i]
    if (isBlank(l) || isRule(l) || FOOTER.test(l)) continue
    if (indentOf(l) <= optLead) return null
  }
  const cursors = found.filter(o => o.mark)
  if (cursors.length > 1) return null
  if (!cursors.length && !footer) return null

  const options = found.map((o, k) => {
    const stop = k + 1 < found.length ? found[k + 1].i : end + 1
    // Where the option line's text ends, and where the pane (or the box in it) would wrap.
    const edge = cols - (/[│┃]\s*$/u.test(raw[o.i]) ? 4 : 2)
    let label = o.rest, separated = false
    const desc = []
    let wrapping = true, prevWidth = contentWidth(raw[o.i])
    for (let i = o.i + 1; i < stop; i++) {
      const l = lines[i]
      if (isRule(l)) { if (k + 1 < found.length && i > o.i) separated = true; wrapping = false; continue }
      if (isBlank(l) || FOOTER.test(l)) { wrapping = false; continue }
      if (indentOf(l) <= optLead) return null
      // A multi-select draws an unnumbered "Submit" row under its last checkbox.
      if (l.trim() === 'Submit' && CHECKBOX.test(o.rest)) { wrapping = false; continue }
      // A label the pane wrapped at its edge goes on under it, at the description's
      // indent; tell them apart by whether its first word would have fit.
      if (wrapping && !desc.length && prevWidth + 1 + strWidth(firstWord(l)) > edge) { label += ' ' + l.trim(); prevWidth = contentWidth(raw[i]); continue }
      wrapping = false
      desc.push(l.trim())
    }
    let checked = null
    const cb = label.match(CHECKBOX)
    if (cb) { checked = cb[1] != null ? cb[1] !== ' ' : cb[2] !== '☐'; label = label.slice(cb[0].length) }
    const recommended = RECOMMENDED.test(label)
    if (recommended) label = label.replace(RECOMMENDED, '')
    return { n: o.n, label, description: desc.join(' '), recommended, input: INPUT.test(label) && !desc.length, chat: CHAT.test(label), separated: false, checked, _sepAfter: separated }
  })
  if (options.includes(null)) return null
  options.forEach((o, k) => { if (k && options[k - 1]._sepAfter) o.separated = true })
  for (const o of options) delete o._sepAfter

  // 3. The question: the paragraph just above option 1.
  let i = found[0].i - 1
  while (i >= 0 && isBlank(lines[i])) i--
  const para = []
  for (; i >= 0 && para.length < 12; i--) {
    const l = lines[i]
    if (isBlank(l) || isRule(l) || isTabRow(l)) break
    para.unshift(l.trim())
  }
  const prompt = para.join(' ')
  if (!prompt) return null
  let top = i + 1 // the dialog's first line on screen, widened below

  // 4. Header chips (several questions) above the question, if any.
  let tabs = null, header = null
  for (let j = i; j >= 0 && j > i - 4; j--) {
    if (isBlank(lines[j])) continue
    if (isTabRow(lines[j])) {
      top = j
      const t = parseTabs(lines[j])
      if (t.length > 1) tabs = t
      else header = t[0]?.label ?? null
    }
    break
  }

  const permission = /^Do you want to\b/i.test(prompt) && options.some(o => /^Yes\b/.test(o.label)) && options.some(o => /^No\b/.test(o.label))
  let title = null, context = []

  // A multi-question dialog ends on a review: "Review your answers", each question with
  // its answer, then "Ready to submit your answers?". The answers go in the card too.
  if (!tabs && /submit your answers\?$/i.test(prompt)) {
    for (let j = i; j >= 0 && j > i - 60; j--) {
      if (!/^\s*Review your answers\b/i.test(lines[j])) continue
      title = lines[j].trim()
      context = lines.slice(j + 1, i + 1).filter(l => !isBlank(l)).map(l => l.trim())
      top = j
      for (let k = j - 1; k >= 0 && k > j - 4; k--) {
        if (isBlank(lines[k])) continue
        if (isTabRow(lines[k])) { top = k; const t = parseTabs(lines[k]); if (t.length > 1) tabs = t }
        break
      }
      break
    }
  }
  if (permission) {
    // What it asks about: the lines between the dialog's top rule (or box top) and the question.
    // A box inside it (an edit's diff) is kept, without its own frame.
    const ctx = []
    for (let j = i; j >= 0 && j > i - 30; j--) {
      if (isRule(raw[j])) break
      top = j
      if (!isRule(lines[j])) ctx.unshift(unbox(lines[j]))
    }
    while (ctx.length && isBlank(ctx[0])) ctx.shift()
    while (ctx.length && isBlank(ctx.at(-1))) ctx.pop()
    if (ctx.length) {
      title = ctx[0].trim()
      const rest = ctx.slice(1)
      while (rest.length && isBlank(rest[0])) rest.shift()
      const cut = Math.min(80, ...rest.filter(l => !isBlank(l)).map(indentOf))
      context = rest.map(l => (isBlank(l) ? '' : l.slice(cut)))
    }
  }

  // The rule (or box top) just over it belongs to it too.
  for (let j = top - 1; j >= 0 && j >= top - 3; j--) {
    if (isRule(raw[j])) { top = j; break }
    if (!isBlank(lines[j])) break
  }

  const cursor = cursors[0]?.n ?? null
  return {
    kind: permission ? 'permission' : 'question',
    prompt, header, title, context, tabs,
    multi: options.some(o => o.checked != null),
    options, cursor, footer, top, plain: false,
  }
}

// A menu without numbers, like the folder-trust prompt: a run of one-line entries at one
// indent, ❯ on the focused one, right above the footer, under a rule. A menu whose entries
// take several lines (rewind) can't be told from its notes, so it stays on the keys.
const PLAIN_CURSOR = /^(\s*)❯\s+(\S.*)$/u
function plainMenu(lines, b, end, footer) {
  if (!footer) return null
  const items = []
  let i = b
  for (; i >= 0 && items.length <= 10; i--) {
    const l = lines[i]
    if (isBlank(l)) break
    if (isRule(l) || OPTION.test(l) || CHECKBOX.test(l.trim())) return null
    const m = l.match(PLAIN_CURSOR)
    items.unshift(m ? { col: m[1].length + 2, label: m[2].trim(), cursor: true } : { col: indentOf(l), label: l.trim(), cursor: false })
  }
  if (items.length < 2 || items.length > 10) return null
  if (items.filter(t => t.cursor).length !== 1 || items.some(t => t.col !== items[0].col)) return null
  // What it asks: the paragraphs between the rule over it and the entries.
  let top = -1
  for (let j = i; j >= 0 && j > i - 30; j--) if (isRule(lines[j])) { top = j; break }
  if (top < 0) return null
  const paras = []
  for (let j = top + 1, cur = null; j <= i; j++) {
    if (isBlank(lines[j])) { cur = null; continue }
    if (!cur) paras.push(cur = [])
    cur.push(lines[j].trim())
  }
  if (!paras.length) return null
  const title = paras.length > 1 ? paras.shift().join(' ') : null
  let q = paras.findLastIndex(p => p.join(' ').includes('?'))
  if (q < 0) q = paras.length - 1
  const prompt = paras.splice(q, 1)[0].join(' ')
  const context = paras.flatMap((p, k) => (k ? ['', ...p] : p))
  const options = items.map((t, k) => ({ n: k + 1, label: t.label, description: '', recommended: false, input: false, chat: false, separated: false, checked: null }))
  return {
    kind: 'question', prompt, header: null, title, context, tabs: null, multi: false,
    options, cursor: items.findIndex(t => t.cursor) + 1, footer, top, plain: true,
  }
}

function isTabRow(l) {
  if (OPTION.test(l)) return false
  const t = l.trim()
  if (t.length > 200) return false
  const chips = (t.match(/[☐☒☑✔✓]/gu) ?? []).length
  if (!chips) return false
  if (chips >= 2 || /\bSubmit\b/.test(t) || /^←|→$/u.test(t)) return true
  return /^[☐☒☑✔✓]\s+\S/u.test(t) && t.length < 60 && !/[.?!:]$/.test(t) // one question's header chip
}
function parseTabs(l) {
  return l.replace(/[←→]/gu, ' ').split(/\s{2,}|(?=[☐☒☑✔✓]\s)/u).map(s => s.trim()).filter(Boolean).map(s => {
    const m = s.match(/^([☐☒☑✔✓])\s*(.*)$/u)
    return m ? { label: m[2], done: m[1] !== '☐' } : { label: s, done: false }
  }).filter(t => t.label)
}

/**
 * Keys that choose `option` in `dialog`. A digit selects (and submits) an option in
 * Claude Code, or toggles a checkbox in a multi-select; a menu without numbers takes
 * arrows and Enter. A free-text option is only focused, with arrows from the cursor, so the
 * text typed next lands in it (the caller types it and sends Enter). Options past 9 use
 * arrows and Enter. Null when the keys can't be worked out (no cursor to count from).
 */
export function keysFor(dialog, option) {
  if (!dialog.plain && !option.input && option.n <= 9) return [String(option.n)]
  if (dialog.cursor == null) return null
  const d = option.n - dialog.cursor
  const keys = Array(Math.abs(d)).fill(d > 0 ? 'down' : 'up')
  return option.input ? keys : [...keys, 'enter']
}

/** Whether the app can show `dialog` as a card. */
export const cardable = dialog => !!dialog && dialog.options.length >= 2
