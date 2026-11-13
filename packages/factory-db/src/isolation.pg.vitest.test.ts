import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed, type CoreSeed } from '../seed/_core'
import { seed as seedAccounting } from '../seed/accounting'
import { seed as seedAlerts } from '../seed/alerts'
import { seed as seedAndon } from '../seed/andon'
import { seed as seedApprovals } from '../seed/approvals'
import { seed as seedAudit } from '../seed/audit'
import { seed as seedAuth } from '../seed/auth'
import { seed as seedBank } from '../seed/bank'
import { seed as seedBuyingDepth } from '../seed/buying-depth'
import { seed as seedCalendar } from '../seed/calendar'
import { seed as seedCapa } from '../seed/capa'
import { seed as seedCarriers } from '../seed/carriers'
import { seed as seedChanges } from '../seed/changes'
import { seed as seedCollab } from '../seed/collab'
import { seed as seedCompliance } from '../seed/compliance'
import { seed as seedComplianceRules } from '../seed/compliance-rules'
import { seed as seedCostActuals } from '../seed/cost-actuals'
import { seed as seedCosting } from '../seed/costing'
import { seed as seedCustoms } from '../seed/customs'
import { seed as seedCutting } from '../seed/cutting'
import { seed as seedEmail } from '../seed/email'
import { seed as seedEmailIn } from '../seed/email-in'
import { seed as seedFiles } from '../seed/files'
import { seed as seedFilesDepth } from '../seed/files-depth'
import { seed as seedFloorAuth } from '../seed/floor-auth'
import { seed as seedFloorSync } from '../seed/floor-sync'
import { seed as seedFollowupsQualityMoney } from '../seed/followups-quality-money'
import { seed as seedHealth } from '../seed/health'
import { seed as seedHolds } from '../seed/holds'
import { seed as seedImports } from '../seed/imports'
import { seed as seedInsights } from '../seed/insights'
import { seed as seedInspectionPlans } from '../seed/inspection-plans'
import { seed as seedInstructions } from '../seed/instructions'
import { seed as seedIntegration } from '../seed/integration'
import { seed as seedInventory } from '../seed/inventory'
import { seed as seedLabour } from '../seed/labour'
import { seed as seedLeather } from '../seed/leather'
import { seed as seedLinks } from '../seed/links'
import { seed as seedLinksDepth } from '../seed/links-depth'
import { seed as seedMoney } from '../seed/money'
import { seed as seedMtmOffice } from '../seed/mtm-office'
import { seed as seedNotifyDepth } from '../seed/notify-depth'
import { seed as seedNumbering } from '../seed/numbering'
import { seed as seedNumberingBlocks } from '../seed/numbering-blocks'
import { seed as seedOps } from '../seed/ops'
import { seed as seedOptions } from '../seed/options'
import { seed as seedOutbox } from '../seed/outbox'
import { seed as seedPacking } from '../seed/packing'
import { seed as seedParties } from '../seed/parties'
import { seed as seedPay } from '../seed/pay'
import { seed as seedPlanning } from '../seed/planning'
import { seed as seedPlanningDepth } from '../seed/planning-depth'
import { seed as seedPlant } from '../seed/plant'
import { seed as seedPlantCare } from '../seed/plantcare'
import { seed as seedPortalAuth } from '../seed/portal-auth'
import { seed as seedPortalFollowups } from '../seed/portal-followups'
import { seed as seedPortalFrame } from '../seed/portal-frame'
import { seed as seedPortalSales } from '../seed/portal-sales'
import { seed as seedPortalSupply } from '../seed/portal-supply'
import { seed as seedPpeTexts } from '../seed/ppe-texts'
import { seed as seedSafety } from '../seed/safety'
import { seed as seedPeople } from '../seed/people'
import { seed as seedPricing } from '../seed/pricing'
import { seed as seedPrint } from '../seed/print'
import { seed as seedPrivacy } from '../seed/privacy'
import { seed as seedPrivacyOps } from '../seed/privacy-ops'
import { seed as seedProduct } from '../seed/product'
import { seed as seedProduction } from '../seed/production'
import { seed as seedQuality } from '../seed/quality'
import { seed as seedQualityLab } from '../seed/quality-lab'
import { seed as seedReturns } from '../seed/returns'
import { seed as seedReasons } from '../seed/reasons'
import { seed as seedRecall } from '../seed/recall'
import { seed as seedReceivables } from '../seed/receivables'
import { seed as seedRoles } from '../seed/roles'
import { seed as seedSales } from '../seed/sales'
import { seed as seedSalesIntake } from '../seed/sales-intake'
import { seed as seedSalesPricing } from '../seed/sales-pricing'
import { seed as seedSalesOrdersDepth } from '../seed/sales-orders-depth'
import { seed as seedSamples } from '../seed/samples'
import { seed as seedSchedule } from '../seed/schedule'
import { seed as seedSearch } from '../seed/search'
import { seed as seedSecurity } from '../seed/security'
import { seed as seedService } from '../seed/service'
import { seed as seedShipping } from '../seed/shipping'
import { seed as seedSizesDepth } from '../seed/sizes-depth'
import { seed as seedSkills } from '../seed/skills'
import { seed as seedSourcing } from '../seed/sourcing'
import { seed as seedStylesDepth } from '../seed/styles-depth'
import { seed as seedSubcontract } from '../seed/subcontract'
import { seed as seedSubcontractReceipts } from '../seed/subcontract-receipts'
import { seed as seedSubstances } from '../seed/substances'
import { seed as seedSuppliersDepth } from '../seed/suppliers-depth'
import { seed as seedSupply } from '../seed/supply'
import { seed as seedTax } from '../seed/tax'
import { seed as seedTechfiles } from '../seed/techfiles'
import { seed as seedThreads } from '../seed/threads'
import { seed as seedTime } from '../seed/time'
import { seed as seedViews } from '../seed/views'
import { seed as seedWarehouseDepth } from '../seed/warehouse-depth'
import { seed as seedFollowupsPlatformW2b } from '../seed/w2b-followups-platform'
import { openFactoryDatabase, type FactoryClient, type FactoryDatabase, type FactoryScope } from './client'
import { classifiedModels } from './ownership'
import { PLATFORM_ROLE, POLICY_KEYS, RUNTIME_LOGIN, RUNTIME_ROLES, WALL, type PolicyKeyName, type RuntimeRole } from './roles'
import { migratedDatabase, type MigratedDatabase } from './testing/database'
import { loadOwnership, loadSchema } from './tools'

/**
 * The generated isolation tests (plan A1 §6.7): for EVERY classified table and EVERY runtime role, on a database built
 * from the migrations and seeded twice (tenant A and tenant B, two sites each, one portal party each), through the
 * real login, the audited pool and the scoped client:
 *   - a role with select sees exactly the rows inside its scope (tenant, and site or party where it is scoped by them,
 *     and only the listed values of a column where it has onlyValues), and rows outside it exist, so the wall is really
 *     tested;
 *   - it cannot read a hidden column, and Prisma's default select (every column) fails loudly;
 *   - a role with insert cannot insert a row outside its scope (the control insert inside it works; the copied row
 *     gets a new id, and its unique text and number columns new values);
 *   - a role with update changes no row outside its scope and cannot move a row out of it (the control works);
 *   - a role with delete deletes no row outside its scope;
 *   - every privilege the classification does not grant is refused.
 * The cases come from ownership/*.json and the schema: a new model gets its tests without a new line here.
 */

const classified = classifiedModels(loadSchema(), loadOwnership())
const DENIED = /permission denied/
const RLS = /row-level security/

let db: MigratedDatabase
let factory: FactoryDatabase
let a: CoreSeed
let b: CoreSeed
/** Tenant A's portal party: the audit seed writes its partner rows for it, the parties seed its Party row (P1). */
let partyId: string

/** Tenant A's scope for each role; the floor device sits on A's first site. */
function scopeOf(role: RuntimeRole): FactoryScope {
  const base = { tenantId: a.tenantId, actorId: a.actorId }
  if (role === 'factory_runtime') return { audience: 'office', ...base }
  if (role === 'factory_floor_runtime') return { audience: 'floor', ...base, siteId: a.sites[0]!.id }
  if (role === 'factory_partner_runtime') return { audience: 'partner', ...base, partyId }
  return { audience: 'platform' }
}
const keyValue = (key: PolicyKeyName): string => ({ tenant: a.tenantId, site: a.sites[0]!.id, party: partyId })[key]

const as = <T>(role: RuntimeRole, work: (client: FactoryClient) => Promise<T>): Promise<T> => factory.withScope(scopeOf(role), work)
const query = (role: RuntimeRole, sql: string, ...values: unknown[]) => as(role, (client) => client.$queryRawUnsafe<Record<string, unknown>[]>(sql, ...values))
const execute = (role: RuntimeRole, sql: string, ...values: unknown[]) => as(role, (client) => client.$executeRawUnsafe(sql, ...values))
const admin = async (sql: string, values: unknown[] = []) => (await db.admin.query(sql, values)).rows as Record<string, unknown>[]
/**
 * Removes a row the test inserted. Append-only tables refuse DELETE for every login (their triggers), so the cleanup
 * runs with triggers off for its own transaction (session_replication_role, superuser only: the test admin).
 */
async function removeRow(table: string, pk: string, id: unknown): Promise<void> {
  await db.admin.query('BEGIN')
  try {
    await db.admin.query("SET LOCAL session_replication_role = 'replica'")
    await db.admin.query(`DELETE FROM ${table} WHERE ${pk} = $1::uuid`, [id])
    await db.admin.query('COMMIT')
  } catch (error) {
    await db.admin.query('ROLLBACK')
    throw error
  }
}
const q = (name: string): string => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`bad identifier ${name}`)
  return `"${name}"`
}

beforeAll(async () => {
  db = await migratedDatabase('isolation')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  a = await seed({ db: factory, namespace: 'iso-a' })
  b = await seed({ db: factory, namespace: 'iso-b' })
  partyId = (await seedAudit({ db: factory, namespace: 'iso-a' })).partyId
  await seedAudit({ db: factory, namespace: 'iso-b' })
  await seedAuth({ db: factory, namespace: 'iso-a' })
  await seedAuth({ db: factory, namespace: 'iso-b' })
  await seedNumbering({ db: factory, namespace: 'iso-a' })
  await seedNumbering({ db: factory, namespace: 'iso-b' })
  await seedOutbox({ db: factory, namespace: 'iso-a' })
  await seedOutbox({ db: factory, namespace: 'iso-b' })
  await seedParties({ db: factory, namespace: 'iso-a' })
  await seedParties({ db: factory, namespace: 'iso-b' })
  await seedProduct({ db: factory, namespace: 'iso-a' })
  await seedProduct({ db: factory, namespace: 'iso-b' })
  await seedCompliance({ db: factory, namespace: 'iso-a' })
  await seedCompliance({ db: factory, namespace: 'iso-b' })
  await seedRoles({ db: factory, namespace: 'iso-a' })
  await seedRoles({ db: factory, namespace: 'iso-b' })
  await seedIntegration({ db: factory, namespace: 'iso-a' })
  await seedIntegration({ db: factory, namespace: 'iso-b' })
  await seedFiles({ db: factory, namespace: 'iso-a' })
  await seedFiles({ db: factory, namespace: 'iso-b' })
  await seedLinks({ db: factory, namespace: 'iso-a' })
  await seedLinks({ db: factory, namespace: 'iso-b' })
  await seedFloorAuth({ db: factory, namespace: 'iso-a' })
  await seedFloorAuth({ db: factory, namespace: 'iso-b' })
  await seedNumberingBlocks({ db: factory, namespace: 'iso-a' })
  await seedNumberingBlocks({ db: factory, namespace: 'iso-b' })
  await seedFloorSync({ db: factory, namespace: 'iso-a' })
  await seedFloorSync({ db: factory, namespace: 'iso-b' })
  await seedThreads({ db: factory, namespace: 'iso-a' })
  await seedThreads({ db: factory, namespace: 'iso-b' })
  await seedImports({ db: factory, namespace: 'iso-a' })
  await seedImports({ db: factory, namespace: 'iso-b' })
  await seedPrint({ db: factory, namespace: 'iso-a' })
  await seedPrint({ db: factory, namespace: 'iso-b' })
  await seedEmail({ db: factory, namespace: 'iso-a' })
  await seedEmail({ db: factory, namespace: 'iso-b' })
  await seedEmailIn({ db: factory, namespace: 'iso-a' })
  await seedEmailIn({ db: factory, namespace: 'iso-b' })
  await seedSales({ db: factory, namespace: 'iso-a' })
  await seedSales({ db: factory, namespace: 'iso-b' })
  await seedSupply({ db: factory, namespace: 'iso-a' })
  await seedSupply({ db: factory, namespace: 'iso-b' })
  await seedInventory({ db: factory, namespace: 'iso-a' })
  await seedInventory({ db: factory, namespace: 'iso-b' })
  await seedProduction({ db: factory, namespace: 'iso-a' })
  await seedProduction({ db: factory, namespace: 'iso-b' })
  await seedPrivacy({ db: factory, namespace: 'iso-a' })
  await seedPrivacy({ db: factory, namespace: 'iso-b' })
  await seedQuality({ db: factory, namespace: 'iso-a' })
  await seedQuality({ db: factory, namespace: 'iso-b' })
  await seedShipping({ db: factory, namespace: 'iso-a' })
  await seedShipping({ db: factory, namespace: 'iso-b' })
  await seedMoney({ db: factory, namespace: 'iso-a' })
  await seedMoney({ db: factory, namespace: 'iso-b' })
  await seedCosting({ db: factory, namespace: 'iso-a' })
  await seedCosting({ db: factory, namespace: 'iso-b' })
  await seedQualityLab({ db: factory, namespace: 'iso-a' })
  await seedQualityLab({ db: factory, namespace: 'iso-b' })
  await seedInsights({ db: factory, namespace: 'iso-a' })
  await seedInsights({ db: factory, namespace: 'iso-b' })
  await seedPricing({ db: factory, namespace: 'iso-a' })
  await seedPricing({ db: factory, namespace: 'iso-b' })
  await seedReturns({ db: factory, namespace: 'iso-a' })
  await seedReturns({ db: factory, namespace: 'iso-b' })
  // The platform schema of W2a (wave 1/7).
  for (const seedPlatform of [seedCalendar, seedReasons, seedCollab, seedViews, seedAlerts, seedSearch, seedOps]) {
    await seedPlatform({ db: factory, namespace: 'iso-a' })
    await seedPlatform({ db: factory, namespace: 'iso-b' })
  }
  await seedSourcing({ db: factory, namespace: 'iso-a' })
  await seedSourcing({ db: factory, namespace: 'iso-b' })
  await seedSubcontract({ db: factory, namespace: 'iso-a' })
  await seedSubcontract({ db: factory, namespace: 'iso-b' })
  // W2b schema wave 1/7: goods out to and back from a workshop, a job sheet version.
  await seedSubcontractReceipts({ db: factory, namespace: 'iso-a' })
  await seedSubcontractReceipts({ db: factory, namespace: 'iso-b' })
  // The stock and planning schema of W2a (wave 4/7).
  await seedPlanning({ db: factory, namespace: 'iso-a' })
  await seedPlanning({ db: factory, namespace: 'iso-b' })
  // The production and schedule schema of W2a (wave 5/7).
  await seedSchedule({ db: factory, namespace: 'iso-a' })
  await seedSchedule({ db: factory, namespace: 'iso-b' })
  // The quality, plant and shipping schema of W2a (wave 6/7).
  await seedHolds({ db: factory, namespace: 'iso-a' })
  await seedHolds({ db: factory, namespace: 'iso-b' })
  await seedPlant({ db: factory, namespace: 'iso-a' })
  await seedPlant({ db: factory, namespace: 'iso-b' })
  // The money schema of W2a (wave 7/7).
  for (const seedMoneyW2a of [seedReceivables, seedAccounting]) {
    await seedMoneyW2a({ db: factory, namespace: 'iso-a' })
    await seedMoneyW2a({ db: factory, namespace: 'iso-b' })
  }
  // W2b schema wave 2/7: the follow-ups for quality, planning and money.
  await seedFollowupsQualityMoney({ db: factory, namespace: 'iso-a' })
  await seedFollowupsQualityMoney({ db: factory, namespace: 'iso-b' })
  // The W2a follow-ups for sales, product and platform (W2b schema wave 3/7).
  await seedFollowupsPlatformW2b({ db: factory, namespace: 'iso-a' })
  await seedFollowupsPlatformW2b({ db: factory, namespace: 'iso-b' })
  // The people schema of W2b (wave 4/7).
  for (const seedPeopleW2b of [seedPeople, seedSkills]) {
    await seedPeopleW2b({ db: factory, namespace: 'iso-a' })
    await seedPeopleW2b({ db: factory, namespace: 'iso-b' })
  }
  // The time and attendance schema of W2b (wave 5/7).
  await seedTime({ db: factory, namespace: 'iso-a' })
  await seedTime({ db: factory, namespace: 'iso-b' })
  // The piece pay and payroll export schema of W2b (wave 6/7).
  // B-W2b-30: piece pay ON (the default seed leaves it OFF), so every pay table has a first row to copy.
  await seedPay({ db: factory, namespace: 'iso-a' }, { piecePay: true })
  await seedPay({ db: factory, namespace: 'iso-b' }, { piecePay: true })
  // The floor work schema of W2b (wave 7/7).
  for (const seedFloorWork of [seedAndon, seedLabour]) {
    await seedFloorWork({ db: factory, namespace: 'iso-a' })
    await seedFloorWork({ db: factory, namespace: 'iso-b' })
  }
  // The inspection plans and records schema of W2b (wave 10/16).
  await seedInspectionPlans({ db: factory, namespace: 'iso-a' })
  await seedInspectionPlans({ db: factory, namespace: 'iso-b' })
  // The quality problems schema of W2b (wave 11/16).
  await seedCapa({ db: factory, namespace: 'iso-a' })
  await seedCapa({ db: factory, namespace: 'iso-b' })
  // The leather and roll stock schema of W2b (wave 12/16).
  await seedLeather({ db: factory, namespace: 'iso-a' })
  await seedLeather({ db: factory, namespace: 'iso-b' })
  // The cutting room schema of W2b (wave 13/16).
  await seedCutting({ db: factory, namespace: 'iso-a' })
  await seedCutting({ db: factory, namespace: 'iso-b' })
  // The plant care schema of W2b (wave 14/16).
  await seedPlantCare({ db: factory, namespace: 'iso-a' })
  await seedPlantCare({ db: factory, namespace: 'iso-b' })
  // The safety at work schema of W2b (wave 15/16).
  await seedSafety({ db: factory, namespace: 'iso-a' })
  await seedSafety({ db: factory, namespace: 'iso-b' })
  // The protected safety data schema of W2b (wave 16/16).
  await seedHealth({ db: factory, namespace: 'iso-a' })
  await seedHealth({ db: factory, namespace: 'iso-b' })
  // The portal identity schema of W2b (wave 17/22): partner users, their sessions and codes, portal settings, branding, terms.
  await seedPortalAuth({ db: factory, namespace: 'iso-a' })
  await seedPortalAuth({ db: factory, namespace: 'iso-b' })
  // The files in depth schema of W2b (wave 18/22).
  await seedFilesDepth({ db: factory, namespace: 'iso-a' })
  await seedFilesDepth({ db: factory, namespace: 'iso-b' })
  // W2b-2 (B-W2b-74): a floor session inserts only an unplanned operation, so the first operation of tenant A's first site is
  // one, on its work order in progress (the seeds leave a work order's operations to their routing, every test reads them).
  await db.admin.query(
    `INSERT INTO "WorkOrderOperation" (id, "tenantId", "siteId", "workOrderId", "styleRevisionId", seq, "operationId", "unplannedReason", code, name, "standardMinutes", "workCentreId")
     SELECT '00000000-0000-7000-8000-000000000074', o."tenantId", o."siteId", o."workOrderId", o."styleRevisionId", 900, r."operationId", 'QUALITY_FIX', l.code, l.name, l."standardMinutes", o."workCentreId"
       FROM "WorkOrderOperation" o
       JOIN "WorkOrder" w ON w."tenantId" = o."tenantId" AND w.id = o."workOrderId"
       JOIN "RoutingOperation" r ON r."tenantId" = o."tenantId" AND r."revisionId" = o."styleRevisionId" AND r.seq = o."routingSeq"
       JOIN "Operation" l ON l."tenantId" = r."tenantId" AND l.id = r."operationId"
      WHERE o."siteId" = $1 AND w.status = 'IN_PROGRESS' ORDER BY o.seq LIMIT 1`,
    [a.sites[0]!.id],
  )
  // The links in depth schema of W2b (wave 19/22).
  await seedLinksDepth({ db: factory, namespace: 'iso-a' })
  await seedLinksDepth({ db: factory, namespace: 'iso-b' })
  // The portal frame schema of W2b (wave 20/22): partner tasks, notifications and e-mail settings, a portal post.
  await seedPortalFrame({ db: factory, namespace: 'iso-a' })
  await seedPortalFrame({ db: factory, namespace: 'iso-b' })
  // The customer portal schema of W2b (wave 21/22): order requests, change requests, payment intents, measurements by link.
  await seedPortalSales({ db: factory, namespace: 'iso-a' })
  await seedPortalSales({ db: factory, namespace: 'iso-b' })
  // The supplier portal schema of W2b (wave 22/22): P2's ship notices, answers and job; with partnerScope, rows of P1's own
  // (a sent purchase order with a draft ship notice, a job at its workshop, an answer) for the partner scope.
  await seedPortalSupply({ db: factory, namespace: 'iso-a' }, { partnerScope: true })
  await seedPortalSupply({ db: factory, namespace: 'iso-b' }, { partnerScope: true })
  // The portal follow-ups of W2b (schema wave 23): P2's uploads and change requests; with partnerScope, P1's delivery address
  // that waits for the office's check (the first address: a partner session inserts only such a one), upload and request.
  await seedPortalFollowups({ db: factory, namespace: 'iso-a' }, { partnerScope: true })
  await seedPortalFollowups({ db: factory, namespace: 'iso-b' }, { partnerScope: true })
  // W2b-4 routings, standard minutes and work instructions (schema wave 25/33): SMV versions, per-size times, machine
  // settings, work instructions with versions, steps and media, the acknowledgements on A1's tablet.
  await seedInstructions({ db: factory, namespace: 'iso-a' })
  await seedInstructions({ db: factory, namespace: 'iso-b' })
  // The styles and libraries schema of W2b-4 (wave 26/33): texts, pictures, revision files, product types, GTIN ranges, branding
  // sets, product settings; its first picture, revision file, branding set and SKU are the plain ones a copy may repeat.
  await seedStylesDepth({ db: factory, namespace: 'iso-a' })
  await seedStylesDepth({ db: factory, namespace: 'iso-b' })
  // W2b-4 sizes, measurements and made-to-measure rules (schema wave 27/33): a fit scale, points of measure, specs, grade
  // rules, prepacks, protector placement, template rules and limits.
  await seedSizesDepth({ db: factory, namespace: 'iso-a' })
  await seedSizesDepth({ db: factory, namespace: 'iso-b' })
  // The BOM depth and option library schema of W2b-4 (wave 28/33): a sub-assembly, alternates, option groups, values, rules,
  // effects and a style's offers; its first group, value, rule, effect, offer (archived) and alternate are the ones a copy may repeat.
  await seedOptions({ db: factory, namespace: 'iso-a' })
  await seedOptions({ db: factory, namespace: 'iso-b' })
  // The change control, release and samples schema of W2b-4 (wave 29/33): sample rounds with their fit, swatches, shipments and
  // order gates; change requests (one from A1's floor, which a floor session copies), a DRAFT change order with its lines and
  // an undecided approval. Their first rows are the plain ones a copy may repeat.
  for (const seedChangesSamples of [seedSamples, seedChanges]) {
    await seedChangesSamples({ db: factory, namespace: 'iso-a' })
    await seedChangesSamples({ db: factory, namespace: 'iso-b' })
  }
  // The compliance rule library of W2b-4 (wave 30/33): the register and its watch, markets, requirements, gate events at A1
  // and B1, operators, phrases and translations, notified bodies, the certificates naming them; its first entry, market,
  // requirement, refusal (A1), operator, phrase, draft translation, change and (archived) body are the ones a copy may repeat.
  await seedComplianceRules({ db: factory, namespace: 'iso-a' })
  await seedComplianceRules({ db: factory, namespace: 'iso-b' })
  // The materials and restricted substances schema of W2b-4 (wave 31/33): the substance list, its rules, Candidate List
  // versions, test plans, material profiles, and declarations asked of P2 and of P1 (the brand that sends its own lining:
  // the partner reads its request and line). Their first rows are the plain ones a copy may repeat.
  await seedSubstances({ db: factory, namespace: 'iso-a' })
  await seedSubstances({ db: factory, namespace: 'iso-b' })
  // The declarations, technical files and labels of W2b-4 (wave 32/33): documents and their batches, technical files with items,
  // risk assessments, production-control tests, evidence packs, label kinds, artwork and spoiled labels at A1; its first batch
  // record (typed), file (archived), item, assessment (draft) and row, test (due), pack (building), artwork (draft) and spoiled
  // labels are the plain ones a copy may repeat.
  await seedTechfiles({ db: factory, namespace: 'iso-a' })
  await seedTechfiles({ db: factory, namespace: 'iso-b' })
  // The recall, authority and claims schema of W2b-4 (wave 33/33): authority notices, recalls and withdrawals with their
  // progress, distributor notices, authority requests, sustainability claims and their uses; their first rows (DRAFT notices,
  // recall and claim of OPEN entries, an OPEN request, the DRAFT recall's progress without a shipment, a use of an APPROVED
  // claim that never expires) are the plain ones a copy may repeat.
  await seedRecall({ db: factory, namespace: 'iso-a' })
  await seedRecall({ db: factory, namespace: 'iso-b' })
  // The W2b-4 follow-ups of W2b-5 (schema wave 34/44): the PPE text approvals; company B's approval in force is the first row
  // (the one a copy may repeat), company A's two are withdrawn.
  await seedPpeTexts({ db: factory, namespace: 'iso-a' })
  await seedPpeTexts({ db: factory, namespace: 'iso-b' })
  // The approvals schema of W2b-5 (wave 35/44): approval rules (all switched off: Owner answer Q3), requests for a yes in each
  // state and their history; the first rule (off), request (PENDING) and line (its REQUESTED) are the plain ones a copy may repeat.
  await seedApprovals({ db: factory, namespace: 'iso-a' })
  await seedApprovals({ db: factory, namespace: 'iso-b' })
  // The warehouse in depth schema of W2b-5 (wave 36/44): places, defaults, transfers, schedules, a count that freezes moves with
  // its scans, the warehouse rules, the task inbox, substitutes and goods without a PO at A1 (and B1's default); their first
  // rows (an inactive default, a DRAFT transfer and its line, an OPEN task, a WAITING substitute, an ADDED line of a COUNTING
  // count and its COUNT scan) are the plain ones a copy may repeat.
  await seedWarehouseDepth({ db: factory, namespace: 'iso-a' })
  await seedWarehouseDepth({ db: factory, namespace: 'iso-b' })
  // The sales intake and customers schema of W2b-5 (wave 37/44): seasons, inquiries and their lines, customer requirements,
  // holds and terms per company, a rider under a team, the contacts' lawful basis and an erased contact; their first rows (an
  // OPEN season, a NEW office inquiry and its line, a requirement in force, a RELEASED hold, ENDED terms) are the plain ones a
  // copy may repeat.
  await seedSalesIntake({ db: factory, namespace: 'iso-a' })
  await seedSalesIntake({ db: factory, namespace: 'iso-b' })
  // The quotes, pricing and configuration schema of W2b-5 (wave 38/44): templates, delivery schedules and chosen options of a
  // DRAFT quote and a CONFIRMED order for P1 (the partner reads them), breaks and surcharges of a DRAFT price list version,
  // minimums, size curves; their first rows (a delivery bringing at most half of each size, a default option) are the plain
  // ones a copy may repeat.
  await seedSalesPricing({ db: factory, namespace: 'iso-a' })
  await seedSalesPricing({ db: factory, namespace: 'iso-b' })
  // The orders, credit and changes schema of W2b-5 (wave 39/44): freeze rules, credit checks with an override, customers'
  // materials, an order waiting for a yes, a priced amendment, customer-owned stock; the first freeze rule (off), check (a PASS)
  // and material (of the waiting order) are the plain ones a copy may repeat.
  await seedSalesOrdersDepth({ db: factory, namespace: 'iso-a' })
  await seedSalesOrdersDepth({ db: factory, namespace: 'iso-b' })
  // Buying and subcontracting in depth (W2b-5 schema wave 40/44): variants, tolerances, two purchase orders with their delivery
  // schedules (P1's), a re-dated delivery, requests to buy, a workshop's cost; with partnerScope a SENT kit line of P1's job and
  // its material balance. Their first rows (a DRAFT order's delivery, the newest change of its date, an OPEN request, an
  // adjustment that moves 0.1 from used to scrapped, a fee) are the ones a copy may repeat.
  await seedBuyingDepth({ db: factory, namespace: 'iso-a' }, { partnerScope: true })
  await seedBuyingDepth({ db: factory, namespace: 'iso-b' }, { partnerScope: true })
  // The planning depth schema of W2b-5 (wave 41/44): planned work and subcontract orders, action messages, promises, the
  // board's changes and pins, what-ifs, a workshop's capacity; their first rows (a PLANNED order with a protected due date, an
  // OPEN message, a re-promise, a move, a DRAFT what-if, an open capacity) are the plain ones a copy may repeat.
  await seedPlanningDepth({ db: factory, namespace: 'iso-a' })
  await seedPlanningDepth({ db: factory, namespace: 'iso-b' })
  // The suppliers schema of W2b-5 (wave 42/44): P2's kinds, status and origin, its bank accounts (never changed in place), its
  // qualifications and written terms; the first account (PROPOSED in the portal), qualification (PENDING) and agreement (DRAFT)
  // are the plain ones a copy may repeat; with partnerScope, P1's PROPOSED account (the row a partner session inserts).
  await seedSuppliersDepth({ db: factory, namespace: 'iso-a' }, { partnerScope: true })
  await seedSuppliersDepth({ db: factory, namespace: 'iso-b' }, { partnerScope: true })
  // The returns, repairs, service and product safety schema of W2b-5 (wave 43/44): return policies (the first retired: one
  // live per company and channel) and fee rules, SEED-REP-0001's estimates (the first a DRAFT, its zip line the first line),
  // service cases and their links, safety reports, their injuries (keys `injury:<report>`) and the accident log (the first
  // row a second revision with its reason): the plain ones a copy may repeat. P1's repairs and estimates for the partner scope.
  await seedService({ db: factory, namespace: 'iso-a' })
  await seedService({ db: factory, namespace: 'iso-b' })
  // The made-to-measure office schema of W2b-5 (wave 44/44): the factory review of P1's and P4's rider profiles, a new TROUSERS
  // revision, appointments (the first a BOOKED fitting) and fitting results (the first an OK result that opened nothing), the
  // alteration one opened and a worksheet: the plain ones a copy may repeat.
  await seedMtmOffice({ db: factory, namespace: 'iso-a' })
  await seedMtmOffice({ db: factory, namespace: 'iso-b' })
  // The packing and shipments schema of W2b-6 (wave 46/57): packaging types and defaults (the first switched off), SH-0002's
  // carton typed, numbered and marked with its contents (the first row: a DRAFT shipment's), mark templates (the first switched
  // off), SH-0002's holds (both released) and cut-offs per carrier: the plain ones a copy may repeat.
  await seedPacking({ db: factory, namespace: 'iso-a' })
  await seedPacking({ db: factory, namespace: 'iso-b' })
  // The notifications, My work and mail schema of W2b-6 (wave 47/57): preferences, role defaults, push devices, view follows,
  // reminders, team inboxes and capture addresses; their first rows (a turned-off push device without keys, a waiting
  // reminder, a turned-off capture address) are the plain ones a copy may repeat.
  await seedNotifyDepth({ db: factory, namespace: 'iso-a' })
  await seedNotifyDepth({ db: factory, namespace: 'iso-b' })
  // The carriers, labels and dispatch schema of W2b-6 (wave 48/57): carrier contracts (the first switched off without its
  // number), a customer's carrier account, a live site, a parcel's values, pickups (the first one that failed), day sheets (the
  // first an open one), a reprint and a printer that prints straight from the station: the plain ones a copy may repeat.
  await seedCarriers({ db: factory, namespace: 'iso-a' })
  await seedCarriers({ db: factory, namespace: 'iso-b' })
  // The invoicing, tax and currency schema of W2b-6 (wave 49/57): e-invoice settings (one company live), tax codes (the first
  // archived), declarations of intent (the first revoked), stamp duty quarters (the first not paid), self-invoices (the first
  // cancelled), our copy of an SDI send, invoice runs (the first a preview), deposit rules (the first archived), currencies (the
  // first switched off) and exchange rates (the first an ECB rate): the plain ones a copy may repeat.
  await seedTax({ db: factory, namespace: 'iso-a' })
  await seedTax({ db: factory, namespace: 'iso-b' })
  // The bank, receivables, payables and accountant's bridge schema of W2b-6 (wave 50/57): bank accounts (the first switched off),
  // a statement and its lines (the first unplaced), matches (the first a suggestion), a write-off with room left in its payment,
  // a draft Ri.Ba. batch and its item, reminder stops (the first a promise that is over), a customer's figures, a draft payment
  // proposal and its line, account mappings, the bridge settings, documents of a draft export and check runs: the plain ones a
  // copy may repeat.
  await seedBank({ db: factory, namespace: 'iso-a' })
  await seedBank({ db: factory, namespace: 'iso-b' })
  // The delivery, returns and customs schema of W2b-6 (wave 51/57): tracking problems (the first resolved), return labels (the
  // first offered by link on the waiting RMA) and customs declarations (the first with its pack merely sent): the plain ones a
  // copy may repeat.
  await seedCustoms({ db: factory, namespace: 'iso-a' })
  await seedCustoms({ db: factory, namespace: 'iso-b' })
  // The security and audit schema of W2b-6 (wave 52/57): the security settings, an archived custom role, sessions with their
  // device and place, step-up tries (the first a plain wrong code), security events (the first a failed sign-in of nobody
  // known; the floor's at A1 and B1, P1's portal) and reads of sensitive records: the plain ones a copy may repeat.
  await seedSecurity({ db: factory, namespace: 'iso-a' })
  await seedSecurity({ db: factory, namespace: 'iso-b' })
  // The privacy and integration schema of W2b-6 (wave 53/57): data requests (the first one RECEIVED), the erasure of P3's former
  // contact (the first row: of a request in progress), retention rules (the first one only reports) and REPORT sweeps, the
  // error queue (the first item an OPEN refused call) and job runs (the first a succeeded tick): the plain ones a copy may repeat.
  await seedPrivacyOps({ db: factory, namespace: 'iso-a' })
  await seedPrivacyOps({ db: factory, namespace: 'iso-b' })
  // The actual cost schema of W2b-6 (wave 54/57): company A's settings with its figures for the accountant switched on, a work
  // order closed twice (the first close undone, its entries reversed), its variance split, a purchase price variance, cost of
  // goods sold (one reversed) and landed cost (one reversed, the first a DRAFT with its share): the plain ones a copy may repeat.
  await seedCostActuals({ db: factory, namespace: 'iso-a' })
  await seedCostActuals({ db: factory, namespace: 'iso-b' })
  // Every seed of both tenants: under a full parallel run this takes more than a minute.
}, 120_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

it('covers every classified table and every runtime role', () => {
  expect(classified.map(({ model }) => model.name).sort()).toEqual([
    'AbsenceCode',
    'AbsenceEntry',
    'AccidentLogEntry',
    'AccountMapping',
    'AccountingExport',
    'AccountingExportFile',
    'AccountingSettings',
    'ActualCostSettings',
    'Alert',
    'AlertEvent',
    'AlertRule',
    'Appointment',
    'ApprovalEvent',
    'ApprovalRequest',
    'ApprovalRule',
    'ApprovalTask',
    'AqlProfile',
    'AqlProfileAssignment',
    'AttendanceAnomaly',
    'AttendanceCorrection',
    'AttendanceDay',
    'AttendanceMonthClose',
    'AttentionAction',
    'AttentionActionLog',
    'AuditLog',
    'AuthorityNotice',
    'AuthorityRequest',
    'Badge',
    'BankAccount',
    'BankLine',
    'BankMatch',
    'BankStatement',
    'BomLine',
    'BomLineAlternate',
    'BomLineColour',
    'BomLineSize',
    'BrandingSet',
    'Bundle',
    'BundleCoupon',
    'BundleReprint',
    'CalendarDay',
    'Capa',
    'CapaAction',
    'CapaSource',
    'CaptureAddress',
    'CarrierAccount',
    'CarrierCutOff',
    'CauseCode',
    'Certificate',
    'CertificateCoverage',
    'CertificateRenewal',
    'ChangeApproval',
    'ChangeOrder',
    'ChangeOrderItem',
    'ChangeRequest',
    'Chemical',
    'ClaimUse',
    'ClickingDie',
    'ClockEvent',
    'Colour',
    'Colourway',
    'Company',
    'CompanyBranding',
    'CompanyEInvoiceSettings',
    'Complaint',
    'ComplianceDocument',
    'ComplianceDocumentBatch',
    'ComplianceRequirement',
    'CostOfSalesEntry',
    'CostingSettings',
    'CountSchedule',
    'CreditCheck',
    'CrewMember',
    'CrewSession',
    'CronRun',
    'Currency',
    'CustomerMaterial',
    'CustomerRequirement',
    'CustomerStatementFigures',
    'CustomsDeclaration',
    'CutConsumption',
    'CutIssue',
    'CutIssueLine',
    'CutLog',
    'CutLogPiece',
    'CutOrder',
    'CutOrderLine',
    'CutReconciliation',
    'CutTicket',
    'DataRequest',
    'Ddt',
    'DdtCancellation',
    'DeclarationOfIntent',
    'DefaultLocation',
    'DefectCode',
    'DeliveryTolerance',
    'DepositCancellationRule',
    'DepositRequest',
    'Device',
    'DeviceEnrolment',
    'DispatchAssignment',
    'DispatchManifest',
    'DispositionCode',
    'DistributorNotice',
    'DueTimer',
    'EarningsEntry',
    'EconomicOperatorRole',
    'EmailIdentity',
    'EmailOutbound',
    'Employee',
    'EmployeeSkill',
    'ErasureRecord',
    'EvidencePack',
    'ExchangeRate',
    'ExportJob',
    'ExportedDocument',
    'FabricRoll',
    'FileMarkup',
    'FileUploadSession',
    'FirstLoadStep',
    'FitnessJudgement',
    'FittingResult',
    'FloorRefusedAction',
    'FloorScanRefusal',
    'FloorSession',
    'FloorSettings',
    'FloorSyncEvent',
    'GarmentDowngrade',
    'GarmentLabelPrint',
    'GarmentLabelSpoil',
    'GarmentProtectorLot',
    'GarmentSerial',
    'GateEvent',
    'GeneratedDocument',
    'GoodsReceipt',
    'GoodsReceiptLine',
    'GradeRule',
    'GradeRuleStep',
    'GtinRange',
    'HandoverNote',
    'HealthPlan',
    'HealthVisit',
    'HeldScan',
    'HelpCall',
    'HelpCallType',
    'Hide',
    'HideMark',
    'HideMeasure',
    'IdempotencyReceipt',
    'ImportJob',
    'ImportRow',
    'InProcessCheck',
    'InailFiling',
    'InboundEmail',
    'InboundWebhook',
    'IncentiveScheme',
    'Incident',
    'IncidentAction',
    'IncidentPerson',
    'IncomingComponentResult',
    'IncomingHideResult',
    'IncomingInspection',
    'IncomingRollResult',
    'Inquiry',
    'InquiryLine',
    'Inspection',
    'InspectionAmendment',
    'InspectionCheckResult',
    'InspectionDefect',
    'InspectionMeasurement',
    'InspectionPlan',
    'InspectionPlanCheck',
    'InspectionPlanVersion',
    'InspectionTrigger',
    'InstructionAcknowledgement',
    'InstructionRecord',
    'IntegrationAccount',
    'IntegrationCall',
    'IntegrationErrorItem',
    'IntegrityCheckRun',
    'InterestReferenceRate',
    'InventorySettings',
    'Invitation',
    'Invoice',
    'InvoiceLine',
    'InvoiceRun',
    'Item',
    'ItemColour',
    'ItemGradeRule',
    'ItemPlanning',
    'ItemVariant',
    'LabResult',
    'LabelArtworkVersion',
    'LabelTemplate',
    'LabourDay',
    'LabourDispute',
    'LabourEdit',
    'LabourRate',
    'LandedCostAllocation',
    'LandedCostShare',
    'Lay',
    'LayRoll',
    'LeatherGrade',
    'LeaverCase',
    'LeaverStep',
    'Line',
    'LineCapacity',
    'LineLoan',
    'LineTarget',
    'LinkDraft',
    'LinkEvidence',
    'LinkFile',
    'Location',
    'Lot',
    'LotDocument',
    'Machine',
    'MachineAuthorisation',
    'MachineCheckPlan',
    'MachineCheckResult',
    'MachineCheckType',
    'MachineClass',
    'MachineStatusEvent',
    'MachineSymptom',
    'MaintenanceJob',
    'MaintenanceRequest',
    'MarketProfile',
    'MaterialComplianceProfile',
    'MaterialRequirement',
    'MaterialSubstitution',
    'MeasurementPoint',
    'MeasurementProfile',
    'MeasurementRule',
    'MeasurementSpec',
    'MeasurementSpecValue',
    'MeasurementTemplate',
    'Message',
    'MessageMention',
    'MoqRule',
    'MrpActionMessage',
    'NcrConcession',
    'NcrContainmentAction',
    'NcrCostLine',
    'NcrDispositionLine',
    'NcrLink',
    'Nonconformance',
    'Notification',
    'NotificationDelivery',
    'NotificationPreference',
    'NotifiedBody',
    'NumberAllocation',
    'NumberBlock',
    'NumberBlockUse',
    'NumberSeries',
    'OffStandardCode',
    'OffStandardEntry',
    'OneOffLink',
    'Operation',
    'OperationChecklistResult',
    'OperationMachineSetting',
    'OperationScan',
    'OperationScanDefect',
    'OperationScanMember',
    'OperationTimeVersion',
    'OptionEffect',
    'OptionGroup',
    'OptionRule',
    'OptionValue',
    'OrderChangeRequest',
    'OrderChangeRequestLine',
    'OrderFreezeRule',
    'OrderGate',
    'OrgArea',
    'OutboxEvent',
    'OvertimeAgreement',
    'OvertimeEntry',
    'OvertimeRequest',
    'PackagingDefault',
    'PackagingType',
    'Parcel',
    'ParcelLine',
    'PartnerEmailPreference',
    'PartnerNoticeAck',
    'PartnerTask',
    'Party',
    'PartyAddress',
    'PartyChangeRequest',
    'PartyCompanyTerms',
    'PartyContact',
    'PartyHold',
    'PartyPriceListAssignment',
    'PartyTaxIdentity',
    'PasswordReset',
    'PatternPiece',
    'PayPeriod',
    'PayablesSettings',
    'Payment',
    'PaymentAllocation',
    'PaymentIntent',
    'PaymentProposal',
    'PaymentProposalLine',
    'PaymentReminder',
    'PaymentTerms',
    'PaymentWriteOff',
    'PayrollCodeMapping',
    'PayrollExport',
    'PayrollExportFile',
    'PayrollExportLayout',
    'PeopleLegalGate',
    'PeopleSettings',
    'PeriodLock',
    'Phrase',
    'PhraseTranslation',
    'PickupRequest',
    'PiecePaySwitch',
    'PieceRateEntry',
    'PieceRateTable',
    'PieceRateVersion',
    'PlanVersion',
    'PlannedWorkOrder',
    'PlanningException',
    'PlanningRun',
    'PlanningSettings',
    'PlantSettings',
    'PlyRun',
    'PoDateChange',
    'PointOfMeasure',
    'PortalOrderRequest',
    'PortalOrderRequestLine',
    'PortalOrderRequestSize',
    'PortalSettings',
    'PortalSignInCode',
    'PpeIssue',
    'PpeItem',
    'PpeKitLine',
    'PpeRegisterEntry',
    'PpeTextApproval',
    'Prepack',
    'PrepackLine',
    'PriceBreak',
    'PriceList',
    'PriceListEntry',
    'PriceListVersion',
    'PrintJob',
    'Printer',
    'PrivacyDpia',
    'PrivacyNotice',
    'PrivacyNoticeText',
    'ProcessingActivity',
    'ProductRiskAssessment',
    'ProductRiskRow',
    'ProductSafetyInjury',
    'ProductSafetyReport',
    'ProductSettings',
    'ProductTypeProfile',
    'ProductionControlTest',
    'ProductionSettings',
    'PromiseRecord',
    'ProtectedView',
    'ProtectorPlacement',
    'PurchaseOrder',
    'PurchaseOrderLine',
    'PurchaseOrderLineDelivery',
    'PurchaseOrderReminder',
    'PurchaseOrderRevision',
    'PurchasePriceVariance',
    'PurchaseRequest',
    'PurchasingSettings',
    'PushSubscription',
    'QualityAlertRule',
    'QualityHold',
    'QualityHoldGroup',
    'QualityRelease',
    'QualityReleaseReversal',
    'QualitySettings',
    'Quote',
    'QuoteAcceptance',
    'QuoteApproval',
    'QuoteLine',
    'QuoteLineDelivery',
    'QuoteLineOption',
    'QuoteLineSize',
    'QuoteTemplate',
    'QuoteTemplateLine',
    'QuoteVersion',
    'RateAcknowledgement',
    'RatePublication',
    'ReadLog',
    'ReasonCode',
    'RecallAction',
    'RecallProgress',
    'ReceiptDiscrepancy',
    'ReceivablesSettings',
    'RecordFollower',
    'RecordShare',
    'Refund',
    'RegulationOrStandard',
    'Reminder',
    'ReminderStop',
    'Remnant',
    'RepairEstimate',
    'RepairEstimateLine',
    'RepairOrder',
    'RepairStageEvent',
    'ReplacementRequest',
    'ReportRun',
    'ReportSubscription',
    'RequestRoutingRule',
    'RequiredDocumentRule',
    'RequirementPegging',
    'Reservation',
    'RestoreDrill',
    'RestrictedSubstance',
    'RetentionRule',
    'RetentionSweep',
    'ReturnAuthorisation',
    'ReturnFeeRule',
    'ReturnLabel',
    'ReturnLine',
    'ReturnPolicy',
    'ReturnReceipt',
    'ReworkOrder',
    'RibaBatch',
    'RibaItem',
    'RiskAssessment',
    'RiskAssessmentSignature',
    'RiskAssessmentVersion',
    'RiskMeasure',
    'RlsNotice',
    'Role',
    'RoleAssignment',
    'RoleNotificationDefault',
    'RoleSheet',
    'RoleSheetItem',
    'RosterEntry',
    'RoutingOperation',
    'RoutingOperationSizeTime',
    'SafetyAppointment',
    'SafetyCourse',
    'SafetyDataSheet',
    'SafetyDeadline',
    'SalesOrder',
    'SalesOrderAmendment',
    'SalesOrderLine',
    'SalesOrderLineDelivery',
    'SalesOrderLineOption',
    'SalesOrderLineSize',
    'SalesOrderMilestone',
    'SalesSettings',
    'SampleComment',
    'SampleMeasurement',
    'SampleRound',
    'SampleShipment',
    'SampleSwatch',
    'SavedView',
    'ScanCorrectionRequest',
    'ScanPatternFinding',
    'ScheduleChange',
    'ScheduleSlot',
    'ScrapApproval',
    'ScrapReason',
    'SdiArchiveCopy',
    'SdiInboxItem',
    'SdiNotification',
    'SdiSubmission',
    'SearchEntry',
    'Season',
    'SecondaryProcess',
    'SecretValue',
    'SecurityEvent',
    'SecuritySettings',
    'SelfInvoice',
    'ServiceCase',
    'ServiceCaseLink',
    'Session',
    'ShadeGroup',
    'ShiftPattern',
    'ShiftSegment',
    'ShipNotice',
    'ShipNoticeHide',
    'ShipNoticeLine',
    'Shipment',
    'ShipmentHold',
    'ShipmentLine',
    'ShippingMarkTemplate',
    'ShippingSettings',
    'Site',
    'Size',
    'SizeCurve',
    'SizeScale',
    'SizeSurcharge',
    'Skill',
    'StaffNoticeAck',
    'StampDutyQuarter',
    'StandardChange',
    'StandardCost',
    'Station',
    'StepUpAttempt',
    'StockCount',
    'StockCountLine',
    'StockCountScan',
    'StockMove',
    'StockValuation',
    'StoredFile',
    'Style',
    'StyleImage',
    'StyleOptionGroup',
    'StyleRevision',
    'StyleRevisionFile',
    'StyleText',
    'SubcontractAgreement',
    'SubcontractBundle',
    'SubcontractConsumption',
    'SubcontractCostEntry',
    'SubcontractKitLine',
    'SubcontractOperation',
    'SubcontractOrder',
    'SubcontractProgressReport',
    'SubcontractReceipt',
    'SubcontractReceiptLine',
    'SubcontractReturnNotice',
    'SubcontractorCapacity',
    'SubstanceRule',
    'SupplierBankAccount',
    'SupplierClaim',
    'SupplierClaimLine',
    'SupplierDeclarationLine',
    'SupplierDeclarationRequest',
    'SupplierDocumentUpload',
    'SupplierInvoice',
    'SupplierInvoiceFile',
    'SupplierInvoiceLine',
    'SupplierInvoiceMatch',
    'SupplierItem',
    'SupplierQualification',
    'SupplierQuestionnaire',
    'SupplierQuestionnaireResponse',
    'Suppression',
    'SustainabilityClaim',
    'SvhcListVersion',
    'Task',
    'TaxCode',
    'Team',
    'TeamInbox',
    'TeamMember',
    'TechnicalFile',
    'TechnicalFileItem',
    'Tenant',
    'TestPlanRule',
    'Thread',
    'TimesheetApproval',
    'TodayLayout',
    'TrackingEvent',
    'TrackingException',
    'TrainingAttendance',
    'TrainingRecord',
    'TrainingRequirement',
    'TrainingSession',
    'TransferLine',
    'TransferOrder',
    'TypeChangeReview',
    'User',
    'Variant',
    'ViesCheck',
    'ViewFollower',
    'WarehouseTask',
    'WhatIfScenario',
    'WorkCalendar',
    'WorkCentre',
    'WorkCentreCapacity',
    'WorkInstruction',
    'WorkInstructionMedia',
    'WorkInstructionStep',
    'WorkInstructionVersion',
    'WorkOrder',
    'WorkOrderClose',
    'WorkOrderCostEntry',
    'WorkOrderKit',
    'WorkOrderMaterial',
    'WorkOrderOperation',
    'WorkOrderSize',
    'WorkOrderVariance',
    'Worker',
    'WorkerNoticeAck',
    'WorkerRole',
    'WorkerStatement',
    'WorkingTimeRule',
  ])
  expect(RUNTIME_ROLES).toHaveLength(4)
  expect(a.tenantId).not.toBe(b.tenantId)
})

describe.each(classified)('$model.name', ({ model, ownership }) => {
  const table = q(model.table)
  const pk = model.uniques[0]?.[0] as string
  const keyColumns = ownership.keyColumns ?? {}

  describe.each([...RUNTIME_ROLES])('as %s', (role) => {
    const access = ownership.access[role]
    const privileges = new Set(access?.privileges ?? [])
    const hidden = new Set(access?.hiddenColumns ?? [])
    const visible = model.columns.filter((column) => !hidden.has(column))
    // B-W2b-363: a write-only column is written (insert, update) but never read back.
    const writeOnly = new Set(access?.writeOnlyColumns ?? [])
    const readable = visible.filter((column) => !writeOnly.has(column))
    // The platform role has no tenant: its policies see every row.
    const keys: PolicyKeyName[] = role === PLATFORM_ROLE ? [] : [...WALL, ...((access?.scopedBy ?? []) as PolicyKeyName[])]
    // The values exist only once the seed ran, so they are read inside the tests.
    const filter = keys.map((key) => ({ column: keyColumns[key] as string, type: POLICY_KEYS[key].type, value: () => keyValue(key) }))
    const keysInside = filter.map((entry, index) => `${q(entry.column)} = $${index + 1}::${entry.type}`).join(' AND ') || 'true'
    /** The role's value filters (onlyValues): a column and the only values its rows may hold (plain names, checked by db-kit). */
    const only = Object.entries(access?.onlyValues ?? {}).map(([column, list]) => ({ column, sql: `${q(column)}::text IN (${list.map((value) => `'${value.replace(/'/g, "''")}'`).join(', ')})` }))
    const inside = [keysInside, ...only.map((entry) => entry.sql)].join(' AND ')
    const values = () => filter.map((entry) => entry.value())
    /** The first row matching `where`, whose `$n` parameters are the scope's values (or `params`, when given). */
    const rowOf = async (where: string, params: unknown[] = values()): Promise<Record<string, unknown>> => {
      const [row] = await admin(`SELECT to_jsonb(t) AS row FROM ${table} t WHERE ${where} ORDER BY ${q(pk)} LIMIT 1`, params)
      expect(row, `a ${model.name} row ${where}`).toBeDefined()
      return row!.row as Record<string, unknown>
    }
    /**
     * A copy of a row that breaks no unique key: a new id, every unique text column suffixed, and every unique number
     * and date moved out of the seeded range (a NULL stays NULL).
     */
    const copyOf = (row: Record<string, unknown>): Record<string, unknown> => {
      const copy: Record<string, unknown> = { ...row, [pk]: randomUUID() }
      for (const unique of model.uniques) {
        for (const column of unique) {
          const field = model.fields.find((entry) => entry.column === column)
          if (field?.type === 'String' && field.nativeType !== 'Uuid' && row[column] !== null) copy[column] = `${String(row[column])}-copy-${randomUUID().slice(0, 8)}`
          // A number in a unique key (a row number) moves out of the seeded range.
          if (field?.type === 'Int' && row[column] !== null) copy[column] = Number(row[column]) + 1_000_000
          // So does a date or time in one (a validity start): a thousand years later.
          if (field?.type === 'DateTime' && row[column] !== null) {
            const later = new Date(String(row[column]))
            later.setUTCFullYear(later.getUTCFullYear() + 1000)
            copy[column] = field.nativeType === 'Date' ? later.toISOString().slice(0, 10) : later.toISOString()
          }
        }
      }
      return copy
    }
    // Only the columns the role may see: a hidden column has no grant, so its row takes the column's default (B-W2b-79:
    // the floor inserts holds without QualityHold.nextStep).
    const insertColumns = visible.map(q).join(', ')
    const insert = (copy: Record<string, unknown>) =>
      execute(role, `INSERT INTO ${table} (${insertColumns}) SELECT ${insertColumns} FROM jsonb_populate_record(NULL::${table}, $1::jsonb)`, JSON.stringify(copy))

    if (!access) {
      it('has no privilege at all', async () => {
        await expect(query(role, `SELECT 1 FROM ${table} LIMIT 1`)).rejects.toThrow(DENIED)
        await expect(execute(role, `INSERT INTO ${table} (${q(pk)}) VALUES (NULL)`)).rejects.toThrow(DENIED)
        await expect(execute(role, `UPDATE ${table} SET ${q(pk)} = ${q(pk)} WHERE false`)).rejects.toThrow(DENIED)
        await expect(execute(role, `DELETE FROM ${table} WHERE false`)).rejects.toThrow(DENIED)
      })
      return
    }

    if (privileges.has('select')) {
      it(`reads exactly the rows inside its scope (${keys.join(', ') || 'every row'})`, async () => {
        expect(visible).toContain(pk)
        const seen = await query(role, `SELECT ${q(pk)}::text AS id FROM ${table}`)
        const expected = await admin(`SELECT ${q(pk)}::text AS id FROM ${table} WHERE ${inside}`, values())
        expect(expected.length).toBeGreaterThan(0)
        expect(seen.map((row) => row.id).sort()).toEqual(expected.map((row) => row.id).sort())
        // Not vacuous: for every key of the scope, rows on the other side of it exist and stay hidden.
        for (const entry of filter) {
          const [{ n }] = (await admin(`SELECT count(*)::int AS n FROM ${table} WHERE ${q(entry.column)} <> $1::${entry.type}`, [entry.value()])) as [{ n: number }]
          expect(n, `${model.name} rows outside ${entry.column}`).toBeGreaterThan(0)
        }
        // And for every value filter, rows inside the keys but of another value exist and stay hidden.
        for (const entry of only) {
          const [{ n }] = (await admin(`SELECT count(*)::int AS n FROM ${table} WHERE ${keysInside} AND NOT (${entry.sql})`, values())) as [{ n: number }]
          expect(n, `${model.name} rows of ${entry.column} values outside the role's`).toBeGreaterThan(0)
        }
        if (filter.length === 0 && only.length === 0) expect(new Set(seen.map((row) => row.id)).size).toBe((await admin(`SELECT 1 FROM ${table}`)).length)
      })

      if (hidden.size > 0 || writeOnly.size > 0) {
        it(`cannot read its hidden or write-only columns (${[...hidden, ...writeOnly].join(', ')})`, async () => {
          for (const column of [...hidden, ...writeOnly]) await expect(query(role, `SELECT ${q(column)} FROM ${table} LIMIT 1`)).rejects.toThrow(DENIED)
          const delegate = (client: FactoryClient) =>
            (client as unknown as Record<string, { findMany: (args?: unknown) => Promise<unknown[]> }>)[model.name[0]!.toLowerCase() + model.name.slice(1)]!
          // Prisma's default select names every column, so a forgotten `select` fails loudly.
          await expect(as(role, (client) => delegate(client).findMany())).rejects.toThrow(DENIED)
          const rows = await as(role, (client) => delegate(client).findMany({ select: Object.fromEntries(readable.map((column) => [column, true])) }))
          expect(rows.length).toBeGreaterThan(0)
        })
      }
    } else {
      it('cannot select', async () => {
        await expect(query(role, `SELECT ${q(pk)} FROM ${table} LIMIT 1`)).rejects.toThrow(DENIED)
      })
    }

    if (privileges.has('insert')) {
      it('cannot insert a row outside its scope; the same insert inside it works', async () => {
        if (filter.length > 0) await expect(insert(copyOf(await rowOf(`NOT (${inside})`)))).rejects.toThrow(RLS)
        for (const entry of only) await expect(insert(copyOf(await rowOf(`${keysInside} AND NOT (${entry.sql})`)))).rejects.toThrow(RLS)
        const own = copyOf(await rowOf(inside))
        expect(await insert(own)).toBe(1)
        await removeRow(table, q(pk), own[pk])
      })
    } else {
      it('cannot insert', async () => {
        await expect(execute(role, `INSERT INTO ${table} (${q(pk)}) VALUES (NULL)`)).rejects.toThrow(DENIED)
      })
    }

    if (privileges.has('update')) {
      it('updates no row outside its scope and cannot move a row out of it', async () => {
        const column = q(readable.find((name) => name !== pk && !Object.values(keyColumns).includes(name)) ?? pk)
        const touch = (id: unknown) => execute(role, `UPDATE ${table} SET ${column} = ${column} WHERE ${q(pk)} = $1::uuid`, id)
        const own = await rowOf(inside)
        expect(await touch(own[pk])).toBe(1)
        if (filter.length > 0) {
          const other = await rowOf(`NOT (${inside})`)
          expect(await touch(other[pk])).toBe(0)
          for (const entry of filter) {
            const away = await rowOf(`${q(entry.column)} <> $1::${entry.type}`, [entry.value()])
            await expect(
              execute(role, `UPDATE ${table} SET ${q(entry.column)} = $1::${entry.type} WHERE ${q(pk)} = $2::uuid`, away[entry.column], own[pk]),
            ).rejects.toThrow(RLS)
          }
        }
        // Nor to a value outside its own: a row of another value it may not see is not touched, and none is made.
        for (const entry of only) {
          const away = await rowOf(`${keysInside} AND NOT (${entry.sql})`)
          expect(await touch(away[pk])).toBe(0)
          // A value filter's column is text or an enum (db-kit compares it as text).
          const type = model.fields.find((field) => field.column === entry.column)?.type
          const cast = type === 'String' ? 'text' : `text::${q(type ?? 'text')}`
          await expect(execute(role, `UPDATE ${table} SET ${q(entry.column)} = $1::${cast} WHERE ${q(pk)} = $2::uuid`, String(away[entry.column]), own[pk])).rejects.toThrow(RLS)
        }
      })
    } else {
      it('cannot update', async () => {
        await expect(execute(role, `UPDATE ${table} SET ${q(pk)} = ${q(pk)} WHERE false`)).rejects.toThrow(DENIED)
      })
    }

    if (privileges.has('delete')) {
      it('deletes no row outside its scope', async () => {
        if (filter.length === 0) return
        const other = await rowOf(`NOT (${inside})`)
        expect(await execute(role, `DELETE FROM ${table} WHERE ${q(pk)} = $1::uuid`, other[pk])).toBe(0)
      })
    } else {
      it('cannot delete', async () => {
        await expect(execute(role, `DELETE FROM ${table} WHERE false`)).rejects.toThrow(DENIED)
      })
    }
  })
})
