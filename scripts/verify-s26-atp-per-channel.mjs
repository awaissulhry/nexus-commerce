#!/usr/bin/env node
/**
 * S.26 verification — per-channel ATP visualization.
 */

import { fileURLToPath } from 'url'
import path from 'path'
import fs from 'fs'

const here = path.dirname(fileURLToPath(import.meta.url))
const en = JSON.parse(fs.readFileSync(path.join(here, '..', 'apps/web/src/lib/i18n/messages/en.json'), 'utf8'))
const it = JSON.parse(fs.readFileSync(path.join(here, '..', 'apps/web/src/lib/i18n/messages/it.json'), 'utf8'))
const atpChannel = fs.readFileSync(path.join(here, '..', 'apps/api/src/services/atp-channel.service.ts'), 'utf8')
const stockRoutes = fs.readFileSync(path.join(here, '..', 'apps/api/src/routes/stock.routes.ts'), 'utf8')
const stockWorkspace = fs.readFileSync(path.join(here, '..', 'apps/web/src/app/fulfillment/stock/StockWorkspace.tsx'), 'utf8')

let pass = 0
let fail = 0
const failures = []
function ok(label) { pass++; console.log(`✓ ${label}`) }
function bad(label, detail) {
  fail++
  failures.push({ label, detail })
  console.log(`✗ ${label}${detail ? ` — ${detail}` : ''}`)
}

// 1. Service export
if (/export async function resolveAtpAcrossChannels/.test(atpChannel)) {
  ok('service exports resolveAtpAcrossChannels')
} else {
  bad('service exports resolveAtpAcrossChannels')
}

// 2. ChannelAtpRow interface present
if (/export interface ChannelAtpRow/.test(atpChannel)) {
  ok('service exports ChannelAtpRow type')
} else {
  bad('service exports ChannelAtpRow type')
}

// 3. Available formula: max(0, onHand - reserved - buffer)
if (/Math\.max\(0,\s*onHand\s*-\s*reservedForChannel\s*-\s*buffer\)/.test(atpChannel)) {
  ok('available = max(0, onHand − reserved − buffer)')
} else {
  bad('available = max(0, onHand − reserved − buffer)')
}

// 4. Drift = available − channelQuantity
if (/drift = l\.quantity == null \? null : available - l\.quantity/.test(atpChannel)) {
  ok('drift = available − channelQuantity (null when channel hasn\'t reported)')
} else {
  bad('drift = available − channelQuantity')
}

// 5. Reservations attributed via Order.channel
if (/channelByOrderId/.test(atpChannel) && /reservedByChannel/.test(atpChannel)) {
  ok('reservations attributed to channel via Order.channel join')
} else {
  bad('reservations attributed to channel via Order.channel join')
}

// 6. Drawer route includes atpPerChannel
if (/atpPerChannel:\s*atp \?\s*await resolveAtpAcrossChannels\(\{/.test(stockRoutes)) {
  ok('drawer bundle includes atpPerChannel')
} else {
  bad('drawer bundle includes atpPerChannel')
}

// 7. Frontend renders the breakdown
if (/bundle\.atpPerChannel\?\.find/.test(stockWorkspace)) {
  ok('drawer matches per-listing ATP row')
} else {
  bad('drawer matches per-listing ATP row')
}
if (/atp\.onHand/.test(stockWorkspace)
    && /atp\.reservedForChannel/.test(stockWorkspace)
    && /atp\.stockBuffer/.test(stockWorkspace)
    && /atp\.available/.test(stockWorkspace)) {
  ok('drawer renders onHand / reserved / buffer / available')
} else {
  bad('drawer renders onHand / reserved / buffer / available')
}
if (/atp\.drift != null && atp\.drift !== 0/.test(stockWorkspace)) {
  ok('drawer renders drift indicator when nonzero')
} else {
  bad('drawer renders drift indicator when nonzero')
}

// 8. Catalog parity
const newKeys = [
  'stock.atpPerChannel.onHand',
  'stock.atpPerChannel.reserved',
  'stock.atpPerChannel.buffer',
  'stock.atpPerChannel.available',
  'stock.atpPerChannel.drift',
]
for (const k of newKeys) {
  if (en[k]) ok(`en.json has ${k}`)
  else bad(`en.json has ${k}`)
  if (it[k]) ok(`it.json has ${k}`)
  else bad(`it.json has ${k}`)
  if (en[k] && it[k] && en[k] === it[k] && k !== 'stock.atpPerChannel.buffer') {
    bad(`${k} translated`)
  }
}

console.log()
console.log(`[S.26 verify] ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log()
  for (const f of failures) console.log(`  ✗ ${f.label}${f.detail ? ` — ${f.detail}` : ''}`)
  process.exit(1)
}
process.exit(0)
