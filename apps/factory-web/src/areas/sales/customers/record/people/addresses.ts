import type { Address } from '../../../../parties/_shared/api'
import type { AddressUsage } from './api'
import { REFUSED_IN_VIEW_DAYS, said, type PeopleCan, type Said } from './model'

/**
 * F-CA-104 (customer page › PEOPLE & ADDRESSES tab, lane ca-; 10-design §5.2; 18-lead-settles Z17) — the Addresses section's rows, pure:
 * what each address is for, its defaults as words, which one the e-invoices use (the server's own rule, mirrored), the check of an
 * address the customer added in the portal (waiting: Approve / Refuse… here; refused: in view 30 days after the decision, then only
 * under Show archived), what it is used on (the usage read, D3), and its ⋯ (each act with its own right; held only by state).
 */

export interface AddressRow {
  readonly id: string
  readonly address: Address
  /** Added in the portal and waiting for our check (still active). */
  readonly waiting: boolean
  /** Refused after our check (archived for good by the refusal). */
  readonly refused: boolean
  /** Archived (and not refused). */
  readonly archived: boolean
  /** The address the customer's e-invoices name (the oldest active registered office, else the default invoice address). */
  readonly einvoice: boolean
  /** A second registered office: the e-invoices use the oldest — its city, to say which. */
  readonly otherRegistered: string | null
  /** What it is used on (the usage read); null: not read, failed, or nothing. */
  readonly usage: AddressUsage | null
}

const byAdded = (a: Address, b: Address): number => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0)

/**
 * The address the customer's invoices name: the oldest ACTIVE registered office, else the default invoice address — the invoicing
 * module's own rule (apps/factory-api modules/invoicing/facts.ts partyFacts: active addresses by `createdAt`, the first REGISTERED,
 * else the first default bill-to).
 */
export function invoiceAddressOf(addresses: readonly Address[]): Address | null {
  const active = addresses.filter((address) => address.status === 'ACTIVE').sort(byAdded)
  return active.find((address) => address.kinds.includes('REGISTERED')) ?? active.find((address) => address.isDefaultBillTo) ?? null
}

/** The active registered offices (two or more: the e-invoices use the oldest). */
export const registeredOffices = (addresses: readonly Address[]): Address[] => addresses.filter((address) => address.status === 'ACTIVE' && address.kinds.includes('REGISTERED')).sort(byAdded)

export function addressRows(addresses: readonly Address[], usage: readonly AddressUsage[] | null): AddressRow[] {
  const invoice = invoiceAddressOf(addresses)
  const registered = registeredOffices(addresses)
  const usageOf = new Map((usage ?? []).map((row) => [row.addressId, row]))
  return addresses.map((address) => {
    const approval = address.approval?.status ?? null
    const refused = approval === 'REFUSED'
    return {
      id: address.id,
      address,
      waiting: approval === 'WAITING' && address.status === 'ACTIVE',
      refused,
      archived: address.status === 'ARCHIVED' && !refused,
      einvoice: invoice?.id === address.id,
      otherRegistered: registered.length > 1 && address.status === 'ACTIVE' && address.kinds.includes('REGISTERED') && invoice?.id !== address.id ? (invoice?.city ?? null) : null,
      usage: usageOf.get(address.id) ?? null,
    }
  })
}

/** A refused address decided within the last 30 days (still in view without Show archived). */
export function refusedInView(row: AddressRow, now: string): boolean {
  if (!row.refused) return false
  const decided = row.address.approval?.decidedAt ?? row.address.updatedAt
  return Date.parse(now) - Date.parse(decided) <= REFUSED_IN_VIEW_DAYS * 86_400_000
}

/** The rows shown: active ones (a waiting one first), a refused one for 30 days; archived ones only with Show archived. */
export function shownAddresses(rows: readonly AddressRow[], show: { readonly archived: boolean }, now: string): AddressRow[] {
  const rank = (row: AddressRow) => (row.waiting ? 0 : row.address.status === 'ACTIVE' ? 1 : 2)
  return rows.filter((row) => row.address.status === 'ACTIVE' || show.archived || refusedInView(row, now)).sort((a, b) => rank(a) - rank(b) || byAdded(a.address, b.address))
}

/** How many rows Show archived brings back. */
export const archivedCount = (rows: readonly AddressRow[], now: string): number => rows.filter((row) => row.address.status !== 'ACTIVE' && !refusedInView(row, now)).length

/** The address's name in short, as the answer and the notices say it ("Workshop, Imola"). */
export const addressShort = (address: Pick<Address, 'name' | 'line1' | 'city'>): string => `${address.name ?? address.line1}, ${address.city}`

/** "Used on 1 draft quote · 1 prepared shipment" — each count > 0 as words (no list takes an address filter: words, not doors, P7). */
export function addressUsageWords(usage: AddressUsage | null): Said[] {
  if (!usage) return []
  const parts: Array<[number, string]> = [
    [usage.draftQuoteVersions, 'used.draftQuotes'],
    [usage.preparedShipments, 'used.shipments'],
    [usage.openSampleShipments, 'used.samples'],
    [usage.openPortalRequests, 'used.portalRequests'],
    [usage.openChangeRequests, 'used.changeRequests'],
  ]
  return parts.filter(([count]) => count > 0).map(([count, key]) => said(key, { params: { count } }))
}

// ---- the row's ⋯ -------------------------------------------------------------------------------------------------------------

export type AddressAct = 'edit' | 'billTo' | 'shipTo' | 'copy' | 'archive' | 'restore' | 'approve' | 'refuse' | 'link'

export interface AddressItem {
  readonly id: string
  readonly label: Said
  readonly act?: AddressAct
  readonly href?: string
  readonly held?: Said
  readonly danger?: boolean
  readonly separator?: true
}

export interface AddressMenuContext {
  readonly can: PeopleCan
  readonly archivedCustomer: boolean
  readonly prefix: string
}

const sep = (id: string): AddressItem => ({ id, label: said(''), separator: true })

export function addressMenu(row: AddressRow, context: AddressMenuContext): AddressItem[] {
  const { can } = context
  const address = row.address
  const link: AddressItem = { id: 'link', label: said('row.copyLink'), act: 'link' }
  const copy: AddressItem = { id: 'copy', label: said('address.copy'), act: 'copy' }
  // A refused address never changes (R-B1): one held line, Copy address, the link.
  if (row.refused) return [{ id: 'refused', label: said('address.refusedLine'), held: said('address.refusedHeld') }, copy, link]
  const held = context.archivedCustomer ? said('parties:held.archived') : undefined
  const groups: AddressItem[][] = []
  // A waiting address: Approve and Refuse… first (orders.manage).
  if (row.waiting && can.ordersManage) groups.push([{ id: 'approve', label: said('check.approve'), act: 'approve', ...(held ? { held } : {}) }, { id: 'refuse', label: said('check.refuse'), act: 'refuse', danger: true, ...(held ? { held } : {}) }])
  const own: AddressItem[] = []
  if (can.manage) {
    own.push({ id: 'edit', label: said('parties:common.edit'), act: 'edit', ...(held ? { held } : {}) })
    if (address.status === 'ACTIVE') {
      // A waiting address is never a default (factory-domain address-approval defaultProblem; the API refuses it).
      const defaultHeld = held ?? (row.waiting ? said('address.waitingHeld') : undefined)
      if (address.kinds.includes('BILL_TO') && !address.isDefaultBillTo) own.push({ id: 'billTo', label: said('address.setBillTo'), act: 'billTo', ...(defaultHeld ? { held: defaultHeld } : {}) })
      if (address.kinds.includes('SHIP_TO') && !address.isDefaultShipTo) own.push({ id: 'shipTo', label: said('address.setShipTo'), act: 'shipTo', ...(defaultHeld ? { held: defaultHeld } : {}) })
    }
  }
  groups.push(own)
  groups.push([copy, ...(can.audit ? [{ id: 'history', label: said('row.history'), href: `${context.prefix}/admin/audit?${new URLSearchParams({ type: 'PartyAddress', record: address.id }).toString()}` }] : [])])
  if (can.manage) groups.push([address.status === 'ACTIVE' ? { id: 'archive', label: said('parties:address.archive'), act: 'archive', ...(held ? { held } : {}) } : { id: 'restore', label: said('parties:address.restore'), act: 'restore', ...(held ? { held } : {}) }])
  groups.push([link])
  const items: AddressItem[] = []
  groups
    .filter((group) => group.length > 0)
    .forEach((group, index) => {
      if (index > 0) items.push(sep(`sep-${index}`))
      items.push(...group)
    })
  return items
}

/** The address as text to copy (its lines, the place and the country code). */
export const addressText = (address: Address): string =>
  [address.name, address.line1, address.line2, [address.postalCode, address.city, address.province].filter(Boolean).join(' '), address.country].filter((part) => part && String(part).trim() !== '').join('\n')
