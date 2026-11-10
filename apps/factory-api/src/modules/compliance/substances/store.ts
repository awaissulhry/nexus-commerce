import type { FactoryClient, Prisma } from '@nexus/factory-db'
import type { DeclarationFact, ListVersionFact, MaterialFacts, RuleFacts, SavedSvhc, StyleUse, TestFact } from '@nexus/factory-domain/compliance/substances/evaluate'
import {
  DECLARATION_OF_RULE,
  limitWords,
  sourceWords,
  SUBSTANCE_TESTS,
  TEST_OF_RULE,
  UNIT_WORDS,
  type DeclarationKind,
  type EvidenceKind,
  type LimitBound,
  type RuleCode,
  type RuleSource,
  type SubstanceList,
  type SubstanceStatus,
  type SubstanceTest,
  type SubstanceUnit,
} from '@nexus/factory-domain/compliance/substances/rules'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import type { CommandTx } from '../../../core/command'
import { namesFor } from '../register-of-rules/common'

/**
 * The substance list's reads (B-W2b-250): the columns each part names, the views the routes answer, and the facts the
 * evaluator reads (the rules with their substances, the styles whose current BOM names a material, the markets sold to,
 * the material's current lab results, its suppliers' declarations, the Candidate List versions and the profile it has).
 * One query after another (one connection runs one query at a time); nothing written here. No money.
 */

export type Reader = FactoryClient | CommandTx

const day = (value: Date): BusinessDate => value.toISOString().slice(0, 10)
const decimal = (value: Prisma.Decimal | null): string | null => (value === null ? null : value.toFixed())
const record = (value: unknown): Record<string, string> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}
export const todayOf = (now: Date): BusinessDate => businessDate(now)

// ---- substances -------------------------------------------------------------------------------------------------------

export const SUBSTANCE_SELECT = {
  id: true,
  companyId: true,
  casNumber: true,
  ecNumber: true,
  name: true,
  nameI18n: true,
  groupCode: true,
  lists: true,
  annexXviiEntries: true,
  svhcListVersionId: true,
  note: true,
  status: true,
  version: true,
  updatedAt: true,
} as const satisfies Prisma.RestrictedSubstanceSelect
export type SubstanceRow = Prisma.RestrictedSubstanceGetPayload<{ select: typeof SUBSTANCE_SELECT }>

export const RULE_SELECT = {
  id: true,
  companyId: true,
  key: true,
  code: true,
  name: true,
  nameI18n: true,
  substanceId: true,
  substanceGroup: true,
  materialKinds: true,
  productTypes: true,
  marketCodes: true,
  scopeNote: true,
  limitValue: true,
  limitUnit: true,
  limitBound: true,
  testMethod: true,
  evidence: true,
  exemptPpe: true,
  exemptNaturalLeather: true,
  source: true,
  customerPartyId: true,
  legalReference: true,
  legalUrl: true,
  switchedOn: true,
  offReason: true,
  switchedAt: true,
  switchedById: true,
  note: true,
  status: true,
  version: true,
  updatedAt: true,
} as const satisfies Prisma.SubstanceRuleSelect
export type RuleRow = Prisma.SubstanceRuleGetPayload<{ select: typeof RULE_SELECT }>

export const VERSION_SELECT = { id: true, publishedOn: true, entryCount: true, source: true, sourceUrl: true, note: true, version: true, createdAt: true } as const satisfies Prisma.SvhcListVersionSelect
export type VersionRow = Prisma.SvhcListVersionGetPayload<{ select: typeof VERSION_SELECT }>

/** A rule as a substance row lists it (the design's Limit, Unit, Material scope, Test method and Source columns). */
export function ruleRef(rule: RuleRow) {
  const unit = rule.limitUnit as SubstanceUnit | null
  return {
    id: rule.id,
    key: rule.key,
    code: rule.code as RuleCode,
    name: rule.name,
    limitValue: decimal(rule.limitValue),
    limitUnit: unit,
    unitWords: unit ? UNIT_WORDS[unit] : null,
    limitBound: rule.limitBound as LimitBound | null,
    limit: limitWords(decimal(rule.limitValue), unit, rule.limitBound as LimitBound | null),
    materialKinds: [...rule.materialKinds] as string[],
    testMethod: rule.testMethod,
    source: rule.source as RuleSource,
    sourceWords: sourceWords({ source: rule.source as RuleSource, legalReference: rule.legalReference }),
    switchedOn: rule.switchedOn,
    status: rule.status as SubstanceStatus,
  }
}

/** The rules that restrict a substance: by its id, or by its group. */
export const rulesOfSubstance = (substance: Pick<SubstanceRow, 'id' | 'groupCode'>, rules: readonly RuleRow[]): RuleRow[] =>
  rules.filter((rule) => rule.substanceId === substance.id || (substance.groupCode !== null && rule.substanceGroup === substance.groupCode))

export function substanceView(row: SubstanceRow, rules: readonly RuleRow[], versions: ReadonlyMap<string, VersionRow>) {
  const version = row.svhcListVersionId ? versions.get(row.svhcListVersionId) : undefined
  return {
    id: row.id,
    companyId: row.companyId,
    casNumber: row.casNumber,
    ecNumber: row.ecNumber,
    name: row.name,
    nameI18n: record(row.nameI18n),
    groupCode: row.groupCode,
    lists: [...row.lists] as SubstanceList[],
    annexXviiEntries: [...row.annexXviiEntries],
    svhcListVersion: version ? { id: version.id, publishedOn: day(version.publishedOn) } : null,
    note: row.note,
    status: row.status as SubstanceStatus,
    rules: rulesOfSubstance(row, rules).map(ruleRef),
    version: row.version,
    updatedAt: toUtcIso(row.updatedAt),
  }
}
export type SubstanceView = ReturnType<typeof substanceView>

export const versionsById = async (db: Reader): Promise<Map<string, VersionRow>> => new Map((await db.svhcListVersion.findMany({ select: VERSION_SELECT })).map((row) => [row.id, row]))

// ---- rules ------------------------------------------------------------------------------------------------------------

/** The rules with their substance, brand, members and switcher (one query each). */
export async function ruleViews(db: Reader, rows: readonly RuleRow[]) {
  const substanceIds = [...new Set(rows.flatMap((row) => (row.substanceId ? [row.substanceId] : [])))]
  const groups = [...new Set(rows.flatMap((row) => (row.substanceGroup ? [row.substanceGroup] : [])))]
  const partyIds = [...new Set(rows.flatMap((row) => (row.customerPartyId ? [row.customerPartyId] : [])))]
  const substances = new Map(
    (substanceIds.length === 0 ? [] : await db.restrictedSubstance.findMany({ where: { id: { in: substanceIds } }, select: { id: true, casNumber: true, name: true, status: true } })).map((row) => [row.id, row]),
  )
  const members = new Map<string, number>()
  if (groups.length > 0) {
    for (const row of await db.restrictedSubstance.groupBy({ by: ['groupCode'], where: { groupCode: { in: groups }, status: 'ACTIVE' }, _count: { _all: true } })) {
      if (row.groupCode) members.set(row.groupCode, row._count._all)
    }
  }
  const parties = new Map((partyIds.length === 0 ? [] : await db.party.findMany({ where: { id: { in: partyIds } }, select: { id: true, code: true, legalName: true } })).map((row) => [row.id, row]))
  const name = await namesFor(db, rows.map((row) => row.switchedById))
  return rows.map((row) => {
    const substance = row.substanceId ? substances.get(row.substanceId) : undefined
    const party = row.customerPartyId ? parties.get(row.customerPartyId) : undefined
    const code = row.code as RuleCode
    return {
      ...ruleRef(row),
      companyId: row.companyId,
      nameI18n: record(row.nameI18n),
      substance: substance ? { id: substance.id, casNumber: substance.casNumber, name: substance.name, status: substance.status as SubstanceStatus } : null,
      substanceGroup: row.substanceGroup,
      /** The substances it restricts (1 for one substance; the group's ACTIVE ones). */
      members: row.substanceId ? 1 : (members.get(row.substanceGroup ?? '') ?? 0),
      productTypes: [...row.productTypes] as string[],
      marketCodes: [...row.marketCodes],
      scopeNote: row.scopeNote,
      evidence: row.evidence as EvidenceKind,
      exemptPpe: row.exemptPpe,
      exemptNaturalLeather: row.exemptNaturalLeather,
      customer: party ? { id: party.id, code: party.code, name: party.legalName } : null,
      legalReference: row.legalReference,
      legalUrl: row.legalUrl,
      offReason: row.offReason,
      switchedAt: row.switchedAt ? toUtcIso(row.switchedAt) : null,
      switchedBy: name(row.switchedById),
      note: row.note,
      /** What proves it: the lab test of its own (null: none) and the declaration a supplier is asked for. */
      test: TEST_OF_RULE[code],
      declaration: DECLARATION_OF_RULE[code] as DeclarationKind,
      version: row.version,
      updatedAt: toUtcIso(row.updatedAt),
    }
  })
}
export type RuleView = Awaited<ReturnType<typeof ruleViews>>[number]

// ---- the evaluator's facts --------------------------------------------------------------------------------------------

/** Every rule (any status: the evaluator says why an archived or switched-off one does not apply) with its substances. */
export async function ruleFacts(db: Reader): Promise<RuleFacts[]> {
  const rules = await db.substanceRule.findMany({ select: RULE_SELECT, orderBy: [{ key: 'asc' }] })
  const groups = [...new Set(rules.flatMap((rule) => (rule.substanceGroup ? [rule.substanceGroup] : [])))]
  const members = groups.length === 0 ? [] : await db.restrictedSubstance.findMany({ where: { groupCode: { in: groups }, status: 'ACTIVE' }, select: { id: true, groupCode: true } })
  return rules.map((rule) => ({
    id: rule.id,
    key: rule.key,
    code: rule.code as RuleCode,
    name: rule.name,
    companyId: rule.companyId,
    substanceId: rule.substanceId,
    substanceGroup: rule.substanceGroup,
    materialKinds: [...rule.materialKinds],
    productTypes: [...rule.productTypes],
    marketCodes: [...rule.marketCodes],
    limitValue: decimal(rule.limitValue),
    limitUnit: rule.limitUnit as SubstanceUnit | null,
    limitBound: rule.limitBound as LimitBound | null,
    testMethod: rule.testMethod,
    evidence: rule.evidence as EvidenceKind,
    exemptPpe: rule.exemptPpe,
    exemptNaturalLeather: rule.exemptNaturalLeather,
    source: rule.source as RuleSource,
    customerPartyId: rule.customerPartyId,
    legalReference: rule.legalReference,
    switchedOn: rule.switchedOn,
    offReason: rule.offReason,
    status: rule.status as SubstanceStatus,
    substanceIds: rule.substanceId ? [rule.substanceId] : members.filter((member) => member.groupCode === rule.substanceGroup).map((member) => member.id),
  }))
}

export const MATERIAL_SELECT = { id: true, code: true, name: true, kind: true, companyId: true, status: true } as const satisfies Prisma.ItemSelect
export type MaterialRow = Prisma.ItemGetPayload<{ select: typeof MATERIAL_SELECT }>
export const materialFacts = (row: MaterialRow): MaterialFacts => ({ id: row.id, code: row.code, name: row.name, kind: row.kind, companyId: row.companyId })

const STYLE_SELECT = { id: true, code: true, name: true, productType: true, ppeCategory: true, brandPartyId: true, companyId: true } as const satisfies Prisma.StyleSelect
type StyleRow = Prisma.StyleGetPayload<{ select: typeof STYLE_SELECT }>
export const styleUse = (row: StyleRow): StyleUse => ({ styleId: row.id, code: row.code, productType: row.productType, ppeCategory: row.ppeCategory, brandPartyId: row.brandPartyId, companyId: row.companyId })

/** Per material, the styles whose current BOM (a DRAFT or RELEASED revision) names it on a line or as an alternate. */
export async function usesOf(db: Reader, itemIds: readonly string[]): Promise<Map<string, StyleUse[]>> {
  const out = new Map<string, StyleUse[]>(itemIds.map((id) => [id, []]))
  if (itemIds.length === 0) return out
  const current = { status: { in: ['DRAFT', 'RELEASED'] } } as const satisfies Prisma.StyleRevisionWhereInput
  const lines = await db.bomLine.findMany({ where: { itemId: { in: [...itemIds] }, revision: current }, select: { itemId: true, styleId: true } })
  const alternates = await db.bomLineAlternate.findMany({ where: { itemId: { in: [...itemIds] }, bomLine: { revision: current } }, select: { itemId: true, bomLine: { select: { styleId: true } } } })
  const pairs = [...lines.map((line) => [line.itemId, line.styleId] as const), ...alternates.map((alternate) => [alternate.itemId, alternate.bomLine.styleId] as const)]
  const styles = new Map((pairs.length === 0 ? [] : await db.style.findMany({ where: { id: { in: [...new Set(pairs.map(([, styleId]) => styleId))] } }, select: STYLE_SELECT })).map((row) => [row.id, styleUse(row)]))
  for (const [itemId, styleId] of pairs) {
    const style = styles.get(styleId)
    const list = out.get(itemId)!
    if (style && !list.some((use) => use.styleId === styleId)) list.push(style)
  }
  for (const list of out.values()) list.sort((a, b) => a.code.localeCompare(b.code))
  return out
}

/** The market codes sold to: the ACTIVE switched-on market profiles of these companies and the tenant-wide ones. */
export async function marketsFor(db: Reader, companyIds: readonly (string | null)[]): Promise<string[]> {
  const companies = [...new Set(companyIds.filter((id): id is string => id !== null))]
  const rows = await db.marketProfile.findMany({
    where: { status: 'ACTIVE', switchedOn: true, OR: [{ companyId: null }, ...(companies.length > 0 ? [{ companyId: { in: companies } }] : [])] },
    select: { code: true },
  })
  return [...new Set(rows.map((row) => row.code))].sort()
}

/** Per material, its current lab results of the substance tests (no other result supersedes them). */
export async function testsOf(db: Reader, itemIds: readonly string[]): Promise<Map<string, TestFact[]>> {
  const out = new Map<string, TestFact[]>(itemIds.map((id) => [id, []]))
  if (itemIds.length === 0) return out
  const rows = await db.labResult.findMany({
    where: { itemId: { in: [...itemIds] }, test: { in: [...SUBSTANCE_TESTS] }, supersededBy: { none: {} } },
    select: { id: true, itemId: true, lotId: true, test: true, verdict: true, testedOn: true, createdAt: true },
  })
  for (const row of rows) {
    if (row.verdict !== 'PASS' && row.verdict !== 'FAIL') continue
    out.get(row.itemId)?.push({ resultId: row.id, lotId: row.lotId, test: row.test as SubstanceTest, verdict: row.verdict, testedOn: day(row.testedOn), recordedAt: toUtcIso(row.createdAt) })
  }
  return out
}

/** Per material, the declaration requests with a line about it (its lines only). */
export async function declarationsOf(db: Reader, itemIds: readonly string[]): Promise<Map<string, DeclarationFact[]>> {
  const out = new Map<string, DeclarationFact[]>(itemIds.map((id) => [id, []]))
  if (itemIds.length === 0) return out
  const lines = await db.supplierDeclarationLine.findMany({
    where: { itemId: { in: [...itemIds] } },
    select: { itemId: true, requestId: true, contains: true, aboveThreshold: true, substanceId: true, substanceName: true },
    orderBy: [{ seq: 'asc' }],
  })
  const requestIds = [...new Set(lines.map((line) => line.requestId))]
  const requests = new Map(
    (requestIds.length === 0
      ? []
      : await db.supplierDeclarationRequest.findMany({
          where: { id: { in: requestIds } },
          select: { id: true, number: true, kind: true, status: true, dueOn: true, validTo: true, decidedAt: true, svhcListVersionId: true, answeredListVersionId: true },
        })
    ).map((row) => [row.id, row]),
  )
  for (const itemId of itemIds) {
    const mine = lines.filter((line) => line.itemId === itemId)
    for (const requestId of new Set(mine.map((line) => line.requestId))) {
      const request = requests.get(requestId)
      if (!request) continue
      out.get(itemId)!.push({
        requestId,
        number: request.number,
        kind: request.kind as DeclarationKind,
        status: request.status,
        dueOn: day(request.dueOn),
        validTo: request.validTo ? day(request.validTo) : null,
        decidedAt: request.decidedAt ? toUtcIso(request.decidedAt) : null,
        svhcListVersionId: request.svhcListVersionId,
        answeredListVersionId: request.answeredListVersionId,
        lines: mine
          .filter((line) => line.requestId === requestId)
          .map((line) => ({ contains: line.contains, aboveThreshold: line.aboveThreshold, substanceId: line.substanceId, substanceName: line.substanceName })),
      })
    }
  }
  return out
}

export const listVersionFacts = (versions: Iterable<VersionRow>): ListVersionFact[] => [...versions].map((row) => ({ id: row.id, publishedOn: day(row.publishedOn), entryCount: row.entryCount }))

/** The substances on the SVHC Candidate List: their ids, CAS numbers and names. */
export async function svhcSubstances(db: Reader): Promise<Map<string, { id: string; casNumber: string | null; name: string }>> {
  const rows = await db.restrictedSubstance.findMany({ where: { lists: { has: 'SVHC' } }, select: { id: true, casNumber: true, name: true } })
  return new Map(rows.map((row) => [row.id, row]))
}

export const PROFILE_SELECT = {
  id: true,
  itemId: true,
  svhcAboveThreshold: true,
  svhcListVersionId: true,
  svhcSubstanceIds: true,
  applicableRuleIds: true,
  testsNeeded: true,
  declarationsNeeded: true,
  evaluatedAt: true,
  state: true,
  stateReason: true,
  version: true,
  updatedAt: true,
} as const satisfies Prisma.MaterialComplianceProfileSelect
export type ProfileRow = Prisma.MaterialComplianceProfileGetPayload<{ select: typeof PROFILE_SELECT }>

export async function profilesOf(db: Reader, itemIds: readonly string[]): Promise<Map<string, ProfileRow>> {
  if (itemIds.length === 0) return new Map()
  // One profile per material: its id is the item's id (B-W2b-217).
  return new Map((await db.materialComplianceProfile.findMany({ where: { id: { in: [...itemIds] } }, select: PROFILE_SELECT })).map((row) => [row.id, row]))
}

export const savedSvhc = (profile: ProfileRow | undefined): SavedSvhc | null =>
  profile ? { aboveThreshold: profile.svhcAboveThreshold, listVersionId: profile.svhcListVersionId, substanceIds: [...profile.svhcSubstanceIds] } : null

export function profileView(profile: ProfileRow | undefined) {
  if (!profile) return null
  return {
    state: profile.state as 'INCOMPLETE' | 'COMPLETE' | 'BLOCKED',
    stateReason: profile.stateReason,
    evaluatedAt: profile.evaluatedAt ? toUtcIso(profile.evaluatedAt) : null,
    applicableRuleIds: [...profile.applicableRuleIds],
    testsNeeded: [...profile.testsNeeded] as SubstanceTest[],
    declarationsNeeded: [...profile.declarationsNeeded] as DeclarationKind[],
    svhcAboveThreshold: profile.svhcAboveThreshold,
    svhcListVersionId: profile.svhcListVersionId,
    svhcSubstanceIds: [...profile.svhcSubstanceIds],
    version: profile.version,
  }
}
