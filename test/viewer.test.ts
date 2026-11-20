// The full-screen picture viewer: with a mouse, only a pressed main button drags the picture.
// A right-click's menu (and a Control-click's) takes the release, so a drag started by it never ended.
import { test, expect } from 'bun:test'
import { join } from 'path'

const web = (f: string) => Bun.file(join(import.meta.dir, '..', 'web', f)).text()
const viewerCode = async () => { const app = await web('app.js'); const i = app.indexOf('// ---------- image viewer'); return app.slice(i, app.indexOf('// ---------- presence', i)) }
const listener = (src: string, ev: string) => { const i = src.indexOf(`vStage.addEventListener('${ev}'`); return src.slice(i, src.indexOf('\n  })\n', i)) }

test('a right-click (any button but the main one) never starts a drag', async () => {
  const down = listener(await viewerCode(), 'pointerdown')
  expect(down).toContain("e.pointerType === 'mouse' && e.button !== 0")
  // The check comes before the pointer is captured or counted.
  expect(down.indexOf('e.button !== 0')).toBeLessThan(down.indexOf('setPointerCapture'))
  expect(down.indexOf('e.button !== 0')).toBeLessThan(down.indexOf('pts.set('))
})

test('a press whose release never came ends at the first move with the button up', async () => {
  const code = await viewerCode()
  const move = listener(code, 'pointermove')
  expect(move).toContain("e.pointerType === 'mouse' && !(e.buttons & 1)")
  expect(move.indexOf('e.buttons & 1')).toBeLessThan(move.indexOf('viewer.x +='))
  // It lets go of the pointer and ends the drag the way a cancel does (no tap, no double-tap zoom).
  const lost = code.slice(code.indexOf('const lost = '), code.indexOf("vStage.addEventListener('pointerup'"))
  expect(lost).toContain('releasePointerCapture(e.pointerId)')
  expect(lost).toContain("type: 'pointercancel'")
})

test('the browser menu still opens on the picture', async () => {
  const code = await viewerCode()
  expect(code).not.toContain("addEventListener('contextmenu'")
})
