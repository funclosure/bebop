#!/usr/bin/env bun
// Hello: the smallest Bebop tool. A note pad per project (manifest scope "project"), opened at a page:
// the topic's id, or "overview" from the project's header. "Post" sends the note into that page's topic.
//
//   PORT=5180 BEBOP_HUB_ORIGIN=http://127.0.0.1:8787 bun server.ts
//
// It speaks `bebop-tool` v1 (SPEC.md, Tools): say hello to the parent until it answers with init,
// then ready; post a note and wait for post-ack. It talks only to window.parent, and after init only
// to the origin that sent it, which must be one of BEBOP_HUB_ORIGIN (space-separated).
const port = Number(process.env.PORT ?? 5180)
const hubOrigins = (process.env.BEBOP_HUB_ORIGIN ?? 'http://127.0.0.1:8787 http://localhost:8787').split(/\s+/).filter(Boolean)

const page = (instance: string, pageId: string) => `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Hello · ${instance}</title>
<style>
  body { font: 15px/1.4 system-ui, sans-serif; margin: 0; padding: 16px; color: #222; background: #fff; }
  textarea { width: 100%; box-sizing: border-box; min-height: 8em; font: inherit; padding: 8px; }
  button { font: inherit; padding: 6px 14px; margin-top: 8px; }
  #log { color: #666; font-size: 13px; margin-top: 12px; white-space: pre-line; }
</style></head>
<body>
  <h1 style="font-size:17px;margin:0 0 8px">Notes for <code id="inst"></code> · <span id="page"></span></h1>
  <textarea id="note" placeholder="Write a note for the agent"></textarea>
  <button id="post" type="button" disabled>Post to the topic</button>
  <div id="log"></div>
<script>
const HUB_ORIGINS = ${JSON.stringify(hubOrigins)}
const instance = ${JSON.stringify(instance)}
// The page from the URL; the hub's init names it too, with a title.
let pageId = ${JSON.stringify(pageId)}
const P = { protocol: 'bebop-tool', v: 1 }
document.getElementById('inst').textContent = instance
document.getElementById('page').textContent = pageId || 'no page'
const log = s => { document.getElementById('log').textContent = s + '\\n' + document.getElementById('log').textContent }
const embedded = window.parent !== window
let hub = null, init = null, posted = 0
const pending = new Map()
const send = msg => embedded && window.parent.postMessage({ ...P, ...msg }, hub ?? '*') // hello only goes out before init

addEventListener('message', e => {
  if (e.source !== window.parent || !HUB_ORIGINS.includes(e.origin) || (hub && e.origin !== hub)) return
  const d = e.data
  if (!d || d.protocol !== 'bebop-tool' || d.v !== 1) return
  if (d.type === 'init' && !init) {
    hub = e.origin; init = d
    if (d.page?.id) { pageId = d.page.id; document.getElementById('page').textContent = d.page.title || d.page.id }
    log('Connected to ' + (d.agent?.name || d.agent?.id || 'the agent') + ' as ' + (d.user?.name || 'you'))
    document.getElementById('post').disabled = false
    send({ type: 'ready', link: location.origin + '/t/' + encodeURIComponent(instance) + '?page=' + encodeURIComponent(pageId) })
    send({ type: 'status', text: 'No notes yet', busy: false })
  } else if (d.type === 'post-ack') {
    pending.get(d.id)?.(d)
  }
})
if (embedded) {
  const started = Date.now()
  const t = setInterval(() => { if (init || Date.now() - started > 10000) return clearInterval(t); send({ type: 'hello', versions: [1] }) }, 500)
  send({ type: 'hello', versions: [1] })
} else log('Open this beside a topic in the hub to post notes.')

document.getElementById('post').onclick = () => {
  const text = document.getElementById('note').value.trim()
  if (!text) return
  const id = crypto.randomUUID()
  send({ type: 'status', text: 'Posting…', busy: true })
  // The app acks once the post is in the topic; a post sent within 2 s of the last waits in its queue first.
  const timer = setTimeout(() => pending.get(id)?.({ ok: false, error: 'no answer' }), 30000)
  pending.set(id, ack => {
    clearTimeout(timer); pending.delete(id)
    if (ack.ok) { posted++; document.getElementById('note').value = ''; log('Posted.') } else log('Not posted: ' + (ack.error || 'unknown error'))
    send({ type: 'status', text: posted + ' note' + (posted === 1 ? '' : 's') + ' posted', busy: false })
  })
  send({ type: 'post', id, text, files: [{ name: 'note.txt', mime: 'text/plain', data: text }], ref: { note: id, page: pageId }, key: id })
}
</script></body></html>`

const server = Bun.serve({
  port,
  fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === '/healthz') return new Response('ok')
    const m = /^\/t\/([A-Za-z0-9_-]{6,64})$/.exec(url.pathname)
    if (!m) return new Response('not found', { status: 404 })
    return new Response(page(m[1], (url.searchParams.get('page') ?? '').slice(0, 200)), { headers: {
      'content-type': 'text/html; charset=utf-8',
      // Only the hub may frame it.
      'content-security-policy': `frame-ancestors 'self' ${hubOrigins.join(' ')}`,
    } })
  },
})
console.log(`hello: http://localhost:${server.port} (framed by ${hubOrigins.join(', ')})`)
