import { test, expect } from 'bun:test'
// @ts-ignore: plain JS module shared with the PWA
import { parseAnsi, applySgr, layoutScreen, asRule, strWidth, termColor, spanCss, fleetCounts, findLinks } from '../web/term.js'

const text = (row: any) => row.spans.map((s: any) => s.t).join('')
const layout = (s: string, cols?: number) => layoutScreen(parseAnsi(s), cols ? { cols } : {})

test('ansi: SGR colors and attributes become styled spans; resets and other escapes are handled', () => {
  const [line] = parseAnsi('\x1b[0m\x1b[3m\x1b[38;2;153;153;153mdim it\x1b[0m plain \x1b[1;31mred\x1b[22m\x1b[48;5;236m bg\x1b[0m\x1b[K')
  expect(line).toEqual([
    { t: 'dim it', st: { i: 1, fg: [153, 153, 153] } },
    { t: ' plain ', st: null },
    { t: 'red', st: { b: 1, fg: 1 } },
    { t: ' bg', st: { fg: 1, bg: 236 } },
  ])
  expect(parseAnsi('a\nb').map(l => l.map(s => s.t).join(''))).toEqual(['a', 'b'])
  expect(applySgr({}, '38:2:10:20:300')).toEqual({ fg: [10, 20, 255] })
  expect(applySgr({ b: 1, fg: 2 }, '')).toEqual({}) // ESC[m is a reset
  expect(applySgr({}, '97;7;9')).toEqual({ fg: 15, inv: 1, s: 1 })
  expect(applySgr({ fg: 3, bg: 4, u: 1 }, '39;49;24')).toEqual({})
})

test('width: CJK and fullwidth count as two columns, combining marks as none', () => {
  expect(strWidth('abc')).toBe(3)
  expect(strWidth('中文字')).toBe(6)
  expect(strWidth('é')).toBe(1)
  expect(strWidth('ＡＢ')).toBe(4)
})

test('reflow: lines wrapped at the pane edge are joined; bullets hang; new items and paragraphs stay apart', () => {
  const cols = 40
  const src = [
    '⏺ The quick brown fox jumps over the lazy', // 41 > … wrapped: "dog." did not fit
    '  dog. Then it naps.',
    '',
    '  - first item that is long enough to wrap',
    '    at the edge.',
    '  - second item',
    '  short line',
    '  another short line',
  ].join('\n')
  const { rows } = layout(src, cols)
  expect(rows.map(r => r.kind)).toEqual(['text', 'blank', 'text', 'text', 'text', 'text'])
  expect(rows[0]).toMatchObject({ lead: 0, indent: 2 })
  expect(text(rows[0])).toBe('⏺ The quick brown fox jumps over the lazy dog. Then it naps.')
  expect(rows[2]).toMatchObject({ lead: 2, indent: 4 })
  expect(text(rows[2])).toBe('- first item that is long enough to wrap at the edge.')
  expect(text(rows[3])).toBe('- second item') // a new item, not a continuation
  expect(text(rows[4])).toBe('short line') // short lines were not wrapped: kept apart
  expect(text(rows[5])).toBe('another short line')
})

test('reflow: CJK joins without a space; styles survive the join', () => {
  const { rows } = layout('\x1b[1m中文中文中文中文中文\x1b[0m\n中文', 20)
  expect(rows.length).toBe(1)
  expect(text(rows[0])).toBe('中文中文中文中文中文中文')
  expect(rows[0].spans[0].st).toEqual({ b: 1 })
})

test('rules: a rule spans any width; a label is kept with its side; tables are not rules', () => {
  expect(asRule('─'.repeat(30))).toEqual({ label: '', align: 'left' })
  expect(asRule('─'.repeat(60) + ' weft ─')).toEqual({ label: 'weft', align: 'right' })
  expect(asRule('╭─── Settings ' + '─'.repeat(30) + '╮')).toMatchObject({ label: 'Settings', align: 'left' })
  expect(asRule('┌──────┬──────┐')).toBeNull()
  expect(asRule('-- not a rule, just text')).toBeNull()
  const { rows } = layout('───────────────\n❯ hi\n───────────────\n┌────┬────┐\n│ a  │ b  │\n└────┴────┘')
  expect(rows.map(r => r.kind)).toEqual(['rule', 'text', 'rule', 'table', 'table', 'table'])
})

test('boxes: a drawn box keeps its content (edges dropped) and its rows reflow inside', () => {
  const { rows } = layout('│ Do you want to proceed with this     │\n│ change?                              │\n│ ❯ 1. Yes                             │', 40)
  expect(rows.map(r => [r.box, text(r)])).toEqual([[true, 'Do you want to proceed with this change?'], [true, '❯ 1. Yes']])
})

test('layout: leading and repeated blank lines go; the widest line sets the columns', () => {
  const { cols, rows } = layout('\n\nabc\n\n\n\nabcdef')
  expect(cols).toBe(6)
  expect(rows.map(r => r.kind)).toEqual(['text', 'blank', 'text'])
})

test('colors: basic colors use the theme palette; others keep hue and are moved to read on the background', () => {
  expect(termColor(1, true)).toBe('#e5786d')
  expect(termColor(1, false)).toBe('#b8432f')
  expect(termColor(null, true)).toBeNull()
  expect(termColor([255, 255, 255], true)).toBe('hsl(0 0% 100%)') // white stays white on dark
  expect(termColor([255, 255, 255], false)).toBe('hsl(0 0% 12%)') // and becomes near black on light
  expect(termColor([153, 153, 153], false)).toBe('hsl(0 0% 35%)') // grey mirrored
  expect(termColor([0, 0, 0], true)).toBe('hsl(0 0% 100%)') // black text on dark is lifted
  expect(termColor([78, 186, 101], false)).toMatch(/^hsl\(13\d 4\d% 38%\)$/) // green deepened for white
  expect(termColor([55, 55, 55], false, true)).toBe('hsl(0 0% 82%)') // a dark bar becomes a light one
  expect(termColor(236, true, true)).toBe('hsl(0 0% 19%)') // 256-color grey, kept on dark
  expect(spanCss({ b: 1, d: 1, i: 1, u: 1, fg: 2 }, true)).toBe('color:#8cc79f;font-weight:700;opacity:.6;font-style:italic;text-decoration:underline')
  expect(spanCss({ inv: 1 }, true)).toBe('color:var(--surface);background:var(--text)')
  expect(spanCss(null, true)).toBe('')
})

test('fleet: panes counted by state, done as idle', () => {
  const p = (status: string) => ({ status })
  expect(fleetCounts([p('working'), p('idle'), p('done'), p('blocked'), p('weird'), p('working')])).toEqual({ blocked: 1, working: 2, idle: 2, other: 1 })
})

test('links: a URL broken at the pane edge joins without a space; words wrapped after a link keep theirs', () => {
  const rowText = (r: any) => r.spans.map((s: any) => s.t).join('')
  const cut = layout('❯ https://apps.example.com/us/app/my-app-bookmark-\n  social-posts/id1234567890?l=en-GB\n  ctrl+enter to send now', 48)
  expect(rowText(cut.rows[0])).toBe('❯ https://apps.example.com/us/app/my-app-bookmark-social-posts/id1234567890?l=en-GB')
  const prose = layout('see the page at https://example.com/a/b and then\nwrite back when it is done, thanks a lot', 48)
  expect(rowText(prose.rows[0])).toBe('see the page at https://example.com/a/b and then write back when it is done, thanks a lot')
  expect(findLinks('Live: https://example.com/sightings/myapp/c653de5c.')).toEqual([{ start: 6, end: 50, href: 'https://example.com/sightings/myapp/c653de5c' }])
  expect(findLinks('（https://x.com/a/b）看這個')[0].href).toBe('https://x.com/a/b')
  expect(findLinks('no links here, just http:// alone')).toEqual([])
})

test('project conversation: thread id, the @peer prefix, and what the bubble shows', async () => {
  // @ts-ignore: plain JS module shared with the PWA
  const { projectThread, projectOfThread, validPeer, addressed, unaddressed } = await import('../web/term.js')
  expect(projectThread('my-app-web')).toBe('project-my-app-web')
  expect(projectOfThread('project-my-app-web')).toBe('my-app-web')
  expect(projectOfThread('my-app-layout')).toBeNull()
  expect(projectOfThread(null)).toBeNull()
  expect(projectOfThread('project-my-app-web~mh1abc')).toBe('my-app-web')
  expect(addressed('hello', 'notes-1a')).toBe('@notes-1a hello')
  expect(addressed('@notes-1a hello', 'notes-1a')).toBe('@notes-1a hello')
  expect(unaddressed('@notes-1a hello @you')).toBe('hello @you')
  expect(validPeer('notes-1a')).toBe(true)
  expect(validPeer('Zoë')).toBe(false)
  expect(validPeer(null)).toBe(false)
})

test('layout: a plain shell (join: false) keeps its lines as printed', () => {
  const screen = '[master][~/w/my-app]$ ls\nbun.lock     data         node_modules scripts      web\nchannel      examples     package.json SPEC.md\nCLAUDE.md    hub          README.md    test\n[master][~/w/my-app]$'
  const texts = (r: any) => r.rows.map((x: any) => x.spans.map((s: any) => s.t).join(''))
  expect(texts(layoutScreen(parseAnsi(screen), { join: false }))).toEqual(screen.split('\n'))
  expect(texts(layoutScreen(parseAnsi(screen))).length).toBeLessThan(5) // the agent heuristic would join them
})
