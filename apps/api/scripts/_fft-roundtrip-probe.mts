/**
 * FFT.0 — flat-file round-trip battery (the program's regression proof).
 *
 * Exercises the REAL route handlers (Fastify inject, prod DB) on a throwaway
 * FFT-SCRATCH-* family — the same harness pattern as _ffp1-verify.mts. No
 * platform writes: EBAY_API_BASE is pointed at a dead port, NEXUS_EBAY_REAL_API
 * unset, and the Amazon save path is DB-only. Scratch rows are created and
 * cleaned here; nothing else is touched.
 *
 * Checks (each prints GREEN/RED; RED = violates the Zero-Data-Loss Invariant):
 *   L-413-*     save/publish endpoints reject >1MB bodies (Z3 — R1a)
 *   A-RT        Amazon save→GET field round-trip on scratch rows (Z2)
 *   A-ACCT      Amazon save accounts for every sent row (Z3)
 *   A-VER       second save with returned _version does not conflict
 *   A-VER-STALE stale _version yields a per-row error (designed CAS behavior)
 *   E-RT        eBay save→GET field round-trip, active market (Z2)
 *   E-MKT       eBay content is market-scoped (IT save invisible on DE) — by design
 *   E-ACCT      eBay save accounts for every sent row — incl. the deleted-SKU
 *               re-import scenario that hits the silent-skip path (Z3 — R1d)
 *
 * Run: cd apps/api && npx tsx scripts/_fft-roundtrip-probe.mts
 * Flags: --keep (skip cleanup, for inspection)
 */

// Platform-write belts BEFORE any import wires up services.
process.env.EBAY_API_BASE = 'http://127.0.0.1:9'
delete process.env.NEXUS_EBAY_REAL_API
delete process.env.ENABLE_QUEUE_WORKERS

import Fastify from 'fastify'
const amazonRoutes = (await import('../src/routes/amazon-flat-file.routes.js')).default
const ebayRoutes = (await import('../src/routes/ebay-flat-file.routes.js')).default
const prisma = (await import('../src/db.js')).default

const KEEP = process.argv.includes('--keep')
const MP = 'IT'
const PT = 'OUTERWEAR'
const A_PARENT = 'FFT-SCRATCH-A-PARENT'
const A_CHILD = 'FFT-SCRATCH-A-CHILD1'
const E_PARENT = 'FFT-SCRATCH-E-PARENT'
const E_CHILD = 'FFT-SCRATCH-E-CHILD1'
const E_DELETED = 'FFT-SCRATCH-E-DELETED'
const SCRATCH_PREFIX = 'FFT-SCRATCH-'

type Check = { id: string; ok: boolean; note: string }
const checks: Check[] = []
const record = (id: string, ok: boolean, note: string) => {
  checks.push({ id, ok, note })
  console.log(`${ok ? '✅ GREEN' : '❌ RED'}  ${id} — ${note}`)
}

async function cleanup() {
  const products = await prisma.product.findMany({
    where: { sku: { startsWith: SCRATCH_PREFIX } },
    select: { id: true },
  })
  const ids = products.map((p) => p.id)
  if (ids.length === 0) return
  await prisma.outboundSyncQueue.deleteMany({ where: { productId: { in: ids } } }).catch(() => null)
  await prisma.sharedListingMembership.deleteMany({ where: { productId: { in: ids } } }).catch(() => null)
  await prisma.channelListing.deleteMany({ where: { productId: { in: ids } } })
  await prisma.productVariation.deleteMany({ where: { productId: { in: ids } } }).catch(() => null)
  await prisma.stockLevel.deleteMany({ where: { productId: { in: ids } } }).catch(() => null)
  await prisma.stockMovement.deleteMany({ where: { productId: { in: ids } } }).catch(() => null)
  await prisma.productReadCache.deleteMany({ where: { id: { in: ids } } }).catch(() => null)
  await prisma.product.deleteMany({ where: { id: { in: ids } } })
}

const app = Fastify() // default 1 MB bodyLimit — mirrors prod registration
await app.register(amazonRoutes)
await app.register(ebayRoutes)
await app.ready()

const inject = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url, ...(payload !== undefined ? { payload } : {}) })

try {
  await cleanup() // idempotent pre-clean

  // ── L-413: oversized bodies on save/publish endpoints ──────────────────────
  {
    // Deliberately SKU-LESS: once the body limit is lifted these rows reach the
    // real handlers, and sku-less rows are inert in every lane (Amazon errors
    // per-row, eBay skips, push/publish gate) — nothing can be written.
    const bigRows = Array.from({ length: 600 }, () => ({
      item_name: 'x'.repeat(1800),
      title: 'x'.repeat(1800),
    }))
    const big = { rows: bigRows, marketplace: MP, productType: PT }
    const targets: Array<[string, 'POST' | 'PATCH', string]> = [
      ['L-413-AMZ-SAVE', 'POST', '/amazon/flat-file/sync-rows'],
      ['L-413-AMZ-SUBMIT', 'POST', '/amazon/flat-file/submit'],
      ['L-413-EBAY-SAVE', 'PATCH', '/ebay/flat-file/rows'],
      ['L-413-EBAY-PUSH', 'POST', '/ebay/flat-file/push'],
      ['L-413-EBAY-PUBLISH', 'POST', '/ebay/flat-file/publish'],
    ]
    for (const [id, method, url] of targets) {
      const r = await inject(method, url, big)
      // Invariant: a large-but-legal sheet must NOT be rejected for size.
      // 413 = RED (the R1a defect). Anything else (400 validation etc.) = GREEN.
      record(id, r.statusCode !== 413, `HTTP ${r.statusCode} for ~1.1MB body`)
    }
  }

  // ── Amazon: create scratch family via the real save ────────────────────────
  const aRows1 = [
    {
      item_sku: A_PARENT, item_name: 'FFT scratch parent', product_type: PT,
      parentage_level: 'parent', brand_name: 'FFTBRAND', update_delete: 'partial_update',
      _isNew: true, // grid-added rows carry this — the create gate keys on it
    },
    {
      item_sku: A_CHILD, item_name: 'FFT scratch child ONE', product_type: PT,
      parentage_level: 'child', parent_sku: A_PARENT, brand_name: 'FFTBRAND',
      color_name: 'Nero', size_name: 'M', care_instructions: 'Machine wash',
      update_delete: 'partial_update', _isNew: true,
    },
  ]
  const aSave1 = await inject('POST', '/amazon/flat-file/sync-rows', {
    rows: aRows1, marketplace: MP, productType: PT,
  })
  const aBody1 = aSave1.json() as any
  {
    const sent = aRows1.length
    const accounted = (aBody1.synced ?? 0) + (aBody1.created ?? 0) + (aBody1.errors?.length ?? 0)
    const errs = (aBody1.errors ?? []) as Array<{ sku?: string; error?: string }>
    // Valid NEW rows must actually create — errors on create = the operator's
    // "add rows then Save" flow failing.
    record('A-ACCT-CREATE', aSave1.statusCode === 200 && accounted === sent && errs.length === 0,
      `HTTP ${aSave1.statusCode}; sent ${sent}, accounted ${accounted} (synced ${aBody1.synced}, created ${aBody1.created})` +
      (errs.length ? ` — errors: ${errs.map((e) => `${e.sku}: ${e.error}`).join(' | ')}` : ''))
  }

  // Edit + save (update path) → returned versions
  const aRows2 = aRows1.map((r) => ({ ...r }))
  aRows2[1].item_name = 'FFT scratch child EDITED'
  aRows2[1].care_instructions = 'Hand wash only'
  ;(aRows2[1] as any).ffx_custom_note = 'round-trip-probe' // arbitrary column → snapshot verbatim
  const aSave2 = await inject('POST', '/amazon/flat-file/sync-rows', {
    rows: aRows2, marketplace: MP, productType: PT,
  })
  const aBody2 = aSave2.json() as any
  {
    const sent = aRows2.length
    const accounted = (aBody2.synced ?? 0) + (aBody2.created ?? 0) + (aBody2.errors?.length ?? 0)
    record('A-ACCT-UPDATE', aSave2.statusCode === 200 && accounted === sent && (aBody2.errors?.length ?? 0) === 0,
      `HTTP ${aSave2.statusCode}; accounted ${accounted}/${sent}, errors ${aBody2.errors?.length ?? 0}`)
  }

  // Round-trip read-back
  {
    const r = await inject('GET', `/amazon/flat-file/rows?marketplace=${MP}&productType=${PT}&scope=all`)
    const rows = ((r.json() as any).rows ?? []) as Array<Record<string, unknown>>
    const child = rows.find((x) => x.item_sku === A_CHILD)
    const fields: Array<[string, unknown]> = [
      ['item_name', 'FFT scratch child EDITED'],
      ['care_instructions', 'Hand wash only'],
      ['ffx_custom_note', 'round-trip-probe'],
      ['parent_sku', A_PARENT],
    ]
    if (!child) {
      record('A-RT', false, `scratch child ${A_CHILD} missing from GET /rows (${rows.length} rows)`)
    } else {
      const bad = fields.filter(([k, v]) => String(child[k] ?? '') !== String(v))
      record('A-RT', bad.length === 0,
        bad.length === 0 ? 'all edited fields round-tripped verbatim'
          : `mismatches: ${bad.map(([k, v]) => `${k}='${child[k]}'≠'${v}'`).join('; ')}`)
      // A-VER — save again carrying the version the LAST save returned.
      const ver = (aBody2.versions ?? {})[A_CHILD]
      const aRows3 = [{ ...aRows2[1], _version: ver, item_name: 'FFT scratch child EDITED v3' }]
      const s3 = await inject('POST', '/amazon/flat-file/sync-rows', { rows: aRows3, marketplace: MP, productType: PT })
      const b3 = s3.json() as any
      record('A-VER', ver != null && s3.statusCode === 200 && (b3.errors?.length ?? 0) === 0,
        ver == null ? 'save response returned NO version for updated row' : `re-save with returned version ${ver}: errors ${b3.errors?.length ?? 0}`)
      // A-VER-STALE — deliberately stale version must yield a per-row error (not silence).
      const s4 = await inject('POST', '/amazon/flat-file/sync-rows', {
        rows: [{ ...aRows2[1], _version: 1, item_name: 'should-conflict' }], marketplace: MP, productType: PT,
      })
      const b4 = s4.json() as any
      const conflictEntry = (b4.errors ?? []).find((e: any) => /version conflict|Changed elsewhere/i.test(String(e.error ?? '')))
      record('A-VER-STALE', Boolean(conflictEntry), conflictEntry ? 'stale version surfaced as per-row conflict error' : `no conflict error surfaced (errors: ${JSON.stringify(b4.errors ?? [])})`)
      // FFT.1 contract — the conflict error carries the row's CURRENT version so
      // the client can adopt it and the operator's next Save wins knowingly.
      record('A-CONFLICT-VERSION', conflictEntry?.currentVersion != null && Number.isFinite(Number(conflictEntry.currentVersion)),
        `conflict entry currentVersion=${conflictEntry?.currentVersion}`)
    }
  }

  // ── eBay: create scratch family via the real save ──────────────────────────
  const eRows1 = [
    {
      sku: E_PARENT, parentage: 'parent', title: 'FFT scratch eBay parent',
      variation_theme: 'Colore,Taglia', category_id: '177104',
    },
    {
      sku: E_CHILD, parentage: 'child', parent_sku: E_PARENT,
      title: 'FFT scratch eBay child', aspect_Colore: 'Nero', aspect_Taglia: 'M',
      it_price: '9.99',
    },
  ]
  const eSave1 = await inject('PATCH', '/ebay/flat-file/rows', { rows: eRows1, marketplace: MP })
  const eBody1 = eSave1.json() as any
  record('E-SAVE', eSave1.statusCode === 200,
    `HTTP ${eSave1.statusCode}; saved ${eBody1.saved}, processed ${eBody1.processed}, contentOnly ${eBody1.contentOnly}`)

  // Edit + round-trip via family GET (parent product id from DB)
  {
    const parent = await prisma.product.findFirst({ where: { sku: E_PARENT, deletedAt: null }, select: { id: true } })
    const eRows2 = eRows1.map((r) => ({ ...r }))
    eRows2[1].title = 'FFT scratch eBay child EDITED'
    ;(eRows2[1] as any).aspect_Colore = 'Giallo'
    ;(eRows2[1] as any).subtitle = 'fft-subtitle'
    const s2 = await inject('PATCH', '/ebay/flat-file/rows', { rows: eRows2, marketplace: MP })
    const b2 = s2.json() as any
    if (!parent) {
      record('E-RT', false, 'scratch eBay parent product was not created by the save pre-pass')
    } else {
      const g = await inject('GET', `/ebay/flat-file/rows?familyId=${parent.id}&marketplace=${MP}`)
      const rows = ((g.json() as any).rows ?? []) as Array<Record<string, unknown>>
      const child = rows.find((x) => x.sku === E_CHILD)
      const fields: Array<[string, unknown]> = [
        ['title', 'FFT scratch eBay child EDITED'],
        ['aspect_Colore', 'Giallo'],
        ['subtitle', 'fft-subtitle'],
      ]
      if (!child) {
        record('E-RT', false, `scratch child ${E_CHILD} missing from family GET (${rows.length} rows)`)
      } else {
        const bad = fields.filter(([k, v]) => String(child[k] ?? '') !== String(v))
        record('E-RT', bad.length === 0,
          bad.length === 0 ? `all edited fields round-tripped (save: saved ${b2.saved}, contentOnly ${b2.contentOnly})`
            : `mismatches: ${bad.map(([k, v]) => `${k}='${child[k]}'≠'${v}'`).join('; ')}`)
        // E-MKT — per-market saves must round-trip per-market: after saving a
        // DIFFERENT title under DE, each market's view shows its own title.
        const eRowsDe = eRows2.map((r) => ({ ...r }))
        eRowsDe[1].title = 'FFT scratch eBay child DE-TITLE'
        await inject('PATCH', '/ebay/flat-file/rows', { rows: eRowsDe, marketplace: 'DE' })
        const gIt2 = await inject('GET', `/ebay/flat-file/rows?familyId=${parent.id}&marketplace=${MP}`)
        const gDe2 = await inject('GET', `/ebay/flat-file/rows?familyId=${parent.id}&marketplace=DE`)
        const itT = String((((gIt2.json() as any).rows ?? []) as Array<Record<string, unknown>>).find((x) => x.sku === E_CHILD)?.title ?? '')
        const deT = String((((gDe2.json() as any).rows ?? []) as Array<Record<string, unknown>>).find((x) => x.sku === E_CHILD)?.title ?? '')
        record('E-MKT', itT === 'FFT scratch eBay child EDITED' && deT === 'FFT scratch eBay child DE-TITLE',
          `IT title='${itT}', DE title='${deT}' (each market must keep its own saved content)`)
      }
    }
  }

  // ── E-ACCT: the deleted-SKU re-import scenario (silent-skip class, R1d) ────
  {
    // A product that EXISTED and was soft-deleted — the operator re-imports its
    // SKU. Lookup filters deletedAt:null → unresolved; create pre-pass collides
    // with the unique SKU of the soft-deleted row (or refuses) → the row can
    // fall through the bare `continue` and vanish from the response accounting.
    // Create it through the REAL save path, then soft-delete like the app does.
    await inject('PATCH', '/ebay/flat-file/rows', {
      rows: [{
        sku: E_DELETED, parentage: 'child', parent_sku: E_PARENT,
        title: 'to be deleted', aspect_Colore: 'Nero', aspect_Taglia: 'L', it_price: '5.00',
      }],
      marketplace: MP,
    })
    await prisma.product.updateMany({ where: { sku: E_DELETED }, data: { deletedAt: new Date() } })
    const row = {
      sku: E_DELETED, parentage: 'child', parent_sku: E_PARENT,
      title: 'resurrected row', aspect_Colore: 'Nero', aspect_Taglia: 'L', it_price: '5.00',
    }
    const r = await inject('PATCH', '/ebay/flat-file/rows', { rows: [row], marketplace: MP })
    const b = r.json() as any
    const createErrors: Array<{ sku?: string }> = b.createResult?.errors ?? []
    const rowErrors: Array<{ sku?: string }> = b.errors ?? []
    const mentioned =
      createErrors.some((e) => e.sku === E_DELETED) || rowErrors.some((e) => e.sku === E_DELETED)
    // Did ANYTHING persist for this row?
    const persisted = await prisma.product.findFirst({ where: { sku: E_DELETED, deletedAt: null }, select: { id: true } })
    const ok = Boolean(persisted) || mentioned
    record('E-ACCT-DELETED-SKU', ok,
      persisted
        ? 'row persisted (soft-deleted SKU was resurrected/created)'
        : mentioned
          ? `row did NOT persist but the response names it (createErrors ${createErrors.length}, rowErrors ${rowErrors.length})`
          : `HTTP ${r.statusCode} saved=${b.saved} processed=${b.processed} — row neither persisted nor reported: SILENT LOSS`)
  }
} catch (err) {
  console.error('battery crashed:', err)
  record('BATTERY', false, `crashed: ${(err as Error)?.stack?.split('\n').slice(0, 3).join(' ← ') ?? String(err)}`)
} finally {
  if (!KEEP) {
    await cleanup().catch((e) => console.error('cleanup failed:', e))
  } else {
    console.log('--keep: scratch family left in place')
  }
  await app.close()
  await prisma.$disconnect()
}

const red = checks.filter((c) => !c.ok)
console.log(`\n═══ FFT battery: ${checks.length - red.length}/${checks.length} GREEN ═══`)
if (red.length) console.log('RED:', red.map((c) => c.id).join(', '))
process.exit(0)
