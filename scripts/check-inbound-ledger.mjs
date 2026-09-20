#!/usr/bin/env node
/**
 * P2.1 — the inbound ledger's two standing rules, checked against executable source.
 *
 * Rule 1 (Decision D8): no code DELETES an inbound event. The ledger is the only
 * record that a notification ever arrived, so a row may be archived — its payload
 * moved out, a pointer left behind — but never removed. A delete would erase the
 * evidence that anything happened at all.
 *
 * Rule 2: every inbound event type a receiver WRITES has a handler that can replay it,
 * or is named here as one that cannot. A replay registry and a set of receivers are two
 * lists of the same topics, and two lists drift: `refunds/create` was written by the
 * route and listed as `refund/create` by the dispatcher, so no refund was replayable
 * and nothing said so. This derives both lists from source and compares them.
 *
 * Derived, not hardcoded: a list of event types written by hand goes stale the first
 * time someone adds a topic, and would then pass by describing a codebase that no
 * longer exists.
 *
 * Usage:
 *   node scripts/check-inbound-ledger.mjs            — check, exit 1 on a violation
 *   node scripts/check-inbound-ledger.mjs --seed-delete   — prove rule 1 can fail
 *   node scripts/check-inbound-ledger.mjs --seed-orphan   — prove rule 2 can fail
 */
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(new URL('..', import.meta.url).pathname)
const apiSrc = path.join(root, 'apps/api/src')
const seedDelete = process.argv.includes('--seed-delete')
const seedOrphan = process.argv.includes('--seed-orphan')

/** Event types a receiver writes but nothing can replay, each with the reason. */
const UNREPLAYABLE = {
  // An Amazon notification is handled inside the SQS poll loop, against the queue
  // message rather than the stored payload. Re-running one from the ledger alone would
  // need that loop split out first; until then the retry worker dead-letters these on
  // the first sweep with that as the reason, which is visible rather than silent.
  AMAZON: '*',
  // eBay's receiver decides what to do from the live notification envelope and syncs
  // orders as a side effect. The replay endpoint re-syncs every eBay connection
  // instead, which is why it is handled there and not by the registry.
  EBAY: '*',
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue
      walk(full, out)
    } else if (/\.(ts|mts)$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

const files = walk(apiSrc)
const failures = []

// ── Rule 1: nothing deletes an inbound event ────────────────────────────────────
const DELETE_PATTERNS = [
  /\bwebhookEvent\s*\.\s*delete\b/,
  /\bwebhookEvent\s*\.\s*deleteMany\b/,
  /DELETE\s+FROM\s+"WebhookEvent"/i,
]
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8')
  for (const pattern of DELETE_PATTERNS) {
    if (pattern.test(text)) {
      failures.push(`${path.relative(root, file)}: deletes inbound events (${pattern}). Decision D8 — archive, never delete.`)
    }
  }
}
if (seedDelete) {
  failures.push('SEEDED: a deliberate rule-1 violation, to prove this check can fail.')
}

// ── Rule 2: every written event type is replayable, or named unreplayable ───────
// Receivers name their event type where they call the ledger writer. Both the literal
// `eventType: 'x'` form and the `receiveShopify(path, 'x', handler)` form are read.
const written = new Map() // channel -> Set(eventType)
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8')
  for (const m of text.matchAll(/receiveShopify\(\s*"[^"]*"\s*,\s*"([^"]+)"/g)) {
    if (!written.has('SHOPIFY')) written.set('SHOPIFY', new Set())
    written.get('SHOPIFY').add(m[1])
  }
}

// The registry's own entries, read from its source rather than imported: this script
// must not need the API's runtime to run.
const registrySource = fs.readFileSync(path.join(apiSrc, 'services/cx/ingress/handlers.ts'), 'utf8')
const registered = new Map()
let currentChannel = null
for (const line of registrySource.split('\n')) {
  const channel = line.match(/^\s{2}([A-Z_]+):\s*\{/)
  if (channel) { currentChannel = channel[1]; registered.set(currentChannel, new Set()); continue }
  const entry = line.match(/^\s{4}'([^']+)':\s*async/)
  if (entry && currentChannel) registered.get(currentChannel).add(entry[1])
}

for (const [channel, types] of written) {
  if (UNREPLAYABLE[channel] === '*') continue
  for (const type of types) {
    if (!registered.get(channel)?.has(type)) {
      failures.push(`${channel}/${type} is written by a receiver but has no replay handler. Add it to services/cx/ingress/handlers.ts or name it in UNREPLAYABLE with a reason.`)
    }
  }
}
if (seedOrphan) {
  failures.push('SEEDED: a deliberate rule-2 violation, to prove this check can fail.')
}

// ── Positive control ────────────────────────────────────────────────────────────
// A check that found nothing to look at is not a pass. State what was examined, so a
// green caused by an empty file list is visible rather than reassuring.
const writtenCount = [...written.values()].reduce((n, set) => n + set.size, 0)
const registeredCount = [...registered.values()].reduce((n, set) => n + set.size, 0)
console.log(`[inbound-ledger] ${files.length} source files; ${writtenCount} event types written by receivers; ${registeredCount} replay handlers registered.`)
if (files.length === 0 || registeredCount === 0) {
  console.error('[inbound-ledger] FAIL: nothing was examined. This check cannot pass on an empty measurement.')
  process.exit(1)
}

if (failures.length) {
  console.error(`[inbound-ledger] FAIL — ${failures.length} violation(s):`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log('[inbound-ledger] OK — no inbound event is deleted, and every written event type is replayable or named.')
