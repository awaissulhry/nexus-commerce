import type { FactoryClient } from '@nexus/factory-db'
import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { pickOverhead } from '@nexus/factory-domain/costing/inputs'
import type { ComponentFacts, ComponentStep, ComponentSubcontract, ComponentWorkshop, PackagingTypeFacts } from '@nexus/factory-domain/costing/sheet-components/components'
import { pieceRateSite, type GradeShares, type LeatherBasisFacts, type UpliftFacts } from '@nexus/factory-domain/costing/sheet-components/rules'
import { paysOn, windowsOf, type RateCandidate } from '@nexus/factory-domain/people/earnings/rules'
import { inForceOn, type AgreementFacts } from '@nexus/factory-domain/purchasing/subcontract-depth/terms'
import { decimalText } from '@nexus/factory-domain/product/units/units'
import type { CommandTx } from '../../../core/command'
import { readColourways, readLines, type RevisionRow } from '../../product/bom/store'
import { withoutCustomerSupplied } from '../../product/bom-lines/store'
import { readSteps, readSubcontracts, readWorkshops } from '../../product/routing/read'
import { liveDefaults } from '../../shipping/cartons/store'
import { companyOrTenant, dayOf, processCostingInputs } from '../inputs'
import { activeRulesOf } from '../overhead-rules/overhead-rules'
import { readCostingMaterials, type CostingStyleRow } from '../store'
// B-W2b-423: the garment without options (FIN-018) and the multi-level roll-up (FIN-019, KS4:02).
import type { OptionParts } from '@nexus/factory-domain/costing/option-cost/rules'
import { optionPartsOf, withoutOptionParts } from '../option-cost/parts'
import { rolledUpFor } from '../rollup/store'

/**
 * What a revision's components are computed from (B-W2b-418), read with one client, one query after another (a transaction
 * client runs one at a time): W1's BOM lines, materials, routing and labour rates (modules/costing/store), the subcontracted
 * steps and their workshops with the written terms in force (modules/product/routing, B-W2b-331's agreements), the overhead
 * rules (B-W2b-419) and the costing settings' percent, the leather bases with the grades' usable shares, the uplifts, the
 * piece rates of the site that pays them (B-W2b-34) while the company's piece-rate labour is on, and the packaging master's
 * defaults (B-W2b-384). Reads only.
 */

type Reader = FactoryClient | CommandTx
const text = (value: { toString(): string }): string => decimalText(value.toString())
const textOrNull = (value: { toString(): string } | null): string | null => (value === null ? null : text(value))
const dayOrNull = (value: Date | null): string | null => (value === null ? null : dayOf(value))

/** The company a sheet is costed for (a cost sheet always has one). */
export interface ComponentCompany {
  readonly id: string
  readonly currency: string
}

export interface ComponentOptions {
  readonly colourwayId?: string | undefined
  readonly siteId?: string | undefined
  readonly piecesPerCarton?: number | undefined
  /** B-W2b-423: keep the BOM lines and routing steps only for an option (an option's own cost puts them back per value). */
  readonly withOptionParts?: boolean | undefined
  /** B-W2b-423: the level and the revisions above, when a sub-assembly is costed for its parent's roll-up. */
  readonly rollup?: { readonly level: number; readonly path: readonly string[] } | undefined
  /** B-W2b-423 (FIN-022): materials' standard prices as a mass update would set them (a preview: nothing written). */
  readonly priceOverrides?: ReadonlyMap<string, string> | undefined
}

export interface LoadedComponents {
  readonly facts: ComponentFacts
  readonly colourway: { readonly id: string; readonly code: string; readonly name: string }
  readonly pieceRate: { readonly on: boolean; readonly siteId: string | null; readonly payingSites: number }
  /** B-W2b-423: the revision's parts only for options (left out of the facts unless withOptionParts). */
  readonly optionParts: OptionParts
}

/** The leather bases of these articles that a sheet for the company may take (its own and every company's). */
async function leatherBasesOf(db: Reader, itemIds: readonly string[], companyId: string): Promise<LeatherBasisFacts[]> {
  if (itemIds.length === 0) return []
  const rows = await db.leatherCostBasis.findMany({
    where: { AND: [companyOrTenant(companyId), { itemId: { in: [...itemIds] } }] },
    select: { id: true, companyId: true, itemId: true, styleId: true, areaUnit: true, expectedYieldPct: true, gradeMix: true, validFrom: true, status: true },
  })
  return rows.map((row) => ({
    id: row.id,
    companyId: row.companyId,
    itemId: row.itemId,
    styleId: row.styleId,
    areaUnit: row.areaUnit as LeatherBasisFacts['areaUnit'],
    expectedYieldPct: text(row.expectedYieldPct),
    gradeMix: row.gradeMix as Record<string, string>,
    validFrom: dayOf(row.validFrom),
    status: row.status,
  }))
}

/** Per leather article: the active grades' usable shares and its own active grade rules. */
async function gradeSharesOf(db: Reader, itemIds: readonly string[]): Promise<Map<string, GradeShares>> {
  if (itemIds.length === 0) return new Map()
  const grades = await db.leatherGrade.findMany({ where: { active: true }, select: { id: true, code: true, usableShare: true } })
  const rules = await db.itemGradeRule.findMany({ where: { itemId: { in: [...itemIds] }, active: true }, select: { itemId: true, gradeId: true, usableShare: true } })
  const codeOf = new Map(grades.map((grade) => [grade.id, grade.code]))
  const gradeShares = new Map(grades.map((grade) => [grade.code, text(grade.usableShare)]))
  return new Map(
    itemIds.map((itemId) => [
      itemId,
      { grades: gradeShares, itemRules: new Map(rules.filter((rule) => rule.itemId === itemId && codeOf.has(rule.gradeId)).map((rule) => [codeOf.get(rule.gradeId)!, text(rule.usableShare)])) },
    ]),
  )
}

/** The uplifts a sheet for the company may take (its own and every company's, every target). */
async function upliftsOf(db: Reader, companyId: string): Promise<UpliftFacts[]> {
  const rows = await db.materialCostUplift.findMany({
    where: companyOrTenant(companyId),
    select: { id: true, companyId: true, target: true, itemId: true, itemKind: true, partyId: true, source: true, freightPct: true, dutyPct: true, insurancePct: true, transportOutPerPiece: true, transportBackPerPiece: true, currency: true, validFrom: true, status: true },
  })
  return rows.map((row) => ({
    id: row.id,
    companyId: row.companyId,
    target: row.target,
    itemId: row.itemId,
    // A kind uplift is for a material's kind: never FINISHED (no BOM line names a finished garment).
    itemKind: row.itemKind as UpliftFacts['itemKind'],
    partyId: row.partyId,
    source: row.source,
    freightPct: textOrNull(row.freightPct),
    dutyPct: textOrNull(row.dutyPct),
    insurancePct: textOrNull(row.insurancePct),
    transportOutPerPiece: textOrNull(row.transportOutPerPiece),
    transportBackPerPiece: textOrNull(row.transportBackPerPiece),
    currency: row.currency,
    validFrom: dayOf(row.validFrom),
    status: row.status,
  }))
}

/** The company's own settings row says piece-rate labour is on (GATE-PIECE-PAY: never the tenant-wide row). */
async function pieceRateLabourOn(db: Reader, companyId: string): Promise<boolean> {
  const own = await db.costingSettings.findUnique({ where: { id: companyId }, select: { companyId: true, pieceRateLabour: true } })
  return own !== null && own.companyId === companyId && own.pieceRateLabour
}

/** The sites of the company whose piece pay holds the day (the switch's windows). */
export async function payingSitesOf(db: Reader, companyId: string, on: BusinessDate): Promise<string[]> {
  const rows = await db.piecePaySwitch.findMany({ where: { companyId }, select: { siteId: true, onFrom: true, offFrom: true, earlierWindows: true } })
  return rows.filter((row) => paysOn(windowsOf({ onFrom: dayOrNull(row.onFrom), offFrom: dayOrNull(row.offFrom), earlierWindows: row.earlierWindows }), on)).map((row) => row.siteId)
}

/** Every rate of a site that may pay some day (people/earnings' own read, B-W2b-43). */
async function ratesAt(db: Reader, siteId: string): Promise<RateCandidate[]> {
  const versions = await db.pieceRateVersion.findMany({
    where: { siteId, status: { in: ['PROVISIONAL', 'PUBLISHED', 'SUPERSEDED'] } },
    select: { id: true, status: true, effectiveFrom: true, effectiveTo: true, table: { select: { styleId: true, lineId: true, currency: true } } },
  })
  if (versions.length === 0) return []
  const entries = await db.pieceRateEntry.findMany({ where: { versionId: { in: versions.map((row) => row.id) } }, select: { id: true, operationId: true, sizeBand: true, ratePerPiece: true, standardMinutes: true, versionId: true } })
  const versionBy = new Map(versions.map((row) => [row.id, row]))
  return entries.map((entry) => {
    const version = versionBy.get(entry.versionId)!
    return {
      entryId: entry.id,
      operationId: entry.operationId,
      sizeBand: entry.sizeBand,
      ratePerPiece: text(entry.ratePerPiece),
      standardMinutes: textOrNull(entry.standardMinutes),
      currency: version.table.currency,
      status: version.status,
      effectiveFrom: dayOf(version.effectiveFrom),
      effectiveTo: dayOrNull(version.effectiveTo),
      styleId: version.table.styleId,
      lineId: version.table.lineId,
    }
  })
}

/** The workshops of these steps, each with whether signed written terms with the company hold the day. */
async function workshopsOf(db: Reader, subcontracts: ReadonlyMap<string, ComponentSubcontract>, companyId: string, on: BusinessDate): Promise<Map<string, ComponentWorkshop>> {
  const named = await readWorkshops(db, [...subcontracts.values()].map((entry) => ({ supplierId: entry.supplierId, pricePerPiece: entry.pricePerPiece, transitDays: null })))
  if (named.size === 0) return new Map()
  const agreements = await db.subcontractAgreement.findMany({
    where: { companyId, partyId: { in: [...named.keys()] } },
    select: { id: true, partyId: true, revision: true, status: true, title: true, validFrom: true, validUntil: true, signedAt: true, endedAt: true, termsFileId: true },
  })
  return new Map(
    [...named.values()].map((workshop) => {
      const facts: AgreementFacts[] = agreements
        .filter((row) => row.partyId === workshop.id)
        .map((row) => ({ id: row.id, revision: row.revision, status: row.status, title: row.title, validFrom: dayOf(row.validFrom), validUntil: dayOrNull(row.validUntil), signedAt: row.signedAt, endedAt: row.endedAt, termsFileId: row.termsFileId }))
      return [workshop.id, { id: workshop.id, name: workshop.name, termsInForce: inForceOn(facts, on) !== null }]
    }),
  )
}

/** The company's active packaging types, as the components read them. */
async function packagingTypesOf(db: Reader, companyId: string): Promise<Map<string, PackagingTypeFacts>> {
  const rows = await db.packagingType.findMany({ where: { companyId, active: true }, select: { id: true, name: true, kind: true, costPerUnit: true, costCurrency: true } })
  return new Map(rows.map((row) => [row.id, { id: row.id, name: row.name, kind: row.kind, costPerUnit: textOrNull(row.costPerUnit), costCurrency: row.costCurrency }]))
}

/** The labour rates written by a cost-per-minute calculation that carries overhead per minute (B-W2b-419's OVERHEAD_TWICE). */
async function ratesWithOverheadOf(db: Reader, companyId: string): Promise<Set<string>> {
  const rows = await db.costPerMinuteCalc.findMany({ where: { companyId, labourRateId: { not: null }, overheadPerMinute: { gt: 0 } }, select: { labourRateId: true } })
  return new Set(rows.flatMap((row) => (row.labourRateId ? [row.labourRateId] : [])))
}

/** Everything a revision's components are computed from, for one company, colourway and day. */
export async function loadComponentFacts(db: Reader, style: CostingStyleRow, revision: RevisionRow, company: ComponentCompany, on: BusinessDate, options: ComponentOptions): Promise<LoadedComponents> {
  const all = await readColourways(db, style.id)
  const active = all.filter((colourway) => colourway.status === 'ACTIVE')
  const colourway = options.colourwayId === undefined ? active[0] : active.find((entry) => entry.id === options.colourwayId)
  if (!colourway) {
    if (options.colourwayId !== undefined) throw new ValidationError('The colourway is not valid.', [{ path: 'colourwayId', message: 'Not an active colourway of this style.' }])
    throw new NotFoundError('The style has no active colourway to cost.')
  }
  const allLines = await withoutCustomerSupplied(db, revision.id, await readLines(db, revision.id, { sizes: style.sizes, colourwayIds: all.map((entry) => entry.id) }))
  // B-W2b-423 (FIN-018): the garment without options — a line or a step only for an option is the option's own cost.
  const optionParts = await optionPartsOf(db, revision.id)
  const allSteps = await readSteps(db, revision.id)
  const kept = options.withOptionParts ? { lines: allLines, steps: allSteps } : withoutOptionParts(optionParts, allLines, allSteps)
  const lines = kept.lines
  const steps = kept.steps
  const materials = withPrices(await readCostingMaterials(db, lines.map((line) => line.itemId)), options.priceOverrides)
  const subcontracts = new Map([...(await readSubcontracts(db, revision.id))].map(([stepId, entry]) => [stepId, { supplierId: entry.supplierId, pricePerPiece: entry.pricePerPiece }]))
  const workshops = await workshopsOf(db, subcontracts, company.id, on)
  const inputs = processCostingInputs()
  const rates = await inputs.labourRates(db, company.id)
  const settingsOverhead = pickOverhead(await inputs.overheadRules(db, company.id), company.id)
  const overheadRules = await activeRulesOf(db, company.id)
  const leatherIds = [...materials.values()].filter((material) => material.kind === 'LEATHER').map((material) => material.id)
  const leatherBases = await leatherBasesOf(db, leatherIds, company.id)
  const gradeShares = await gradeSharesOf(db, leatherIds)
  const uplifts = await upliftsOf(db, company.id)
  const ratesWithOverhead = await ratesWithOverheadOf(db, company.id)

  const pieceRateOn = await pieceRateLabourOn(db, company.id)
  const paying = pieceRateOn ? await payingSitesOf(db, company.id, on) : []
  const site = pieceRateOn ? pieceRateSite(paying, options.siteId ?? null) : { siteId: null, problem: null }
  const candidates = site.siteId === null ? [] : await ratesAt(db, site.siteId)

  const scale = await db.style.findUnique({ where: { id: style.id }, select: { sizeScaleId: true } })
  const sizes = scale?.sizeScaleId ? await db.size.findMany({ where: { scaleId: scale.sizeScaleId }, select: { code: true, seq: true } }) : []
  const defaults = await liveDefaults(db, company.id)
  const types = await packagingTypesOf(db, company.id)

  const componentSteps: ComponentStep[] = steps.map((step) => ({ id: step.id, seq: step.seq, operationId: step.operationId, code: step.code, name: step.name, workCentreKind: step.workCentreKind, standardMinutes: step.standardMinutes }))
  // B-W2b-423 (FIN-019, KS4:02): each sub-assembly line at its own cost, every level down.
  const rolledUp = await rolledUpFor(db, { revisionId: revision.id, lines, materials, sizes: style.sizes, colourwayCode: colourway.code, company, on, level: options.rollup?.level ?? 1, path: options.rollup?.path ?? [revision.id], priceOverrides: options.priceOverrides }, loadComponentFacts)
  return {
    colourway: { id: colourway.id, code: colourway.code, name: colourway.name },
    pieceRate: { on: pieceRateOn, siteId: site.siteId, payingSites: paying.length },
    optionParts,
    facts: {
      currency: company.currency,
      companyId: company.id,
      on,
      styleId: style.id,
      sizes: [...style.sizes],
      colourwayId: colourway.id,
      lines,
      materials,
      steps: componentSteps,
      subcontracts,
      workshops,
      rates,
      ratesWithOverhead,
      overheadRules,
      settingsOverhead,
      leatherBases,
      gradeShares,
      uplifts,
      pieceRate: { on: pieceRateOn, siteId: site.siteId, problem: site.problem, candidates },
      packaging: { defaults, types, sizeScaleId: scale?.sizeScaleId ?? null, sizeSeqs: new Map(sizes.map((size) => [size.code, size.seq])) },
      piecesPerCarton: options.piecesPerCarton ?? null,
      rolledUp,
    },
  }
}

/** B-W2b-423 (FIN-022): the materials with the prices a mass update would give them (the material's own currency). */
function withPrices<Material extends { readonly standardCost: string | null }>(materials: Map<string, Material>, overrides: ReadonlyMap<string, string> | undefined): Map<string, Material> {
  if (!overrides || overrides.size === 0) return materials
  return new Map([...materials].map(([id, material]) => [id, overrides.has(id) ? { ...material, standardCost: overrides.get(id)! } : material]))
}
