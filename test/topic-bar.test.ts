// The topic bar: inside a topic, one row naming it (under the top bar on the phone, in the top bar's
// left side on wide windows); in All, the same row for the topic of the message at the top of the list
// (floating over the list on the phone, in the top bar on wide windows).
import { test, expect } from 'bun:test'
import { join } from 'path'

const web = (f: string) => Bun.file(join(import.meta.dir, '..', 'web', f)).text()
const body = (src: string, name: string) => { const i = src.indexOf(name); return src.slice(i, src.indexOf('\n}\n', i)) }

test('the bar replaces the chips and the context line; the top bar stays', async () => {
  const app = await web('app.js'), css = await web('style.css'), html = await web('index.html')
  expect(html).toContain('id="topic-bar"')
  expect(html).toContain('id="topic-pin"')
  const bar = body(app, 'function renderTopicBar(')
  expect(bar).toContain('on = state.thread != null')
  expect(bar).toContain("classList.toggle('in-topic', on)")
  // No context line at any width: the topic bar has all it had.
  expect(html).not.toContain('id="context"')
  expect(app).not.toContain("$('context')")
  expect(app).not.toContain('function toolButtons(')
  expect(html).not.toContain('id="threads"') // no chip row: the name button opens the topic list
  expect(css).not.toContain('.top .bar { display: none')
  // Every repaint of the nav repaints it, so its session button follows the panes list.
  expect(body(app, 'function renderNav(')).toContain('renderTopicBar()')
})

test('the row leads to its project\'s page, its session, and a menu with what the context line had', async () => {
  const app = await web('app.js')
  expect(body(app, 'function renderTopicBar(')).toContain("openTopicsSheet(p ? { kind: 'project', key: p.key } : null)")
  const row = body(app, 'function topicRow(')
  expect(row).toContain('openPanes(mine[0].id)')
  expect(row).not.toContain('shortTitle(') // the whole title: a shortened one can read wrong
  const menu = body(app, 'function openTopicMenu(')
  for (const x of ['setArchived(cur', 'toggleTool(t.id', "openTopicsSheet({ kind: 'project'", 'projectLinks']) expect(menu).toContain(x)
  // The message sheet's emoji row comes back for messages.
  expect(body(app, 'function openSheet(')).toContain("$('sheet-emojis').hidden = false")
})

test('in All the pinned row follows the message at the top, opens that topic, and hides over the main conversation', async () => {
  const app = await web('app.js')
  const pin = body(app, 'function updatePin(')
  expect(pin).toContain('all = state.thread == null && !state.home')
  expect(pin).toContain('switchThread(id)')
  expect(pin).toContain('el.hidden = !id')
  expect(body(app, 'function topThread(')).toContain('?.thread ?? null') // a message with no topic: no row
  expect(app).toContain("list.addEventListener('scroll', () => {\n  if (topicPin.frame) return")
})

test('the name button opens the project list as before, with Needs you and All topics above it', async () => {
  const app = await web('app.js'), css = await web('style.css'), html = await web('index.html')
  const sheet = body(app, 'function renderSheet(')
  expect(sheet).toContain("projectRow(p, () => showSheet({ kind: 'project', key: p.key }), false)")
  expect(sheet).toContain("showSheet({ kind: 'needs' })")
  expect(sheet).toContain("showSheet({ kind: 'all' })")
  expect(sheet).toContain('allTopicsNodes(pickTopic)')
  expect(html).not.toContain('title-needs') // no badge on the name button
  // All topics: every open topic, with its project and one line of next step.
  const all = body(app, 'function allTopicsNodes(')
  expect(all).toContain('openTopics()')
  expect(all).toContain('one-line')
  // A long next step is cut, and the list never scrolls sideways.
  expect(css).toContain('.topics-list .home-topic-next, .home .home-topic-next { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2;')
  expect(css).toContain('#topics-list { overflow-x: hidden; }')
})

test('a topic title loses its project name only before a separator', async () => {
  const app = await web('app.js')
  const fn = new Function(`${body(app, 'function shortTitle(')}\n}\nreturn shortTitle`)()
  const p = { name: 'Hub', key: 'hub' }
  expect(fn('Hub: topic header', p)).toBe('Topic header')
  expect(fn('Hub · notes', p)).toBe('Notes')
  expect(fn('Hub + Bebop: design notes', p)).toBe('Hub + Bebop: design notes')
  expect(fn('Hub mobile: topic header', p)).toBe('Hub mobile: topic header')
  expect(fn('Hubcap prices', p)).toBe('Hubcap prices')
  expect(fn('Anything', null)).toBe('Anything')
})

test('wide windows: the row takes the top bar\'s left side, with the session, tools and Archive; the app\'s buttons stay on the right', async () => {
  const app = await web('app.js'), css = await web('style.css')
  const wideCss = css.slice(css.indexOf('/* Wide windows: the topic row takes'))
  for (const x of ['.top > .bar { display: contents; }', '.bar-actions { grid-column: 2; grid-row: 1;', '.topic-bar { grid-column: 1; grid-row: 1;',
    '#app.pane-on .topic-bar, #app.blank .topic-bar { display: none; }']) expect(wideCss).toContain(x)
  const bar = body(app, 'function renderTopicBar(')
  expect(bar).toContain('on && wide.matches')
  expect(bar).toContain('toggleProjectColumn(p.key)')
  expect(bar).toContain('topicActions(curTopic())')
  const acts = body(app, 'function topicActions(')
  expect(acts).toContain('setArchived(cur, !arch)')
  expect(acts).toContain('toggleTool(t.id, cur.id)')
  // On a narrow conversation Archive is its icon.
  expect(css).toContain('@container (max-width: 620px) { .tb-act-label { display: none; }')
  // An open column has no background of its own on the row (it read as the hover): hover only.
  expect(bar).toContain("setAttribute('aria-expanded'")
  expect(css).not.toContain('.tb-main[aria-expanded="true"]')
})

test('wide windows: a click on the topic shows or hides its project\'s column and keeps the topic open', async () => {
  const app = await web('app.js')
  const show = body(app, 'function showProject(')
  expect(show).toContain("if (!wide.matches) return openTopicsSheet({ kind: 'project', key })")
  expect(show).toContain("setHome({ kind: 'project', key })")
  expect(show).not.toContain('switchThread(') // openHome would open the project's own topic
  expect(show).not.toContain('openHome(')
  expect(app).toContain('function toggleProjectColumn(key) { if (columnShown(key)) closeHome(); else showProject(key) }')
  // Several sessions behind a topic: its project's sessions, the column on wide windows.
  expect(body(app, 'function topicRow(')).toContain('showProject(p?.key ?? selfName())')
})

test('wide windows, All: the top bar names the topic of the message at the top, or the agent', async () => {
  const app = await web('app.js')
  const pin = body(app, 'function updatePin(')
  expect(pin).toContain('if (wide.matches) { // in the top bar')
  // The floating row is the phone's only (the other way, tried on wide windows, is gone).
  expect(app).not.toContain('PIN_ROW')
  expect(app).not.toContain('pinInBar')
  expect(pin).toContain("swapRow($('topic-bar'), id ?? '', id ? topicRow(id, () => switchThread(id), ICON_CHEVRON_RIGHT, []) : allRow(), topicPin.dir)")
  expect(app).toContain('const allRow = () =>')
  expect(app).toContain('S.allMessages)))]')
})

test('a project\'s column cuts a long next step to two lines, as the phone\'s sheet does', async () => {
  const app = await web('app.js')
  expect(body(app, 'function topicItem(')).toContain('title: column && t.detail ? t.detail : null') // the whole of it on hover
})

test('another topic slides in by one edge as the old one leaves by the other; the same topic repaints in place', async () => {
  const app = await web('app.js'), css = await web('style.css')
  const swap = body(app, 'function swapRow(')
  expect(swap).toContain('if (cur && host.dataset.topic === key) return cur.replaceChildren(...nodes)') // no motion for a repaint
  expect(swap).toContain("transform: y(-100 * dir)") // the old row leaves by the edge the list moves toward
  expect(swap).toContain("transform: y(100 * dir)") // the new one comes in by the other
  expect(swap).toContain("if (!dir || !host.getClientRects().length) return cur.replaceWith(row)") // hidden or asked for none: no motion
  // Reduced motion: a short fade, no movement.
  expect(swap).toContain("matchMedia('(prefers-reduced-motion: reduce)').matches")
  expect(swap).toContain("still ? 'none' : `translateY(${pct}%)`")
  // In All the way follows the list: scrolled down, the new topic comes up from the bottom edge.
  expect(app).toContain('if (top !== topicPin.top) topicPin.dir = top > topicPin.top ? 1 : -1')
  // Opening another topic on a wide window: from the bottom. On the phone a topic opens from a sheet: no motion.
  const bar = body(app, 'function renderTopicBar(')
  expect(bar).toContain('swapRow(bar, state.thread, row, 1, state.home ? null : wideBack)')
  expect(bar).toContain("bar.replaceChildren(back, h('div', { class: 'tb-row' }, ...main))")
  // The phone's floating row moves the same way, but just appears after messages with no topic.
  expect(body(app, 'function updatePin(')).toContain('el.hidden ? 0 : topicPin.dir')
  // The bar clips the rows at its edges.
  expect(css).toContain('.topic-bar { position: relative; overflow: hidden;')
})

test('wide windows: ‹ back to All before the topic, as on the phone; it stays put while another topic slides in, and goes in All', async () => {
  const app = await web('app.js'), css = await web('style.css')
  // The same as the agent's row in the sidebar: All, closing a project's column or a session.
  expect(app).toContain("const wideBack = h('button', { type: 'button', class: 'tb-back', 'aria-label': S.allMessages, title: S.allMessages, onclick: () => switchThread(null) }")
  const swap = body(app, 'function swapRow(')
  // The leaving row is measured before the ‹ comes or goes beside it, so it leaves from where it was.
  expect(swap.indexOf('const r = cur?.getBoundingClientRect(), hr = host.getBoundingClientRect()')).toBeLessThan(swap.indexOf('if (n !== cur && n !== lead) n.remove()'))
  expect(swap).toContain('if (lead && host.firstChild !== lead) {')
  // In All (wide) the row is swapped with no lead: the ‹ goes.
  expect(body(app, 'function updatePin(')).toContain('allRow(), topicPin.dir)')
  expect(css).toContain('.topic-bar .tb-back { height: 40px;')
  expect(css).toContain('.tb-back:hover')
})

test('wide windows, a column open: the ‹ starts the column\'s header, not the conversation\'s', async () => {
  const app = await web('app.js'), css = await web('style.css')
  // The same button and action as the conversation header's (it's a .tb-back, so it hovers the same).
  expect(app).toContain("const colBack = h('button', { type: 'button', class: 'tb-back col-back', 'aria-label': S.allMessages, title: S.allMessages, onclick: () => switchThread(null) }")
  const nodes = body(app, 'function homeNodes(')
  expect(nodes).toContain('const back = column ? colBack : null') // only beside the conversation; the phone's sheet has its own back
  // First in every column's header: a project's and Needs you, and Sessions.
  expect(nodes).toContain("h('div', { class: 'home-head' }, back, view.kind === 'needs'")
  expect(nodes).toContain("h('div', { class: 'home-head' }, back, h('h2', {}, S.sessions)")
  // The conversation's header has none while a column is open; it comes back when the column closes.
  expect(body(app, 'function renderTopicBar(')).toContain('state.home ? null : wideBack')
  // Sized like the header's, at the column's left edge.
  expect(css).toContain('.home .col-back { height: 40px; min-width: 36px; padding: 0 9px 0 8px; margin: 0 -3px 0 -10px; }')
})

test('a project with no icon: its initial centred in the header\'s tile; a new project conversation is named, not its id', async () => {
  const app = await web('app.js'), css = await web('style.css')
  // .tb-icon (display: block) comes after .proj-initial (display: grid), so the tile says grid itself, as .home-icon's does.
  expect(css).toContain('.tb-icon.proj-initial { display: grid; font-size: 13px; }')
  expect(css.indexOf('.tb-icon.proj-initial {')).toBeGreaterThan(css.indexOf('.tb-icon { flex: none; display: block;'))
  expect(app).toContain('?.title ?? (projectOfThread(id) ? S.projectChat : id)')
})

test('wide windows: one session button, beside the topic, with a session\'s mark; the phone keeps both', async () => {
  const app = await web('app.js'), css = await web('style.css')
  // No sparkle up top on wide windows; on the phone it opens the sessions as before.
  expect(css).toContain('  #panes-btn { display: none; }')
  expect(app).toContain("$('panes-btn').onclick = () => openPanes()")
  expect(app).not.toContain('toggleTerminal')
  // The topic's button: the sparkle (>_ when its sessions are all plain terminals) on wide, >_ on the phone.
  expect(body(app, 'function topicRow(')).toContain("html: wide.matches ? agentMark(mine.find(x => x.agent !== 'shell')?.agent ?? 'shell') : ICON_TERMINAL")
  // A session always shows beside a column: its view's, its project's, or Sessions (no folder).
  expect(body(app, 'function selectSession(')).toContain("p?.project ? { kind: 'project', key: projectKey(p.project) } : { kind: 'sessions' }")
})
