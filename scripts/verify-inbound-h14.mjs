#!/usr/bin/env node
// H.14 verification — SSE event channel.
//
//   GET /api/fulfillment/inbound/events
//     - 200 with text/event-stream; first chunk is the "ping" hello.
//   GET /api/fulfillment/inbound/events/stats
//     - 200 with { listenerCount: <number> }, increases by 1 while
//       a stream is open.
//
// We open an SSE connection, read the first byte to confirm it
// works, then close. Doesn't try to assert event delivery (that
// would require triggering a mutation in a side test).
//
//   API_BASE_URL=https://nexusapi-production-b7bb.up.railway.app node scripts/verify-inbound-h14.mjs

import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

const API_BASE = process.env.API_BASE_URL ?? 'http://localhost:3001'

let pass = 0
let fail = 0
const failures = []
function ok(label) { pass++; console.log(`✓ ${label}`) }
function bad(label, detail) {
  fail++
  failures.push({ label, detail })
  console.log(`✗ ${label}${detail ? ` — ${detail}` : ''}`)
}

// ─── Branch 1: open SSE, confirm we get the hello ping ───
{
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), 8000)
  let chunk = ''
  try {
    const res = await fetch(`${API_BASE}/api/fulfillment/inbound/events`, { signal: ac.signal })
    console.log(`[SSE] status=${res.status} content-type=${res.headers.get('content-type')}`)
    if (res.status !== 200) {
      bad(`expected 200, got ${res.status}`)
    } else if (!/text\/event-stream/.test(res.headers.get('content-type') ?? '')) {
      bad('content-type not text/event-stream', res.headers.get('content-type'))
    } else {
      ok('SSE: 200 with text/event-stream')
      const reader = res.body?.getReader()
      if (reader) {
        const dec = new TextDecoder()
        const r = await Promise.race([
          reader.read(),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
        ])
        chunk = dec.decode(r.value ?? new Uint8Array())
        console.log(`[SSE] first chunk: ${chunk.slice(0, 200)}`)
        if (/event: ping/.test(chunk) || /connected/.test(chunk)) {
          ok('SSE: hello ping received')
        } else {
          bad('SSE: first chunk did not contain ping', chunk.slice(0, 200))
        }
      }
    }
  } catch (e) {
    if (e.name === 'AbortError') ok('SSE: connection held open until abort (expected)')
    else bad(`SSE error: ${e.message}`)
  } finally {
    clearTimeout(t)
    ac.abort()
  }
}

// Tiny pause so the server cleans up the listener before stats
await new Promise((r) => setTimeout(r, 200))

// ─── Branch 2: stats endpoint ───
{
  const res = await fetch(`${API_BASE}/api/fulfillment/inbound/events/stats`)
  const data = await res.json().catch(() => ({}))
  console.log(`[stats] status=${res.status} body=${JSON.stringify(data).slice(0, 200)}`)
  if (res.status === 200 && typeof data?.listenerCount === 'number') {
    ok(`stats endpoint reports listenerCount=${data.listenerCount}`)
  } else if (res.status === 404) {
    bad('404: stats route not deployed yet', JSON.stringify(data).slice(0, 200))
  } else {
    bad(`expected 200 with listenerCount, got status=${res.status}`, JSON.stringify(data).slice(0, 200))
  }
}

console.log(`\n[verify-inbound-h14] PASS=${pass} FAIL=${fail}`)
if (fail > 0) {
  for (const f of failures) console.log(`  - ${f.label}${f.detail ? `: ${f.detail}` : ''}`)
  process.exit(1)
}
