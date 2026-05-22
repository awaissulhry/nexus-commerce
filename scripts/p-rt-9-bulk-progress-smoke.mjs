// P-RT.9 — end-to-end smoke for the bulk-progress SSE round-trip.
// Boots a minimal SSE server, publishes bulk.progress + bulk.completed
// events, asserts the wire frames a network consumer sees match what
// the BulkProgressBanner expects to render.
//
// Run:
//   tsx scripts/p-rt-9-bulk-progress-smoke.mjs
// Exit 0 = pass, 1 = bus or wire broken.

import http from 'node:http'
import {
  publishListingEvent,
  subscribeListingEvents,
} from '../apps/api/src/services/listing-events.service.ts'

// ── SSE server, lifted from production handler ──
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

// Simulate a bulk job's lifecycle: 3 progress ticks then a completion.
publishListingEvent({
  type: 'bulk.progress', jobId: 'bja_smoke_1',
  processed: 30, total: 100, succeeded: 30, failed: 0, ts: Date.now(),
})
publishListingEvent({
  type: 'bulk.progress', jobId: 'bja_smoke_1',
  processed: 60, total: 100, succeeded: 58, failed: 2, ts: Date.now() + 1,
})
publishListingEvent({
  type: 'bulk.progress', jobId: 'bja_smoke_1',
  processed: 100, total: 100, succeeded: 95, failed: 5, ts: Date.now() + 2,
})
publishListingEvent({
  type: 'bulk.completed', jobId: 'bja_smoke_1', status: 'PARTIALLY_COMPLETED', ts: Date.now() + 3,
})

await new Promise((r) => setTimeout(r, 300))
consumer.destroy()
server.close()

console.log('[smoke] captured frames:')
for (const f of captured) console.log('  ', f.type, JSON.stringify(f.data))

let ok = true
const progressFrames = captured.filter((f) => f.type === 'bulk.progress')
const completedFrames = captured.filter((f) => f.type === 'bulk.completed')

if (progressFrames.length !== 3) {
  console.error(`[smoke] FAIL — expected 3 progress frames, got ${progressFrames.length}`)
  ok = false
}
if (completedFrames.length !== 1) {
  console.error(`[smoke] FAIL — expected 1 completed frame, got ${completedFrames.length}`)
  ok = false
}
// Verify ordering: progress count should be monotonic per ts.
const processedValues = progressFrames.map((f) => f.data.processed)
const sorted = [...processedValues].sort((a, b) => a - b)
if (JSON.stringify(processedValues) !== JSON.stringify(sorted)) {
  console.error(`[smoke] FAIL — progress not monotonic: ${processedValues}`)
  ok = false
}
// Verify final completed frame carries the right status.
if (completedFrames[0]?.data.status !== 'PARTIALLY_COMPLETED') {
  console.error(`[smoke] FAIL — completed status mismatch: ${completedFrames[0]?.data.status}`)
  ok = false
}

if (ok) {
  console.log('[smoke] PASS — bulk.progress + bulk.completed round-trip works')
  process.exit(0)
} else {
  process.exit(1)
}
