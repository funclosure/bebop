// Dragging files onto the conversation attaches them like + (web/app.js).
import { test, expect } from 'bun:test'
import { join } from 'path'
import { readFileSync } from 'fs'

const web = (f: string) => readFileSync(join(import.meta.dir, '..', 'web', f), 'utf8')

test('drop: files dropped on the conversation go through the same upload as + and paste', () => {
  const app = web('app.js')
  const drop = app.slice(app.indexOf("document.addEventListener('drop'"), app.indexOf('function startUpload('))
  expect(drop).toContain('attachFiles(files)')
  expect(drop).toContain('isDirectory') // folders are skipped, with a note
  expect(drop).toContain('S.noFolders')
  // Never open a dragged file in place of the app, wherever it lands.
  const over = app.slice(app.indexOf("document.addEventListener('dragover'"), app.indexOf("document.addEventListener('drop'"))
  expect(over).toContain('e.preventDefault()')
  // Only while a conversation's composer is on screen.
  expect(over).toContain('composerShown()')
  const paste = app.slice(app.indexOf("input.addEventListener('paste'"), app.indexOf('function attachFiles('))
  expect(paste).toContain('attachFiles(files)')
  expect(web('index.html')).toContain('id="drop-zone"')
  expect(web('strings.js')).toContain('dropToAttach')
})
