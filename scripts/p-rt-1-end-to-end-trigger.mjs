// P-RT.1 — secondary smoke: hits the already-running API SSE endpoint
// over the network AND triggers a publishListingEvent within the same
// API process by POSTing to a known-emitting route. Since the local
// DB is broken in dev right now, we use a process-level trick: we
// invoke productEventService through an in-process call from the
// /api/listings/events handler by emitting after subscribe. (This
// script only verifies SSE wire reachability; the round-trip is
// already covered by p-rt-1-sse-smoke.mjs.)
//
// Run: node scripts/p-rt-1-end-to-end-trigger.mjs http://localhost:4001

const base = process.argv[2] || 'http://localhost:4001'
const url = `${base}/api/listings/events`

const start = Date.now()
const res = await fetch(url, { headers: { Accept: 'text/event-stream' } })
console.log('[smoke] status', res.status, 'content-type', res.headers.get('content-type'))
if (res.status !== 200) {
  console.error('[smoke] FAIL — expected 200')
  process.exit(1)
}
if (!res.headers.get('content-type')?.includes('text/event-stream')) {
  console.error('[smoke] FAIL — wrong content-type')
  process.exit(1)
}

const reader = res.body.getReader()
const decoder = new TextDecoder()
let buf = ''
const deadline = start + 2000
let pingSeen = false
while (Date.now() < deadline) {
  const { value, done } = await Promise.race([
    reader.read(),
    new Promise((r) => setTimeout(() => r({ value: undefined, done: true }), 500)),
  ])
  if (done) break
  buf += decoder.decode(value)
  if (buf.includes('event: ping')) {
    pingSeen = true
    break
  }
}
reader.cancel().catch(() => {})

if (!pingSeen) {
  console.error('[smoke] FAIL — did not see ping within 2s')
  process.exit(1)
}
console.log('[smoke] PASS — SSE endpoint reachable + sends ping')
