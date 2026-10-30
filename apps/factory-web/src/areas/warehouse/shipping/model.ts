import { CARRIER_CODE, CUT_OFF_TIME, SERVICE_CODE, shippingAddressProblems } from '@nexus/factory-domain/shipping/settings'
import { isApiError, issuePath } from '../../../lib/api/errors'
import type { AccountMode, CarrierAccount, Printer, PrinterKind, SaveAddress, SaveBody, ShippingAddress, ShippingSettings, SiteSettings, TransportBy } from './api'

/**
 * Carriers & shipping's pure rules (SCR-068; design warehouse.shipping): what the person may do, the form a site's
 * settings are edited in and the PUT body it makes (the settings are saved WHOLE: a field the person cannot see is sent
 * back as it was, never cleared), every field's problem in the page's own words (the same rules as factory-domain
 * shipping/settings.ts, which the server applies again), the carrier account's state and its TEST mode, and the
 * printers each slot takes. No fetching, no React: the tests hold them.
 */

export interface SettingsAbilities {
  view: boolean
  manage: boolean
  /** List the carrier accounts (Admin › Connections' integrations.view). */
  accounts: boolean
  /** List the site's printers (print.view). */
  printers: boolean
  /** Open Admin › Connections. */
  openConnections: boolean
  /** Open Admin › Devices & printers. */
  openDevices: boolean
}

export function abilitiesOf(permissions: readonly string[]): SettingsAbilities {
  const held = new Set(permissions)
  return {
    view: held.has('shipping.settings.view'),
    manage: held.has('shipping.settings.manage'),
    accounts: held.has('integrations.view'),
    printers: held.has('print.view'),
    openConnections: held.has('integrations.view'),
    openDevices: held.has('devices.view'),
  }
}

// ---- the form ------------------------------------------------------------------------------------------------------------

export const ADDRESS_FIELDS = ['name', 'line1', 'line2', 'postalCode', 'city', 'province', 'country', 'phone', 'email'] as const
export type AddressField = (typeof ADDRESS_FIELDS)[number]
export type AddressForm = Record<AddressField, string>

/** Longest values the API takes (its contract), drawn as each input's maxLength. */
export const ADDRESS_MAX: Readonly<Record<AddressField, number>> = { name: 120, line1: 200, line2: 200, postalCode: 20, city: 120, province: 40, country: 2, phone: 40, email: 200 }
export const FIELD_MAX = { defaultCarrierCode: 64, defaultServiceCode: 128, defaultGoodsAppearance: 200, cutOffTime: 5 } as const

export interface SettingsForm {
  sender: AddressForm
  /** Returns go to another address than the ship-from one. */
  returnDifferent: boolean
  returns: AddressForm
  /** '' = none. */
  integrationAccountId: string
  defaultTransportBy: TransportBy
  defaultCarrierCode: string
  defaultServiceCode: string
  defaultGoodsAppearance: string
  cutOffTime: string
  labelPrinterId: string
  documentPrinterId: string
}

export const emptyAddress = (): AddressForm => ({ name: '', line1: '', line2: '', postalCode: '', city: '', province: '', country: 'IT', phone: '', email: '' })

const addressForm = (address: ShippingAddress | null | undefined): AddressForm => {
  const form = emptyAddress()
  if (!address) return form
  for (const field of ADDRESS_FIELDS) form[field] = address[field] ?? ''
  return form
}

/** The form a site's settings open in; a site without settings starts empty (country IT, carried by a carrier). */
export function formOf(settings: ShippingSettings | null): SettingsForm {
  return {
    sender: addressForm(settings?.senderAddress),
    returnDifferent: !!settings?.returnAddress,
    returns: addressForm(settings?.returnAddress ?? null),
    integrationAccountId: settings?.integrationAccountId ?? '',
    defaultTransportBy: settings?.defaultTransportBy ?? 'CARRIER',
    defaultCarrierCode: settings?.defaultCarrierCode ?? '',
    defaultServiceCode: settings?.defaultServiceCode ?? '',
    defaultGoodsAppearance: settings?.defaultGoodsAppearance ?? '',
    cutOffTime: settings?.cutOffTime ?? '',
    labelPrinterId: settings?.labelPrinterId ?? '',
    documentPrinterId: settings?.documentPrinterId ?? '',
  }
}

const blank = (value: string): string | null => (value.trim() === '' ? null : value.trim())

const addressBody = (address: AddressForm): SaveAddress => ({
  name: address.name.trim(),
  line1: address.line1.trim(),
  line2: blank(address.line2),
  postalCode: address.postalCode.trim(),
  city: address.city.trim(),
  province: blank(address.province),
  country: address.country.trim().toUpperCase(),
  phone: blank(address.phone),
  email: blank(address.email),
})

/** The PUT body: the whole settings as the form holds them, with the version read (none the first time). */
export function bodyOf(form: SettingsForm, version: number | null): SaveBody {
  return {
    ...(version !== null ? { version } : {}),
    senderAddress: addressBody(form.sender),
    returnAddress: form.returnDifferent ? addressBody(form.returns) : null,
    integrationAccountId: blank(form.integrationAccountId),
    defaultCarrierCode: blank(form.defaultCarrierCode),
    defaultServiceCode: blank(form.defaultServiceCode),
    defaultTransportBy: form.defaultTransportBy,
    defaultGoodsAppearance: blank(form.defaultGoodsAppearance),
    labelPrinterId: blank(form.labelPrinterId),
    documentPrinterId: blank(form.documentPrinterId),
    cutOffTime: blank(form.cutOffTime),
  }
}

/** A field of the form: `sender.city`, `returns.country`, `cutOffTime` … */
export type FieldId = `sender.${AddressField}` | `returns.${AddressField}` | Exclude<keyof SettingsForm, 'sender' | 'returns'>

/** The fields that differ from the saved settings (the save bar counts them). */
export function changedFields(saved: SettingsForm, draft: SettingsForm): FieldId[] {
  const changed: FieldId[] = []
  for (const field of ADDRESS_FIELDS) if (saved.sender[field] !== draft.sender[field]) changed.push(`sender.${field}`)
  if (saved.returnDifferent !== draft.returnDifferent) changed.push('returnDifferent')
  if (saved.returnDifferent && draft.returnDifferent) for (const field of ADDRESS_FIELDS) if (saved.returns[field] !== draft.returns[field]) changed.push(`returns.${field}`)
  for (const field of ['integrationAccountId', 'defaultTransportBy', 'defaultCarrierCode', 'defaultServiceCode', 'defaultGoodsAppearance', 'cutOffTime', 'labelPrinterId', 'documentPrinterId'] as const) {
    if (saved[field] !== draft[field]) changed.push(field)
  }
  return changed
}

/** A field's problem: a message key of the `shipping-setup` catalogue. */
export type FieldProblems = Partial<Record<FieldId, string>>

const ADDRESS_PROBLEM: Readonly<Record<string, string>> = { name: 'problem.name', line1: 'problem.required', postalCode: 'problem.required', city: 'problem.required', country: 'problem.country', email: 'problem.email' }

/**
 * Every problem of the form before it is sent, in the page's words: the same rules as factory-domain's
 * shippingSettingsProblems (an address has who, street, postal code, city and a two-letter country; carrier and service
 * are the aggregator's codes, a service needs its carrier; the cut-off is HH:MM).
 */
export function formProblems(form: SettingsForm): FieldProblems {
  const problems: FieldProblems = {}
  const address = (part: 'sender' | 'returns') => {
    const body = addressBody(form[part])
    for (const issue of shippingAddressProblems(body, part)) {
      const field = issue.path.split('/')[1] as AddressField | undefined
      if (field && ADDRESS_PROBLEM[field]) problems[`${part}.${field}` as FieldId] = ADDRESS_PROBLEM[field]
    }
  }
  address('sender')
  if (form.returnDifferent) address('returns')
  const carrier = form.defaultCarrierCode.trim()
  const service = form.defaultServiceCode.trim()
  if (carrier !== '' && !CARRIER_CODE.test(carrier)) problems.defaultCarrierCode = 'problem.carrierCode'
  if (service !== '' && !SERVICE_CODE.test(service)) problems.defaultServiceCode = 'problem.serviceCode'
  else if (service !== '' && carrier === '') problems.defaultServiceCode = 'problem.serviceNeedsCarrier'
  const cutOff = form.cutOffTime.trim()
  if (cutOff !== '' && !CUT_OFF_TIME.test(cutOff)) problems.cutOffTime = 'problem.cutOff'
  return problems
}

/** What the server refused, by field, in the page's words (its paths: `body/senderAddress/city`, `body/labelPrinterId` …). */
export function serverProblems(error: unknown): FieldProblems {
  if (!isApiError(error) || error.kind !== 'invalid') return {}
  const problems: FieldProblems = {}
  for (const issue of error.issues) {
    const parts = issuePath(issue).split(/[./]/).filter((part) => part !== '' && part !== 'body')
    const [head, field] = parts
    if ((head === 'senderAddress' || head === 'returnAddress') && field && (ADDRESS_FIELDS as readonly string[]).includes(field)) {
      problems[`${head === 'senderAddress' ? 'sender' : 'returns'}.${field as AddressField}`] = ADDRESS_PROBLEM[field] ?? 'problem.invalid'
    } else if (head === 'labelPrinterId') problems.labelPrinterId = 'problem.labelPrinter'
    else if (head === 'documentPrinterId') problems.documentPrinterId = 'problem.documentPrinter'
    else if (head === 'integrationAccountId') problems.integrationAccountId = 'problem.account'
    else if (head === 'defaultCarrierCode') problems.defaultCarrierCode = 'problem.carrierCode'
    else if (head === 'defaultServiceCode') problems.defaultServiceCode = 'problem.serviceCode'
    else if (head === 'cutOffTime') problems.cutOffTime = 'problem.cutOff'
    else if (head === 'defaultGoodsAppearance') problems.defaultGoodsAppearance = 'problem.invalid'
  }
  return problems
}

export const problemCount = (problems: FieldProblems): number => Object.keys(problems).length

/** A refused save as one sentence (a message key): changed by someone else, no right, unavailable, refused fields. */
export function saveProblem(error: unknown): { key: string; conflict: boolean } {
  if (!isApiError(error)) return { key: 'save.problem.internal', conflict: false }
  if (error.kind === 'conflict') return { key: 'save.problem.conflict', conflict: true }
  if (error.kind === 'not_found') return { key: 'save.problem.notFound', conflict: true }
  if (['invalid', 'forbidden', 'signed_out', 'rate_limited', 'unavailable'].includes(error.kind)) return { key: `save.problem.${error.kind}`, conflict: false }
  return { key: 'save.problem.internal', conflict: false }
}

/** A failed read as a message key. */
export function readProblem(error: unknown): string {
  if (!isApiError(error)) return 'read.problem.internal'
  if (['signed_out', 'forbidden', 'not_found', 'unavailable', 'rate_limited'].includes(error.kind)) return `read.problem.${error.kind}`
  return 'read.problem.internal'
}

// ---- the carrier account ---------------------------------------------------------------------------------------------------

/** The accounts this site may use: its company's own Sendcloud accounts that are not disabled (a tenant-wide one buys no label). */
export function siteAccounts(accounts: readonly CarrierAccount[], companyId: string): CarrierAccount[] {
  return accounts.filter((account) => account.provider === 'SENDCLOUD' && account.companyId === companyId && account.status !== 'DISABLED')
}

/**
 * The connection's state as the page says it: none set; set but unknown to this person (no integrations.view); a test
 * account (FAKE or SANDBOX: labels marked TEST); paused; disabled; credentials missing; connected (LIVE).
 */
export type AccountState = 'none' | 'unknown' | 'missing' | 'test' | 'paused' | 'disabled' | 'noCredentials' | 'connected'

export function accountState(accountId: string, accounts: readonly CarrierAccount[] | null): AccountState {
  if (accountId === '') return 'none'
  if (accounts === null) return 'unknown'
  const account = accounts.find((entry) => entry.id === accountId)
  if (!account) return 'missing'
  if (account.status === 'DISABLED') return 'disabled'
  if (account.status === 'PAUSED') return 'paused'
  if (account.mode !== 'LIVE') return 'test'
  if (!account.credentials.saved) return 'noCredentials'
  return 'connected'
}

export const STATE_TONE: Readonly<Record<AccountState, 'neutral' | 'info' | 'success' | 'warning' | 'danger'>> = {
  none: 'neutral',
  unknown: 'info',
  missing: 'danger',
  test: 'warning',
  paused: 'warning',
  disabled: 'danger',
  noCredentials: 'danger',
  connected: 'success',
}

/** The TEST mode of the site's account (FAKE: nothing is bought; SANDBOX: Sendcloud's test use), or null when LIVE or unknown. */
export function testMode(accountId: string, accounts: readonly CarrierAccount[] | null): AccountMode | null {
  const account = accounts?.find((entry) => entry.id === accountId)
  return account && account.mode !== 'LIVE' ? account.mode : null
}

// ---- the printers ----------------------------------------------------------------------------------------------------------

/** The site's printers one slot takes: label printers (ZPL) for carrier labels, A4 printers for the DDT and packing list. */
export function printersFor(printers: readonly Printer[], kind: PrinterKind): Printer[] {
  return printers.filter((printer) => printer.kind === kind && printer.status !== 'ARCHIVED').sort((a, b) => a.code.localeCompare(b.code))
}

// ---- the sites -------------------------------------------------------------------------------------------------------------

/** The site the page shows: the address's `?site=` when the person reaches it, else the first (sites come by company and code). */
export function chosenSite(sites: readonly SiteSettings[], wanted: string | null): SiteSettings | null {
  return sites.find((entry) => entry.site.id === wanted) ?? sites[0] ?? null
}
