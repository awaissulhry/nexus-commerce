import type { Address, Company, CompanyWithSites, Site, SiteKind } from '../shared/api'
import { ORG_CODE } from '../shared/api'
import { matches, type Loaded, type Notice } from '../shared/model'

/**
 * SCR-008 Companies & sites (design 02 admin.org): ONE page — a tree of the legal companies and their sites, with what
 * each is missing — and the Company record (Legal & tax · Sites · Defaults · Calendars · Activity). Pure: the rows of the tree, the
 * readiness banner, the code a new company gets, the form checks and the Company record's form drafts.
 */

export interface OrgAbilities {
  /** companies.manage: new company, edit legal and defaults, archive. */
  manageCompanies: boolean
  /** sites.view: the sites under each company. */
  viewSites: boolean
  /** sites.manage: new site. */
  manageSites: boolean
  /** calendars.view: the Company record's Calendars tab and "Holidays for all sites" (B-W2a-59; absent without it). */
  viewCalendars?: boolean
  /** calendars.manage: keep the company's working days and holidays (the API asks it over every site of the company). */
  manageCalendars?: boolean
}

export type OrgDialog = 'new-company' | 'new-site'

export interface CompaniesViewModel {
  prefix: string
  companies: Loaded<CompanyWithSites>
  asOf: string | null
  can: OrgAbilities
  query: string
  showArchived: boolean
  /** Companies whose sites are folded away. */
  collapsed: readonly string[]
  /** Pages of 50 rows shown ("Show 50 more" adds one). */
  pages: number
  notice?: Notice | null
  /** A dialog open at first (design fixtures; `?new=company`). */
  dialog?: OrgDialog | null
  /** The company a new site starts in. */
  dialogCompanyId?: string | null
  busy?: boolean
  /** The dialog's refusal (a message key). */
  dialogProblem?: string | null
  /** The company of the address: "Holidays for all sites" opens its calendar (B-W2a-59). */
  currentCompanyId?: string | null
}

/** One row of the tree: a company, or one of its sites under it. */
export type TreeRow = { kind: 'company'; company: CompanyWithSites; expanded: boolean } | { kind: 'site'; site: Site; company: CompanyWithSites }

/** The tree's rows for a search: a company whose site matches stays (with the matching sites), folded ones show no sites. */
export function treeRows(companies: readonly CompanyWithSites[], query: string, collapsed: readonly string[], showArchived: boolean): TreeRow[] {
  const rows: TreeRow[] = []
  const folded = new Set(collapsed)
  for (const company of companies) {
    if (!showArchived && company.status === 'ARCHIVED') continue
    const sites = company.sites.filter((site) => showArchived || site.status === 'ACTIVE')
    const companyHit = matches(query, company.legalName, company.tradeName, company.code, company.vatNumber)
    const siteHits = sites.filter((site) => matches(query, site.name, site.code))
    if (!companyHit && siteHits.length === 0) continue
    const expanded = !folded.has(company.id) || (query.trim() !== '' && siteHits.length > 0)
    rows.push({ kind: 'company', company, expanded })
    if (expanded) for (const site of companyHit ? sites : siteHits) rows.push({ kind: 'site', site, company })
  }
  return rows
}

/** The message key of a readiness issue path (`company/vatNumber` → `org.issue.vatNumber`). */
export const issueKey = (path: string) => `org.issue.${path.replace(/^company\//, '')}`
export const ISSUE_FIELDS = ['vatNumber', 'regimeFiscale', 'address', 'pec'] as const

/** The one most serious gap, said plainly (design 02 admin.org "Can each company work?"). */
export type Readiness =
  | { kind: 'invoicing'; company: Company; issues: readonly string[] }
  | { kind: 'no-site'; company: Company }
  | { kind: 'no-station'; site: Site; company: Company }
  | null

export function readiness(companies: readonly CompanyWithSites[]): Readiness {
  const active = companies.filter((company) => company.status === 'ACTIVE')
  const notReady = active.find((company) => !company.invoicing.ready)
  if (notReady) return { kind: 'invoicing', company: notReady, issues: notReady.invoicing.issues.map((issue) => issue.path) }
  const plants = active.flatMap((company) => company.sites.filter((site) => site.status === 'ACTIVE' && site.kind === 'PLANT').map((site) => ({ site, company })))
  const bare = plants.find(({ site }) => site.counts.stations === 0)
  if (bare) return { kind: 'no-station', site: bare.site, company: bare.company }
  return null
}

const LEGAL_SUFFIX = /\b(s\.?r\.?l\.?s?|s\.?p\.?a\.?|s\.?n\.?c\.?|s\.?a\.?s\.?|soc\.?|societ[aà]|unipersonale)\b/gi

/** A company code from its name (letters and digits, up to 8), not one already used. */
export function suggestCode(name: string, taken: readonly string[]): string {
  const plain = name.normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(LEGAL_SUFFIX, ' ')
  const words = plain.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean)
  const base = (words[0] ?? '').slice(0, 8) || 'CO'
  const used = new Set(taken.map((code) => code.toUpperCase()))
  if (!used.has(base)) return base
  for (let n = 2; n < 100; n++) {
    const next = `${base.slice(0, 7)}${n}`
    if (!used.has(next)) return next
  }
  return base
}

export interface NewCompanyDraft {
  legalName: string
  code: string
  vatNumber: string
  country: string
}

export interface NewSiteDraft {
  companyId: string
  name: string
  kind: SiteKind
  code: string
  timezone: string
  line1: string
  postalCode: string
  city: string
  province: string
}

/** Field → message key of what is wrong (empty: ready). */
export function newCompanyProblems(draft: NewCompanyDraft, taken: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {}
  if (draft.legalName.trim() === '') out.legalName = 'form.required'
  const code = draft.code.trim().toUpperCase()
  if (!ORG_CODE.test(code)) out.code = 'form.code'
  else if (taken.map((item) => item.toUpperCase()).includes(code)) out.code = 'form.codeTaken'
  if (draft.vatNumber.trim() !== '' && !/^[A-Z]{2}[0-9A-Z]{2,13}$/i.test(draft.vatNumber.replace(/\s+/g, ''))) out.vatNumber = 'form.vat'
  if (!/^[A-Z]{2}$/i.test(draft.country.trim())) out.country = 'form.country'
  return out
}

export function newSiteProblems(draft: NewSiteDraft, taken: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {}
  if (!draft.companyId) out.companyId = 'form.required'
  if (draft.name.trim() === '') out.name = 'form.required'
  const code = draft.code.trim().toUpperCase()
  if (!ORG_CODE.test(code)) out.code = 'form.code'
  else if (taken.map((item) => item.toUpperCase()).includes(code)) out.code = 'form.codeTaken'
  const anyAddress = [draft.line1, draft.postalCode, draft.city].some((part) => part.trim() !== '')
  if (anyAddress) {
    if (draft.line1.trim() === '') out.line1 = 'form.required'
    if (draft.postalCode.trim() === '') out.postalCode = 'form.required'
    if (draft.city.trim() === '') out.city = 'form.required'
  }
  return out
}

export function siteAddress(draft: Pick<NewSiteDraft, 'line1' | 'postalCode' | 'city' | 'province'>, country = 'IT'): Address | null {
  if ([draft.line1, draft.postalCode, draft.city].every((part) => part.trim() === '')) return null
  return { line1: draft.line1.trim(), postalCode: draft.postalCode.trim(), city: draft.city.trim(), province: draft.province.trim() || null, country }
}

/** An address on one line ("Via Esempio 1, 00000 Demoville MI"). */
export function addressLine(address: Address | null): string | null {
  if (!address) return null
  return [address.line1, address.line2, [address.postalCode, address.city, address.province].filter(Boolean).join(' ')].filter((part) => part && part.trim() !== '').join(', ')
}

// ---- the Company record ----------------------------------------------------------------------------------------------

// B-W2a-59: Calendars (Working days and holidays), between Defaults and Activity as the design orders them; shown with calendars.view.
export const COMPANY_TABS = ['legal', 'sites', 'defaults', 'calendars', 'activity'] as const
export type CompanyTab = (typeof COMPANY_TABS)[number]
export const REGIMES = ['RF01', 'RF02', 'RF04', 'RF05', 'RF06', 'RF07', 'RF08', 'RF09', 'RF10', 'RF11', 'RF12', 'RF13', 'RF14', 'RF15', 'RF16', 'RF17', 'RF18', 'RF19'] as const
export const TIME_ZONES = ['Europe/Rome', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Madrid', 'Europe/Bucharest', 'Europe/Tirane', 'Africa/Tunis'] as const

/** The Legal & tax and Defaults forms as text fields (what the inputs hold). */
export interface CompanyDraft {
  legalName: string
  tradeName: string
  vatNumber: string
  fiscalCode: string
  regimeFiscale: string
  reaOffice: string
  reaNumber: string
  shareCapital: string
  soleShareholder: boolean
  inLiquidation: boolean
  line1: string
  line2: string
  postalCode: string
  city: string
  province: string
  addressCountry: string
  pec: string
  sdiReceiverCode: string
  documentFooter: string
  locale: string
  timezone: string
  fiscalYearStartMonth: string
}

export function companyDraft(company: Company): CompanyDraft {
  const text = (value: string | null | undefined) => value ?? ''
  return {
    legalName: company.legalName,
    tradeName: text(company.tradeName),
    vatNumber: text(company.vatNumber),
    fiscalCode: text(company.fiscalCode),
    regimeFiscale: text(company.regimeFiscale),
    reaOffice: text(company.reaOffice),
    reaNumber: text(company.reaNumber),
    shareCapital: text(company.shareCapital),
    soleShareholder: company.soleShareholder,
    inLiquidation: company.inLiquidation,
    line1: text(company.address?.line1),
    line2: text(company.address?.line2),
    postalCode: text(company.address?.postalCode),
    city: text(company.address?.city),
    province: text(company.address?.province),
    addressCountry: company.address?.country ?? company.country,
    pec: text(company.pec),
    sdiReceiverCode: text(company.sdiReceiverCode),
    documentFooter: text(company.documentFooter),
    locale: company.locale,
    timezone: company.timezone,
    fiscalYearStartMonth: String(company.fiscalYearStartMonth),
  }
}

export const LEGAL_FIELDS = [
  'legalName',
  'tradeName',
  'vatNumber',
  'fiscalCode',
  'regimeFiscale',
  'reaOffice',
  'reaNumber',
  'shareCapital',
  'soleShareholder',
  'inLiquidation',
  'line1',
  'line2',
  'postalCode',
  'city',
  'province',
  'addressCountry',
  'pec',
  'sdiReceiverCode',
  'documentFooter',
] as const satisfies ReadonlyArray<keyof CompanyDraft>
export const DEFAULT_FIELDS = ['locale', 'timezone', 'fiscalYearStartMonth'] as const satisfies ReadonlyArray<keyof CompanyDraft>

/** The fields of a form that differ from what was read. */
export function changedFields(before: CompanyDraft, after: CompanyDraft, fields: ReadonlyArray<keyof CompanyDraft>): Array<keyof CompanyDraft> {
  return fields.filter((field) => before[field] !== after[field])
}

/** What is wrong with the draft, per field (a message key); the API checks again. */
export function companyProblems(draft: CompanyDraft): Partial<Record<keyof CompanyDraft, string>> {
  const out: Partial<Record<keyof CompanyDraft, string>> = {}
  if (draft.legalName.trim() === '') out.legalName = 'form.required'
  if (draft.vatNumber.trim() !== '' && !/^[A-Z]{2}[0-9A-Z]{2,13}$/i.test(draft.vatNumber.replace(/\s+/g, ''))) out.vatNumber = 'form.vat'
  if (draft.shareCapital.trim() !== '' && !/^\d{1,16}(\.\d{1,2})?$/.test(draft.shareCapital.trim())) out.shareCapital = 'form.amount'
  if (draft.sdiReceiverCode.trim() !== '' && !/^[A-Z0-9]{7}$/i.test(draft.sdiReceiverCode.trim())) out.sdiReceiverCode = 'form.sdi'
  if (draft.pec.trim() !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.pec.trim())) out.pec = 'form.email'
  const anyAddress = [draft.line1, draft.postalCode, draft.city].some((part) => part.trim() !== '')
  if (anyAddress) {
    if (draft.line1.trim() === '') out.line1 = 'form.required'
    if (draft.postalCode.trim() === '') out.postalCode = 'form.required'
    if (draft.city.trim() === '') out.city = 'form.required'
  }
  return out
}

/** The PATCH body for the changed fields (empty text = cleared; the address is sent whole). */
export function companyPatch(before: CompanyDraft, after: CompanyDraft, fields: ReadonlyArray<keyof CompanyDraft>, version: number): Record<string, unknown> & { version: number } {
  const body: Record<string, unknown> & { version: number } = { version }
  const changed = new Set(changedFields(before, after, fields))
  const text = (value: string) => (value.trim() === '' ? null : value.trim())
  const plain = ['tradeName', 'vatNumber', 'fiscalCode', 'regimeFiscale', 'reaOffice', 'reaNumber', 'shareCapital', 'pec', 'sdiReceiverCode', 'documentFooter'] as const
  if (changed.has('legalName')) body.legalName = after.legalName.trim()
  for (const field of plain) if (changed.has(field)) body[field] = text(after[field])
  if (changed.has('soleShareholder')) body.soleShareholder = after.soleShareholder
  if (changed.has('inLiquidation')) body.inLiquidation = after.inLiquidation
  if (['line1', 'line2', 'postalCode', 'city', 'province', 'addressCountry'].some((field) => changed.has(field as keyof CompanyDraft))) {
    body.address = after.line1.trim() === '' && after.postalCode.trim() === '' && after.city.trim() === '' ? null : { line1: after.line1.trim(), line2: text(after.line2), postalCode: after.postalCode.trim(), city: after.city.trim(), province: text(after.province), country: after.addressCountry.trim().toUpperCase() || 'IT' }
  }
  if (changed.has('locale')) body.locale = after.locale
  if (changed.has('timezone')) body.timezone = after.timezone
  if (changed.has('fiscalYearStartMonth')) body.fiscalYearStartMonth = Number(after.fiscalYearStartMonth)
  return body
}

export interface CompanyRecordModel {
  prefix: string
  tab: CompanyTab
  /** Null while it is read. */
  company: Company | null
  sites: Loaded<Site>
  problem?: string | null
  can: OrgAbilities
  /** The draft the form shows (a fixture shows one being edited). */
  draft?: CompanyDraft | null
  busy?: boolean
  notice?: Notice | null
  fieldProblems?: Partial<Record<keyof CompanyDraft, string>>
  /** The archive confirm is open. */
  archiving?: boolean
  dockOpen?: boolean
}
