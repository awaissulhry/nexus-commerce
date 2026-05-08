#!/usr/bin/env node
/**
 * S.13 verification — transfers + reservations sub-routes exist,
 * backend endpoints are wired, catalog parity holds, links from the
 * main stock workspace surface them.
 */

import { fileURLToPath } from 'url'
import path from 'path'
import fs from 'fs'

const here = path.dirname(fileURLToPath(import.meta.url))
const en = JSON.parse(fs.readFileSync(path.join(here, '..', 'apps/web/src/lib/i18n/messages/en.json'), 'utf8'))
const it = JSON.parse(fs.readFileSync(path.join(here, '..', 'apps/web/src/lib/i18n/messages/it.json'), 'utf8'))
const stockRoutes = fs.readFileSync(path.join(here, '..', 'apps/api/src/routes/stock.routes.ts'), 'utf8')
const stockWorkspace = fs.readFileSync(path.join(here, '..', 'apps/web/src/app/fulfillment/stock/StockWorkspace.tsx'), 'utf8') + '\n' + fs.readFileSync(path.join(here, '..', 'apps/web/src/components/inventory/StockSubNav.tsx'), 'utf8')

let pass = 0
let fail = 0
const failures = []
function ok(label) { pass++; console.log(`✓ ${label}`) }
function bad(label, detail) {
  fail++
  failures.push({ label, detail })
  console.log(`✗ ${label}${detail ? ` — ${detail}` : ''}`)
}

// 1. New API endpoints registered
if (/fastify\.get\('\/stock\/transfers'/.test(stockRoutes)) ok('GET /api/stock/transfers registered')
else bad('GET /api/stock/transfers registered')
if (/fastify\.get\('\/stock\/reservations'/.test(stockRoutes)) ok('GET /api/stock/reservations registered')
else bad('GET /api/stock/reservations registered')

// 2. Frontend pages exist
const transfersPage = path.join(here, '..', 'apps/web/src/app/fulfillment/stock/transfers/page.tsx')
const transfersClient = path.join(here, '..', 'apps/web/src/app/fulfillment/stock/transfers/TransfersClient.tsx')
const reservationsPage = path.join(here, '..', 'apps/web/src/app/fulfillment/stock/reservations/page.tsx')
const reservationsClient = path.join(here, '..', 'apps/web/src/app/fulfillment/stock/reservations/ReservationsClient.tsx')
if (fs.existsSync(transfersPage)) ok('transfers/page.tsx exists')
else bad('transfers/page.tsx exists')
if (fs.existsSync(transfersClient)) ok('transfers/TransfersClient.tsx exists')
else bad('transfers/TransfersClient.tsx exists')
if (fs.existsSync(reservationsPage)) ok('reservations/page.tsx exists')
else bad('reservations/page.tsx exists')
if (fs.existsSync(reservationsClient)) ok('reservations/ReservationsClient.tsx exists')
else bad('reservations/ReservationsClient.tsx exists')

// 3. Both clients hit the right endpoints
const transfersSrc = fs.readFileSync(transfersClient, 'utf8')
const reservationsSrc = fs.readFileSync(reservationsClient, 'utf8')
if (/api\/stock\/transfers/.test(transfersSrc)) ok('TransfersClient calls /api/stock/transfers')
else bad('TransfersClient calls /api/stock/transfers')
if (/api\/stock\/reservations/.test(reservationsSrc)) ok('ReservationsClient calls /api/stock/reservations')
else bad('ReservationsClient calls /api/stock/reservations')

// 4. ReservationsClient has TTL countdown and release button
if (/formatTtl|ttlMs/.test(reservationsSrc)) ok('ReservationsClient renders TTL countdown')
else bad('ReservationsClient renders TTL countdown')
if (/api\/stock\/release/.test(reservationsSrc)) ok('ReservationsClient wires release endpoint')
else bad('ReservationsClient wires release endpoint')

// 5. Status filter (active/consumed/released/all)
if (/FILTER_OPTIONS/.test(reservationsSrc) && /active.*consumed.*released/s.test(reservationsSrc)) {
  ok('ReservationsClient has 4-way status filter')
} else {
  bad('ReservationsClient has 4-way status filter')
}

// 6. Stock workspace links to both
if (/\/fulfillment\/stock\/transfers/.test(stockWorkspace)) ok('StockWorkspace links to /transfers')
else bad('StockWorkspace links to /transfers')
if (/\/fulfillment\/stock\/reservations/.test(stockWorkspace)) ok('StockWorkspace links to /reservations')
else bad('StockWorkspace links to /reservations')

// 7. Catalog parity for new keys
const newKeys = [
  'stock.transfers.title', 'stock.transfers.description',
  'stock.transfers.empty.title', 'stock.transfers.col.product',
  'stock.transfers.col.from', 'stock.transfers.col.to',
  'stock.transfers.status.completed', 'stock.transfers.status.inTransit',
  'stock.reservations.title', 'stock.reservations.description',
  'stock.reservations.filter.active', 'stock.reservations.filter.consumed',
  'stock.reservations.status.active', 'stock.reservations.status.consumed',
  'stock.reservations.status.released', 'stock.reservations.status.expired',
  'stock.drawer.release', 'stock.drawer.releaseConfirm',
]
for (const k of newKeys) {
  if (en[k]) ok(`en.json has ${k}`)
  else bad(`en.json has ${k}`)
  if (it[k]) ok(`it.json has ${k}`)
  else bad(`it.json has ${k}`)
  if (en[k] && it[k] && en[k] === it[k] && !['Status'].includes(en[k])) {
    bad(`${k} translated (en=${en[k]}, it=${it[k]})`)
  }
}

console.log()
console.log(`[S.13 verify] ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log()
  for (const f of failures) console.log(`  ✗ ${f.label}${f.detail ? ` — ${f.detail}` : ''}`)
  process.exit(1)
}
process.exit(0)
