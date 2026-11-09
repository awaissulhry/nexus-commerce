import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedOptions, type OptionsSeed } from '../seed/options'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'

/**
 * BOM depth and the option library (W2b-4, schema wave 28/33, B-W2b-211, …_bom_options_w2b_guards) on a database built from the
 * migrations and seeded, through the real login and the scoped client:
 *   - the rows made before the wave: every revision makes 1 PCS, every line is in no section, group, option or kit;
 *   - a line's group row (same revision, no circle), its sub-assembly (both columns, another style, a COMPONENT we make in PCS,
 *     PAIR or SET, DRAFT or RELEASED when named, no circle of styles, at most 10 levels), customer-supplied material (a customer
 *     or brand, no supplier), the source rule's key, an option line of a group the style offers;
 *   - a revision's output (1-1000 PCS, PAIR or SET, frozen once released) and its release: refused while a sub-assembly is not
 *     RELEASED or an alternate is BLOCKED;
 *   - alternates: a part of the revision (frozen with it, removed with their line), not the line's material, not BLOCKED, a
 *     certificate check for a PPE component;
 *   - option groups, values (the free-text rule), rules, effects (each kind its own columns), style offers (one ACTIVE, of the
 *     style's company, removed only while no line or routing step is for their values), a routing step's option values;
 *   - what the floor reads (alternates, groups, values) and does not (rules, effects, offers).
 * The refusals are check_violation (23514) or restrict_violation (23001); their messages are read through raw SQL.
 */

const NS = 'w2b-211-a'

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let o: OptionsSeed
let ids: { leather: string; lining: string; protector: string; blocked: string; jacketRouting: string }

const key = (name: string): string => seedUuid(NS, name)
const A = { company: key('company:A'), site: key('site:A1'), P1: key('party:P1'), P2: key('party:P2') }
const office = (): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId: a.actorId })
const floor = (): FactoryScope => ({ audience: 'floor', tenantId: a.tenantId, actorId: randomUUID(), siteId: A.site })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const sql = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$queryRawUnsafe<Record<string, unknown>[]>(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
const one = async (text: string, values: unknown[] = []) => (await admin(text, values))[0]!
/** INSERT a copy of row `id` of `table` with `changes` (a jsonb object of columns). */
const copyRow = (scope: FactoryScope, table: string, id: string, changes: Record<string, unknown>) =>
  run(scope, `INSERT INTO "${table}" SELECT * FROM jsonb_populate_record(NULL::"${table}", (SELECT to_jsonb(r) || $1::jsonb FROM "${table}" r WHERE r.id = $2::uuid))`, JSON.stringify(changes), id)
/** UPDATE row `id` of `table`: `set` is the SET list. */
const update = (scope: FactoryScope, table: string, id: string, set: string, ...values: unknown[]) => run(scope, `UPDATE "${table}" SET ${set} WHERE id = $1::uuid`, id, ...values)
const remove = (scope: FactoryScope, table: string, id: string) => run(scope, `DELETE FROM "${table}" WHERE id = $1::uuid`, id)
const tag = (prefix: string): string => `${prefix}-${randomUUID().slice(0, 8)}`
let seq = 100

/** A new tenant-wide style (a copy of SEED-JKT-05 with no offers) with a DRAFT revision 1; `changes` go on the style. */
async function draftStyle(changes: Record<string, unknown> = {}): Promise<{ styleId: string; revisionId: string }> {
  const styleId = randomUUID()
  const revisionId = randomUUID()
  expect(await copyRow(office(), 'Style', o.jacketStyleId, { id: styleId, code: tag('T-STY'), ...changes })).toBe(1)
  expect(await copyRow(office(), 'StyleRevision', o.jacketRevisionId, { id: revisionId, styleId, revision: 1 })).toBe(1)
  return { styleId, revisionId }
}
/** Another DRAFT revision of a style. */
async function draftRevision(styleId: string, revision: number): Promise<string> {
  const revisionId = randomUUID()
  expect(await copyRow(office(), 'StyleRevision', o.jacketRevisionId, { id: revisionId, styleId, revision })).toBe(1)
  return revisionId
}
const release = (revisionId: string) => update(office(), 'StyleRevision', revisionId, `status = 'RELEASED', "releasedAt" = now(), "releasedById" = $2::uuid`, a.actorId)
/** A plain line (a copy of SEED-JKT-05's lining line without its W2b-4 columns) on `revisionId` of `styleId`. */
async function line(styleId: string, revisionId: string, changes: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID()
  seq += 1
  expect(
    await copyRow(office(), 'BomLine', o.bomLineIds.lining, {
      id,
      styleId,
      revisionId,
      seq,
      itemColourId: null,
      section: null,
      parentLineId: null,
      subAssemblyStyleId: null,
      subAssemblyRevisionId: null,
      customerSuppliedByPartyId: null,
      issueToSubcontract: false,
      sourceKey: null,
      optionValueId: null,
      routingSeq: null,
      ...changes,
    }),
  ).toBe(1)
  return id
}
/** A line whose sub-assembly is `sub` (the seeded liner component, 1 PCS). */
const subLine = (styleId: string, revisionId: string, sub: { styleId: string; revisionId: string }, changes: Record<string, unknown> = {}) =>
  line(styleId, revisionId, { itemId: o.itemIds.linerComponent, uom: 'PCS', qty: '1.0000', subAssemblyStyleId: sub.styleId, subAssemblyRevisionId: sub.revisionId, ...changes })
const offer = async (styleId: string, groupId: string, changes: Record<string, unknown> = {}): Promise<string> => {
  const id = randomUUID()
  expect(await copyRow(office(), 'StyleOptionGroup', o.offerIds.liner, { id, styleId, groupId, minPicks: null, maxPicks: null, defaultValueId: null, status: 'ACTIVE', ...changes })).toBe(1)
  return id
}

beforeAll(async () => {
  db = await migratedDatabase('bomoptsw2b')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  o = await seedOptions({ db: factory, namespace: NS })
  const byCode = async (table: string, code: string) => (await one(`SELECT id::text AS id FROM "${table}" WHERE "tenantId" = $1 AND code = $2`, [a.tenantId, code])).id as string
  const blocked = randomUUID()
  ids = {
    leather: await byCode('Item', 'SEED-LEA-100'),
    lining: await byCode('Item', 'SEED-LIN-200'),
    protector: await byCode('Item', 'SEED-PRO-300'),
    blocked,
    jacketRouting: (await one(`SELECT id::text AS id FROM "RoutingOperation" WHERE "revisionId" = $1 ORDER BY seq LIMIT 1`, [o.jacketRevisionId])).id as string,
  }
  expect(
    await copyRow(office(), 'Item', o.itemIds.thread, { id: blocked, code: tag('T-BLK'), approval: 'BLOCKED', approvedAt: new Date().toISOString(), approvedById: a.actorId, approvalNote: 'Made-up test refusal.' }),
  ).toBe(1)
}, 300_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

describe('the rows made before the wave and the seed', () => {
  it('leaves every revision making 1 PCS and every older line in no section, group, option or kit', async () => {
    const revisions = await admin(`SELECT DISTINCT "outputQuantity" AS q, "outputUom"::text AS u FROM "StyleRevision" WHERE "tenantId" = $1`, [a.tenantId])
    expect(revisions).toEqual([{ q: 1, u: 'PCS' }])
    const older = await admin(
      `SELECT count(*)::int AS n FROM "BomLine" b JOIN "Style" s ON s.id = b."styleId"
        WHERE b."tenantId" = $1 AND s.code NOT IN ('SEED-JKT-05', 'SEED-LNR-01')
          AND (b.section IS NOT NULL OR b."parentLineId" IS NOT NULL OR b."subAssemblyRevisionId" IS NOT NULL OR b."optionValueId" IS NOT NULL
               OR b."customerSuppliedByPartyId" IS NOT NULL OR b."sourceKey" IS NOT NULL OR b."issueToSubcontract")`,
      [a.tenantId],
    )
    expect(older).toEqual([{ n: 0 }])
    // The seed: the liner released, the jacket's sub-assembly line for the liner option, its grouped thread, the brand's label.
    expect(await one(`SELECT status::text AS status, "effectiveFrom" IS NOT NULL AS effective FROM "StyleRevision" WHERE id = $1`, [o.linerRevisionId])).toEqual({ status: 'RELEASED', effective: true })
    expect(await one(`SELECT "subAssemblyRevisionId"::text AS sub, "optionValueId"::text AS value FROM "BomLine" WHERE id = $1`, [o.bomLineIds.liner])).toEqual({ sub: o.linerRevisionId, value: o.valueIds.linerYes })
    expect(await one(`SELECT "parentLineId"::text AS parent, "issueToSubcontract" AS kit FROM "BomLine" WHERE id = $1`, [o.bomLineIds.thread])).toEqual({ parent: o.bomLineIds.shell, kit: true })
    expect(await one(`SELECT "customerSuppliedByPartyId"::text AS party, "sourceKey" FROM "BomLine" WHERE id = $1`, [o.bomLineIds.label])).toEqual({ party: A.P1, sourceKey: 'branding:brand-label' })
  })
})

describe('a BOM line: group row, sub-assembly, customer-supplied material, source rule, option', () => {
  it('is grouped under another line of the same revision, never itself or a line grouped under it', async () => {
    const { styleId, revisionId } = await draftStyle()
    const top = await line(styleId, revisionId)
    const middle = await line(styleId, revisionId, { parentLineId: top })
    const bottom = await line(styleId, revisionId, { parentLineId: middle })
    await expect(update(office(), 'BomLine', top, `"parentLineId" = id`)).rejects.toThrow(/is not grouped under itself/)
    await expect(update(office(), 'BomLine', top, `"parentLineId" = $2::uuid`, bottom)).rejects.toThrow(/not grouped under a line grouped under it \(a circle\)/)
    // A line of another revision: the reference refuses it.
    const other = await draftStyle()
    await expect(line(other.styleId, other.revisionId, { parentLineId: top })).rejects.toThrow(/foreign key/i)
    // The group row is kept while lines are grouped under it.
    await expect(remove(office(), 'BomLine', middle)).rejects.toThrow(/foreign key/i)
    expect(await update(office(), 'BomLine', bottom, `"parentLineId" = $2::uuid`, top)).toBe(1)
    expect(await remove(office(), 'BomLine', middle)).toBe(1)
  })

  it('names a sub-assembly by both columns: another style, a COMPONENT we make in PCS, PAIR or SET, not sent by the customer', async () => {
    const parent = await draftStyle()
    const liner = { styleId: o.linerStyleId, revisionId: o.linerRevisionId }
    await expect(line(parent.styleId, parent.revisionId, { itemId: o.itemIds.linerComponent, uom: 'PCS', subAssemblyStyleId: liner.styleId })).rejects.toThrow(/both or neither/)
    await expect(subLine(parent.styleId, parent.revisionId, parent)).rejects.toThrow(/names its own style as a sub-assembly/)
    await expect(subLine(parent.styleId, parent.revisionId, liner, { itemId: ids.lining, uom: 'PCS' })).rejects.toThrow(/is a COMPONENT we make .* not SEED-LIN-200 \(LINING BUY\)/)
    await expect(subLine(parent.styleId, parent.revisionId, liner, { uom: 'M' })).rejects.toThrow(/in PCS, PAIR or SET, not M/)
    await expect(subLine(parent.styleId, parent.revisionId, liner, { customerSuppliedByPartyId: A.P1 })).rejects.toThrow(/sub-assembly we make, so the customer does not send it/)
    const bought = randomUUID()
    expect(await copyRow(office(), 'Item', o.itemIds.linerComponent, { id: bought, code: tag('T-CMP'), sourcing: 'BUY' })).toBe(1)
    await expect(subLine(parent.styleId, parent.revisionId, liner, { itemId: bought })).rejects.toThrow(/COMPONENT we make/)
    const id = await subLine(parent.styleId, parent.revisionId, liner, { uom: 'PAIR' })
    await expect(update(office(), 'BomLine', id, `uom = 'M2'`)).rejects.toThrow(/in PCS, PAIR or SET/)
    await expect(update(office(), 'BomLine', id, `"subAssemblyRevisionId" = NULL`)).rejects.toThrow(/both or neither/)
    expect(await update(office(), 'BomLine', id, `"subAssemblyRevisionId" = NULL, "subAssemblyStyleId" = NULL`)).toBe(1)
  })

  it('names a DRAFT or RELEASED revision, never an OBSOLETE one; a released parent holds RELEASED parts only', async () => {
    const part = await draftStyle()
    const parent = await draftStyle()
    // A draft part under a draft parent: fine; the parent is not released while the part is a draft.
    await subLine(parent.styleId, parent.revisionId, part)
    await expect(release(parent.revisionId)).rejects.toThrow(/is not released: BOM line \d+ takes sub-assembly T-STY-\w+ revision 1, which is DRAFT \(no draft part under a released parent/)
    expect(await one(`SELECT status::text AS status FROM "StyleRevision" WHERE id = $1`, [parent.revisionId])).toEqual({ status: 'DRAFT' })
    expect(await release(part.revisionId)).toBe(1)
    expect(await release(parent.revisionId)).toBe(1)
    // The part's revision 2 replaces revision 1: an obsolete revision is not named anew, and a draft parent naming it waits.
    const waiting = await draftStyle()
    await subLine(waiting.styleId, waiting.revisionId, part)
    const part2 = await draftRevision(part.styleId, 2)
    expect(await update(office(), 'StyleRevision', part.revisionId, `status = 'OBSOLETE'`)).toBe(1)
    expect(await release(part2)).toBe(1)
    const late = await draftStyle()
    await expect(subLine(late.styleId, late.revisionId, part)).rejects.toThrow(/which is OBSOLETE: name its draft or released revision/)
    await expect(release(waiting.revisionId)).rejects.toThrow(/which is OBSOLETE \(no draft part under a released parent/)
    await subLine(late.styleId, late.revisionId, { styleId: part.styleId, revisionId: part2 })
    expect(await release(late.revisionId)).toBe(1)
  })

  it('never makes a circle of styles, and a BOM has at most 10 levels', async () => {
    const x = await draftStyle()
    const y = await draftStyle()
    await subLine(x.styleId, x.revisionId, y)
    await expect(subLine(y.styleId, y.revisionId, x)).rejects.toThrow(/makes a circle: a style would be inside its own sub-assemblies/)
    // Deeper: x → y → z, then z → another revision of x.
    const z = await draftStyle()
    await subLine(y.styleId, y.revisionId, z)
    const x2 = await draftRevision(x.styleId, 2)
    await expect(subLine(z.styleId, z.revisionId, { styleId: x.styleId, revisionId: x2 })).rejects.toThrow(/makes a circle/)
    // A chain of 10 levels, then an 11th refused (at the bottom and at the top).
    const chain: { styleId: string; revisionId: string }[] = []
    for (let i = 0; i < 11; i += 1) chain.push(await draftStyle())
    for (let i = 0; i < 9; i += 1) await subLine(chain[i]!.styleId, chain[i]!.revisionId, chain[i + 1]!)
    await expect(subLine(chain[9]!.styleId, chain[9]!.revisionId, chain[10]!)).rejects.toThrow(/more than 10 levels/)
    await expect(subLine(chain[10]!.styleId, chain[10]!.revisionId, chain[0]!)).rejects.toThrow(/more than 10 levels/)
  })

  it('is sent by a customer or brand and then bought from nobody', async () => {
    const { styleId, revisionId } = await draftStyle()
    await expect(line(styleId, revisionId, { customerSuppliedByPartyId: A.P2 })).rejects.toThrow(/a party with the CUSTOMER or BRAND role/)
    await expect(line(styleId, revisionId, { customerSuppliedByPartyId: A.P1, supplierId: A.P2 })).rejects.toThrow(/is sent by the customer, so it is not bought/)
    const id = await line(styleId, revisionId, { customerSuppliedByPartyId: A.P1, issueToSubcontract: true })
    await expect(update(office(), 'BomLine', id, `"supplierId" = $2::uuid`, A.P2)).rejects.toThrow(/not bought/)
  })

  it('names the rule that made it as "<source>:<key>"', async () => {
    const { styleId, revisionId } = await draftStyle()
    for (const bad of ['polybag', 'Branding:polybag', 'branding:', 'branding:poly bag', 'b:polybag'])
      await expect(line(styleId, revisionId, { sourceKey: bad })).rejects.toThrow(/as "<source>:<key>"/)
    await line(styleId, revisionId, { sourceKey: 'compliance:EN17092-label' })
  })

  it('is for an ACTIVE option value of a group its style offers; the offer is kept while lines are for it', async () => {
    const { styleId, revisionId } = await draftStyle()
    await expect(line(styleId, revisionId, { optionValueId: o.valueIds.perfFront })).rejects.toThrow(/whose group its style does not offer/)
    const offerId = await offer(styleId, o.groupIds.perforation)
    const id = await line(styleId, revisionId, { optionValueId: o.valueIds.perfFront })
    // An archived value is not named anew.
    const archived = randomUUID()
    expect(await copyRow(office(), 'OptionValue', o.valueIds.perfFull, { id: archived, code: tag('T-OLD'), status: 'ARCHIVED' })).toBe(1)
    await expect(update(office(), 'BomLine', id, `"optionValueId" = $2::uuid`, archived)).rejects.toThrow(/which is archived/)
    // Removing the offer is refused while the line is for one of its values; archiving it is not, and then no new line is for it.
    await expect(remove(office(), 'StyleOptionGroup', offerId)).rejects.toThrow(/is kept while a BOM line or routing step of the style is for one of its values: archive it/)
    expect(await update(office(), 'StyleOptionGroup', offerId, `status = 'ARCHIVED'`)).toBe(1)
    await expect(line(styleId, revisionId, { optionValueId: o.valueIds.perfFull })).rejects.toThrow(/does not offer/)
    expect(await remove(office(), 'BomLine', id)).toBe(1)
    expect(await remove(office(), 'StyleOptionGroup', offerId)).toBe(1)
  })
})

describe('a revision: its output and its release', () => {
  it('makes 1 to 1000 units of PCS, PAIR or SET, frozen once released', async () => {
    const { revisionId } = await draftStyle()
    await expect(update(office(), 'StyleRevision', revisionId, `"outputQuantity" = 0`)).rejects.toThrow(/makes 1 to 1000 units of PCS, PAIR or SET, not 0 PCS/)
    await expect(update(office(), 'StyleRevision', revisionId, `"outputQuantity" = 1001`)).rejects.toThrow(/1 to 1000 units/)
    await expect(update(office(), 'StyleRevision', revisionId, `"outputUom" = 'KG'`)).rejects.toThrow(/not 1 KG/)
    expect(await update(office(), 'StyleRevision', revisionId, `"outputQuantity" = 2, "outputUom" = 'PAIR'`)).toBe(1)
    expect(await release(revisionId)).toBe(1)
    await expect(update(office(), 'StyleRevision', revisionId, `"outputQuantity" = 1`)).rejects.toThrow(/it never changes, a change is a new revision/)
  })
})

describe('a line\'s alternates', () => {
  it('are another material, never BLOCKED, first choice from 1; a PPE component needs a certificate check', async () => {
    const { styleId, revisionId } = await draftStyle()
    const lining = await line(styleId, revisionId)
    const protector = await line(styleId, revisionId, { itemId: ids.protector, uom: 'PCS', qty: '2.0000' })
    const alternate = (bomLineId: string, changes: Record<string, unknown>) =>
      copyRow(office(), 'BomLineAlternate', o.alternateIds.lining, { id: randomUUID(), revisionId, bomLineId, itemColourId: null, qty: null, certificateCheck: false, note: null, ...changes })
    await expect(alternate(lining, { priority: 0, itemId: o.itemIds.airflowLining })).rejects.toThrow(/priority starts at 1/)
    await expect(alternate(lining, { priority: 1, itemId: ids.lining })).rejects.toThrow(/another material than its line's own/)
    await expect(alternate(lining, { priority: 1, itemId: ids.blocked })).rejects.toThrow(/is blocked: it is no alternate/)
    await expect(alternate(lining, { priority: 1, itemId: o.itemIds.airflowLining, qty: '0' })).rejects.toThrow(/above 0/)
    await expect(alternate(protector, { priority: 1, itemId: o.itemIds.protector2 })).rejects.toThrow(/needs a certificate check/)
    // An ordinary line whose alternate is a PPE component needs it too.
    await expect(alternate(lining, { priority: 1, itemId: o.itemIds.protector2 })).rejects.toThrow(/needs a certificate check/)
    expect(await alternate(protector, { priority: 1, itemId: o.itemIds.protector2, certificateCheck: true, allowedWhen: 'WITH_APPROVAL' })).toBe(1)
    const first = randomUUID()
    expect(await alternate(lining, { id: first, priority: 1, itemId: o.itemIds.airflowLining, allowedWhen: 'ALWAYS' })).toBe(1)
    await expect(alternate(lining, { priority: 1, itemId: o.itemIds.thread })).rejects.toThrow(/unique/i)
    // The line's material changed: not to one of its alternates; to a PPE component only when each alternate is checked.
    await expect(update(office(), 'BomLine', lining, `"itemId" = $2::uuid`, o.itemIds.airflowLining)).rejects.toThrow(/one of its own alternates/)
    await expect(update(office(), 'BomLine', lining, `"itemId" = $2::uuid, uom = 'PCS'`, ids.protector)).rejects.toThrow(/each of its alternates needs a certificate check/)
    await expect(update(office(), 'BomLineAlternate', first, `"bomLineId" = $2::uuid, priority = 9`, protector)).rejects.toThrow(/line and creation of alternate .* never change/)
    // Removed with its line.
    expect(await remove(office(), 'BomLine', lining)).toBe(1)
    expect(await admin(`SELECT 1 FROM "BomLineAlternate" WHERE id = $1`, [first])).toEqual([])
  })

  it('are frozen with a released revision, whose release waits while one is BLOCKED', async () => {
    const { styleId, revisionId } = await draftStyle()
    const lining = await line(styleId, revisionId)
    const material = randomUUID()
    expect(await copyRow(office(), 'Item', o.itemIds.airflowLining, { id: material, code: tag('T-LIN') })).toBe(1)
    const id = randomUUID()
    expect(await copyRow(office(), 'BomLineAlternate', o.alternateIds.lining, { id, revisionId, bomLineId: lining, priority: 1, itemId: material })).toBe(1)
    expect(await update(office(), 'Item', material, `approval = 'BLOCKED', "approvedAt" = now(), "approvedById" = $2::uuid, "approvalNote" = 'Made-up test refusal.'`, a.actorId)).toBe(1)
    await expect(release(revisionId)).rejects.toThrow(/is not released: an alternate in its BOM is the blocked material T-LIN-/)
    expect(await update(office(), 'Item', material, `approval = 'APPROVED', "approvalNote" = NULL`)).toBe(1)
    expect(await release(revisionId)).toBe(1)
    await expect(update(office(), 'BomLineAlternate', id, `priority = 2`)).rejects.toThrow(/is RELEASED; its "BomLineAlternate" rows never change/)
    await expect(remove(office(), 'BomLineAlternate', id)).rejects.toThrow(/never change/)
    await expect(copyRow(office(), 'BomLineAlternate', id, { id: randomUUID(), priority: 2 })).rejects.toThrow(/never change/)
    await expect(run(office(), `TRUNCATE "BomLineAlternate"`)).rejects.toThrow(/TRUNCATE|permission denied/)
  })
})

describe('the option library', () => {
  it('keeps a group\'s code, names, kind and picks; its company never changes', async () => {
    const group = (changes: Record<string, unknown>) => copyRow(office(), 'OptionGroup', o.groupIds.perforation, { id: randomUUID(), code: tag('T-OG'), ...changes })
    await expect(group({ code: 'TWO WORDS' })).rejects.toThrow(/code is 1 to 60 characters without spaces/)
    await expect(group({ nameI18n: { it: ' ' } })).rejects.toThrow(/names per language/)
    await expect(group({ kind: 'SINGLE', maxPicks: 2 })).rejects.toThrow(/a SINGLE group at most 1/)
    await expect(group({ kind: 'SINGLE', maxPicks: null })).rejects.toThrow(/a SINGLE group at most 1/)
    await expect(group({ kind: 'MULTI', minPicks: 3, maxPicks: 2 })).rejects.toThrow(/not fewer than at least/)
    const id = randomUUID()
    expect(await group({ id, kind: 'MULTI', minPicks: 0, maxPicks: null, description: 'Two lines\nof words.' })).toBe(1)
    await expect(update(office(), 'OptionGroup', id, `"companyId" = $2::uuid`, A.company)).rejects.toThrow(/company and creation of option group .* never change/)
    // A value that takes no free text keeps its group from becoming FREE_TEXT.
    expect(await copyRow(office(), 'OptionValue', o.valueIds.perfFront, { id: randomUUID(), groupId: id, code: 'PLAIN' })).toBe(1)
    await expect(update(office(), 'OptionGroup', id, `kind = 'FREE_TEXT'`)).rejects.toThrow(/becomes FREE_TEXT only when every value of it takes a free text/)
    // A style offering it with more than one keeps it from becoming SINGLE.
    const { styleId } = await draftStyle()
    await offer(styleId, id, { maxPicks: 3 })
    await expect(update(office(), 'OptionGroup', id, `kind = 'SINGLE', "maxPicks" = 1`)).rejects.toThrow(/becomes SINGLE only when no style offers it with more than one value/)
    await expect(run(office(), `DELETE FROM "OptionGroup" WHERE id = $1::uuid`, id)).rejects.toThrow(/permission denied/)
  })

  it('keeps a value\'s free-text rule: a length, a pattern that is a regular expression; always in a FREE_TEXT group', async () => {
    const value = (changes: Record<string, unknown>) => copyRow(office(), 'OptionValue', o.valueIds.perfFront, { id: randomUUID(), code: tag('T-V'), ...changes })
    await expect(value({ freeText: true })).rejects.toThrow(/free text of 1 to 500 characters at most/)
    await expect(value({ freeText: true, freeTextMaxLength: 501 })).rejects.toThrow(/1 to 500 characters/)
    await expect(value({ freeText: true, freeTextMaxLength: 12, freeTextPattern: '[A-Z' })).rejects.toThrow(/regular expression/)
    await expect(value({ freeTextMaxLength: 12 })).rejects.toThrow(/only when it takes a free text/)
    await expect(value({ groupId: o.groupIds.name, freeText: false })).rejects.toThrow(/is of a FREE_TEXT group, so it takes a free text/)
    await expect(value({ seq: -1 })).rejects.toThrow(/a place from 0/)
    expect(await value({ freeText: true, freeTextMaxLength: 3, freeTextPattern: '^[0-9]{1,3}$' })).toBe(1)
    await expect(update(office(), 'OptionValue', o.valueIds.perfFront, `"groupId" = $2::uuid`, o.groupIds.liner)).rejects.toThrow(/group and creation of option value FRONT never change/)
  })

  it('keeps a rule about two values, of the group\'s company, not archived', async () => {
    const rule = (changes: Record<string, unknown>) => copyRow(office(), 'OptionRule', key('options:rule:LINER-needs-STD'), { id: randomUUID(), ...changes })
    await expect(rule({ valueId: o.valueIds.linerYes, otherValueId: o.valueIds.linerYes })).rejects.toThrow(/about one value and another, not the same/)
    await expect(rule({ valueId: null, otherValueId: o.valueIds.linerYes })).rejects.toThrow(/about its whole group names a value of another group, not YES/)
    await expect(rule({ messageI18n: { it: '' } })).rejects.toThrow(/words per language/)
    // The value it is about belongs to its group (the reference).
    await expect(rule({ valueId: o.valueIds.perfFront })).rejects.toThrow(/foreign key/i)
    const archived = randomUUID()
    expect(await copyRow(office(), 'OptionValue', o.valueIds.armourNone, { id: archived, code: tag('T-OLD'), status: 'ARCHIVED' })).toBe(1)
    await expect(rule({ otherValueId: archived })).rejects.toThrow(/which is archived/)
    // A value of a company's group is not named by a tenant-wide group's rule.
    const companyGroup = randomUUID()
    const companyValue = randomUUID()
    expect(await copyRow(office(), 'OptionGroup', o.groupIds.armour, { id: companyGroup, code: tag('T-OG'), companyId: A.company })).toBe(1)
    expect(await copyRow(office(), 'OptionValue', o.valueIds.armourStd, { id: companyValue, groupId: companyGroup })).toBe(1)
    await expect(rule({ otherValueId: companyValue })).rejects.toThrow(/of another company/)
    expect(await rule({ valueId: null, kind: 'EXCLUDES', severity: 'BLOCK', otherValueId: o.valueIds.perfFull, messageI18n: null })).toBe(1)
  })

  it('keeps each effect to its own columns, its materials and operation of the group\'s company, never a BLOCKED material put in', async () => {
    const effect = (changes: Record<string, unknown>) =>
      copyRow(office(), 'OptionEffect', key('options:effect:NAME:thread'), {
        id: randomUUID(),
        kind: 'BOM_ADD',
        itemId: o.itemIds.thread,
        itemColourId: null,
        targetItemId: null,
        qty: '5.0000',
        uom: 'M',
        sizeQuantities: null,
        section: null,
        operationId: null,
        minutes: null,
        priceDelta: null,
        currency: null,
        pricePct: null,
        note: null,
        ...changes,
      })
    const columns = /fills its own columns and no other/
    await expect(effect({ operationId: o.operationId })).rejects.toThrow(columns)
    await expect(effect({ itemId: null })).rejects.toThrow(columns)
    await expect(effect({ uom: null })).rejects.toThrow(/with its unit and a quantity above 0/)
    await expect(effect({ qty: null })).rejects.toThrow(/with its unit and a quantity above 0/)
    await expect(effect({ qty: '0' })).rejects.toThrow(/quantity above 0/)
    await expect(effect({ sizeQuantities: { '50': 1.5 } })).rejects.toThrow(/quantities per size of option effect .* give size 50 a quantity above 0 as a decimal string/)
    await expect(effect({ sizeQuantities: {} })).rejects.toThrow(/name 1 to 100 sizes/)
    await expect(effect({ qty: null, sizeQuantities: { '50': '4.5000', '52 R': '5' } })).rejects.toThrow(/keyed by size codes/)
    expect(await effect({ qty: null, sizeQuantities: { '50': '4.5000' }, section: 'THREAD' })).toBe(1)
    await expect(effect({ itemId: ids.blocked })).rejects.toThrow(/is blocked: no option puts it in/)
    await expect(effect({ kind: 'BOM_REPLACE', targetItemId: o.itemIds.thread })).rejects.toThrow(/another material in place of its target/)
    await expect(effect({ kind: 'BOM_REPLACE', targetItemId: ids.lining, uom: null })).rejects.toThrow(/with a quantity above 0 and its unit, or neither/)
    expect(await effect({ kind: 'BOM_REPLACE', targetItemId: ids.lining, itemId: o.itemIds.airflowLining, qty: null, uom: null })).toBe(1)
    await expect(effect({ kind: 'BOM_REMOVE', targetItemId: ids.protector })).rejects.toThrow(columns)
    expect(await effect({ kind: 'BOM_REMOVE', itemId: null, qty: null, uom: null, targetItemId: ids.protector })).toBe(1)
    const bare = { itemId: null, qty: null, uom: null }
    await expect(effect({ ...bare, kind: 'OPERATION_ADD' })).rejects.toThrow(columns)
    await expect(effect({ ...bare, kind: 'OPERATION_ADD', operationId: o.operationId, minutes: '0' })).rejects.toThrow(/minutes above 0/)
    expect(await effect({ ...bare, kind: 'OPERATION_ADD', operationId: o.operationId })).toBe(1)
    await expect(effect({ ...bare, kind: 'MINUTES', minutes: '0' })).rejects.toThrow(/adds or takes away minutes \(not 0\)/)
    expect(await effect({ ...bare, kind: 'MINUTES', minutes: '-1.500' })).toBe(1)
    await expect(effect({ ...bare, kind: 'PRICE', priceDelta: '10', pricePct: '5' })).rejects.toThrow(/exactly one/)
    await expect(effect({ ...bare, kind: 'PRICE', priceDelta: '10' })).rejects.toThrow(/exactly one/)
    await expect(effect({ ...bare, kind: 'PRICE', priceDelta: '10', currency: 'eur' })).rejects.toThrow(/exactly one/)
    await expect(effect({ ...bare, kind: 'PRICE', priceDelta: '0', currency: 'EUR' })).rejects.toThrow(/exactly one/)
    await expect(effect({ ...bare, kind: 'PRICE', pricePct: '-101' })).rejects.toThrow(/exactly one/)
    await expect(effect({ ...bare, kind: 'PRICE', pricePct: '5', currency: 'EUR' })).rejects.toThrow(/exactly one/)
    expect(await effect({ ...bare, kind: 'PRICE', priceDelta: '-12.50', currency: 'EUR' })).toBe(1)
    expect(await effect({ ...bare, kind: 'PRICE', pricePct: '-100' })).toBe(1)
    await expect(effect({ ...bare, kind: 'CERTIFICATE' })).rejects.toThrow(/says in its note what the certificate no longer covers/)
    await expect(effect({ ...bare, kind: 'CERTIFICATE', note: 'x', priceDelta: '1', currency: 'EUR' })).rejects.toThrow(columns)
    expect(await effect({ ...bare, kind: 'CERTIFICATE', note: 'Without the back protector the class drops.' })).toBe(1)
    // A material of a company on a tenant-wide group's effect.
    const companyItem = randomUUID()
    expect(await copyRow(office(), 'Item', o.itemIds.thread, { id: companyItem, code: tag('T-THR'), companyId: A.company })).toBe(1)
    await expect(effect({ itemId: companyItem })).rejects.toThrow(/names material T-THR-\w+ of another company/)
    await expect(update(office(), 'OptionEffect', key('options:effect:NAME:thread'), `"valueId" = $2::uuid`, o.valueIds.perfFront)).rejects.toThrow(/value and creation of option effect .* never change/)
  })

  it('offers a group on a style once, of the style\'s company, with its own picks and an active default value', async () => {
    const { styleId } = await draftStyle()
    await expect(offer(styleId, o.groupIds.liner, { maxPicks: 2 })).rejects.toThrow(/a SINGLE group at most 1/)
    await expect(offer(styleId, o.groupIds.perforation, { minPicks: 2, maxPicks: 1 })).rejects.toThrow(/not fewer than at least/)
    const first = await offer(styleId, o.groupIds.armour, { minPicks: 1, maxPicks: 1, defaultValueId: o.valueIds.armourStd })
    await expect(offer(styleId, o.groupIds.armour)).rejects.toThrow(/StyleOptionGroup_one_active_per_style|unique/i)
    // A default of another group: the reference refuses it; an archived one is not given anew.
    await expect(update(office(), 'StyleOptionGroup', first, `"defaultValueId" = $2::uuid`, o.valueIds.perfFront)).rejects.toThrow(/foreign key/i)
    const archived = randomUUID()
    expect(await copyRow(office(), 'OptionValue', o.valueIds.armourNone, { id: archived, code: tag('T-OLD'), status: 'ARCHIVED' })).toBe(1)
    await expect(update(office(), 'StyleOptionGroup', first, `"defaultValueId" = $2::uuid`, archived)).rejects.toThrow(/is an active value/)
    await expect(update(office(), 'StyleOptionGroup', first, `"styleId" = $2::uuid`, o.linerStyleId)).rejects.toThrow(/style, group and creation of a style's option group never change/)
    // Archive the old offer first, then another one may be ACTIVE.
    expect(await update(office(), 'StyleOptionGroup', first, `status = 'ARCHIVED'`)).toBe(1)
    expect(await offer(styleId, o.groupIds.armour)).toBeTruthy()
    // A company's group: only on that company's styles. An archived group: offered on no style anew.
    const companyGroup = randomUUID()
    expect(await copyRow(office(), 'OptionGroup', o.groupIds.perforation, { id: companyGroup, code: tag('T-OG'), companyId: A.company })).toBe(1)
    await expect(offer(styleId, companyGroup)).rejects.toThrow(/is of a company: only that company's styles offer it/)
    const companyStyle = await draftStyle({ companyId: A.company })
    expect(await offer(companyStyle.styleId, companyGroup)).toBeTruthy()
    const oldGroup = randomUUID()
    expect(await copyRow(office(), 'OptionGroup', o.groupIds.perforation, { id: oldGroup, code: tag('T-OG'), status: 'ARCHIVED' })).toBe(1)
    await expect(offer(styleId, oldGroup)).rejects.toThrow(/is archived: no style offers it anew/)
  })

  it('checks the option values a routing step is for: of the library, of a group its style offers', async () => {
    const { styleId, revisionId } = await draftStyle()
    const step = (values: string[]) => copyRow(office(), 'RoutingOperation', ids.jacketRouting, { id: randomUUID(), styleId, revisionId, seq: (seq += 1), appliesToOptionValueIds: values, timeVersionId: null, inspectionPlanId: null })
    await expect(step([randomUUID()])).rejects.toThrow(/which is not in the option library/)
    await expect(step([o.valueIds.perfFull])).rejects.toThrow(/whose group its style does not offer/)
    const offerId = await offer(styleId, o.groupIds.perforation)
    expect(await step([o.valueIds.perfFront, o.valueIds.perfFull])).toBe(1)
    expect(await step([])).toBe(1)
    await expect(remove(office(), 'StyleOptionGroup', offerId)).rejects.toThrow(/archive it/)
  })

  it('refuses TRUNCATE on its tables', async () => {
    // In a transaction rolled back, so a TRUNCATE that went through would take nothing with it.
    for (const table of ['OptionGroup', 'OptionValue', 'OptionRule', 'OptionEffect', 'StyleOptionGroup']) {
      await db.admin.query('BEGIN')
      try {
        await expect(db.admin.query(`TRUNCATE "${table}" CASCADE`)).rejects.toThrow(/TRUNCATE on "\w+" is refused/)
      } finally {
        await db.admin.query('ROLLBACK')
      }
    }
  })
})

describe('what the floor reads', () => {
  it('reads a line\'s alternates and the option groups and values, never a rule, an effect or a style\'s offers', async () => {
    for (const table of ['BomLineAlternate', 'OptionGroup', 'OptionValue']) {
      expect((await sql(floor(), `SELECT count(*)::int AS n FROM "${table}"`))[0]!.n).toBeGreaterThan(0)
      await expect(run(floor(), `UPDATE "${table}" SET version = version WHERE false`)).rejects.toThrow(/permission denied/)
    }
    for (const table of ['OptionRule', 'OptionEffect', 'StyleOptionGroup']) await expect(sql(floor(), `SELECT 1 FROM "${table}" LIMIT 1`)).rejects.toThrow(/permission denied/)
    // The new columns of W1's tables follow their grants: the floor reads a line's section and sub-assembly, a revision's output.
    expect(await sql(floor(), `SELECT section::text, "subAssemblyRevisionId"::text AS sub FROM "BomLine" WHERE id = $1::uuid`, o.bomLineIds.liner)).toEqual([{ section: 'INSULATION', sub: o.linerRevisionId }])
    expect(await sql(floor(), `SELECT "outputQuantity" AS q, "outputUom"::text AS u FROM "StyleRevision" WHERE id = $1::uuid`, o.linerRevisionId)).toEqual([{ q: 1, u: 'PCS' }])
  })
})
