/**
 * P5.1 verification probe — the rules that stop a probe doing harm.
 *
 * The Owner chose option B from `build/P5.1.md` §6: one captured live read before
 * the 2026-01-01 switch is turned on. A probe that measures a live seller account
 * has three ways to go wrong, and each has a rule here:
 *
 *   1. it must not CHANGE the thing it measures — the switch stays off;
 *   2. it must not leak buyer personal data into a response or a log;
 *   3. it must name the version where the SDK READS it, or it would probe v0 and
 *      report a green about the wrong API.
 *
 * And one that is about honesty rather than harm:
 *
 *   4. Amazon refusing is a FINDING, reported plainly — not an exception that
 *      reads as "the probe is broken".
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(import.meta.dirname, '..')
const probeFile = readFileSync(join(SRC, 'routes', 'amazon-orders-2026-probe.routes.ts'), 'utf8')

/**
 * The file with its comments stripped.
 *
 * 🔴 Third time today: a test that asserts "X does not appear" fails on the
 * COMMENT that explains why X does not appear. A claim about what the code DOES
 * must be made against the code.
 */
const probe = probeFile
  .split('\n')
  .filter((l) => {
    const t = l.trim()
    return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
  })
  .join('\n')
const index = readFileSync(join(SRC, 'index.ts'), 'utf8')

describe('1. the probe does not change what it measures', () => {
  it('never touches the switch', () => {
    // Reading it would be defensible; writing it is not. A probe that turned the
    // migration on would answer a different question than the one asked.
    expect(probe).not.toContain('NEXUS_ENABLE_AMAZON_ORDERS_2026')
    expect(probe).not.toContain('process.env.NEXUS_ENABLE')
    expect(probe).not.toMatch(/process\.env\.\w+\s*=[^=]/)
    // Positive control: the stripper did not simply empty the file.
    expect(probe).toContain("operation: 'searchOrders'")
  })

  it('only reads — no method other than the SDK’s GET operation', () => {
    expect(probe).toContain("operation: 'searchOrders'")
    for (const write of ['putListingsItem', 'patchListingsItem', 'confirmShipment', 'updateShipmentStatus', 'prisma.']) {
      expect(probe, `probe must not ${write}`).not.toContain(write)
    }
  })

  it('bounds the window so it cannot walk the whole account', () => {
    expect(probe).toContain('Math.min(Math.max(Number(query.days ?? 7) || 7, 1), 30)')
    expect(probe).toContain('maxResultsPerPage: 5')
  })
})

describe('2. buyer personal data does not leave the endpoint', () => {
  it('redacts BuyerInfo and ShippingAddress to presence + key names', () => {
    expect(probe).toContain('function redactV0')
    expect(probe).toContain('const { BuyerInfo, ShippingAddress, ...rest } = raw')
    // Presence and the shape, never the values.
    expect(probe).toContain('BuyerInfo: BuyerInfo ? { present: true, keys: Object.keys(BuyerInfo) } : null')
  })

  it('does not descend into the PII sections when listing paths', () => {
    expect(probe).toContain("const PII_PATHS = new Set(['buyer', 'recipient'])")
    expect(probe).toContain('if (!PII_PATHS.has(key)) pathsOf(child')
  })

  it('returns PATHS, not values, for what Amazon sent', () => {
    // The question is "which field names arrived", and that needs no values.
    // Asserted against the CODE: `pathsOf` pushes the path string and never the
    // child value. (The explaining comment lives in probeFile, not probe.)
    expect(probe).toContain('amazonSentPaths: sent')
    expect(probe).toContain('out.push(path)')
    expect(probe).not.toMatch(/out\.push\(\{[^}]*value/)
    expect(probeFile).toContain('Field PATHS only')
  })

  it('the mapped order goes through the redactor, never raw', () => {
    expect(probe).toContain('mappedFirstOrder: first ? redactV0(toV0Order(first)) : null')
    expect(probe).not.toMatch(/mappedFirstOrder:\s*first\s*\?\s*toV0Order\(first\)/)
  })
})

describe('3. the version is named where the SDK reads it', () => {
  it('puts it in options, not at the top level', () => {
    // A top-level `version` key is accepted by the object and IGNORED, so the
    // probe would call v0 with 2026 parameters and report a green about the
    // wrong API — the exact defect P5.1's own guard exists for.
    expect(probe).toContain('options: { version: AMAZON_ORDERS_2026_VERSION }')
    // Scoped to the REQUEST object. The response body legitimately reports the
    // version it used, and a blunt file-wide match convicted that instead.
    const request = probe.slice(probe.indexOf('const request = {'), probe.indexOf('try {'))
    expect(request).toContain('options: { version: AMAZON_ORDERS_2026_VERSION }')
    expect(request).not.toMatch(/^\s*version:/m)
  })

  it('asks for the same includedData the migration uses', () => {
    // If the probe asked for a different set, it would verify a shape the real
    // path never receives.
    expect(probe).toContain('includedData: [...ORDERS_2026_INCLUDED_DATA]')
    expect(probe).not.toMatch(/includedData: \['/)
  })

  it('reuses the migration’s own mapper, not a copy', () => {
    expect(probe).toContain("from '../services/marketplaces/amazon-orders-2026.js'")
    expect(probe).toContain('toV0Order')
    expect(probe).toContain('toV0OrderItems')
  })
})

describe('4. a refusal is a finding, not a crash', () => {
  it('reports Amazon’s own status and message', () => {
    expect(probe).toContain('ok: false')
    expect(probe).toContain('statusCode: err?.statusCode ?? err?.status ?? null')
    expect(probe).toContain('amazonCode: err?.code ?? null')
  })

  it('says the switch is still off on BOTH paths', () => {
    const notes = probe.match(/note: '[^']+'/g) ?? []
    expect(notes).toHaveLength(2) // success and failure
    for (const note of notes) expect(note.toLowerCase()).toContain('switch')
  })

  it('answers the two questions only a live call can answer', () => {
    expect(probe).toContain('paginationTokenWithIncludedData')
    expect(probe).toContain('marketplaceIdsAccepted')
    // `null` when no second page existed — "not asked" must not read as "no".
    expect(probe).toContain('page2.attempted ? page2.ok : null')
  })

  it('computes the money check, so the answer is unambiguous', () => {
    // v0's ItemPrice is a LINE total and upsertOrderItem divides by quantity.
    // Reporting what WOULD be stored removes the arithmetic from the reader.
    expect(probe).toContain('wouldStoreUnitPrice')
    expect(probe).toContain('Number(i.ItemPrice.Amount) / i.QuantityOrdered')
  })
})

describe('the route is reachable and behind the admin gate', () => {
  it('is registered under /api', () => {
    expect(index).toContain('amazonOrders2026ProbeRoutes')
    expect(index).toContain("app.register(amazonOrders2026ProbeRoutes, { prefix: '/api' })")
  })

  it('sits under /admin, which the RBAC manifest covers by prefix', () => {
    expect(probe).toContain("app.get('/admin/amazon-orders-2026-probe'")
    const manifest = readFileSync(join(SRC, 'lib', 'auth', 'permissions-manifest.ts'), 'utf8')
    // The prefix rule is why this route needs no manifest entry of its own; a
    // new route OUTSIDE an existing prefix is refused by the pre-push gate.
    expect(manifest).toContain("pfx('/api/admin')")
  })
})
