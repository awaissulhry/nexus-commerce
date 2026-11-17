import { addressDomain, normalizeAddress } from '@nexus/factory-domain/email/rules'
import { INQUIRY_ADDRESS_LIMIT } from '@nexus/factory-domain/mail-depth/rules'
import { isApiError, issuePath } from '../../../../lib/api/errors'
import type { Loaded, Phrase } from '../model'
import type { AddressesAnswer } from './api'

/**
 * B-TH-285 (threads plan TH-8; O-SAL-INQ-LIST.band-F04/F05, L2-G09), pure: Incoming's ⋯ "Inquiry addresses" — the addresses whose mail
 * becomes a request by itself (unknown senders included: they arrive as prospects) — and the band's line while that door is not open.
 *
 *   which list    a company's own list when it has one, else the tenant-wide list every company without its own shares (the
 *                 API refuses a company's own list until it has sales settings of its own: the dialog edits the shared one then
 *                 and says so)
 *   problems      in words, before Save: an e-mail address, each once, at most 20, at one of the company's receiving domains (when
 *                 the domains are known); after Save: the API's places in the same words (another company's address too)
 *   the door      open once mail is received live (an ACTIVE SES account in LIVE mode, B-TH-089, a go-live step that costs): until
 *                 then the band says the addresses wait for it; with no receiving domain at all: "Set up the mail domain first"
 *
 * An address belongs to one company (W22): the API refuses another company's address; mail from another customer's sender to an
 * address is held by the sorting (W23). Every word is a key of `sales-inquiries` (`addresses.*`).
 */

export { INQUIRY_ADDRESS_LIMIT }

/** The list the dialog edits: the company's own, or the tenant-wide one (shared by every company without its own). */
export interface AddressScope {
  readonly companyId: string | null
  readonly answer: AddressesAnswer
}

/** Which scope to edit: the company's own list when it has settings of its own, else the tenant-wide list. */
export function scopeOf(company: AddressesAnswer, tenant: AddressesAnswer | null, companyId: string | null): AddressScope {
  if (company.hasOwnSettings || tenant === null) return { companyId, answer: company }
  return { companyId: null, answer: tenant }
}

export interface AddressesModel {
  /** The list as read (its scope), or why not. */
  readonly loaded: Loaded<AddressScope>
  /** The addresses as typed (one per row), the new one being typed. */
  readonly draft: readonly string[]
  readonly adding: string
  /** The company's receiving domains (null: not known to this reader — the API checks them). */
  readonly domains: readonly string[] | null
  /** Mail is received live (null: not known to this reader). */
  readonly live: boolean | null
  readonly busy: boolean
  /** A refusal of the save, in words, with the rows it names. */
  readonly problem: { readonly phrase: Phrase; readonly rows: Readonly<Record<number, Phrase>> } | null
  /** Saved (the receipt). */
  readonly saved: boolean
  readonly offline: boolean
}

export type RowProblem = 'format' | 'twice' | 'domain' | 'taken'

/** One typed address's problem in words, or null (the domain only when the receiving domains are known). */
export function rowProblem(addresses: readonly string[], index: number, domains: readonly string[] | null): Phrase | null {
  const address = normalizeAddress(addresses[index] ?? '')
  if (address.length > 254 || !/^[^@\s]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(address)) return { key: 'addresses.problem.format' }
  if (addresses.slice(0, index).some((other) => normalizeAddress(other) === address)) return { key: 'addresses.problem.twice' }
  if (domains && domains.length > 0 && !domains.includes(addressDomain(address))) return { key: 'addresses.problem.domain', params: { domains: domains.join(', ') } }
  return null
}

/** Why Save waits, in words (the right, a row's problem, the most addresses, nothing changed, offline), or null. */
export function saveHeld(model: Pick<AddressesModel, 'loaded' | 'draft' | 'domains' | 'busy' | 'offline'>): Phrase | null {
  if (model.loaded.status !== 'ready') return { key: 'addresses.reading' }
  if (!model.loaded.value.answer.mayManage) return { key: 'addresses.held.right' }
  if (model.busy) return { key: 'common.working' }
  if (model.draft.length > INQUIRY_ADDRESS_LIMIT) return { key: 'addresses.problem.many', params: { max: INQUIRY_ADDRESS_LIMIT } }
  const bad = model.draft.findIndex((_, index) => rowProblem(model.draft, index, model.domains) !== null)
  if (bad >= 0) return { key: 'addresses.held.row', params: { n: bad + 1 } }
  if (!changed(model.loaded.value.answer.addresses, model.draft)) return { key: 'addresses.held.same' }
  if (model.offline) return { key: 'held.offline' }
  return null
}

/** The list as it will be saved: lower case, trimmed, each once, in the order typed. */
export const savedList = (draft: readonly string[]): string[] => [...new Set(draft.map(normalizeAddress).filter(Boolean))]

const changed = (was: readonly string[], draft: readonly string[]): boolean => JSON.stringify(savedList(was)) !== JSON.stringify(savedList(draft))

/** Adding the typed address: refused in words when the list is full, the address does not read, or it is there already. */
export function addHeld(draft: readonly string[], adding: string, domains: readonly string[] | null): Phrase | null {
  if (adding.trim() === '') return { key: 'addresses.held.type' }
  if (draft.length >= INQUIRY_ADDRESS_LIMIT) return { key: 'addresses.problem.many', params: { max: INQUIRY_ADDRESS_LIMIT } }
  return rowProblem([...draft, adding], draft.length, domains)
}

/** The API's places of a refused save (`body/addresses/<n>`) in our words; a stale version reads again ("changed meanwhile"). */
export function saveProblem(error: unknown): { readonly phrase: Phrase; readonly rows: Readonly<Record<number, Phrase>>; readonly stale: boolean } {
  if (!isApiError(error)) return { phrase: { key: 'problem.unavailable' }, rows: {}, stale: false }
  if (error.kind === 'conflict') return { phrase: { key: 'addresses.problem.stale' }, rows: {}, stale: true }
  if (error.kind === 'forbidden') return { phrase: { key: 'addresses.held.right' }, rows: {}, stale: false }
  if (error.kind !== 'invalid') return { phrase: { key: 'problem.unavailable' }, rows: {}, stale: false }
  const rows: Record<number, Phrase> = {}
  let followsTenant = false
  for (const issue of error.issues) {
    const path = issuePath(issue)
    if (path === 'body/companyId') followsTenant = true
    const match = /^body\/addresses\/(\d+)$/.exec(path)
    if (!match) continue
    // The API's reasons by their kind (its words stay unshown): a receiving domain, another company's, once, an address.
    const text = (issue as { message?: string }).message ?? ''
    const kind: RowProblem = /receiving domain/i.test(text) ? 'domain' : /another company/i.test(text) ? 'taken' : /once/i.test(text) ? 'twice' : 'format'
    rows[Number(match[1])] = kind === 'domain' ? { key: 'addresses.problem.domainApi' } : { key: `addresses.problem.${kind}` }
  }
  if (followsTenant) return { phrase: { key: 'addresses.problem.followsTenant' }, rows, stale: false }
  return { phrase: { key: Object.keys(rows).length > 0 ? 'addresses.problem.rows' : 'problem.invalid' }, rows, stale: false }
}

/**
 * The band's line about the orders@ door (band-F05): addresses in force but mail not received live yet → "not open yet" (it opens
 * with the mail provider's live receiving, a go-live step); no receiving domain → "Set up the mail domain first"; open, nothing to
 * say, or not known to this reader → nothing.
 */
export function doorLine(addresses: readonly string[] | null, live: boolean | null, domains: readonly string[] | null): Phrase | null {
  if (!addresses || addresses.length === 0) return null
  if (domains !== null && domains.length === 0) return { key: 'addresses.door.noDomain' }
  if (live === false) return { key: 'addresses.door.notLive', params: { count: addresses.length } }
  return null
}

/** The dialog's scope in words: the company's own list, or the tenant-wide list it shares. */
export const scopeWords = (scope: AddressScope): Phrase => (scope.companyId !== null ? { key: 'addresses.scope.company' } : { key: scope.answer.source === 'NONE' ? 'addresses.scope.none' : 'addresses.scope.tenant' })
