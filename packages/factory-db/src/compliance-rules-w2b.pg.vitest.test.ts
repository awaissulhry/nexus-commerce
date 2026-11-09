import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedCore, type CoreSeed } from '../seed/_core'
import { seed as seedComplianceRules, type ComplianceRulesSeed } from '../seed/compliance-rules'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'

/**
 * The compliance rule library (W2b-4, schema wave 30/33, B-W2b-216, …_compliance_rules_w2b_guards) on a database built from the
 * migrations and seeded, through the real login and the scoped client:
 *   - the rows made before the wave: every older certificate names no body, levels or base; the seed's rows;
 *   - the register (one entry per code without an edition, successors only while SUPERSEDED, no circle, removed while nothing
 *     names it) and the change watch (OPEN → ASSESSED → CLOSED, the assessment filed once, the certificates and reviews named);
 *   - markets and requirements: codes, languages, marks, national rules, OFF only with a reason, a locked gate never unlocked,
 *     switched off or loosened, the market and product type a requirement names;
 *   - gate events: append-only for every login; a refusal by a requirement that blocks the gate; an override with its refusal,
 *     step-up and end, never from the floor, never at a locked gate; the floor writes and reads its own site's;
 *   - economic operators, phrases and translations (a second person approves the current revision, then frozen; one APPROVED
 *     and one DRAFT per language; the floor reads approved ones only), notified bodies, and the columns on W1's certificates
 *     and coverage (the body's number, levels and base filled once, a bought-in part's supplier).
 * The refusals are check_violation (23514) or restrict_violation (23001); their messages are read through raw SQL.
 */

const NS = 'w2b-216-a'

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let s: ComplianceRulesSeed

const key = (name: string): string => seedUuid(NS, name)
const A = { company: key('company:A'), companyB: key('company:B'), site: key('site:A1'), siteB: key('site:B1'), P1: key('party:P1'), P2: key('party:P2'), P3: key('party:P3') }
const office = (): FactoryScope => ({ audience: 'office', tenantId: a.tenantId, actorId: a.actorId })
const floor = (siteId = A.site): FactoryScope => ({ audience: 'floor', tenantId: a.tenantId, actorId: randomUUID(), siteId })
const as = <T>(scope: FactoryScope, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scope, work)
const run = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$executeRawUnsafe(text, ...values))
const sql = (scope: FactoryScope, text: string, ...values: unknown[]) => as(scope, (client) => client.$queryRawUnsafe<Record<string, unknown>[]>(text, ...values))
const admin = async (text: string, values: unknown[] = []) => (await db.admin.query(text, values)).rows as Record<string, unknown>[]
const one = async (text: string, values: unknown[] = []) => (await admin(text, values))[0]!
/** INSERT a copy of row `id` of `table` with `changes` (a jsonb object of columns) as `scope`; returns the new id. */
async function copy(table: string, id: string, changes: Record<string, unknown> = {}, scope: FactoryScope = office()): Promise<string> {
  const newId = (changes.id as string | undefined) ?? randomUUID()
  const count = await run(
    scope,
    `INSERT INTO "${table}" SELECT * FROM jsonb_populate_record(NULL::"${table}", (SELECT to_jsonb(r) || $1::jsonb FROM "${table}" r WHERE r.id = $2::uuid))`,
    JSON.stringify({ ...changes, id: newId }),
    id,
  )
  expect(count).toBe(1)
  return newId
}
/** UPDATE row `id` of `table`: `set` is the SET list. */
const update = (scope: FactoryScope, table: string, id: string, set: string, ...values: unknown[]) => run(scope, `UPDATE "${table}" SET ${set} WHERE id = $1::uuid`, id, ...values)
const remove = (scope: FactoryScope, table: string, id: string) => run(scope, `DELETE FROM "${table}" WHERE id = $1::uuid`, id)
const tag = (prefix: string): string => `${prefix}-${randomUUID().slice(0, 8)}`
const minutesAgo = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString()
const inDays = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString()

/** A new tenant-wide requirement (a copy of LABEL-LANGUAGE, which blocks label print and names an override role). */
const requirement = (changes: Record<string, unknown> = {}) => copy('ComplianceRequirement', s.requirementIds.labelLanguage, { code: tag('T-REQ'), ...changes })
/** A new REFUSED event of `requirementId` at `gate` on a new work-order subject at A1. */
const refusal = (requirementId: string, gate: string, changes: Record<string, unknown> = {}, scope: FactoryScope = office()) =>
  copy('GateEvent', s.gateEventIds.labelRefused, { requirementId, gate, subjectId: randomUUID(), createdAt: new Date().toISOString(), ...changes }, scope)
/** An OVERRIDDEN event of the refusal `refusedId` (its gate, subject and requirement), made now with a step-up a minute ago. */
async function override(refusedId: string, changes: Record<string, unknown> = {}, scope: FactoryScope = office()): Promise<string> {
  const refused = await one(`SELECT gate::text AS gate, "subjectId"::text AS subject, "requirementId"::text AS requirement FROM "GateEvent" WHERE id = $1`, [refusedId])
  return copy(
    'GateEvent',
    refusedId,
    {
      outcome: 'OVERRIDDEN',
      gate: refused.gate,
      subjectId: refused.subject,
      requirementId: refused.requirement,
      refusedEventId: refusedId,
      reason: 'Test: the leaflet is with the translator.',
      createdAt: new Date().toISOString(),
      createdById: a.actorId,
      stepUpAt: minutesAgo(1),
      overrideUntil: inDays(2),
      ...changes,
    },
    scope,
  )
}

beforeAll(async () => {
  db = await migratedDatabase('complrulesw2b')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seedCore({ db: factory, namespace: NS })
  s = await seedComplianceRules({ db: factory, namespace: NS })
}, 300_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

describe('the rows made before the wave and the seed', () => {
  it('leaves every older certificate without a body, levels or base, and seeds the library', async () => {
    const older = await one(
      `SELECT count(*)::int AS n FROM "Certificate" WHERE "tenantId" = $1 AND number NOT LIKE 'SEED-CERT-216%'
          AND ("notifiedBodyId" IS NOT NULL OR "performanceLevels" IS NOT NULL OR "baseCertificateId" IS NOT NULL)`,
      [a.tenantId],
    )
    expect(older).toEqual({ n: 0 })
    const counts = await one(
      `SELECT (SELECT count(*) FROM "RegulationOrStandard" WHERE "tenantId" = $1)::int AS regs,
              (SELECT count(*) FROM "MarketProfile" WHERE "tenantId" = $1 AND NOT "switchedOn")::int AS off_markets,
              (SELECT count(*) FROM "ComplianceRequirement" WHERE "tenantId" = $1 AND NOT "switchedOn")::int AS off_requirements,
              (SELECT count(*) FROM "GateEvent" WHERE "tenantId" = $1 AND outcome = 'OVERRIDDEN')::int AS overrides`,
      [a.tenantId],
    )
    expect(counts).toEqual({ regs: 10, off_markets: 3, off_requirements: 6, overrides: 1 })
    // B-W2b-208's three textile switches have their home per market: Italy's rows, OFF with the Owner question.
    const textile = await admin(`SELECT "checkKey" AS k, "offReason" AS why FROM "ComplianceRequirement" WHERE "tenantId" = $1 AND "checkKey" LIKE 'textile.%' ORDER BY seq`, [a.tenantId])
    expect(textile.map((row) => row.k)).toEqual(['textile.textileShare', 'textile.careLabel', 'textile.madeInItaly'])
    expect(String(textile[0]!.why)).toMatch(/Q10/)
    expect(await one(`SELECT "supplierPartyId"::text AS p, "supplierArticleCode" AS code FROM "CertificateCoverage" WHERE id = $1`, [key('compliance:coverage:PRO-300')])).toEqual({ p: A.P2, code: 'P2-SHD-L2' })
    expect(await one(`SELECT "baseCertificateId"::text AS base FROM "Certificate" WHERE id = $1`, [s.certificateIds.ownBrand])).toEqual({ base: s.certificateIds.base })
  })
})

describe('the register and the change watch', () => {
  it('checks an entry, keeps one per code without an edition, successors only while SUPERSEDED and without a circle', async () => {
    await expect(copy('RegulationOrStandard', s.regulationIds.ppe, { code: '' })).rejects.toThrow(/a code of 1 to 100 characters/)
    await expect(copy('RegulationOrStandard', s.regulationIds.ppe, { code: tag('T-REG'), link: 'http://example.org' })).rejects.toThrow(/https address/)
    await expect(copy('RegulationOrStandard', s.regulationIds.ppe, { code: tag('T-REG'), titleI18n: { it: '' } })).rejects.toThrow(/words per language/)
    await expect(copy('RegulationOrStandard', s.regulationIds.ppe)).rejects.toThrow(/RegulationOrStandard_one_without_edition|unique/i)
    const old = await copy('RegulationOrStandard', s.regulationIds.en17092_3, { edition: '2015' })
    await expect(update(office(), 'RegulationOrStandard', old, `"supersededById" = $2::uuid`, s.regulationIds.en17092_3)).rejects.toThrow(/only while it is SUPERSEDED/)
    await expect(update(office(), 'RegulationOrStandard', old, `status = 'SUPERSEDED', "supersededById" = id`)).rejects.toThrow(/a circle/)
    expect(await update(office(), 'RegulationOrStandard', old, `status = 'SUPERSEDED', "supersededById" = $2::uuid`, s.regulationIds.en17092_3)).toBe(1)
    // 2015 → 2020 → 2015 is a circle; 2020 → 2026 is fine.
    await expect(update(office(), 'RegulationOrStandard', s.regulationIds.en17092_3, `status = 'SUPERSEDED', "supersededById" = $2::uuid`, old)).rejects.toThrow(/a circle/)
    const newer = await copy('RegulationOrStandard', s.regulationIds.en17092_3, { edition: '2026' })
    expect(await update(office(), 'RegulationOrStandard', s.regulationIds.en17092_3, `status = 'SUPERSEDED', "supersededById" = $2::uuid`, newer)).toBe(1)
    expect(await update(office(), 'RegulationOrStandard', s.regulationIds.en17092_3, `status = 'IN_FORCE', "supersededById" = NULL`)).toBe(1)
    // Removed while nothing names it; a named entry is kept by the references.
    await expect(remove(office(), 'RegulationOrStandard', s.regulationIds.en17092_3)).rejects.toThrow(/foreign key/i)
    expect(await remove(office(), 'RegulationOrStandard', newer)).toBe(1)
  })

  it('moves a change OPEN → ASSESSED → CLOSED, files the assessment once and names registered certificates only', async () => {
    const change = await copy('StandardChange', s.changeIds.amendment, { certificateIds: [] })
    await expect(update(office(), 'StandardChange', change, `impact = 'REVIEW'`)).rejects.toThrow(/is OPEN: its impact is not assessed yet/)
    await expect(update(office(), 'StandardChange', change, `status = 'CLOSED', "closedAt" = now(), "closedById" = $2::uuid`, a.actorId)).rejects.toThrow(/cannot move from OPEN to CLOSED/)
    await expect(update(office(), 'StandardChange', change, `status = 'ASSESSED'`)).rejects.toThrow(/its impact, the assessment in words/)
    const draftCertificate = await copy('Certificate', s.certificateIds.glove, { number: tag('T-CERT'), notifiedBodyId: null, performanceLevels: null })
    await expect(update(office(), 'StandardChange', change, `"certificateIds" = ARRAY[$2::uuid]`, draftCertificate)).rejects.toThrow(/not a registered certificate of the tenant/)
    await expect(update(office(), 'StandardChange', change, `"certificateIds" = ARRAY[$2::uuid]`, randomUUID())).rejects.toThrow(/not a registered certificate/)
    await expect(update(office(), 'StandardChange', change, `"typeChangeReviewIds" = ARRAY[$2::uuid]`, randomUUID())).rejects.toThrow(/not a review of one of its certificates/)
    expect(await update(office(), 'StandardChange', change, `"certificateIds" = ARRAY[$2::uuid], "taskId" = $3::uuid`, s.certificateIds.base, randomUUID())).toBe(1)
    await expect(update(office(), 'StandardChange', change, `"taskId" = $2::uuid`, randomUUID())).rejects.toThrow(/names its impact task once/)
    expect(
      await update(office(), 'StandardChange', change, `status = 'ASSESSED', impact = 'REVIEW', assessment = 'Test: review with the notified body.', "assessedAt" = now(), "assessedById" = $2::uuid`, a.actorId),
    ).toBe(1)
    await expect(update(office(), 'StandardChange', change, `impact = 'RETEST'`)).rejects.toThrow(/assessment .* is filed; it never changes/)
    expect(await update(office(), 'StandardChange', change, `status = 'CLOSED', "closedAt" = now(), "closedById" = $2::uuid`, a.actorId)).toBe(1)
    await expect(update(office(), 'StandardChange', change, `"whatChanged" = 'Changed after closing'`)).rejects.toThrow(/is CLOSED; it never changes/)
    await expect(admin(`DELETE FROM "StandardChange" WHERE id = $1`, [change])).rejects.toThrow(/kept, never removed/)
  })
})

describe('markets and requirements', () => {
  it('checks a market and switches it OFF only with a reason', async () => {
    await expect(copy('MarketProfile', s.marketIds.DE, { code: 'de' })).rejects.toThrow(/a code of two capitals/)
    await expect(copy('MarketProfile', s.marketIds.DE, { code: 'AT', labelLanguages: ['de', 'de'] })).rejects.toThrow(/ISO 639 codes/)
    await expect(copy('MarketProfile', s.marketIds.DE, { code: 'AT', markings: ['ce'] })).rejects.toThrow(/codes of 2 to 20 capitals/)
    await expect(copy('MarketProfile', s.marketIds.DE, { code: 'AT', nationalRules: [{ key: 'x', words: { de: 'Wort' }, extra: 1 }] })).rejects.toThrow(/national rules of market AT are objects/)
    await expect(copy('MarketProfile', s.marketIds.DE, { code: 'AT', nationalRules: [{ key: 'x', words: { de: 'a' } }, { key: 'x', words: { de: 'b' } }] })).rejects.toThrow(/their own key/)
    await expect(copy('MarketProfile', s.marketIds.DE, { code: 'AT', switchedOn: false })).rejects.toThrow(/says why in words/)
    await expect(copy('MarketProfile', s.marketIds.DE, { code: 'AT', offReason: 'Why?' })).rejects.toThrow(/names no reason to be off/)
    const at = await copy('MarketProfile', s.marketIds.DE, { code: 'AT', name: 'Austria', nationalRules: [{ key: 'at-seed', words: { de: 'Wort', en: 'Word' }, href: 'https://example.org/at' }] })
    await expect(update(office(), 'MarketProfile', at, `"switchedOn" = false, "offReason" = 'Test: not sold there yet.'`)).rejects.toThrow(/with the time of the switch/)
    expect(await update(office(), 'MarketProfile', at, `"switchedOn" = false, "offReason" = 'Test: not sold there yet.', "switchedAt" = now()`)).toBe(1)
    await expect(update(office(), 'MarketProfile', at, `code = 'AU'`)).rejects.toThrow(/the code, the company and the creation of market AT never change/)
    await expect(remove(office(), 'MarketProfile', at)).rejects.toThrow(/permission denied|kept, never removed/)
    await expect(admin(`DELETE FROM "MarketProfile" WHERE id = $1`, [at])).rejects.toThrow(/kept, never removed/)
  })

  it('checks a requirement: its operator role, gates, override, check key, market and product type', async () => {
    await expect(requirement({ kind: 'OPERATOR_ROLE' })).rejects.toThrow(/exactly when it asks for an economic operator/)
    await expect(requirement({ operatorRole: 'IMPORTER' })).rejects.toThrow(/exactly when it asks for an economic operator/)
    await expect(requirement({ lockedBlocks: ['SHIPMENT'] })).rejects.toThrow(/locks only gates it blocks/)
    await expect(requirement({ blocks: ['SHIPMENT', 'SHIPMENT'] })).rejects.toThrow(/each product type, PPE category, gate and role once/)
    await expect(requirement({ overrideMaxDays: 8 })).rejects.toThrow(/1 to 7 days/)
    await expect(requirement({ checkKey: 'Textile careLabel' })).rejects.toThrow(/"area.check"/)
    await expect(requirement({ marketCode: 'XX' })).rejects.toThrow(/market XX, which is not a market of the tenant/)
    await expect(requirement({ switchedOn: false })).rejects.toThrow(/says why in words/)
    await expect(requirement({ legalReference: '' })).rejects.toThrow(/legal reference/)
    await expect(requirement({ appliesFrom: '2027-01-01', appliesUntil: '2026-01-01' })).rejects.toThrow(/until a day not before it starts/)
    // A product type of the requirement's company or tenant-wide, and its kind of garment.
    const glovesB = randomUUID()
    expect(await run(office(), `INSERT INTO "ProductTypeProfile" (id, "companyId", code, name, "productType") VALUES ($1::uuid, $2::uuid, $3, 'Test gloves of B', 'GLOVES')`, glovesB, A.companyB, tag('T-TYPE'))).toBe(1)
    await expect(requirement({ companyId: A.company, productTypeProfileId: glovesB })).rejects.toThrow(/a product type of another company/)
    await expect(requirement({ companyId: A.companyB, productTypeProfileId: glovesB, productTypes: ['JACKET'] })).rejects.toThrow(/kind of garment \(GLOVES\)/)
    expect(await requirement({ companyId: A.companyB, productTypeProfileId: glovesB, productTypes: ['GLOVES'], marketCode: 'DE' })).toMatch(/-/)
    await expect(admin(`DELETE FROM "ComplianceRequirement" WHERE id = $1`, [s.requirementIds.crVi])).rejects.toThrow(/kept, never removed/)
  })

  it('keeps a gate the law locks: never unlocked, switched off, archived or loosened in scope', async () => {
    const id = s.requirementIds.certificate
    await expect(update(office(), 'ComplianceRequirement', id, `"lockedBlocks" = ARRAY['LABEL_PRINT', 'FINAL_RELEASE']::"ComplianceGate"[]`)).rejects.toThrow(/a locked gate stays locked/)
    await expect(update(office(), 'ComplianceRequirement', id, `blocks = ARRAY['WORK_ORDER_RELEASE']::"ComplianceGate"[]`)).rejects.toThrow(/locks only gates it blocks/)
    await expect(update(office(), 'ComplianceRequirement', id, `"switchedOn" = false, "offReason" = 'Test: off', "switchedAt" = now()`)).rejects.toThrow(/never switched off or archived/)
    await expect(update(office(), 'ComplianceRequirement', id, `status = 'ARCHIVED'`)).rejects.toThrow(/never switched off or archived/)
    await expect(update(office(), 'ComplianceRequirement', id, `"marketCode" = 'IT'`)).rejects.toThrow(/its kind, check, scope and dates never change/)
    await expect(update(office(), 'ComplianceRequirement', id, `"appliesUntil" = '2026-12-31'`)).rejects.toThrow(/its kind, check, scope and dates never change/)
    // Tightening is fine: the company's choice at work-order release becomes locked too; the words may change.
    const locked = await copy('ComplianceRequirement', id, { code: tag('T-LOCK') })
    expect(await update(office(), 'ComplianceRequirement', locked, `"lockedBlocks" = blocks, name = 'Test: locked everywhere'`)).toBe(1)
  })
})

describe('gate events', () => {
  it('are append-only for every login, the owner included', async () => {
    const id = s.gateEventIds.labelRefused
    await expect(update(office(), 'GateEvent', id, `reason = reason`)).rejects.toThrow(/permission denied/)
    await expect(remove(office(), 'GateEvent', id)).rejects.toThrow(/permission denied/)
    await expect(admin(`UPDATE "GateEvent" SET reason = 'changed' WHERE id = $1`, [id])).rejects.toThrow(/append-only; UPDATE refused/)
    await expect(admin(`DELETE FROM "GateEvent" WHERE id = $1`, [id])).rejects.toThrow(/append-only; DELETE refused/)
    await expect(admin(`TRUNCATE "GateEvent"`)).rejects.toThrow(/append-only; TRUNCATE refused/)
  })

  it('refuses only by a switched-on, ACTIVE requirement that blocks the gate', async () => {
    await expect(refusal(s.requirementIds.labelLanguage, 'SHIPMENT')).rejects.toThrow(/does not block SHIPMENT/)
    await expect(refusal(s.requirementIds.textileShareIt, 'LABEL_PRINT')).rejects.toThrow(/does not block LABEL_PRINT/)
    await expect(refusal(s.requirementIds.labelLanguage, 'LABEL_PRINT', { subjectType: 'work order' })).rejects.toThrow(/by its model name/)
    await expect(refusal(s.requirementIds.labelLanguage, 'LABEL_PRINT', { reason: ' ' })).rejects.toThrow(/says why in words/)
    await expect(refusal(s.requirementIds.labelLanguage, 'LABEL_PRINT', { stepUpAt: minutesAgo(1) })).rejects.toThrow(/names no refusal, step-up or end/)
    expect(await refusal(s.requirementIds.labelLanguage, 'LABEL_PRINT')).toMatch(/-/)
  })

  it('takes an override of a refusal with a fresh step-up and an end, never from the floor or at a locked gate', async () => {
    const refused = await refusal(s.requirementIds.userInfoLanguage, 'WORK_ORDER_RELEASE')
    await expect(override(refused, { stepUpAt: minutesAgo(20) })).rejects.toThrow(/fresh step-up/)
    await expect(override(refused, { stepUpAt: new Date(Date.now() + 60_000).toISOString() })).rejects.toThrow(/fresh step-up/)
    await expect(override(refused, { overrideUntil: inDays(8) })).rejects.toThrow(/at most 7 days later/)
    await expect(override(refused, { overrideUntil: minutesAgo(1) })).rejects.toThrow(/ends after it is made/)
    await expect(override(refused, { createdById: null })).rejects.toThrow(/names its person, the refusal it lifts/)
    await expect(override(refused, { subjectId: randomUUID() })).rejects.toThrow(/lifts a refusal of the same gate, subject and requirement/)
    await expect(override(s.gateEventIds.releaseOverridden, { refusedEventId: s.gateEventIds.releaseOverridden })).rejects.toThrow(/lifts a refusal/)
    expect(await override(refused)).toMatch(/-/)
    // The certificate requirement: locked at label print (nobody overrides there); open at release but it names no role.
    const atLabel = await refusal(s.requirementIds.certificate, 'LABEL_PRINT')
    await expect(override(atLabel)).rejects.toThrow(/locked by law at LABEL_PRINT; nobody overrides it there/)
    const atRelease = await refusal(s.requirementIds.certificate, 'WORK_ORDER_RELEASE')
    await expect(override(atRelease)).rejects.toThrow(/names no role that may override it/)
    // The label languages requirement allows 3 days.
    const label = await refusal(s.requirementIds.labelLanguage, 'LABEL_PRINT')
    await expect(override(label, { overrideUntil: inDays(4) })).rejects.toThrow(/at most 3 days later/)
    // The floor writes refusals of its own site only, reads its site's events, and never overrides.
    expect(await refusal(s.requirementIds.labelLanguage, 'LABEL_PRINT', {}, floor())).toMatch(/-/)
    await expect(refusal(s.requirementIds.labelLanguage, 'LABEL_PRINT', { companyId: A.companyB, siteId: A.siteB }, floor())).rejects.toThrow(/row-level security/)
    await expect(override(label, {}, floor())).rejects.toThrow(/the floor never overrides a gate/)
    const seen = await sql(floor(), `SELECT DISTINCT "siteId"::text AS site FROM "GateEvent"`)
    expect(seen).toEqual([{ site: A.site }])
  })
})

describe('economic operators', () => {
  it('names a style or a brand, a party for every role but the manufacturer, a market of the tenant', async () => {
    await expect(copy('EconomicOperatorRole', s.operatorIds.styleCh, { brandPartyId: A.P1 })).rejects.toThrow(/for a style or for a brand, not both/)
    await expect(copy('EconomicOperatorRole', s.operatorIds.styleCh, { partyId: null })).rejects.toThrow(/names its party: only the manufacturer/)
    await expect(copy('EconomicOperatorRole', s.operatorIds.brand, { brandPartyId: A.P2 })).rejects.toThrow(/a party that is not a brand/)
    await expect(copy('EconomicOperatorRole', s.operatorIds.styleCh, { companyId: A.company })).rejects.toThrow(/for the style's company/)
    await expect(copy('EconomicOperatorRole', s.operatorIds.styleCh, { marketCode: 'XX' })).rejects.toThrow(/market XX, which is not a market of the tenant/)
    await expect(copy('EconomicOperatorRole', s.operatorIds.styleCh, { validTo: '2026-01-01' })).rejects.toThrow(/ends on a day not before it starts/)
    await expect(copy('EconomicOperatorRole', s.operatorIds.companyA, { printedAddress: '' })).rejects.toThrow(/prints a name/)
    expect(await copy('EconomicOperatorRole', s.operatorIds.companyA, { marketCode: 'DE', role: 'AUTHORISED_REPRESENTATIVE', partyId: A.P3 })).toMatch(/-/)
    await expect(admin(`DELETE FROM "EconomicOperatorRole" WHERE id = $1`, [s.operatorIds.companyA])).rejects.toThrow(/kept, never removed/)
  })
})

describe('the phrase library', () => {
  it('moves a phrase revision with its source words, and only then', async () => {
    await expect(update(office(), 'Phrase', s.phraseIds.storage, `"sourceText" = 'Conservare all''asciutto.'`)).rejects.toThrow(/takes revision 2 with its new source words/)
    await expect(update(office(), 'Phrase', s.phraseIds.storage, `revision = 2`)).rejects.toThrow(/keeps its revision while its source words stay/)
    await expect(update(office(), 'Phrase', s.phraseIds.storage, `key = 'userinfo.other'`)).rejects.toThrow(/the key, the company and the creation of phrase userinfo.storage never change/)
    await expect(copy('Phrase', s.phraseIds.storage, { key: 'a key with spaces' })).rejects.toThrow(/without spaces/)
    await expect(admin(`DELETE FROM "Phrase" WHERE id = $1`, [s.phraseIds.storage])).rejects.toThrow(/kept, never removed/)
  })

  it('has a translation approved by a second person on the current revision, then frozen; one APPROVED and one DRAFT per language', async () => {
    const t = s.translationIds
    await expect(copy('PhraseTranslation', t.warningEn, { language: 'es', revision: 1 })).rejects.toThrow(/proposed as DRAFT/)
    await expect(copy('PhraseTranslation', t.warningDe, { language: 'it' })).rejects.toThrow(/in the phrase's source language/)
    await expect(copy('PhraseTranslation', t.warningDe, { language: 'es', sourceRevision: 2 })).rejects.toThrow(/translates revision 2 of a phrase at revision 1/)
    await expect(copy('PhraseTranslation', t.warningDe, { revision: 2 })).rejects.toThrow(/PhraseTranslation_one_draft|unique/i)
    // The author never approves.
    await expect(update(office(), 'PhraseTranslation', t.warningDe, `status = 'APPROVED', "approvedAt" = now(), "approvedById" = $2::uuid`, s.translatorId)).rejects.toThrow(/approved by a second person, not by its author/)
    await expect(update(office(), 'PhraseTranslation', t.warningDe, `status = 'APPROVED'`)).rejects.toThrow(/names when and by whom it was approved/)
    await expect(update(office(), 'PhraseTranslation', t.warningDe, `status = 'SUPERSEDED', "approvedAt" = now(), "approvedById" = $2::uuid`, a.actorId)).rejects.toThrow(/cannot move from DRAFT to SUPERSEDED/)
    // A translation of an older source revision is translated again first.
    const stale = await copy('PhraseTranslation', t.careEn2, { language: 'fr', revision: 1, sourceRevision: 1, status: 'DRAFT', approvedAt: null, approvedById: null })
    await expect(update(office(), 'PhraseTranslation', stale, `status = 'APPROVED', "approvedAt" = now(), "approvedById" = $2::uuid`, a.actorId)).rejects.toThrow(/the phrase is at revision 2: translate it again first/)
    // One APPROVED per language: the next English revision waits until the approved one is superseded.
    const next = await copy('PhraseTranslation', t.warningDe, { language: 'en', revision: 2, text: 'Class A garment: read the user information first.' })
    await expect(update(office(), 'PhraseTranslation', next, `status = 'APPROVED', "approvedAt" = now(), "approvedById" = $2::uuid`, a.actorId)).rejects.toThrow(/PhraseTranslation_one_approved|unique/i)
    expect(await update(office(), 'PhraseTranslation', t.warningEn, `status = 'SUPERSEDED'`)).toBe(1)
    expect(await update(office(), 'PhraseTranslation', next, `status = 'APPROVED', "approvedAt" = now(), "approvedById" = $2::uuid`, a.actorId)).toBe(1)
    await expect(update(office(), 'PhraseTranslation', next, `text = 'Changed words'`)).rejects.toThrow(/only its status moves/)
    await expect(update(office(), 'PhraseTranslation', t.warningEn, `status = 'DRAFT'`)).rejects.toThrow(/cannot move from SUPERSEDED to DRAFT/)
    await expect(remove(office(), 'PhraseTranslation', next)).rejects.toThrow(/it is kept \(only a draft is removed\)/)
    expect(await remove(office(), 'PhraseTranslation', stale)).toBe(1)
    // The floor reads approved and superseded translations only.
    const statuses = await sql(floor(), `SELECT DISTINCT status::text AS status FROM "PhraseTranslation" ORDER BY 1`)
    expect(statuses).toEqual([{ status: 'APPROVED' }, { status: 'SUPERSEDED' }])
  })
})

describe('notified bodies and the certificates and coverage that name them', () => {
  it('checks a body, keeps one ACTIVE per number and its number once a certificate names it', async () => {
    await expect(copy('NotifiedBody', s.bodyIds.second, { number: '12345' })).rejects.toThrow(/four-digit NANDO number/)
    await expect(copy('NotifiedBody', s.bodyIds.second, { number: '1234', country: 'Italy' })).rejects.toThrow(/a country \(two capitals\)/)
    await expect(copy('NotifiedBody', s.bodyIds.second, { number: '1234', contactEmail: 'no mail' })).rejects.toThrow(/an e-mail address/)
    await expect(copy('NotifiedBody', s.bodyIds.second)).rejects.toThrow(/NotifiedBody_one_active_per_number|unique/i)
    expect(await copy('NotifiedBody', s.bodyIds.second, { status: 'ARCHIVED' })).toMatch(/-/)
    await expect(update(office(), 'NotifiedBody', s.bodyIds.second, `number = '9998'`)).rejects.toThrow(/named by certificates; its number never changes/)
    await expect(admin(`DELETE FROM "NotifiedBody" WHERE id = $1`, [s.bodyIds.archived])).rejects.toThrow(/kept, never removed/)
  })

  it('names the body of the typed number, and fills body, levels and base once a certificate is registered', async () => {
    const draft = await copy('Certificate', s.certificateIds.glove, { number: tag('T-CERT'), notifiedBodyId: null, performanceLevels: null })
    await expect(update(office(), 'Certificate', draft, `"notifiedBodyId" = $2::uuid`, s.bodyIds.active)).rejects.toThrow(/issued by notified body 9999 \(as typed\); the directory's body 0000 is another one/)
    await expect(update(office(), 'Certificate', draft, `"notifiedBodyNumber" = '0000', "notifiedBodyId" = $2::uuid`, s.bodyIds.archived)).rejects.toThrow(/is archived; pick the active entry/)
    await expect(update(office(), 'Certificate', draft, `"performanceLevels" = '{"Level": "2"}'::jsonb`)).rejects.toThrow(/name each property in letters and digits/)
    await expect(update(office(), 'Certificate', draft, `"performanceLevels" = '{"level": 2}'::jsonb`)).rejects.toThrow(/a level of 1 to 20 characters/)
    expect(await update(office(), 'Certificate', draft, `status = 'VALID', "statusChangedAt" = now()`)).toBe(1)
    // Registered: each may be filled in once, then never changes.
    expect(await update(office(), 'Certificate', draft, `"notifiedBodyId" = $2::uuid, "performanceLevels" = '{"level": "1"}'::jsonb`, s.bodyIds.second)).toBe(1)
    await expect(update(office(), 'Certificate', draft, `"performanceLevels" = '{"level": "2"}'::jsonb`)).rejects.toThrow(/filled in once and never change/)
    await expect(update(office(), 'Certificate', draft, `"notifiedBodyId" = NULL`)).rejects.toThrow(/filled in once and never change/)
  })

  it('rests an own-brand certificate of a brand on the factory\'s own certificate with no base', async () => {
    const own = (changes: Record<string, unknown>) => copy('Certificate', s.certificateIds.ownBrand, { number: tag('T-OWN'), ...changes })
    await expect(own({ holderPartyId: A.P2 })).rejects.toThrow(/only as an own-brand certificate held by a brand/)
    await expect(own({ baseCertificateId: s.certificateIds.ownBrand })).rejects.toThrow(/the factory's own \(held by a company\) with no base of its own/)
    await expect(own({ baseCertificateId: key('compliance:certificate:JKT-01') })).rejects.toThrow(/the factory's own \(held by a company\)/)
    await expect(update(office(), 'Certificate', s.certificateIds.base, `"baseCertificateId" = $2::uuid`, s.certificateIds.ownBrand)).rejects.toThrow(/own-brand certificate held by a brand|no base of its own/)
    expect(await own({})).toMatch(/-/)
    await expect(update(office(), 'Certificate', s.certificateIds.ownBrand, `"baseCertificateId" = NULL`)).rejects.toThrow(/filled in once and never change/)
  })

  it('names a bought-in part\'s supplier once, on an item\'s coverage', async () => {
    const coverage = key('compliance:coverage:PRO-300')
    const styleCoverage = key('compliance:coverage:JKT-01')
    await expect(update(office(), 'CertificateCoverage', styleCoverage, `"supplierPartyId" = $2::uuid`, A.P2)).rejects.toThrow(/only for a bought-in part/)
    await expect(update(office(), 'CertificateCoverage', coverage, `"supplierPartyId" = $2::uuid`, A.P1)).rejects.toThrow(/names its supplier once/)
    const fresh = await copy('CertificateCoverage', coverage, { supplierPartyId: null, supplierArticleCode: null })
    await expect(update(office(), 'CertificateCoverage', fresh, `"supplierArticleCode" = 'X-1'`)).rejects.toThrow(/only with its supplier/)
    await expect(update(office(), 'CertificateCoverage', fresh, `"supplierPartyId" = $2::uuid`, A.P1)).rejects.toThrow(/not a supplier/)
    expect(await update(office(), 'CertificateCoverage', fresh, `"supplierPartyId" = $2::uuid, "supplierArticleCode" = 'P2-OTHER'`, A.P2)).toBe(1)
    expect(await update(office(), 'CertificateCoverage', fresh, `"supplierArticleCode" = 'P2-OTHER-2'`)).toBe(1)
  })
})
