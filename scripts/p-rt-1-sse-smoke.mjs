// P-RT.1 — end-to-end smoke proving product.* events flow through the
// listing-events SSE bus and reach a network consumer. Does not touch
// Prisma or any DB — boots a tiny http server with just the SSE route
// (mirroring the production handler at apps/api/src/routes/
// listings-syndication.routes.ts:2735), publishes events via the same
// in-process bus productEventService writes to, captures the SSE
// frames a curl-style consumer sees, and asserts the wire format.
//
// Run:
//   node --experimental-vm-modules scripts/p-rt-1-sse-smoke.mjs
//   tsx scripts/p-rt-1-sse-smoke.mjs      (also works)
//
// Exit 0 = all assertions passed.
// Exit 1 = bus or wire format broken.

import http from 'node:http'
import {
  publishListingEvent,
  subscribeListingEvents,
} from '../apps/api/src/services/listing-events.service.ts'

// ── 1. Minimal SSE server, lifted from the production handler ──
const server = http.createServer((req, res) => {
  if (req.url !== '/api/listings/events') {
    res.writeHead(404).end()
    return
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.write(`event: ping\ndata: ${JSON.stringify({ ts: Date.now(), connected: true })}\n\n`)
  const send = (event) => {
    try {
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    } catch {}
  }
  const unsubscribe = subscribeListingEvents(send)
  req.on('close', unsubscribe)
})

await new Promise((r) => server.listen(0, r))
const port = server.address().port
console.log(`[smoke] SSE server listening on :${port}`)

// ── 2. Consumer: read frames for ~1s ──
const captured = []
const consumer = http.get(`http://127.0.0.1:${port}/api/listings/events`, (res) => {
  let buf = ''
  res.setEncoding('utf8')
  res.on('data', (chunk) => {
    buf += chunk
    // Frames are separated by \n\n. Parse complete frames as we go.
    let idx
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      const lines = frame.split('\n')
      const type = lines.find((l) => l.startsWith('event: '))?.slice(7)
      const data = lines.find((l) => l.startsWith('data: '))?.slice(6)
      if (type && data) captured.push({ type, data: JSON.parse(data) })
    }
  })
})

// ── 3. Publish events through the same in-process bus that
//        productEventService.emit() writes to (P-RT.1 wiring) ──
await new Promise((r) => setTimeout(r, 150))  // wait for SSE to subscribe
publishListingEvent({ type: 'product.updated', productId: 'p_smoke_1', reason: 'PRICE_CHANGED', ts: Date.now() })
publishListingEvent({ type: 'product.created', productId: 'p_smoke_2', ts: Date.now() })
publishListingEvent({ type: 'product.deleted', productId: 'p_smoke_3', ts: Date.now() })

// ── 4. Drain ──
await new Promise((r) => setTimeout(r, 300))
consumer.destroy()
server.close()

// ── 5. Assertions ──
const types = captured.map((f) => f.type)
const expected = ['ping', 'product.updated', 'product.created', 'product.deleted']
console.log('[smoke] captured frames:')
for (const f of captured) console.log('  ', f.type, JSON.stringify(f.data))

let ok = true
for (const t of expected) {
  if (!types.includes(t)) {
    console.error(`[smoke] FAIL — missing event: ${t}`)
    ok = false
  }
}
const updated = captured.find((f) => f.type === 'product.updated')
if (updated && updated.data.productId !== 'p_smoke_1') {
  console.error('[smoke] FAIL — product.updated has wrong productId:', updated.data.productId)
  ok = false
}
if (updated && updated.data.reason !== 'PRICE_CHANGED') {
  console.error('[smoke] FAIL — product.updated has wrong reason:', updated.data.reason)
  ok = false
}

if (ok) {
  console.log('[smoke] PASS — SSE bus → wire → consumer round-trip works for all product.* events')
  process.exit(0)
} else {
  process.exit(1)
}
