import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedStylesDepth, type StylesDepthSeed } from '../seed/styles-depth'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'

/**
 * Styles and libraries in depth (W2b-4, schema wave 26/33, B-W2b-206, …_styles_libraries_w2b_guards) on a database built from
 * the migrations and seeded, through the real login and the scoped client:
 *   - the rows made before the wave: a style's lifecycle from its record state and revisions, a material of a released BOM
 *     approved by that release (the migration's own statements, run again on seeded rows);
 *   - a style's lifecycle moves with its time (the transaction's when the writer leaves it), into production only with a
 *     released revision; its replacement, its product type, sold under our name only with a brand;
 *   - a SKU's GTIN: its shortest form with its check digit, fixed once garments with it shipped;
 *   - a colour's system and reference; a material's approval (who, when, why) and typed properties; a blocked material on no
 *     BOM line and in no released revision;
 *   - names per language, pictures (one main, callouts, the file of the style, frozen with a released revision), revision
 *     files (pattern and CAD frozen, markers not);
 *   - product types (kind, company, parent, no circle, defaults), GTIN ranges (never back, limits fixed once used, never
 *     deleted), branding sets (a brand, its own files, library colours, packaging rules, one active), product settings;
 *   - what the floor reads (names, pictures, revision files, product settings) and does not.
 * The refusals are check_violation (23514) or restrict_violation (23001); their messages are read through raw SQL.
 */

const NS = 'w2b-206-a'

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let s: StylesDepthSeed
let ids: {
  rev01: string
  rev02: string
  blackColourway01: string
  lining: string
  leather: string
  protector: string
  bomLine01: string
  colourBlack: string
  scale: string
  template: string
}

const key = (name: string): string => seedUuid(NS, name)
const A = { company: key('company:A'), site: key('site:A1'), P1: key('party:P1'), P2: key('party:P2') }
const office = (): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId: a.actorId })
const floor = (): FactoryScope => ({ audience: 'floor', tenantId: a.tenantId, actorId: randomUUID(), siteId: A.site })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const sql = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$queryRawUnsafe<Record<string, unknown>[]>(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
/** INSERT a copy of row `id` of `table` with `changes` (a jsonb object of columns). */
const copyRow = (scope: FactoryScope, table: string, id: string, changes: Record<string, unknown>) =>
  run(scope, `INSERT INTO "${table}" SELECT * FROM jsonb_populate_record(NULL::"${table}", (SELECT to_jsonb(r) || $1::jsonb FROM "${table}" r WHERE r.id = $2::uuid))`, JSON.stringify(changes), id)
/** UPDATE row `id` of `table`: `set` is the SET list. */
const update = (scope: FactoryScope, table: string, id: string, set: string, ...values: unknown[]) => run(scope, `UPDATE "${table}" SET ${set} WHERE id = $1::uuid`, id, ...values)
/** A write past the database's guards (the facts a test needs: never what it then proves). */
async function force(text: string, values: unknown[] = []): Promise<void> {
  await admin('SET session_replication_role = replica')
  try {
    await admin(text, values)
  } finally {
    await admin('SET session_replication_role = DEFAULT')
  }
}
const tag = (prefix: string): string => `${prefix}-${randomUUID().slice(0, 8)}`
const one = async (text: string, values: unknown[] = []) => (await admin(text, values))[0]!
/** A file row of `recordType` `recordId` (a copy of a seeded file with a new id and storage key). */
async function fileOf(recordType: string, recordId: string, kind = 'PHOTO'): Promise<string> {
  const id = randomUUID()
  const source = (await one(`SELECT id::text AS id FROM "StoredFile" WHERE "tenantId" = $1 AND "recordType" = 'Style' ORDER BY id LIMIT 1`, [a.tenantId])).id as string
  await copyRow(office(), 'StoredFile', source, { id, recordType, recordId, kind, storageKey: `t/${a.tenantId}/tenant/2026/${id}`, sha256: 'b'.repeat(64), thumbnailKey: null, seriesId: null, versionNo: 1, sourceFileId: null })
  return id
}

beforeAll(async () => {
  db = await migratedDatabase('styleslibw2b')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  s = await seedStylesDepth({ db: factory, namespace: NS })
  const byCode = async (table: string, code: string) => (await one(`SELECT id::text AS id FROM "${table}" WHERE "tenantId" = $1 AND code = $2`, [a.tenantId, code])).id as string
  const revision = async (styleId: string) => (await one(`SELECT id::text AS id FROM "StyleRevision" WHERE "styleId" = $1 AND revision = 1`, [styleId])).id as string
  const rev01 = await revision(s.styleIds.jkt01)
  ids = {
    rev01,
    rev02: await revision(s.styleIds.jkt02),
    blackColourway01: (await one(`SELECT id::text AS id FROM "Colourway" WHERE "styleId" = $1 AND code = 'BLK'`, [s.styleIds.jkt01])).id as string,
    lining: await byCode('Item', 'SEED-LIN-200'),
    leather: await byCode('Item', 'SEED-LEA-100'),
    protector: await byCode('Item', 'SEED-PRO-300'),
    bomLine01: (await one(`SELECT id::text AS id FROM "BomLine" WHERE "revisionId" = $1 ORDER BY seq LIMIT 1`, [rev01])).id as string,
    colourBlack: await byCode('Colour', 'SEED-BLK'),
    scale: await byCode('SizeScale', 'SEED-EU-JKT'),
    template: await byCode('MeasurementTemplate', 'JACKET'),
  }
}, 300_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

describe('the rows made before the wave (the migration\'s own statements)', () => {
  it('gives each style a lifecycle from what it is, and approves the materials of a released BOM by that release', async () => {
    const text = readFileSync(new URL('../prisma/migrations/202611010003_styles_libraries_w2b_guards/migration.sql', import.meta.url), 'utf8')
    const data = text.slice(text.indexOf('UPDATE "Style" s'), text.indexOf('-- ====', text.indexOf('UPDATE "Style" s')))
    expect(data).toMatch(/UPDATE "Item" i/)
    // As before the wave: every style CONCEPT, every material PENDING; one more style, archived.
    const before = await admin(`SELECT id, status, lifecycle, "lifecycleChangedAt", "lifecycleChangedById" FROM "Style" WHERE "tenantId" = $1`, [a.tenantId])
    const items = await admin(`SELECT id, approval, "approvedAt", "approvedById", "approvalNote" FROM "Item" WHERE "tenantId" = $1`, [a.tenantId])
    const archived = randomUUID()
    expect(await copyRow(office(), 'Style', s.styleIds.jkt01, { id: archived, code: tag('T-OLD') })).toBe(1)
    try {
      await force(`UPDATE "Style" SET lifecycle = 'CONCEPT', status = CASE WHEN id = $2 THEN 'ARCHIVED'::"StyleStatus" ELSE status END WHERE "tenantId" = $1`, [a.tenantId, archived])
      await force(`UPDATE "Item" SET approval = 'PENDING', "approvedAt" = NULL, "approvedById" = NULL, "approvalNote" = NULL WHERE "tenantId" = $1`, [a.tenantId])
      await force(data)
      const styles = await admin(
        `SELECT s.id::text AS id, s.status::text AS status, s.lifecycle::text AS lifecycle,
                EXISTS (SELECT 1 FROM "StyleRevision" r WHERE r."styleId" = s.id AND r.status = 'RELEASED') AS released
           FROM "Style" s WHERE s."tenantId" = $1`,
        [a.tenantId],
      )
      for (const row of styles) expect(row.lifecycle).toBe(row.status === 'ARCHIVED' ? 'DISCONTINUED' : row.released ? 'IN_PRODUCTION' : 'DEVELOPMENT')
      const lifecycleOf = (id: string) => styles.find((row) => row.id === id)!.lifecycle
      expect([lifecycleOf(s.styleIds.jkt01), lifecycleOf(s.styleIds.jkt02), lifecycleOf(archived)]).toEqual(['DEVELOPMENT', 'IN_PRODUCTION', 'DISCONTINUED'])
      // Each material a released (or obsoleted) BOM names: APPROVED at its first such release, by that releaser; the others PENDING.
      const releases = await admin(
        `SELECT b."itemId"::text AS item, r."releasedAt", r."releasedById"::text AS by FROM "BomLine" b JOIN "StyleRevision" r ON r.id = b."revisionId"
          WHERE b."tenantId" = $1 AND r.status IN ('RELEASED', 'OBSOLETE') AND r."releasedAt" IS NOT NULL ORDER BY r."releasedAt", r.id`,
        [a.tenantId],
      )
      expect(releases.some((row) => row.item === ids.leather)).toBe(true)
      const materials = await admin(`SELECT id::text AS id, approval::text AS approval, "approvedAt", "approvedById"::text AS by FROM "Item" WHERE "tenantId" = $1`, [a.tenantId])
      for (const row of materials) {
        const first = releases.find((release) => release.item === row.id)
        expect(row).toEqual(first ? { id: row.id, approval: 'APPROVED', approvedAt: first.releasedAt, by: first.by } : { id: row.id, approval: 'PENDING', approvedAt: null, by: null })
      }
      expect(materials.find((row) => row.id === s.blockedItemId)!.approval).toBe('PENDING')
    } finally {
      for (const row of before)
        await force(`UPDATE "Style" SET status = $2::"StyleStatus", lifecycle = $3::"StyleLifecycle", "lifecycleChangedAt" = $4, "lifecycleChangedById" = $5 WHERE id = $1`, [row.id, row.status, row.lifecycle, row.lifecycleChangedAt, row.lifecycleChangedById])
      for (const row of items)
        await force(`UPDATE "Item" SET approval = $2::"MaterialApproval", "approvedAt" = $3, "approvedById" = $4, "approvalNote" = $5 WHERE id = $1`, [row.id, row.approval, row.approvedAt, row.approvedById, row.approvalNote])
    }
  })
})

describe('a style: lifecycle, replacement, product type, private label', () => {
  const copyStyle = (changes: Record<string, unknown>) => copyRow(office(), 'Style', s.styleIds.jkt01, { id: randomUUID(), code: tag('T-STY'), ...changes })

  it('moves its lifecycle with the time (the transaction\'s when the writer leaves it), into production only with a released revision', async () => {
    const id = randomUUID()
    expect(await copyStyle({ id, lifecycle: 'CONCEPT', lifecycleChangedAt: null, lifecycleChangedById: null })).toBe(1)
    expect(await update(office(), 'Style', id, `lifecycle = 'DEVELOPMENT', "lifecycleChangedById" = $2::uuid`, a.actorId)).toBe(1)
    const moved = await one(`SELECT "lifecycleChangedAt" IS NOT NULL AS at, "lifecycleChangedById"::text AS by FROM "Style" WHERE id = $1`, [id])
    expect(moved).toEqual({ at: true, by: a.actorId })
    await expect(update(office(), 'Style', id, `"lifecycleChangedAt" = now() - interval '1 day'`)).rejects.toThrow(/change only with a move/)
    await expect(update(office(), 'Style', id, `"lifecycleChangedById" = $2::uuid`, randomUUID())).rejects.toThrow(/change only with a move/)
    await expect(update(office(), 'Style', id, `lifecycle = 'SAMPLING', "lifecycleChangedAt" = '2020-01-01T00:00:00Z'`)).rejects.toThrow(/at a time on or after its last move/)
    await expect(update(office(), 'Style', id, `lifecycle = 'IN_PRODUCTION'`)).rejects.toThrow(/into production only with a released revision/)
    // SEED-JKT-02 has its released revision: back to APPROVED and into production again.
    expect(await update(office(), 'Style', s.styleIds.jkt02, `lifecycle = 'APPROVED'`)).toBe(1)
    expect(await update(office(), 'Style', s.styleIds.jkt02, `lifecycle = 'IN_PRODUCTION'`)).toBe(1)
    // An insert may start anywhere (a copy, an import).
    expect(await copyStyle({ lifecycle: 'IN_PRODUCTION' })).toBe(1)
  })

  it('names the style that replaces it only while phased out or discontinued, never itself', async () => {
    const id = randomUUID()
    expect(await copyStyle({ id, lifecycle: 'DEVELOPMENT' })).toBe(1)
    await expect(update(office(), 'Style', id, `"replacedById" = $2::uuid`, s.styleIds.jkt02)).rejects.toThrow(/only while it is phased out or discontinued, not DEVELOPMENT/)
    expect(await update(office(), 'Style', id, `lifecycle = 'PHASE_OUT', "replacedById" = $2::uuid`, s.styleIds.jkt02)).toBe(1)
    await expect(update(office(), 'Style', id, `"replacedById" = id`)).rejects.toThrow(/not replaced by itself/)
    await expect(update(office(), 'Style', id, `lifecycle = 'DEVELOPMENT'`)).rejects.toThrow(/only while it is phased out or discontinued/)
    expect(await update(office(), 'Style', id, `lifecycle = 'DISCONTINUED'`)).toBe(1)
  })

  it('is sold under our name only as a brand\'s private-label style', async () => {
    expect(await copyStyle({ soldUnderOurName: true })).toBe(1)
    await expect(copyStyle({ soldUnderOurName: true, brandPartyId: null })).rejects.toThrow(/sold under our name only as a brand's private-label style/)
    const id = randomUUID()
    expect(await copyStyle({ id, soldUnderOurName: true })).toBe(1)
    await expect(update(office(), 'Style', id, `"brandPartyId" = NULL`)).rejects.toThrow(/sold under our name only/)
    expect(await update(office(), 'Style', id, `"brandPartyId" = NULL, "soldUnderOurName" = false`)).toBe(1)
  })

  it('takes a product type of its kind of garment, of its company or tenant-wide, not an archived one', async () => {
    await expect(copyStyle({ productTypeProfileId: s.profileIds.vest })).rejects.toThrow(/is a JACKET, so its product type is one of that kind, not of VEST/)
    const companyType = randomUUID()
    expect(await copyRow(office(), 'ProductTypeProfile', s.profileIds.touring, { id: companyType, code: tag('T-PT'), companyId: A.company })).toBe(1)
    await expect(copyStyle({ productTypeProfileId: companyType })).rejects.toThrow(/of its company or tenant-wide/)
    expect(await copyStyle({ productTypeProfileId: companyType, companyId: A.company })).toBe(1)
    await expect(update(office(), 'Style', s.styleIds.jkt02, `"productType" = 'TROUSERS'`)).rejects.toThrow(/is a TROUSERS, so its product type is one of that kind/)
    expect(await update(office(), 'ProductTypeProfile', companyType, `status = 'ARCHIVED'`)).toBe(1)
    await expect(copyStyle({ productTypeProfileId: companyType, companyId: A.company })).rejects.toThrow(/is archived: it is given to no style/)
  })
})

describe('a SKU\'s GTIN', () => {
  const variant = async (sku: string) => (await one(`SELECT id::text AS id, gtin FROM "Variant" WHERE "tenantId" = $1 AND sku = $2`, [a.tenantId, sku])) as { id: string; gtin: string | null }

  it('is a GTIN-8, -13 or -14 in its shortest form with its check digit', async () => {
    const { id } = await variant('SEED-JKT-01-RED-54')
    const set = (gtin: string) => update(office(), 'Variant', id, `gtin = $2`, gtin)
    await expect(set('2009999001004')).rejects.toThrow(/ends with its check digit/)
    await expect(set('200999900100')).rejects.toThrow(/is 8, 13 or 14 digits/)
    await expect(set('02009999001041')).rejects.toThrow(/without the leading zeros/)
    await expect(set('0000020012342')).rejects.toThrow(/without the leading zeros/)
    await expect(set('0000000000000')).rejects.toThrow(/not all zeros/)
    await expect(set('2009999 00104')).rejects.toThrow(/8, 13 or 14 digits/)
    expect(await set('2009999001041')).toBe(1)
    expect(await set('20012342')).toBe(1)
    expect(await set('12009999001048')).toBe(1)
    expect(await update(office(), 'Variant', id, `gtin = NULL`)).toBe(1)
    // Unique in the tenant (W1's key).
    await expect(set(s.gtins[0]!.gtin)).rejects.toThrow(/unique/i)
  })

  it('never changes or clears once garments with it have shipped; a SKU that shipped without one may get one', async () => {
    const isShipped = async (variantId: string) =>
      (
        await admin(
          `SELECT 1 FROM "ShipmentLine" l JOIN "Shipment" sh ON sh.id = l."shipmentId" JOIN "WorkOrderSize" w ON w.id = l."workOrderSizeId"
             JOIN "Variant" v ON v."styleId" = w."styleId" AND v."colourwayId" = w."colourwayId" AND v.size = w.size WHERE v.id = $1 AND sh."shippedAt" IS NOT NULL`,
          [variantId],
        )
      ).length > 0
    type Gtin = (typeof s.gtins)[number]
    const shipped: Gtin[] = []
    const unshipped: Gtin[] = []
    for (const entry of s.gtins) ((await isShipped(entry.variantId)) ? shipped : unshipped).push(entry)
    // SH-0001 shipped SEED-JKT-02 black 50 and red 52; at most one of them is the tenant's first SKU (kept without a GTIN).
    expect(shipped.length).toBeGreaterThan(0)
    expect(unshipped.length).toBeGreaterThan(0)
    const [first] = shipped
    await expect(update(office(), 'Variant', first!.variantId, `gtin = '2009999001041'`)).rejects.toThrow(new RegExp(`keeps its GTIN ${first!.gtin}: garments with it have shipped`))
    await expect(update(office(), 'Variant', first!.variantId, `gtin = NULL`)).rejects.toThrow(/keeps its GTIN/)
    expect(await update(office(), 'Variant', first!.variantId, `status = status, gtin = gtin`)).toBe(1)
    // Cleared past the guard (as if it shipped without one), it may be given one.
    await force(`UPDATE "Variant" SET gtin = NULL WHERE id = $1`, [first!.variantId])
    expect(await update(office(), 'Variant', first!.variantId, `gtin = $2`, first!.gtin)).toBe(1)
    // An unshipped SKU's GTIN changes.
    expect(await update(office(), 'Variant', unshipped[0]!.variantId, `gtin = '2009999001058'`)).toBe(1)
    expect(await update(office(), 'Variant', unshipped[0]!.variantId, `gtin = $2`, unshipped[0]!.gtin)).toBe(1)
  })
})

describe('a colour of the library, a material of the library', () => {
  it('names a reference only with its system, and one for Pantone, RAL and NCS', async () => {
    const copy = (changes: Record<string, unknown>) => copyRow(office(), 'Colour', ids.colourBlack, { id: randomUUID(), code: tag('T-COL'), ...changes })
    await expect(copy({ system: null, reference: 'X-1' })).rejects.toThrow(/reference only with the colour system/)
    await expect(copy({ system: 'PANTONE', reference: null })).rejects.toThrow(/names its PANTONE reference/)
    await expect(copy({ system: 'NCS', reference: ' ' })).rejects.toThrow(/1 to 40 characters/)
    await expect(copy({ family: 'x'.repeat(41) })).rejects.toThrow(/1 to 40 characters/)
    expect(await copy({ system: 'OWN', reference: null, family: 'black' })).toBe(1)
    expect(await copy({ system: 'NCS', reference: 'S 9000-N', family: null })).toBe(1)
  })

  it('is decided with when, who and (conditional, blocked) why; when and who change only with the approval', async () => {
    const copy = (changes: Record<string, unknown>) => copyRow(office(), 'Item', ids.leather, { id: randomUUID(), code: tag('T-ITM'), variantId: null, ...changes })
    await expect(copy({ approval: 'PENDING', approvedAt: null, approvedById: a.actorId })).rejects.toThrow(/exactly when it is not PENDING/)
    await expect(copy({ approval: 'APPROVED', approvedAt: null })).rejects.toThrow(/exactly when it is not PENDING/)
    await expect(copy({ approval: 'APPROVED', approvedById: null })).rejects.toThrow(/names who decided it is APPROVED/)
    await expect(copy({ approval: 'CONDITIONAL', approvalNote: null })).rejects.toThrow(/says why it is CONDITIONAL/)
    await expect(copy({ approval: 'BLOCKED', approvalNote: '  ' })).rejects.toThrow(/says why it is BLOCKED/)
    const id = randomUUID()
    expect(await copy({ id, approval: 'PENDING', approvedAt: null, approvedById: null, approvalNote: null })).toBe(1)
    await expect(update(office(), 'Item', id, `approval = 'APPROVED', "approvedAt" = now()`)).rejects.toThrow(/names who decided/)
    expect(await update(office(), 'Item', id, `approval = 'APPROVED', "approvedAt" = now(), "approvedById" = $2::uuid`, a.actorId)).toBe(1)
    await expect(update(office(), 'Item', id, `"approvedById" = $2::uuid`, randomUUID())).rejects.toThrow(/change only with its approval/)
    await expect(update(office(), 'Item', id, `"approvedAt" = now() - interval '1 day'`)).rejects.toThrow(/change only with its approval/)
    expect(await update(office(), 'Item', id, `"approvalNote" = 'Checked again (made-up).'`)).toBe(1)
    expect(await update(office(), 'Item', id, `approval = 'PENDING', "approvedAt" = NULL, "approvedById" = NULL`)).toBe(1)
  })

  it('has the properties of its kind, typed (decimals as strings)', async () => {
    const set = (itemId: string, props: unknown) => update(office(), 'Item', itemId, `properties = $2::jsonb`, JSON.stringify(props))
    await expect(set(ids.lining, { weightGsm: 120 })).rejects.toThrow(/"weightGsm" as a decimal above 0, in a string/)
    await expect(set(ids.lining, { weightGsm: '0' })).rejects.toThrow(/"weightGsm" as a decimal above 0/)
    await expect(set(ids.lining, { widthCm: '1.5e2' })).rejects.toThrow(/"widthCm" as a decimal above 0/)
    await expect(set(ids.lining, { level: '2' })).rejects.toThrow(/have no "level" for a LINING material/)
    await expect(set(ids.protector, { level: '3' })).rejects.toThrow(/"level" as "1" or "2"/)
    await expect(set(ids.protector, { standard: '' })).rejects.toThrow(/"standard" as a text of 1 to 100 characters/)
    await expect(set(ids.leather, { construction: 'woven' })).rejects.toThrow(/have no "construction" for a LEATHER material/)
    await expect(set(s.blockedItemId, { nickelFree: 'no' })).rejects.toThrow(/"nickelFree" as true or false/)
    await expect(set(ids.lining, ['weightGsm'])).rejects.toThrow(/an object of its kind's properties/)
    expect(await set(ids.lining, { weightGsm: '120.5', widthCm: '150', construction: 'Mesh' })).toBe(1)
    expect(await set(s.blockedItemId, { material: 'steel', nickelFree: true })).toBe(1)
    expect(await set(ids.leather, {})).toBe(1)
    // A kind change re-checks them.
    await expect(update(office(), 'Item', ids.lining, `kind = 'LEATHER'`)).rejects.toThrow(/have no "(weightGsm|widthCm|construction)" for a LEATHER material/)
  })

  it('is refused on a BOM line when blocked, and holds the release of a revision whose BOM names it', async () => {
    await expect(copyRow(office(), 'BomLine', ids.bomLine01, { id: randomUUID(), seq: 900, itemId: s.blockedItemId, itemColourId: null, colourDependent: false, sizeDependent: false })).rejects.toThrow(
      /is blocked: no BOM line takes it/,
    )
    const line = randomUUID()
    expect(await copyRow(office(), 'BomLine', ids.bomLine01, { id: line, seq: 901, itemId: ids.protector, itemColourId: null, colourDependent: false, sizeDependent: false })).toBe(1)
    await expect(update(office(), 'BomLine', line, `"itemId" = $2::uuid`, s.blockedItemId)).rejects.toThrow(/is blocked/)
    // The protector blocked later: the draft's line stays, its release is held.
    expect(await update(office(), 'Item', ids.protector, `approval = 'BLOCKED', "approvedAt" = now(), "approvedById" = $2::uuid, "approvalNote" = 'Recall (made-up).'`, a.actorId)).toBe(1)
    try {
      await expect(update(office(), 'StyleRevision', ids.rev01, `status = 'RELEASED', "releasedAt" = now(), "releasedById" = $2::uuid`, a.actorId)).rejects.toThrow(
        /is not released: its BOM names the blocked material SEED-PRO-300/,
      )
    } finally {
      expect(await update(office(), 'Item', ids.protector, `approval = 'APPROVED', "approvedAt" = now(), "approvedById" = $2::uuid, "approvalNote" = NULL`, a.actorId)).toBe(1)
      expect(await run(office(), `DELETE FROM "BomLine" WHERE id = $1::uuid`, line)).toBe(1)
    }
    expect((await one(`SELECT status::text FROM "StyleRevision" WHERE id = $1`, [ids.rev01])).status).toBe('DRAFT')
  })
})

describe('names per language, pictures, revision files', () => {
  it('keeps a style\'s text in one language, its style and language fixed', async () => {
    const first = (await one(`SELECT id::text AS id FROM "StyleText" WHERE "tenantId" = $1 ORDER BY id LIMIT 1`, [a.tenantId])).id as string
    const copy = (changes: Record<string, unknown>) => copyRow(office(), 'StyleText', first, { id: randomUUID(), styleId: s.styleIds.jkt02, ...changes })
    await expect(copy({ language: 'Italian' })).rejects.toThrow(/BCP 47 tag/)
    await expect(copy({ language: 'fr', name: ' ' })).rejects.toThrow(/a name of 1 to 200 characters/)
    await expect(copy({ language: 'fr', longDescription: 'a\u0007b' })).rejects.toThrow(/long one of up to 10 000/)
    const id = randomUUID()
    expect(await copy({ id, language: 'de-CH', name: 'Seed Jacke', longDescription: 'Zeile 1\nZeile 2' })).toBe(1)
    await expect(copy({ language: 'de-CH' })).rejects.toThrow(/unique/i)
    await expect(update(office(), 'StyleText', id, `language = 'fr'`)).rejects.toThrow(/style and language of text .* never change/)
    expect(await run(office(), `DELETE FROM "StyleText" WHERE id = $1::uuid`, id)).toBe(1)
  })

  it('has at most one main picture per style, callouts of their shape, and files of the style', async () => {
    const copy = (changes: Record<string, unknown>) => copyRow(office(), 'StyleImage', s.imageIds.front, { id: randomUUID(), ...changes })
    await expect(copy({ isMain: true })).rejects.toThrow(/StyleImage_one_main_per_style/)
    await expect(copy({ seq: -1 })).rejects.toThrow(/a place from 0/)
    await expect(copy({ callouts: [{ n: 1, x: 0.5, y: '0.5', text: 'A' }] })).rejects.toThrow(/x and y from "0" to "1"/)
    await expect(copy({ callouts: [{ n: 1, x: '1.5', y: '0.5', text: 'A' }] })).rejects.toThrow(/x and y from "0" to "1"/)
    await expect(copy({ callouts: [{ n: 1, x: '0.5', y: '0.5', text: 'A' }, { n: 1, x: '0.2', y: '0.2', text: 'B' }] })).rejects.toThrow(/number callout 1 once/)
    await expect(copy({ callouts: [{ n: 0, x: '0.5', y: '0.5', text: 'A' }] })).rejects.toThrow(/whole numbers from 1/)
    await expect(copy({ callouts: [{ n: 1, x: '0.5', y: '0.5' }] })).rejects.toThrow(/a text of 1 to 500/)
    await expect(copy({ callouts: [{ n: 1, x: '0.5', y: '0.5', text: 'A', colour: 'red' }] })).rejects.toThrow(/have no "colour"/)
    await expect(copy({ callouts: { n: 1 } })).rejects.toThrow(/a list of at most 60/)
    expect(await copy({ callouts: [{ n: 1, x: '0', y: '1.0', text: 'Corner' }] })).toBe(1)
    // The file: of the style, one of its colourways or revisions; a picture or a drawing.
    await expect(copy({ fileId: await fileOf('Style', s.styleIds.jkt02) })).rejects.toThrow(/a file of its style, of one of its colourways or of one of its revisions/)
    await expect(copy({ fileId: await fileOf('Style', s.styleIds.jkt01, 'AUDIO') })).rejects.toThrow(/not a AUDIO file/)
    expect(await copy({ fileId: await fileOf('Colourway', ids.blackColourway01) })).toBe(1)
    expect(await copy({ revisionId: ids.rev01, fileId: await fileOf('StyleRevision', ids.rev01) })).toBe(1)
    // The main mark moves: the old one cleared first.
    expect(await update(office(), 'StyleImage', s.imageIds.colourway, `"isMain" = false`)).toBe(1)
    expect(await update(office(), 'StyleImage', s.imageIds.front, `"isMain" = true`)).toBe(1)
    expect(await update(office(), 'StyleImage', s.imageIds.front, `"isMain" = false`)).toBe(1)
    expect(await update(office(), 'StyleImage', s.imageIds.colourway, `"isMain" = true`)).toBe(1)
    await expect(update(office(), 'StyleImage', s.imageIds.front, `"styleId" = $2::uuid`, s.styleIds.jkt02)).rejects.toThrow()
  })

  it('freezes a released revision\'s pictures: only their place and the main mark change; none added or removed', async () => {
    const file = await fileOf('StyleRevision', ids.rev02)
    await expect(copyRow(office(), 'StyleImage', s.imageIds.jkt02, { id: randomUUID(), revisionId: ids.rev02, fileId: file, isMain: false })).rejects.toThrow(
      /is RELEASED; its pictures change no more/,
    )
    const frozen = randomUUID()
    await force(
      `INSERT INTO "StyleImage" (id, "tenantId", "styleId", "revisionId", "fileId", kind, seq) VALUES ($1, $2, $3, $4, $5, 'SKETCH', 5)`,
      [frozen, a.tenantId, s.styleIds.jkt02, ids.rev02, file],
    )
    await expect(update(office(), 'StyleImage', frozen, `caption = 'Changed'`)).rejects.toThrow(/its pictures change no more/)
    await expect(update(office(), 'StyleImage', frozen, `"revisionId" = NULL`)).rejects.toThrow(/its pictures change no more/)
    expect(await update(office(), 'StyleImage', frozen, `seq = 1, version = version + 1, "updatedAt" = now()`)).toBe(1)
    await expect(run(office(), `DELETE FROM "StyleImage" WHERE id = $1::uuid`, frozen)).rejects.toThrow(/its pictures are kept with it/)
    // A draft revision's picture is removed freely (and put back as it was).
    const page = (await one(`SELECT to_jsonb(i) AS row FROM "StyleImage" i WHERE id = $1`, [s.imageIds.page])).row
    expect(await run(office(), `DELETE FROM "StyleImage" WHERE id = $1::uuid`, s.imageIds.page)).toBe(1)
    await force(`INSERT INTO "StyleImage" SELECT * FROM jsonb_populate_record(NULL::"StyleImage", $1::jsonb)`, [JSON.stringify(page)])
  })

  it('keeps a released revision\'s pattern and CAD files; markers and others come and go; sizes of the range; files of the revision', async () => {
    const copy = (from: string, changes: Record<string, unknown>) => copyRow(office(), 'StyleRevisionFile', from, { id: randomUUID(), ...changes })
    await expect(copy(s.revisionFileIds.marker, { kind: 'PATTERN' })).rejects.toThrow(/is RELEASED; its pattern and CAD files change no more/)
    await expect(copy(s.revisionFileIds.marker, { kind: 'CAD' })).rejects.toThrow(/is RELEASED; its pattern and CAD files/)
    const marker = randomUUID()
    expect(await copy(s.revisionFileIds.marker, { id: marker, sizes: ['54'] })).toBe(1)
    expect(await update(office(), 'StyleRevisionFile', marker, `note = 'Recut lay (made-up).'`)).toBe(1)
    await expect(update(office(), 'StyleRevisionFile', marker, `kind = 'PATTERN'`)).rejects.toThrow(/its pattern and CAD files change no more/)
    expect(await run(office(), `DELETE FROM "StyleRevisionFile" WHERE id = $1::uuid`, marker)).toBe(1)
    await expect(copy(s.revisionFileIds.marker, { sizes: ['58'] })).rejects.toThrow(/for sizes of its style's range \(50, 52, 54\), not 58/)
    await expect(copy(s.revisionFileIds.marker, { sizes: ['50', '50'] })).rejects.toThrow(/names each size once/)
    await expect(copy(s.revisionFileIds.marker, { fileId: await fileOf('StyleRevision', ids.rev01, 'ATTACHMENT') })).rejects.toThrow(/of its revision or style/)
    await expect(copy(s.revisionFileIds.marker, { fileId: await fileOf('Style', s.styleIds.jkt02, 'AUDIO') })).rejects.toThrow(/not a AUDIO file/)
    expect(await copy(s.revisionFileIds.marker, { fileId: await fileOf('Style', s.styleIds.jkt02, 'DOCUMENT'), format: null })).toBe(1)
    // The draft's pattern changes, moves to a new file version, and goes.
    const pattern = randomUUID()
    expect(await copy(s.revisionFileIds.pattern, { id: pattern, kind: 'CAD', format: 'GERBER' })).toBe(1)
    expect(await update(office(), 'StyleRevisionFile', pattern, `"fileId" = $2::uuid`, await fileOf('StyleRevision', ids.rev01, 'ATTACHMENT'))).toBe(1)
    await expect(update(office(), 'StyleRevisionFile', pattern, `"revisionId" = $2::uuid`, ids.rev02)).rejects.toThrow()
    expect(await run(office(), `DELETE FROM "StyleRevisionFile" WHERE id = $1::uuid`, pattern)).toBe(1)
    // The released revision's pattern, put there past the guard, is kept.
    const kept = randomUUID()
    await force(`INSERT INTO "StyleRevisionFile" (id, "tenantId", "styleId", "revisionId", "fileId", kind) VALUES ($1, $2, $3, $4, $5, 'PATTERN')`, [
      kept,
      a.tenantId,
      s.styleIds.jkt02,
      ids.rev02,
      await fileOf('StyleRevision', ids.rev02, 'ATTACHMENT'),
    ])
    await expect(run(office(), `DELETE FROM "StyleRevisionFile" WHERE id = $1::uuid`, kept)).rejects.toThrow(/its PATTERN files are kept with it/)
  })
})

describe('the libraries: product types, GTIN ranges, branding sets, product settings', () => {
  it('builds product types: one kind of garment up the tree, a company\'s or tenant-wide parent, no circle, defaults that fit', async () => {
    const copy = (changes: Record<string, unknown>) => copyRow(office(), 'ProductTypeProfile', s.profileIds.touring, { id: randomUUID(), code: tag('T-PT'), ...changes })
    await expect(copy({ parentId: s.profileIds.vest })).rejects.toThrow(/refines a type of its own kind of garment \(JACKET\), not VEST/)
    await expect(copy({ code: 'with space' })).rejects.toThrow(/without spaces/)
    await expect(copy({ requiredAttributes: ['gender', 'gender'] })).rejects.toThrow(/each once/)
    await expect(copy({ requiredAttributes: ['Gender'] })).rejects.toThrow(/as names/)
    await expect(copy({ defaultPpeClass: 'x'.repeat(11) })).rejects.toThrow(/a class of up to 10/)
    const company = randomUUID()
    expect(await copy({ id: company, companyId: A.company })).toBe(1)
    await expect(copy({ parentId: company })).rejects.toThrow(/the parent of product type .* is of its company or tenant-wide/)
    expect(await copy({ parentId: company, companyId: A.company })).toBe(1)
    await expect(update(office(), 'ProductTypeProfile', company, `"companyId" = NULL`)).rejects.toThrow(/never changes/)
    // No circle: Jacket ← Touring ← child; Jacket under child refused.
    const child = randomUUID()
    expect(await copy({ id: child, parentId: s.profileIds.touring })).toBe(1)
    await expect(update(office(), 'ProductTypeProfile', s.profileIds.jacket, `"parentId" = $2::uuid`, child)).rejects.toThrow(/its own ancestor/)
    await expect(update(office(), 'ProductTypeProfile', child, `"parentId" = id`)).rejects.toThrow(/not its own parent/)
    // An archived type takes no new child; its old ones stay.
    expect(await update(office(), 'ProductTypeProfile', company, `status = 'ARCHIVED'`)).toBe(1)
    await expect(copy({ parentId: company, companyId: A.company })).rejects.toThrow(/is archived: no type refines it any more/)
    // The kind stays while a style or a child is of it.
    await expect(update(office(), 'ProductTypeProfile', s.profileIds.touring, `"productType" = 'VEST'`)).rejects.toThrow(/keeps its kind of garment \(JACKET\)/)
    // Defaults: a tenant-wide type's are tenant-wide; the measurement template of its kind.
    const companyScale = randomUUID()
    expect(await copyRow(office(), 'SizeScale', ids.scale, { id: companyScale, code: tag('T-SC'), companyId: A.company })).toBe(1)
    await expect(copy({ defaultSizeScaleId: companyScale })).rejects.toThrow(/default size scale .* of its company or tenant-wide/)
    expect(await copy({ defaultSizeScaleId: companyScale, companyId: A.company })).toBe(1)
    const vestTemplate = randomUUID()
    expect(await copyRow(office(), 'MeasurementTemplate', ids.template, { id: vestTemplate, code: tag('T-MT'), productType: 'VEST' })).toBe(1)
    await expect(copy({ measurementTemplateId: vestTemplate })).rejects.toThrow(/measurement template .* of its kind of garment/)
  })

  it('gives GTINs from a range: the next only moves up, at most to last + 1; limits fixed once used; never deleted', async () => {
    const copy = (changes: Record<string, unknown>) => copyRow(office(), 'GtinRange', s.gtinRangeId, { id: randomUUID(), ...changes })
    await expect(copy({ gs1Prefix: '800' })).rejects.toThrow(/4 to 12 digits, not 800/)
    await expect(copy({ gs1Prefix: '2009999', lastReference: 100000, nextReference: 100 })).rejects.toThrow(/inside the 100000 item references its prefix leaves/)
    await expect(copy({ firstReference: 10, lastReference: 5, nextReference: 10 })).rejects.toThrow(/runs from 10 to 5/)
    await expect(copy({ nextReference: 1001 })).rejects.toThrow(/\(next 1001\)/)
    await expect(copy({ name: '' })).rejects.toThrow(/a name of 1 to 100 characters/)
    expect(await copy({ gs1Prefix: '200999999999', firstReference: 0, lastReference: 0, nextReference: 0 })).toBe(1)
    const id = randomUUID()
    expect(await copy({ id, nextReference: 100 })).toBe(1)
    expect(await update(office(), 'GtinRange', id, `"lastReference" = 500`)).toBe(1)
    expect(await update(office(), 'GtinRange', id, `"nextReference" = 101`)).toBe(1)
    await expect(update(office(), 'GtinRange', id, `"nextReference" = 100`)).rejects.toThrow(/never goes back \(101 given\)/)
    await expect(update(office(), 'GtinRange', id, `"lastReference" = 600`)).rejects.toThrow(/has given numbers: its prefix and limits never change/)
    await expect(update(office(), 'GtinRange', id, `"companyId" = $2::uuid`, key('company:B'))).rejects.toThrow(/never changes/)
    expect(await update(office(), 'GtinRange', id, `"nextReference" = 501, status = 'ARCHIVED'`)).toBe(1)
    await expect(run(office(), `DELETE FROM "GtinRange" WHERE id = $1::uuid`, id)).rejects.toThrow(/permission denied/)
    await expect(admin(`DELETE FROM "GtinRange" WHERE id = $1`, [id])).rejects.toThrow(/archived, never deleted/)
  })

  it('keeps a brand\'s branding set: a brand, its own files, library colours, packaging rules; one active per company and brand', async () => {
    const copy = (changes: Record<string, unknown>) => copyRow(office(), 'BrandingSet', s.brandingSetIds.archived, { id: randomUUID(), code: tag('T-BS'), ...changes })
    await expect(copy({ partyId: A.P2 })).rejects.toThrow(/a party with the CUSTOMER or BRAND role/)
    await expect(copy({ status: 'ACTIVE' })).rejects.toThrow(/BrandingSet_one_active_per_brand/)
    await expect(copy({ brandColourIds: [randomUUID()] })).rejects.toThrow(/colours of the library/)
    await expect(copy({ brandColourIds: [ids.colourBlack, ids.colourBlack] })).rejects.toThrow(/each logo, artwork file and colour once/)
    const rules = (value: unknown) => copy({ packagingRules: value })
    await expect(rules([{ key: 'Poly Bag', text: 'x' }])).rejects.toThrow(/a key of lower-case letters/)
    await expect(rules([{ key: 'a', text: 'x' }, { key: 'a', text: 'y' }])).rejects.toThrow(/use the key "a" once/)
    await expect(rules([{ key: 'a', text: 'x', quantity: '1' }])).rejects.toThrow(/all three or none/)
    await expect(rules([{ key: 'a', text: 'x', itemId: s.packagingItemId, quantity: 1, per: 'GARMENT' }])).rejects.toThrow(/a quantity above 0/)
    await expect(rules([{ key: 'a', text: 'x', itemId: s.packagingItemId, quantity: '1', per: 'BOX' }])).rejects.toThrow(/GARMENT, PACK or CARTON/)
    await expect(rules([{ key: 'a', text: 'x', itemId: randomUUID(), quantity: '1', per: 'PACK' }])).rejects.toThrow(/which is not in the library/)
    await expect(rules([{ key: 'a', text: 'x', note: 'y' }])).rejects.toThrow(/have no "note"/)
    // Files: its own (recordType BrandingSet), a logo a picture.
    const id = randomUUID()
    expect(await copy({ id, packagingRules: [{ key: 'carton', text: 'Ten per carton', itemId: s.packagingItemId, quantity: '0.1', per: 'GARMENT' }] })).toBe(1)
    await expect(update(office(), 'BrandingSet', id, `"logoFileIds" = ARRAY[$2::uuid]`, await fileOf('Style', s.styleIds.jkt01))).rejects.toThrow(/names its own files/)
    await expect(update(office(), 'BrandingSet', id, `"logoFileIds" = ARRAY[$2::uuid]`, await fileOf('BrandingSet', id, 'DOCUMENT'))).rejects.toThrow(/a logo of branding set .* is a picture \(PHOTO\)/)
    expect(await update(office(), 'BrandingSet', id, `"logoFileIds" = ARRAY[$2::uuid], "labelArtworkFileIds" = ARRAY[$3::uuid]`, await fileOf('BrandingSet', id), await fileOf('BrandingSet', id, 'DOCUMENT'))).toBe(1)
    await expect(update(office(), 'BrandingSet', id, `"labelArtworkFileIds" = ARRAY[$2::uuid]`, randomUUID())).rejects.toThrow(/is no file/)
    await expect(update(office(), 'BrandingSet', id, `"partyId" = $2::uuid`, key('party:P3'))).rejects.toThrow(/company and brand of branding set .* never change/)
    // A new active set: the old one archived first.
    await expect(update(office(), 'BrandingSet', id, `status = 'ACTIVE'`)).rejects.toThrow(/BrandingSet_one_active_per_brand/)
    expect(await update(office(), 'BrandingSet', s.brandingSetIds.active, `status = 'ARCHIVED'`)).toBe(1)
    expect(await update(office(), 'BrandingSet', id, `status = 'ACTIVE'`)).toBe(1)
    expect(await update(office(), 'BrandingSet', id, `status = 'ARCHIVED'`)).toBe(1)
    expect(await update(office(), 'BrandingSet', s.brandingSetIds.active, `status = 'ACTIVE'`)).toBe(1)
  })

  it('keeps the product settings: a percent exactly with WARN_ABOVE, per-kind rules of their shape', async () => {
    const copy = (changes: Record<string, unknown>) => copyRow(office(), 'ProductSettings', A.company, { id: randomUUID(), ...changes })
    await expect(copy({ consumptionTolerancePct: null })).rejects.toThrow(/exactly with WARN_ABOVE/)
    await expect(copy({ consumptionTolerance: 'MATCH' })).rejects.toThrow(/exactly with WARN_ABOVE/)
    await expect(copy({ consumptionTolerancePct: '100.5' })).rejects.toThrow(/at most 100/)
    await expect(copy({ consumptionTolerance: null, consumptionTolerancePct: null, consumptionToleranceByKind: { SILK: { rule: 'MATCH' } } })).rejects.toThrow(/for "SILK"/)
    await expect(copy({ consumptionToleranceByKind: { LEATHER: { rule: 'WARN_ABOVE' } } })).rejects.toThrow(/for "LEATHER"/)
    await expect(copy({ consumptionToleranceByKind: { LEATHER: { rule: 'MATCH', percent: '5' } } })).rejects.toThrow(/for "LEATHER"/)
    await expect(copy({ consumptionToleranceByKind: { LEATHER: { rule: 'WARN_ABOVE', percent: 5 } } })).rejects.toThrow(/for "LEATHER"/)
    await expect(copy({ consumptionToleranceByKind: { LEATHER: 'MATCH' } })).rejects.toThrow(/for "LEATHER"/)
    await expect(copy({ consumptionToleranceByKind: [] })).rejects.toThrow(/an object of kinds/)
    expect(await copy({ consumptionToleranceByKind: { PROTECTOR: { rule: 'MATCH' }, LEATHER: { rule: 'WARN_ABOVE', percent: '7.5' } } })).toBe(1)
    await expect(update(office(), 'ProductSettings', A.company, `"companyId" = NULL`)).rejects.toThrow(/never changes/)
    expect(await update(office(), 'ProductSettings', a.tenantId, `"editRuleSampling" = 'FREE'`)).toBe(1)
  })
})

describe('what the floor reads', () => {
  it('reads names, pictures, revision files and the product settings; nothing else here, and writes none', async () => {
    for (const table of ['StyleText', 'StyleImage', 'StyleRevisionFile', 'ProductSettings']) {
      expect((await sql(floor(), `SELECT count(*)::int AS n FROM "${table}"`))[0]!.n).toBeGreaterThan(0)
      await expect(run(floor(), `UPDATE "${table}" SET version = version WHERE false`)).rejects.toThrow(/permission denied/)
    }
    for (const table of ['ProductTypeProfile', 'GtinRange', 'BrandingSet']) await expect(sql(floor(), `SELECT 1 FROM "${table}" LIMIT 1`)).rejects.toThrow(/permission denied/)
    // A style's new columns and a material's approval reach the station.
    expect(await sql(floor(), `SELECT lifecycle::text FROM "Style" WHERE id = $1::uuid`, s.styleIds.jkt02)).toEqual([{ lifecycle: 'IN_PRODUCTION' }])
    expect(await sql(floor(), `SELECT approval::text FROM "Item" WHERE id = $1::uuid`, s.blockedItemId)).toEqual([{ approval: 'BLOCKED' }])
  })
})
