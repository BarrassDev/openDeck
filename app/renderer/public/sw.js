// OpenDeck service worker: makes the remote control surface installable and
// lets it open instantly from the home screen. Network-first so UI updates
// land immediately; the cache is only a fallback while the desktop app is down.
const CACHE = "opendeck-v2"

self.addEventListener("install", () => {
    self.skipWaiting()
})

self.addEventListener("activate", (event) => {
    event.waitUntil((async () => {
        const keys = await caches.keys()
        await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
        await self.clients.claim()
    })())
})

self.addEventListener("fetch", (event) => {
    const req = event.request
    if (req.method !== "GET") return
    const url = new URL(req.url)
    if (url.origin !== self.location.origin) return
    if (url.pathname.startsWith("/api/")) return

    event.respondWith((async () => {
        try {
            const res = await fetch(req)
            if (res.ok) {
                const copy = res.clone()
                caches.open(CACHE).then(c => c.put(req, copy)).catch(() => { })
            }
            return res
        } catch (err) {
            const cached = await caches.match(req)
            if (cached) return cached
            if (req.mode === "navigate") {
                const index = await caches.match("./") || await caches.match("/index.html")
                if (index) return index
            }
            throw err
        }
    })())
})
