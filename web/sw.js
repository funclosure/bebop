// Service worker: app shell (network-first, cache fallback) and push.
// It never answers /api, /agent or /files, never touches SSE or Range requests.
const CACHE = 'shell-v74'
const SHELL = ['./', 'style.css', 'app.js', 'strings.js', 'term.js', 'dialog.js', 'vendor/marked.js', 'vendor/purify.js', 'manifest.webmanifest', 'icons/icon.svg', 'icons/mark.svg', 'icons/icon-192.png']
const scope = new URL(self.registration.scope)
const shellPaths = new Set(SHELL.map(p => new URL(p, scope).pathname))

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}))
})

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))))
})

self.addEventListener('message', e => {
  if (e.data?.type === 'SKIP_WAITING') self.skipWaiting()
})

self.addEventListener('fetch', e => {
  const req = e.request
  if (req.method !== 'GET' || req.headers.has('range')) return
  const url = new URL(req.url)
  if (url.origin !== scope.origin) return
  const isNav = req.mode === 'navigate' && url.pathname === scope.pathname
  if (!isNav && !shellPaths.has(url.pathname)) return // allowlist: everything else goes straight to the network
  e.respondWith((async () => {
    const key = isNav ? new URL('./', scope).href : req
    try {
      const res = await fetch(req)
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(key, copy)) }
      return res
    } catch {
      const hit = await caches.match(key)
      return hit ?? Response.error()
    }
  })())
})

self.addEventListener('push', e => {
  let d = {}
  try { d = e.data?.json() ?? {} } catch { d = { body: e.data?.text() } }
  // iOS revokes push if a push does not end in a notification.
  e.waitUntil((async () => {
    await self.registration.showNotification(d.title || 'Bebop', {
      body: d.body || '',
      tag: d.tag || (d.thread ? `thread-${d.thread}` : 'general'),
      renotify: true,
      icon: 'icons/icon-192.png',
      badge: 'icons/icon-192.png',
      data: { thread: d.thread ?? null, id: d.id ?? null, pane: d.pane ?? null },
    })
    if (self.navigator?.setAppBadge) self.navigator.setAppBadge().catch(() => {})
  })())
})

self.addEventListener('notificationclick', e => {
  e.notification.close()
  const { thread, id, pane } = e.notification.data || {}
  e.waitUntil((async () => {
    const all = await clients.matchAll({ type: 'window', includeUncontrolled: true })
    const win = all.find(c => new URL(c.url).pathname.startsWith(scope.pathname))
    if (win) {
      await win.focus()
      win.postMessage(pane ? { type: 'open-pane', pane } : { type: 'open', thread, id })
      return
    }
    const u = new URL('./', scope)
    if (pane) u.searchParams.set('pane', pane) // a session waiting for an answer (v0.6)
    if (thread) u.searchParams.set('thread', thread)
    if (id) u.hash = `m${id}`
    await clients.openWindow(u.href)
  })())
})
