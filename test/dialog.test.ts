import { test, expect } from 'bun:test'
// @ts-ignore: plain JS module shared with the PWA
import { parseDialog, keysFor, cardable } from '../web/dialog.js'

const RULE = '─'.repeat(80)

// AskUserQuestion, one question, as Claude Code draws it at the bottom of the pane.
const single = [
  '⏺ I need one decision before I build the undo stack:',
  '',
  '  1. Keep the stack per document',
  '  2. Keep it across documents',
  '',
  RULE,
  ' ☐ Undo scope',
  '',
  'How should undo treat a move of several nodes at once? It changes how the history',
  'panel groups the entries.',
  '',
  '❯ 1. Same as a move (Recommended)',
  '     Undo reverts the whole move in one step, like Figma does.',
  '  2. Per node',
  '     Each node\'s change is its own undo step. More precise, but a 20-node move',
  '     takes 20 undos.',
  '  3. Type something.',
  RULE,
  '  4. Chat about this',
  '',
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
].join('\n')

test('dialog: one question, single select: prompt, options with descriptions, Recommended, free text, chat', () => {
  const d = parseDialog(single)
  expect(d).toMatchObject({
    kind: 'question',
    header: 'Undo scope',
    tabs: null,
    multi: false,
    cursor: 1,
    prompt: 'How should undo treat a move of several nodes at once? It changes how the history panel groups the entries.',
    footer: 'Enter to select · ↑/↓ to navigate · Esc to cancel',
    top: 5, // the rule over the header chip
  })
  expect(d.options).toEqual([
    { n: 1, label: 'Same as a move', description: 'Undo reverts the whole move in one step, like Figma does.', recommended: true, input: false, chat: false, separated: false, checked: null },
    { n: 2, label: 'Per node', description: 'Each node\'s change is its own undo step. More precise, but a 20-node move takes 20 undos.', recommended: false, input: false, chat: false, separated: false, checked: null },
    { n: 3, label: 'Type something.', description: '', recommended: false, input: true, chat: false, separated: false, checked: null },
    { n: 4, label: 'Chat about this', description: '', recommended: false, input: false, chat: true, separated: true, checked: null },
  ])
  expect(cardable(d)).toBe(true)
})

test('dialog: inside a │ left border (or a full box) it reads the same', () => {
  const boxed = single.split('\n').map(l => (l.startsWith('─') ? l : `│ ${l}`)).join('\n')
  const d = parseDialog(boxed)
  expect(d?.prompt).toBe(parseDialog(single).prompt)
  expect(d.options.map((o: any) => o.label)).toEqual(['Same as a move', 'Per node', 'Type something.', 'Chat about this'])
  const full = single.split('\n').map(l => (l.startsWith('─') ? l : `│ ${l.padEnd(78)} │`)).join('\n')
  expect(parseDialog(full)?.options[1].description).toBe('Each node\'s change is its own undo step. More precise, but a 20-node move takes 20 undos.')
})

test('dialog: a label the pane wrapped at its edge stays the label; the description under it stays apart', () => {
  const src = [
    'Which name should the new command get?',
    '',
    '❯ 1. A long label that goes on and on until it reaches the edge of this rather',
    '     narrow pane (Recommended)',
    '     The description under it.',
    '  2. Short',
    '  3. Type something.',
    '',
    'Enter to select · ↑/↓ to navigate · Esc to cancel',
  ].join('\n')
  const d = parseDialog(src, { cols: 80 })
  expect(d.options[0]).toMatchObject({ label: 'A long label that goes on and on until it reaches the edge of this rather narrow pane', recommended: true, description: 'The description under it.' })
  expect(d.options[1]).toMatchObject({ label: 'Short', description: '' })
})

test('dialog: several questions: header chips become tabs; the cursor may sit lower', () => {
  const src = [
    RULE,
    '←  ☐ Scope  ☐ Undo  ✔ Names  ✔ Submit  →',
    '',
    'Which nodes does a move cover?',
    '',
    '  1. The selection',
    '     Only what is selected.',
    '❯ 2. The selection and its children',
    '  3. Type something.',
    RULE,
    '  4. Chat about this',
    '',
    'Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
  ].join('\n')
  const d = parseDialog(src)
  expect(d.tabs).toEqual([{ label: 'Scope', done: false }, { label: 'Undo', done: false }, { label: 'Names', done: true }, { label: 'Submit', done: true }])
  expect(d.header).toBe(null)
  expect(d.cursor).toBe(2)
  expect(d.prompt).toBe('Which nodes does a move cover?')
  expect(d.top).toBe(0)
  expect(cardable(d)).toBe(true)
  expect(keysFor(d, d.options[0])).toEqual(['1'])
  expect(keysFor(d, d.options[2])).toEqual(['down']) // focus the text option from option 2; no Enter yet
})

// A one-question multi-select (Claude Code 2.1.310, captured from a pane): an unnumbered
// "Submit" row under the last checkbox, and the Submit chip in the header.
test('dialog: multi-select is a card: checkboxes, digits toggle, the Submit row is not a description', () => {
  const src = [
    RULE,
    '←  ☒ Platforms  ✔ Submit  →',
    '',
    'Which platforms should the build cover?',
    '',
    '❯ 1. [ ] iOS',
    '         iPhone and iPad',
    '  2. [✔] macOS',
    '         Mac',
    '  3. [ ] Type something',
    '     Submit',
    RULE,
    '  4. Chat about this',
    '',
    'Enter to select · ↑/↓ to navigate · Esc to cancel',
  ].join('\n')
  const d = parseDialog(src)
  expect(d.multi).toBe(true)
  expect(d.tabs).toEqual([{ label: 'Platforms', done: true }, { label: 'Submit', done: true }])
  expect(d.options.map((o: any) => [o.label, o.description, o.checked, o.input])).toEqual([
    ['iOS', 'iPhone and iPad', false, false], ['macOS', 'Mac', true, false], ['Type something', '', false, true], ['Chat about this', '', null, false],
  ])
  expect(cardable(d)).toBe(true)
  expect(keysFor(d, d.options[1])).toEqual(['2']) // toggles, the cursor stays
  expect(keysFor(d, d.options[2])).toEqual(['down', 'down'])
})

// The folder-trust prompt (Claude Code 2.1.310): options without numbers.
const trust = [
  '[~/scratch/cardlab]$ claude',
  '',
  RULE,
  ' Accessing workspace:',
  '',
  ' /tmp/scratch/cardlab',
  '',
  ' Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known',
  ' open source project, or work from your team). If not, take a moment to review what\'s in this folder first.',
  '',
  ' Claude Code\'ll be able to read, edit, and execute files here.',
  '',
  ' Security guide',
  '',
  ' ❯ No, exit',
  '   Yes, I trust this folder',
  '',
  ' Enter to confirm · Esc to cancel',
].join('\n')

test('dialog: a menu without numbers (folder trust) is a card chosen with arrows', () => {
  const d = parseDialog(trust)
  expect(d).toMatchObject({ plain: true, multi: false, cursor: 1, title: 'Accessing workspace:', top: 2 })
  expect(d.prompt).toStartWith('Quick safety check: Is this a project')
  expect(d.context).toEqual(['/tmp/scratch/cardlab', '', 'Claude Code\'ll be able to read, edit, and execute files here.', '', 'Security guide'])
  expect(d.options.map((o: any) => o.label)).toEqual(['No, exit', 'Yes, I trust this folder'])
  expect(cardable(d)).toBe(true)
  expect(keysFor(d, d.options[0])).toEqual(['enter'])
  expect(keysFor(d, d.options[1])).toEqual(['down', 'enter'])
})

test('dialog: a menu whose entries span several lines (rewind) stays on the keys', () => {
  const src = [
    '▔'.repeat(80),
    '   Rewind',
    '',
    '   Restore the code and/or conversation to the point before…',
    '',
    '     Add the undo stack',
    '     No code changes',
    '',
    '   ❯ (current)',
    '',
    '   Enter to continue · Esc to cancel',
  ].join('\n')
  expect(parseDialog(src)).toBeNull()
})

test('dialog: the idle prompt is not a menu', () => {
  expect(parseDialog(['⏺ Done.', '', RULE, '❯ ', RULE, '  ? for shortcuts'].join('\n'))).toBeNull()
})

test('dialog: a Bash permission prompt: title, the command as context, Yes / Yes, and don\'t ask / No', () => {
  const src = [
    '⏺ Bash(git push origin feat/undo)',
    '  ⎿  Running…',
    '',
    RULE,
    ' Bash command',
    '',
    '   git push origin feat/undo',
    '   Push the undo branch',
    '',
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    '   2. Yes, and don\'t ask again for git push commands in /home/dev/projects/app',
    '   3. No, and tell Claude what to do differently (esc)',
    '',
    ' Esc to cancel · Tab to amend · ctrl+e to explain',
  ].join('\n')
  const d = parseDialog(src)
  expect(d).toMatchObject({ kind: 'permission', prompt: 'Do you want to proceed?', title: 'Bash command', context: ['git push origin feat/undo', 'Push the undo branch'], cursor: 1, top: 3 })
  expect(d.options.map((o: any) => o.label)).toEqual(['Yes', 'Yes, and don\'t ask again for git push commands in /home/dev/projects/app', 'No, and tell Claude what to do differently (esc)'])
  expect(keysFor(d, d.options[2])).toEqual(['3'])
})

test('dialog: an edit permission in a drawn box, with a diff', () => {
  const src = [
    '╭──────────────────────────────────────────────────────────────╮',
    '│ Edit file                                                    │',
    '│ ╭──────────────────────────────────────────────────────────╮ │',
    '│ │ web/app.js                                               │ │',
    '│ │ 12  - const a = 1                                        │ │',
    '│ │ 12  + const a = 2                                        │ │',
    '│ ╰──────────────────────────────────────────────────────────╯ │',
    '│ Do you want to make this edit to app.js?                     │',
    '│ ❯ 1. Yes                                                     │',
    '│   2. Yes, allow all edits during this session (shift+tab)   │',
    '│   3. No, and tell Claude what to do differently (esc)       │',
    '╰──────────────────────────────────────────────────────────────╯',
  ].join('\n')
  const d = parseDialog(src)
  expect(d?.kind).toBe('permission')
  expect(d.prompt).toBe('Do you want to make this edit to app.js?')
  expect(d).toMatchObject({ title: 'Edit file', context: ['web/app.js', '12  - const a = 1', '12  + const a = 2'], top: 0 })
  expect(d.options.length).toBe(3)
  expect(d.options[1].label).toBe('Yes, allow all edits during this session (shift+tab)')
})

// The last step of a multi-question dialog (Claude Code 2.1.309, captured from a pane).
test('dialog: the review before submitting several answers carries the answers', () => {
  const review = [
    RULE,
    '←  ☒ Color  ☒ Size  ✔ Submit  →',
    '',
    'Review your answers',
    '',
    ' ● Which color do you prefer?',
    '   → Red',
    ' ● Which size do you prefer?',
    '   → Small',
    '',
    'Ready to submit your answers?',
    '',
    '❯ 1. Submit answers',
    '  2. Cancel',
  ].join('\n')
  const d = parseDialog(review)
  expect(d).toMatchObject({ kind: 'question', prompt: 'Ready to submit your answers?', title: 'Review your answers', cursor: 1, top: 0 })
  expect(d.context).toEqual(['● Which color do you prefer?', '→ Red', '● Which size do you prefer?', '→ Small'])
  expect(d.tabs.map((t: any) => t.label)).toEqual(['Color', 'Size', 'Submit'])
  expect(d.options.map((o: any) => o.label)).toEqual(['Submit answers', 'Cancel'])
  expect(cardable(d)).toBe(true)
  expect(keysFor(d, d.options[0])).toEqual(['1'])
})

test('dialog: ordinary output is not a dialog', () => {
  const idle = [
    '⏺ Done. Three things changed:',
    '  1. The parser',
    '  2. The card',
    '  3. The key bar',
    '',
    '╭──────────────────────────────────────╮',
    '│ >                                    │',
    '╰──────────────────────────────────────╯',
    '  ? for shortcuts',
  ].join('\n')
  expect(parseDialog(idle)).toBe(null)
  expect(parseDialog('')).toBe(null)
  expect(parseDialog('  1. one\n  2. two')).toBe(null) // no cursor and no footer
  expect(parseDialog('Pick one\n❯ 1. a\n  3. b\n\nEsc to cancel')).toBe(null) // numbers out of order
  expect(parseDialog('Pick one\n❯ 1. a\n  2. b\nsomething else\n\nEsc to cancel')).toBe(null) // text after the options
  expect(parseDialog('❯ 1. a\n  2. b\n\nEsc to cancel')).toBe(null) // no question
})

test('keys: a digit for 1-9; arrows (and Enter) past 9 or for the text option; null without a cursor', () => {
  const opts = Array.from({ length: 11 }, (_, k) => ({ n: k + 1, label: `o${k + 1}`, input: false }))
  const d = { cursor: 1, options: opts }
  expect(keysFor(d, opts[8])).toEqual(['9'])
  expect(keysFor(d, opts[10])).toEqual([...Array(10).fill('down'), 'enter'])
  expect(keysFor({ cursor: 4 }, { n: 2, input: true })).toEqual(['up', 'up'])
  expect(keysFor({ cursor: 3 }, { n: 3, input: true })).toEqual([])
  expect(keysFor({ cursor: null }, { n: 3, input: true })).toBe(null)
})
