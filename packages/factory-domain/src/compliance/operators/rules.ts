import type { Issue } from '../../core/errors'
import { isBusinessDate, type BusinessDate } from '../../core/time'
import { MARKET_CODE, MARKET_CODE_MAX } from '../markets/rules'

/**
 * Economic operators per style and market (B-W2b-249; PRD-298; PPE Reg. (EU) 2016/425 arts. 8(6), 10(3), 11; GPSR Reg.
 * (EU) 2023/988 art. 9; design compliance.settings › rm-operators), pure. The table is B-W2b-216's EconomicOperatorRole:
 * a row names who is the manufacturer, authorised representative, importer, distributor or fulfilment provider, with the
 * name, postal address and contact as printed, for a style, a brand (its private-label styles), a company's styles or
 * every style of the tenant, for one market or every market, from a day to a day.
 *
 * The most specific row wins (`resolveOperators`): style, then brand, then company, then tenant; at each level a row for
 * the market asked before a row for every market. Owner 11-09 (question 3): a private-label style sold under the brand's
 * name has the brand as manufacturer; one sold under our name, or our own style, has our company — so a brand's
 * MANUFACTURER row does not apply to a brand style sold under our name. A MANUFACTURER row without a party is our company.
 *
 * One row per scope, market and role on a day: the database cannot hold that rule (its isolation copies would break it),
 * so the API refuses an overlap here (`overlapOf`) before it writes.
 */

export const OPERATOR_ROLES = ['MANUFACTURER', 'AUTHORISED_REPRESENTATIVE', 'IMPORTER', 'DISTRIBUTOR', 'FULFILMENT'] as const
export type OperatorRole = (typeof OPERATOR_ROLES)[number]
export const SCOPE_LEVELS = ['STYLE', 'BRAND', 'COMPANY', 'TENANT'] as const
export type ScopeLevel = (typeof SCOPE_LEVELS)[number]

export const NAME_MAX = 200
export const ADDRESS_MAX = 500
export const CONTACT_MAX = 200
export const NOTE_MAX = 2000

export const ROLE_WORDS: Readonly<Record<OperatorRole, { readonly en: string; readonly it: string }>> = {
  MANUFACTURER: { en: 'manufacturer', it: 'fabbricante' },
  AUTHORISED_REPRESENTATIVE: { en: 'authorised representative', it: 'mandatario' },
  IMPORTER: { en: 'importer', it: 'importatore' },
  DISTRIBUTOR: { en: 'distributor', it: 'distributore' },
  FULFILMENT: { en: 'fulfilment service provider', it: 'fornitore di servizi di logistica' },
}

export interface OperatorRow {
  readonly id: string
  readonly companyId: string | null
  readonly styleId: string | null
  readonly brandPartyId: string | null
  readonly marketCode: string | null
  readonly role: OperatorRole
  readonly partyId: string | null
  readonly printedName: string
  readonly printedAddress: string
  readonly contact: string | null
  readonly validFrom: BusinessDate
  readonly validTo: BusinessDate | null
}

export const scopeLevelOf = (row: Pick<OperatorRow, 'styleId' | 'brandPartyId' | 'companyId'>): ScopeLevel =>
  row.styleId !== null ? 'STYLE' : row.brandPartyId !== null ? 'BRAND' : row.companyId !== null ? 'COMPANY' : 'TENANT'

/** Valid on that day (from its first to its last day, both included). */
export const validOn = (row: Pick<OperatorRow, 'validFrom' | 'validTo'>, day: BusinessDate): boolean => row.validFrom <= day && (row.validTo === null || day <= row.validTo)

const sameScope = (a: OperatorRow, b: OperatorRow): boolean =>
  a.role === b.role && a.styleId === b.styleId && a.brandPartyId === b.brandPartyId && a.companyId === b.companyId && a.marketCode === b.marketCode

const daysOverlap = (a: Pick<OperatorRow, 'validFrom' | 'validTo'>, b: Pick<OperatorRow, 'validFrom' | 'validTo'>): boolean =>
  a.validFrom <= (b.validTo ?? '9999-12-31') && b.validFrom <= (a.validTo ?? '9999-12-31')

/** Another row of the same scope, market and role whose days overlap the candidate's; null: none. */
export function overlapOf(candidate: OperatorRow, rows: readonly OperatorRow[]): OperatorRow | null {
  return rows.find((row) => row.id !== candidate.id && sameScope(row, candidate) && daysOverlap(row, candidate)) ?? null
}

/** The overlap in words: who already holds the role, for which days, and what to do. */
export function overlapWords(other: OperatorRow, where: string): string {
  const days = other.validTo ? `from ${other.validFrom} to ${other.validTo}` : `from ${other.validFrom} with no last day`
  const market = other.marketCode ? `for market ${other.marketCode}` : 'for every market'
  return `${where} already has a ${ROLE_WORDS[other.role].en} ${market} ${days} (${other.printedName}): give that one a last day before this one starts, or change the days.`
}

export interface OperatorDraft {
  readonly role?: OperatorRole | undefined
  readonly styleId?: string | null | undefined
  readonly brandPartyId?: string | null | undefined
  readonly partyId?: string | null | undefined
  readonly marketCode?: string | null | undefined
  readonly printedName?: string | undefined
  readonly printedAddress?: string | undefined
  readonly contact?: string | null | undefined
  readonly validFrom?: string | undefined
  readonly validTo?: string | null | undefined
  readonly note?: string | null | undefined
}

/** What is wrong with an operator's fields, in words (paths under `body/`). `whole` checks the row as it will be. */
export function operatorProblems(draft: OperatorDraft, whole: boolean): Issue[] {
  const problems: Issue[] = []
  if (whole && draft.styleId && draft.brandPartyId) problems.push({ path: 'body/brandPartyId', message: 'An operator is set for a style or for a brand, not both.' })
  if (whole && draft.role !== undefined && draft.role !== 'MANUFACTURER' && !draft.partyId) {
    problems.push({ path: 'body/partyId', message: `A ${ROLE_WORDS[draft.role].en} is a party: name it (only the manufacturer may be our own company).` })
  }
  if (draft.marketCode !== undefined && draft.marketCode !== null && (draft.marketCode.length > MARKET_CODE_MAX || !MARKET_CODE.test(draft.marketCode))) {
    problems.push({ path: 'body/marketCode', message: 'A market code ("DE", "UK"), or none for every market.' })
  }
  const text = (path: string, value: string | null | undefined, max: number, what: string) => {
    if (value === undefined || value === null) return
    if (value.trim() === '' || value.length > max) problems.push({ path: `body/${path}`, message: `${what}: 1 to ${max} characters.` })
  }
  text('printedName', draft.printedName, NAME_MAX, 'The name as printed')
  text('printedAddress', draft.printedAddress, ADDRESS_MAX, 'The postal address as printed')
  text('contact', draft.contact, CONTACT_MAX, 'The contact (e-mail or web address)')
  text('note', draft.note, NOTE_MAX, 'The note')
  if (draft.validFrom !== undefined && !isBusinessDate(draft.validFrom)) problems.push({ path: 'body/validFrom', message: 'A day (YYYY-MM-DD).' })
  if (draft.validTo !== undefined && draft.validTo !== null && !isBusinessDate(draft.validTo)) problems.push({ path: 'body/validTo', message: 'A day (YYYY-MM-DD), or none.' })
  if (draft.validFrom && draft.validTo && isBusinessDate(draft.validFrom) && isBusinessDate(draft.validTo) && draft.validTo < draft.validFrom) {
    problems.push({ path: 'body/validTo', message: 'The last day is not before the first.' })
  }
  return problems
}

export interface OperatorTarget {
  readonly styleId: string | null
  /** The company that makes it (the style's, else the batch's). */
  readonly companyId: string | null
  /** The style's brand (private label), if any. */
  readonly brandPartyId: string | null
  /** Owner 11-09 question 3: a brand style sold under our name keeps our company as manufacturer. */
  readonly soldUnderOurName: boolean
  /** The market asked; null: rows for every market only. */
  readonly marketCode: string | null
  readonly day: BusinessDate
}

export interface ResolvedOperator {
  readonly role: OperatorRole
  readonly row: OperatorRow
  readonly level: ScopeLevel
  /** True when the row is for the market asked; false: a row for every market. */
  readonly forMarket: boolean
}

const LEVEL_RANK: Readonly<Record<ScopeLevel, number>> = { STYLE: 0, BRAND: 1, COMPANY: 2, TENANT: 3 }

function applies(row: OperatorRow, target: OperatorTarget): boolean {
  if (!validOn(row, target.day)) return false
  if (row.marketCode !== null && row.marketCode !== target.marketCode) return false
  switch (scopeLevelOf(row)) {
    case 'STYLE':
      return target.styleId !== null && row.styleId === target.styleId
    case 'BRAND':
      if (target.brandPartyId === null || row.brandPartyId !== target.brandPartyId) return false
      if (row.role === 'MANUFACTURER' && target.soldUnderOurName) return false
      return row.companyId === null || row.companyId === target.companyId
    case 'COMPANY':
      return target.companyId !== null && row.companyId === target.companyId
    case 'TENANT':
      return true
  }
}

/** Per role, the row that applies to the style and market on the day (the most specific); roles nobody holds are left out. */
export function resolveOperators(rows: readonly OperatorRow[], target: OperatorTarget): ResolvedOperator[] {
  const best = new Map<OperatorRole, ResolvedOperator>()
  const rank = (entry: ResolvedOperator) => LEVEL_RANK[entry.level] * 2 + (entry.forMarket ? 0 : 1)
  for (const row of rows) {
    if (!applies(row, target)) continue
    const entry: ResolvedOperator = { role: row.role, row, level: scopeLevelOf(row), forMarket: row.marketCode !== null }
    const current = best.get(row.role)
    if (!current || rank(entry) < rank(current) || (rank(entry) === rank(current) && entry.row.validFrom > current.row.validFrom)) best.set(row.role, entry)
  }
  return OPERATOR_ROLES.map((role) => best.get(role)).filter((entry): entry is ResolvedOperator => entry !== undefined)
}

/** The contact as an e-mail address, when it is one (the public page's "Write to …"); null otherwise. */
export function contactEmail(contact: string | null): string | null {
  if (contact === null) return null
  const trimmed = contact.trim()
  return /^[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]+$/.test(trimmed) ? trimmed : null
}
