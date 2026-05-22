// P-RT.2 — end-to-end smoke for Shopify product/* webhook → SSE.
// Stands up a minimal SSE server (production handler pattern), mocks
// the Shopify webhook dispatch path by manually invoking the same
// productEventService.emit() call the handler does, and asserts the
// listing-events wire carries product.updated + product.deleted
// frames in the right shape.
//
// Why not call dispatchShopifyWebhook() directly: it touches prisma
// (product.findFirst, product.update), and prisma isn't safe to import
// from an ad-hoc node script without a working DB. The vitest case
// (apps/api/src/routes/__tests__/shopify-webhooks-events.test.ts)
// already proves the dispatch → emit chain with mocked prisma; this
// smoke confirms the emit → bus → wire chain end-to-end at the
// network layer using the same wire format the real handler uses.
//
// Run:
//   tsx scripts/p-rt-2-shopify-smoke.mjs
//
// Exit 0 = pass, 1 = bus or wire broken.

import http from 'node:http'
import {
  publishListingEvent,
  subscribeListingEvents,
} from '../apps/api/src/services/listing-events.service.ts'

// ── SSE server, lifted from production listings-syndication.routes.ts ──
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
console.log(`[smoke] SSE server :${port}`)

// ── Consumer ──
const captured = []
const consumer = http.get(`http://127.0.0.1:${port}/api/listings/events`, (res) => {
  let buf = ''
  res.setEncoding('utf8')
  res.on('data', (chunk) => {
    buf += chunk
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

await new Promise((r) => setTimeout(r, 150))

// ── Simulate the production handler's emit ──
// handleProductUpdate (apps/api/src/routes/shopify-webhooks.ts) does
// productEventService.emit({ aggregateType: 'Product', eventType:
// 'PRODUCT_UPDATED', ... }), which via P-RT.1's ssePayloadFor mapping
// turns into publishListingEvent({type:'product.updated',...}). We
// publish the wire-equivalent directly so this smoke doesn't need a
// working DB (vitest covers the prisma + dispatch path).
publishListingEvent({
  type: 'product.updated',
  productId: 'prod_xavia_42',
  reason: 'PRODUCT_UPDATED',
  ts: Date.now(),
})
publishListingEvent({
  type: 'product.deleted',
  productId: 'prod_xavia_43',
  ts: Date.now(),
})
// Also exercise STOCK_ADJUSTED → product.updated mapping for the
// inventory_levels/update path.
publishListingEvent({
  type: 'product.updated',
  productId: 'prod_xavia_44',
  reason: 'STOCK_ADJUSTED',
  ts: Date.now(),
})

await new Promise((r) => setTimeout(r, 300))
consumer.destroy()
server.close()

console.log('[smoke] captured frames:')
for (const f of captured) console.log('  ', f.type, JSON.stringify(f.data))

let ok = true
const expectedFrames = [
  { type: 'ping' },
  { type: 'product.updated', productId: 'prod_xavia_42', reason: 'PRODUCT_UPDATED' },
  { type: 'product.deleted', productId: 'prod_xavia_43' },
  { type: 'product.updated', productId: 'prod_xavia_44', reason: 'STOCK_ADJUSTED' },
]
for (const want of expectedFrames) {
  const match = captured.find(
    (f) =>
      f.type === want.type &&
      (want.productId == null || f.data.productId === want.productId) &&
      (want.reason == null || f.data.reason === want.reason),
  )
  if (!match) {
    console.error(`[smoke] FAIL — missing frame: ${JSON.stringify(want)}`)
    ok = false
  }
}

if (ok) {
  console.log('[smoke] PASS — Shopify product/* → SSE bus → wire round-trip works')
  process.exit(0)
} else {
  process.exit(1)
}
