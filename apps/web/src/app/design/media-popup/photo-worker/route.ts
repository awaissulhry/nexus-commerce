/**
 * /design/media-popup/photo-worker — the lab's service worker (Lane C). It draws the made-up photos the lab names
 * `https://lab-photos.nexus.invalid/<name>.svg?hue=<0-359>` — shapes only, no text (an SVG cannot use the page fonts) —
 * so the lab's photos look and check like real HTTPS photos without any network. Its scope is the lab page only.
 */
const WORKER = `
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()))
self.addEventListener('message', event => { if (event.data === 'claim') self.clients.claim() })
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url)
  if (url.hostname !== 'lab-photos.nexus.invalid') return
  const hue = Number(url.searchParams.get('hue')) || 0
  const body = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">'
    + '<rect width="400" height="400" fill="hsl(' + hue + ',20%,94%)"/>'
    + '<path d="M130 70 L170 50 Q200 80 230 50 L270 70 L330 130 L295 170 L270 150 L270 350 L130 350 L130 150 L105 170 L70 130 Z" fill="hsl(' + hue + ',45%,40%)"/>'
    + '<rect x="195" y="80" width="10" height="260" fill="hsl(' + hue + ',30%,25%)"/></svg>'
  event.respondWith(new Response(body, { headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' } }))
})
`

export function GET() {
  return new Response(WORKER, { headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'Service-Worker-Allowed': '/design/media-popup' } })
}
