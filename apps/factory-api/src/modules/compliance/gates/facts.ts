import type { Prisma } from '@nexus/factory-db'
import { certificateGate, type GateRequest, type PpeCategory } from '@nexus/factory-domain/compliance/cert-gate/gate'
import {
  certificateCoverageResult,
  documentLanguagesResult,
  EXPIRING_DAYS,
  daysBetween,
  gloveLevelsResult,
  gpsrContactResult,
  labelLanguagesResult,
  manufacturerFallbackResult,
  operatorResult,
  type IssuedDocument,
} from '@nexus/factory-domain/compliance/gates/checks'
import type { CheckResult, GateMarket, GateTarget, OverrideInForce } from '@nexus/factory-domain/compliance/gates/gate'
import type { CheckKey, ComplianceGate, ProductType, RequirementRow, RequirementSubject } from '@nexus/factory-domain/compliance/requirements/rules'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { gateRequestFor } from '../certificates/gate'
import { operatorsFor } from '../operators/operators'
import { gatePlugOf, type GateCheck, type GateCheckPlug } from './plugs'
// B-W2b-253's label rules, plugged in by name (its registration runs when this module loads).
import './label-plug'
import type { Reader } from '../register-of-rules/common'

/**
 * What the one gate reads (B-W2b-254): the style (its product type with the type profile's ancestors, its PPE category,
 * its brand), the market profiles by code, the goods' destination as a market, the overrides in force for the subject,
 * and the facts each check computes from — W1's certificate gate (B-W1-12's `gateRequestFor`, so B-W2b-255's base
 * certificate rule comes with it), the style's ISSUED DoCs and user information per language, the label template, the
 * economic operators (B-W2b-249's `operatorsFor`). Reads run one after another (one connection, one query at a time) and
 * only for the checks the requirements ask.
 */

const STYLE_SELECT = {
  id: true,
  code: true,
  name: true,
  companyId: true,
  productType: true,
  productTypeProfileId: true,
  ppeCategory: true,
  sizes: true,
  brandPartyId: true,
  soldUnderOurName: true,
} as const satisfies Prisma.StyleSelect
export type GateStyleRow = Prisma.StyleGetPayload<{ select: typeof STYLE_SELECT }>

export interface GateStyle {
  readonly row: GateStyleRow
  readonly subject: RequirementSubject & { readonly code: string }
}

/** The style the gate asks about, with its type profile and that profile's ancestors (nearest first, at most 20). */
export async function readGateStyle(db: Reader, styleId: string): Promise<GateStyle | null> {
  const row = await db.style.findUnique({ where: { id: styleId }, select: STYLE_SELECT })
  if (!row) return null
  const profileIds: string[] = []
  let next = row.productTypeProfileId
  while (next && !profileIds.includes(next) && profileIds.length < 20) {
    profileIds.push(next)
    next = (await db.productTypeProfile.findUnique({ where: { id: next }, select: { parentId: true } }))?.parentId ?? null
  }
  return {
    row,
    subject: { code: row.code, companyId: row.companyId, productType: row.productType as ProductType, profileIds, ppeCategory: row.ppeCategory as PpeCategory },
  }
}

const MARKET_SELECT = {
  code: true,
  name: true,
  switchedOn: true,
  labelLanguages: true,
  docLanguages: true,
  userInfoLanguages: true,
  importerNeeded: true,
  gpsrContactNeeded: true,
} as const satisfies Prisma.MarketProfileSelect

/** The ACTIVE market profiles by code (ON and OFF: an OFF market's own rules wait, the gate says so). */
export async function readMarkets(db: Reader): Promise<Map<string, GateMarket>> {
  const rows = await db.marketProfile.findMany({ where: { status: 'ACTIVE' }, select: MARKET_SELECT, orderBy: [{ seq: 'asc' }, { code: 'asc' }] })
  return new Map(rows.map((row) => [row.code, { ...row }]))
}

/** ISO 3166 codes whose market profile is named otherwise (the United Kingdom's "UK", Greece's "EL" in EU usage). */
const COUNTRY_ALIASES: Readonly<Record<string, readonly string[]>> = { GB: ['UK'], UK: ['GB'], GR: ['EL'], EL: ['GR'] }

/** The market profile of a destination country (exact code, else the usual alias); null: none names it. */
export function marketOfCountry(country: string | null, markets: ReadonlyMap<string, GateMarket>): GateMarket | null {
  if (!country) return null
  const code = country.trim().toUpperCase()
  return markets.get(code) ?? (COUNTRY_ALIASES[code] ?? []).map((alias) => markets.get(alias)).find((market) => market !== undefined) ?? null
}

/** The country of an address snapshot ({ …, country }); null when there is none. */
export function countryOf(address: unknown): string | null {
  if (!address || typeof address !== 'object' || Array.isArray(address)) return null
  const country = (address as { country?: unknown }).country
  return typeof country === 'string' && country.trim().length > 0 ? country.trim().toUpperCase() : null
}

/** The overrides in force (OVERRIDDEN events whose end is after `now`) for a subject at a gate. */
export async function overridesFor(db: Reader, gate: ComplianceGate, subjectType: string, subjectId: string, now: Date): Promise<OverrideInForce[]> {
  const rows = await db.gateEvent.findMany({
    where: { gate, subjectType, subjectId, outcome: 'OVERRIDDEN', overrideUntil: { gt: now } },
    select: { id: true, refusedEventId: true, requirementId: true, gate: true, overrideUntil: true, reason: true, createdById: true },
    orderBy: [{ overrideUntil: 'desc' }, { id: 'asc' }],
  })
  return rows.map((row) => ({ eventId: row.id, refusedEventId: row.refusedEventId!, requirementId: row.requirementId, gate: row.gate as ComplianceGate, until: row.overrideUntil!, reason: row.reason, byId: row.createdById }))
}

// ---- the checks' facts ----------------------------------------------------------------------------------------------

export interface CheckerOptions {
  readonly style: GateStyle
  /** The label template the gate reads (a released work order's frozen one, else the style's released revision's). */
  readonly labelTemplateId: string | null
  readonly day: BusinessDate
  /** The checks the requirements ask (only their facts are read). */
  readonly checks: ReadonlySet<CheckKey>
  /** The markets of the targets (an operator requirement of one market reads that market's operators). */
  readonly marketCodes: readonly string[]
  /** The targets and the subject (a plugged check reads once for all of them; ./plugs). */
  readonly targets?: readonly GateTarget[] | undefined
  readonly subject?: { readonly type: 'WorkOrder' | 'Shipment'; readonly id: string } | null | undefined
  /** The company that makes it (the subject's; the style's when none): our company as the manufacturer by default. */
  readonly companyId?: string | null | undefined
}

export type Checker = (requirement: RequirementRow, check: CheckKey, target: GateTarget) => CheckResult

const asLevels = (value: unknown): Record<string, string> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : null

/** The label template a style's gate reads by default: its RELEASED revision's (the newest), else its newest revision's. */
export async function styleLabelTemplateId(db: Reader, styleId: string): Promise<string | null> {
  const revision = await db.styleRevision.findFirst({ where: { styleId, labelTemplateId: { not: null } }, select: { labelTemplateId: true }, orderBy: [{ status: 'asc' }, { revision: 'desc' }] })
  const released = await db.styleRevision.findFirst({ where: { styleId, status: 'RELEASED', labelTemplateId: { not: null } }, select: { labelTemplateId: true }, orderBy: { revision: 'desc' } })
  return released?.labelTemplateId ?? revision?.labelTemplateId ?? null
}

/**
 * The checker: reads the facts once, then answers each requirement × target. A target with no colourway and size (a
 * style × market cell of the board) checks every active colourway in every size of the style.
 */
export async function checkerFor(db: Reader, options: CheckerOptions): Promise<Checker> {
  const { style, day, checks } = options
  const styleId = style.row.id

  // W1's certificate gate (QHS-051, MES-004): one read of the style's coverages, then the domain gate per colourway × size.
  let certificate: { request: GateRequest; colourways: { id: string; code: string }[] } | null = null
  const levels = new Map<string, Record<string, string> | null>()
  if (checks.has('certificate.coverage') || checks.has('certificate.gloveLevels')) {
    const colourways = await db.colourway.findMany({ where: { styleId, status: 'ACTIVE' }, select: { id: true, code: true }, orderBy: [{ code: 'asc' }, { id: 'asc' }] })
    const anyColourway = colourways[0] ?? (await db.colourway.findFirst({ where: { styleId }, select: { id: true, code: true } }))
    if (anyColourway && style.row.sizes.length > 0) {
      const { request } = await gateRequestFor(db, { styleId, colourwayId: anyColourway.id, size: style.row.sizes[0]! }, day)
      certificate = { request, colourways }
      if (checks.has('certificate.gloveLevels')) {
        const ids = [...new Set(request.covers.map((cover) => cover.certificate.id))]
        const rows = ids.length > 0 ? await db.certificate.findMany({ where: { id: { in: ids } }, select: { id: true, performanceLevels: true } }) : []
        for (const row of rows) levels.set(row.id, asLevels(row.performanceLevels))
      }
    }
  }

  const documents = new Map<'DECLARATION_OF_CONFORMITY' | 'USER_INFORMATION', IssuedDocument[]>([
    ['DECLARATION_OF_CONFORMITY', []],
    ['USER_INFORMATION', []],
  ])
  if (checks.has('doc.languages') || checks.has('userInfo.languages')) {
    const rows = await db.complianceDocument.findMany({
      where: { styleId, status: 'ISSUED' },
      select: { id: true, kind: true, language: true, number: true, revision: true, marketCode: true },
      orderBy: [{ revision: 'desc' }, { id: 'asc' }],
    })
    for (const row of rows) documents.get(row.kind as 'DECLARATION_OF_CONFORMITY' | 'USER_INFORMATION')?.push({ id: row.id, language: row.language, number: row.number, revision: row.revision, marketCode: row.marketCode })
  }

  const template =
    (checks.has('label.languages') || checks.has('gpsr.contact')) && options.labelTemplateId
      ? await db.labelTemplate.findUnique({ where: { id: options.labelTemplateId }, select: { id: true, code: true, revision: true, languages: true, gpsrContact: true } })
      : null

  // The economic operators per market asked (B-W2b-249: most specific row wins), read on first need.
  const operators = new Map<string, Awaited<ReturnType<typeof operatorsFor>>['resolved']>()
  const operatorsOf = async (marketCode: string | null) => {
    const key = marketCode ?? ''
    if (!operators.has(key)) {
      operators.set(key, (await operatorsFor(db, { id: styleId, code: style.row.code, name: style.row.name, companyId: style.row.companyId, brandPartyId: style.row.brandPartyId, soldUnderOurName: style.row.soldUnderOurName }, { marketCode, day })).resolved)
    }
    return operators.get(key)!
  }
  // With no MANUFACTURER row the maker itself is the EU operator when established in the EU (Owner Q3: the brand that sells
  // the style under its own name, else our company), read from its own row.
  let maker: { recordType: 'Party' | 'Company'; id: string; name: string; country: string | null } | null = null
  if (checks.has('operator.role')) {
    await operatorsOf(null)
    for (const code of new Set(options.marketCodes)) await operatorsOf(code)
    if (style.row.brandPartyId && !style.row.soldUnderOurName) {
      const party = await db.party.findUnique({ where: { id: style.row.brandPartyId }, select: { id: true, legalName: true, country: true } })
      if (party) maker = { recordType: 'Party', id: party.id, name: party.legalName, country: party.country }
    } else {
      const companyId = style.row.companyId ?? options.companyId ?? null
      const company = companyId ? await db.company.findUnique({ where: { id: companyId }, select: { id: true, legalName: true, country: true } }) : null
      if (company) maker = { recordType: 'Company', id: company.id, name: company.legalName, country: company.country }
    }
  }

  const coverageOf = (target: GateTarget): CheckResult => {
    if (!certificate) {
      return style.subject.ppeCategory === 'CATEGORY_II' || style.subject.ppeCategory === 'CATEGORY_III'
        ? { state: 'MISSING', message: `Style ${style.row.code} has no colourway or size to cover yet.`, fix: 'add its colourways and sizes, then cover them (Compliance › Certificates).', facts: { code: 'certificate.noCells' }, evidence: null }
        : { state: 'NOT_NEEDED', message: `Style ${style.row.code} needs no certificate.`, fix: null, facts: { code: 'certificate.notRequired' }, evidence: null }
    }
    if (target.colourwayId && target.size) return certificateCoverageResult(certificateGate({ ...certificate.request, colourwayId: target.colourwayId, size: target.size }), day)
    // Every active colourway × size: the first refusal says what is missing; else the earliest end.
    const results = certificate.colourways.flatMap((colourway) =>
      style.row.sizes.map((size) => ({ label: `${colourway.code} ${size}`, result: certificateCoverageResult(certificateGate({ ...certificate!.request, colourwayId: colourway.id, size }), day) })),
    )
    const lacking = results.filter((entry) => entry.result.state === 'MISSING')
    if (lacking.length > 0) {
      return { state: 'MISSING', message: `Not covered: ${lacking.map((entry) => entry.label).join(', ')}. ${lacking[0]!.result.message}`, fix: lacking[0]!.result.fix, facts: { code: 'certificate.missing', cells: lacking.map((entry) => entry.label) }, evidence: null }
    }
    const expiring = results.filter((entry) => entry.result.state === 'EXPIRING')
    if (expiring.length > 0) return expiring.sort((a, b) => String(a.result.facts.validTo).localeCompare(String(b.result.facts.validTo)))[0]!.result
    return results[0]?.result ?? { state: 'NOT_NEEDED', message: `Style ${style.row.code} has no active colourway.`, fix: null, facts: { code: 'certificate.noCells' }, evidence: null }
  }

  const covering = (target: GateTarget): { id: string; number: string } | null => {
    if (!certificate) return null
    const colourwayId = target.colourwayId ?? certificate.colourways[0]?.id
    const size = target.size ?? style.row.sizes[0]
    if (!colourwayId || !size) return null
    const result = certificateGate({ ...certificate.request, colourwayId, size })
    return result.outcome === 'covered' ? { id: result.certificate.id, number: result.certificate.number } : null
  }

  // Checks plugged in by name (./plugs, e.g. B-W2b-253's label rules): each plug reads once for the question.
  const plugged = new Map<string, GateCheck>()
  const made = new Map<GateCheckPlug, GateCheck>()
  for (const key of checks) {
    const plug = gatePlugOf(key)
    if (!plug) continue
    if (!made.has(plug)) made.set(plug, await plug({ db, style, labelTemplateId: options.labelTemplateId, day, targets: options.targets ?? [], subject: options.subject ?? null, office: true }))
    plugged.set(key, made.get(plug)!)
  }

  return (requirement: RequirementRow, check: CheckKey, target: GateTarget): CheckResult => {
      const plug = plugged.get(check)
      if (plug) return plug(requirement, check, target)
      switch (check) {
        case 'certificate.coverage':
          return coverageOf(target)
        case 'certificate.gloveLevels': {
          const found = covering(target)
          return gloveLevelsResult(found ? { ...found, levels: levels.get(found.id) ?? null } : null)
        }
        case 'doc.languages':
          return documentLanguagesResult('DECLARATION_OF_CONFORMITY', target.market!, documents.get('DECLARATION_OF_CONFORMITY')!)
        case 'userInfo.languages':
          return documentLanguagesResult('USER_INFORMATION', target.market!, documents.get('USER_INFORMATION')!)
        case 'label.languages':
          return labelLanguagesResult(template, target.market!)
        case 'gpsr.contact':
          return gpsrContactResult(template)
        case 'operator.role': {
          const market = requirement.marketCode ? (target.market ?? null) : null
          const resolved = operators.get(market?.code ?? '') ?? operators.get('') ?? []
          const found = resolved.find((entry) => entry.role === requirement.operatorRole)
          if (!found && (requirement.operatorRole ?? 'MANUFACTURER') === 'MANUFACTURER') return manufacturerFallbackResult(maker, market)
          return operatorResult(requirement.operatorRole ?? 'MANUFACTURER', found ? { id: found.row.id, printedName: found.row.printedName } : null, market)
        }
        default:
          return { state: 'MANUAL', message: 'Checked by a person: no check computes it here.', fix: null, facts: { code: 'manual', check }, evidence: null }
      }
  }
}

/** The checks the requirements that can apply ask (ACTIVE and switched on: an OFF one is never checked), for `checkerFor`. */
export function checksAsked(requirements: readonly RequirementRow[], check: (requirement: RequirementRow) => CheckKey | 'MANUAL'): Set<CheckKey> {
  const out = new Set<CheckKey>()
  for (const requirement of requirements) {
    if (requirement.status !== 'ACTIVE' || !requirement.switchedOn) continue
    const key = check(requirement)
    if (key !== 'MANUAL') out.add(key)
  }
  return out
}

export { EXPIRING_DAYS, daysBetween }
