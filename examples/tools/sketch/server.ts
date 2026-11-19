#!/usr/bin/env bun
// Sketch: a plain whiteboard per topic (manifest scope "topic"). Freehand pen in a few colours, an
// eraser, Undo and Clear; the board is saved on this server per instance, so it's there next time.
// "Send" posts a PNG of the board into the topic with a short note.
//
//   PORT=5180 BEBOP_HUB_ORIGIN=http://127.0.0.1:8787 SKETCH_DATA=./data bun server.ts
//
// Speaks `bebop-tool` v1 (SPEC.md, Tools), like examples/tools/hello.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'

const port = Number(process.env.PORT ?? 5180)
const hubOrigins = (process.env.BEBOP_HUB_ORIGIN ?? 'http://127.0.0.1:8787 http://localhost:8787').split(/\s+/).filter(Boolean)
const dataDir = process.env.SKETCH_DATA ?? join(import.meta.dir, 'data')
mkdirSync(dataDir, { recursive: true })
const MAX_BOARD = 2_000_000
const ID = /^[A-Za-z0-9_-]{6,64}$/

const page = (instance: string) => `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<title>Sketch</title>
<style>
  :root { color-scheme: light; }
  html, body { margin: 0; height: 100%; background: #f4f4f2; font: 14px/1.3 system-ui, sans-serif; color: #222; overflow: hidden; }
  body { display: flex; flex-direction: column; }
  .bar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 8px; background: #fff; border-bottom: 1px solid #ddd; }
  .bar button { font: inherit; border: 1px solid #ccc; background: #fff; border-radius: 999px; padding: 6px 12px; min-height: 34px; }
  .bar button.on { border-color: #222; box-shadow: inset 0 0 0 1px #222; }
  .sw { width: 34px; padding: 0 !important; }
  .sw span { display: inline-block; width: 18px; height: 18px; border-radius: 50%; vertical-align: middle; }
  .grow { flex: 1; min-width: 120px; font: 16px system-ui, sans-serif; border: 1px solid #ccc; border-radius: 999px; padding: 6px 12px; min-height: 22px; }
  #send { background: #222; color: #fff; border-color: #222; }
  #send:disabled { opacity: .5; }
  #wrap { flex: 1; position: relative; }
  canvas { position: absolute; inset: 0; width: 100%; height: 100%; background: #fff; touch-action: none; cursor: crosshair; }
  #note { position: absolute; left: 50%; bottom: 14px; transform: translateX(-50%); background: #222; color: #fff; padding: 6px 12px; border-radius: 8px; opacity: 0; transition: opacity .2s; pointer-events: none; }
  #note.show { opacity: .92; }
</style></head>
<body>
<div class="bar">
  <button class="sw on" data-c="#1f1f1f" aria-label="Black"><span style="background:#1f1f1f"></span></button>
  <button class="sw" data-c="#d93025" aria-label="Red"><span style="background:#d93025"></span></button>
  <button class="sw" data-c="#1a73e8" aria-label="Blue"><span style="background:#1a73e8"></span></button>
  <button class="sw" data-c="#188038" aria-label="Green"><span style="background:#188038"></span></button>
  <button id="eraser" type="button">Eraser</button>
  <button id="undo" type="button">Undo</button>
  <button id="clear" type="button">Clear</button>
  <input id="text" class="grow" placeholder="Note (optional)" maxlength="500">
  <button id="send" type="button" disabled>Send to the topic</button>
</div>
<div id="wrap"><canvas id="c"></canvas><div id="note"></div></div>
<script>
const HUB_ORIGINS = ${JSON.stringify(hubOrigins)}
const instance = ${JSON.stringify(instance)}
const P = { protocol: 'bebop-tool', v: 1 }
const embedded = window.parent !== window
const $ = id => document.getElementById(id)
const cv = $('c'), ctx = cv.getContext('2d')
let hub = null, init = null, agentName = 'the agent'
// Strokes: {c: colour or null for the eraser, w: width, p: [x, y, …]} in units of the canvas width.
let strokes = [], cur = null, color = '#1f1f1f', erasing = false
const pending = new Map()
const send = msg => embedded && window.parent.postMessage({ ...P, ...msg }, hub ?? '*')
const note = s => { const n = $('note'); n.textContent = s; n.classList.add('show'); clearTimeout(note.t); note.t = setTimeout(() => n.classList.remove('show'), 2200) }

function size() {
  const r = cv.getBoundingClientRect(), d = devicePixelRatio || 1
  cv.width = Math.round(r.width * d); cv.height = Math.round(r.height * d)
  redraw()
}
function drawStroke(g, s, W) {
  const p = s.p
  g.strokeStyle = s.c ?? '#fff'; g.lineWidth = s.w * W; g.lineCap = 'round'; g.lineJoin = 'round'
  g.beginPath(); g.moveTo(p[0] * W, p[1] * W)
  if (p.length === 2) g.lineTo(p[0] * W + 0.01, p[1] * W)
  for (let i = 2; i < p.length; i += 2) g.lineTo(p[i] * W, p[i + 1] * W)
  g.stroke()
}
function redraw() {
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height)
  for (const s of strokes) drawStroke(ctx, s, cv.width)
  if (cur) drawStroke(ctx, cur, cv.width)
}
function pt(e) { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.width] }
cv.addEventListener('pointerdown', e => {
  e.preventDefault(); cv.setPointerCapture(e.pointerId)
  const r = cv.getBoundingClientRect()
  cur = { c: erasing ? null : color, w: (erasing ? 24 : 3.5) / r.width, p: pt(e) }
  redraw()
})
cv.addEventListener('pointermove', e => {
  if (!cur) return
  for (const ev of (e.getCoalescedEvents?.() ?? [e])) cur.p.push(...pt(ev))
  redraw()
})
const end = () => { if (!cur) return; cleared = null; strokes.push(cur); cur = null; redraw(); save() }
cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end)

for (const b of document.querySelectorAll('.sw')) b.onclick = () => {
  color = b.dataset.c; erasing = false
  for (const o of document.querySelectorAll('.sw, #eraser')) o.classList.toggle('on', o === b)
}
$('eraser').onclick = () => { erasing = true; for (const o of document.querySelectorAll('.sw, #eraser')) o.classList.toggle('on', o === $('eraser')) }
// Clear can be undone: Undo right after it brings the board back.
let cleared = null
$('undo').onclick = () => { if (!strokes.length && cleared) { strokes = cleared; cleared = null } else strokes.pop(); redraw(); save() }
$('clear').onclick = () => { if (!strokes.length) return; cleared = strokes; strokes = []; redraw(); save(); note('Cleared. Undo brings it back.') }

let saveT = null
function save() {
  clearTimeout(saveT)
  saveT = setTimeout(() => {
    const body = JSON.stringify({ strokes: strokes.map(s => ({ ...s, p: s.p.map(v => Math.round(v * 10000) / 10000) })) })
    fetch('/api/' + encodeURIComponent(instance), { method: 'PUT', headers: { 'content-type': 'application/json' }, body })
      .then(r => { if (!r.ok) note('Not saved') }).catch(() => note('Not saved'))
  }, 400)
}
fetch('/api/' + encodeURIComponent(instance)).then(r => r.ok ? r.json() : null).then(d => {
  if (d && Array.isArray(d.strokes) && !strokes.length) { strokes = d.strokes; redraw() }
}).catch(() => {})

function png() {
  // The drawn area plus a margin, at most 1600 px wide, on white.
  const W = cv.width
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const s of strokes) for (let i = 0; i < s.p.length; i += 2) {
    const x = s.p[i] * W, y = s.p[i + 1] * W, h = s.w * W / 2
    x0 = Math.min(x0, x - h); y0 = Math.min(y0, y - h); x1 = Math.max(x1, x + h); y1 = Math.max(y1, y + h)
  }
  const m = 24 * (devicePixelRatio || 1)
  x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m); x1 = Math.min(W, x1 + m); y1 = Math.min(cv.height, y1 + m)
  const w = x1 - x0, h = y1 - y0, k = Math.min(1, 1600 / w)
  const o = document.createElement('canvas'); o.width = Math.max(1, Math.round(w * k)); o.height = Math.max(1, Math.round(h * k))
  const g = o.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, o.width, o.height)
  g.drawImage(cv, x0, y0, w, h, 0, 0, o.width, o.height)
  return o.toDataURL('image/png')
}

$('send').onclick = () => {
  if (!strokes.length) return note('Draw something first')
  const text = $('text').value
  const id = crypto.randomUUID()
  $('send').disabled = true
  send({ type: 'status', text: 'Sending…', busy: true })
  const timer = setTimeout(() => pending.get(id)?.({ ok: false, error: 'no answer' }), 30000)
  pending.set(id, ack => {
    clearTimeout(timer); pending.delete(id); $('send').disabled = false
    if (ack.ok) $('text').value = ''
    note(ack.ok ? 'Sent to ' + agentName : 'Not sent: ' + (ack.error || 'unknown error'))
    send({ type: 'status', text: ack.ok ? 'Sent' : 'Not sent', busy: false })
  })
  send({ type: 'post', id, text: text.trim() || 'Here is my sketch.', files: [{ name: 'sketch.png', mime: 'image/png', data: png() }], ref: { sketch: id }, key: id })
}

addEventListener('message', e => {
  if (e.source !== window.parent || !HUB_ORIGINS.includes(e.origin) || (hub && e.origin !== hub)) return
  const d = e.data
  if (!d || d.protocol !== 'bebop-tool' || d.v !== 1) return
  if (d.type === 'init' && !init) {
    hub = e.origin; init = d; agentName = d.agent?.name || agentName
    $('send').textContent = 'Send to ' + agentName; $('send').disabled = false
    send({ type: 'ready', link: location.origin + '/s/' + encodeURIComponent(instance) })
  } else if (d.type === 'post-ack') pending.get(d.id)?.(d)
})
if (embedded) {
  const started = Date.now()
  const t = setInterval(() => { if (init || Date.now() - started > 10000) return clearInterval(t); send({ type: 'hello', versions: [1] }) }, 500)
  send({ type: 'hello', versions: [1] })
}
addEventListener('resize', size); size()
</script></body></html>`

const html = (body: string) => new Response(body, { headers: {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': `frame-ancestors 'self' ${hubOrigins.join(' ')}`,
} })

const server = Bun.serve({
  port,
  hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === '/healthz') return new Response('ok')
    let m = /^\/s\/([A-Za-z0-9_-]{6,64})$/.exec(url.pathname)
    if (m && req.method === 'GET') return html(page(m[1]))
    m = /^\/api\/([A-Za-z0-9_-]{6,64})$/.exec(url.pathname)
    if (m && ID.test(m[1])) {
      const file = join(dataDir, m[1] + '.json')
      if (req.method === 'GET') {
        try { return new Response(readFileSync(file), { headers: { 'content-type': 'application/json' } }) } catch { return Response.json({ strokes: [] }) }
      }
      if (req.method === 'PUT') {
        const body = await req.text()
        if (body.length > MAX_BOARD) return new Response('too big', { status: 413 })
        try { if (!Array.isArray(JSON.parse(body).strokes)) throw 0 } catch { return new Response('bad board', { status: 400 }) }
        writeFileSync(file + '.tmp', body); renameSync(file + '.tmp', file)
        return new Response(null, { status: 204 })
      }
    }
    return new Response('not found', { status: 404 })
  },
})
console.log(`sketch: http://127.0.0.1:${server.port} (framed by ${hubOrigins.join(', ')}, boards in ${dataDir})`)
