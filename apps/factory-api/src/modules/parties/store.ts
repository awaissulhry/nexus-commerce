import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { ConflictError, ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can, grantsFor, type Actor, type Permission, type ScopeColumns } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import type { AddressFields } from '@nexus/factory-domain/parties/addresses'
import type { ContactFields } from '@nexus/factory-domain/parties/contacts'
import type { AddressView, ContactView, PartyRow, PartyView, TaxIdentityView, ViesCheckView, ViesStandingView } from '@nexus/factory-domain/parties/contracts'
import { PARTIES_VIEW } from '@nexus/factory-domain/parties/permissions'
import type { PartyFields, PartyStatus } from '@nexus/factory-domain/parties/rules'
import { identityAt, taxKeysOf, type TaxIdentityFields } from '@nexus/factory-domain/parties/tax'
import { viesStanding, type ViesCheckFacts, type ViesStanding } from '@nexus/factory-domain/parties/vies'
import { partyWarnings } from '@nexus/factory-domain/parties/warnings'
import { viesErrorMeaning } from '@nexus/factory-domain/ports/vies'
import type { CommandCaller, CommandTools, CommandTx } from '../../core/command'
import { actorOf, type RequestContext } from '../../core/context'
import { ApiError } from '../../core/errors'
import { serverClock } from '../../core/time'

/**
 * The parties' rows (factory-db `Party`, `PartyAddress`, `PartyContact`, `PartyTaxIdentity`, `ViesCheck`): the columns
 * every read names, how rows become the domain's fields and the contracts' views, who may see and write which party,
 * the locks, the duplicate check and the inserts shared by the routes and the importer (always inside a command()).
 *
 * Who: a party is checked with can() against its company AND itself (`partyId` = its id), so a role limited to some
 * customers reaches only those; a tenant-wide party (no company) is written only by a grant over every company.
 * Lock order: the party row first (`lockParty`, or command()'s record guard on the party), then its addresses,
 * contacts or tax identities (compare-and-set of their own version, `bumpVersion`), then the duplicate-number locks.
 * A default address moves the party's version too (`touchParty`): two changes of a default never both win.
 */

export const PARTY_SCOPE: ScopeColumns = { company: { field: 'companyId', nullable: true }, party: 'id' }

export const PARTY_COLUMNS = {
  id: true,
  companyId: true,
  code: true,
  kind: true,
  legalName: true,
  tradeName: true,
  roles: true,
  status: true,
  country: true,
  currency: true,
  language: true,
  paymentTerms: true,
  internalNote: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  createdById: true,
} as const satisfies Prisma.PartySelect
export type PartyRowData = Prisma.PartyGetPayload<{ select: typeof PARTY_COLUMNS }>

export const ADDRESS_COLUMNS = {
  id: true,
  partyId: true,
  kinds: true,
  name: true,
  line1: true,
  line2: true,
  postalCode: true,
  city: true,
  province: true,
  country: true,
  contactName: true,
  phone: true,
  deliveryNotes: true,
  isDefaultBillTo: true,
  isDefaultShipTo: true,
  status: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.PartyAddressSelect
export type AddressRowData = Prisma.PartyAddressGetPayload<{ select: typeof ADDRESS_COLUMNS }>

export const CONTACT_COLUMNS = {
  id: true,
  partyId: true,
  name: true,
  email: true,
  phone: true,
  roles: true,
  language: true,
  status: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.PartyContactSelect
export type ContactRowData = Prisma.PartyContactGetPayload<{ select: typeof CONTACT_COLUMNS }>

export const TAX_COLUMNS = {
  id: true,
  partyId: true,
  country: true,
  taxMode: true,
  vatNumber: true,
  fiscalCode: true,
  sdiRecipientCode: true,
  pec: true,
  validFrom: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.PartyTaxIdentitySelect
export type TaxRowData = Prisma.PartyTaxIdentityGetPayload<{ select: typeof TAX_COLUMNS }>

export const VIES_COLUMNS = {
  id: true,
  partyId: true,
  taxIdentityId: true,
  companyId: true,
  countryCode: true,
  vatNumber: true,
  requesterVatNumber: true,
  requestedAt: true,
  result: true,
  consultationNumber: true,
  traderName: true,
  traderAddress: true,
  errorCode: true,
  requestId: true,
  createdById: true,
} as const satisfies Prisma.ViesCheckSelect
export type ViesRowData = Prisma.ViesCheckGetPayload<{ select: typeof VIES_COLUMNS }>

export function contextOf(caller: CommandCaller): RequestContext {
  if (!caller.factoryContext) throw new ApiError('unauthenticated')
  return caller.factoryContext
}

/** The tenant of an office or system context (parties are always a tenant's). */
export function tenantOf(context: RequestContext): string {
  if (!('tenantId' in context) || !context.tenantId) throw new ApiError('internal_error', 'A party is written in a tenant\'s context.')
  return context.tenantId
}

/** The business day (Europe/Rome) of an instant: which tax identity is in force. */
export const dayOf = (instant: Date): string => businessDate(instant)
export const today = (): string => dayOf(serverClock.now())
/** A DATE column as YYYY-MM-DD (Prisma reads it as midnight UTC). */
export const dateText = (value: Date): string => value.toISOString().slice(0, 10)
export const dateValue = (day: string): Date => new Date(`${day}T00:00:00.000Z`)

export const isUniqueViolation = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === 'P2002'

// ---- rows as domain fields ---------------------------------------------------------------------------------------------

export function partyFieldsOf(row: Pick<PartyRowData, 'code' | 'kind' | 'legalName' | 'tradeName' | 'roles' | 'country' | 'currency' | 'language' | 'paymentTerms' | 'internalNote'>): PartyFields {
  return {
    code: row.code,
    kind: row.kind,
    legalName: row.legalName,
    tradeName: row.tradeName,
    roles: [...row.roles],
    country: row.country,
    currency: row.currency,
    language: row.language,
    paymentTerms: row.paymentTerms,
    internalNote: row.internalNote,
  }
}

export function addressFieldsOf(row: AddressRowData): AddressFields {
  return {
    kinds: [...row.kinds],
    name: row.name,
    line1: row.line1,
    line2: row.line2,
    postalCode: row.postalCode,
    city: row.city,
    province: row.province,
    country: row.country,
    contactName: row.contactName,
    phone: row.phone,
    deliveryNotes: row.deliveryNotes,
  }
}

export function contactFieldsOf(row: ContactRowData): ContactFields {
  return { name: row.name, email: row.email, phone: row.phone, roles: [...row.roles], language: row.language }
}

export function taxFieldsOf(row: TaxRowData): TaxIdentityFields {
  return {
    country: row.country,
    taxMode: row.taxMode,
    vatNumber: row.vatNumber,
    fiscalCode: row.fiscalCode,
    sdiRecipientCode: row.sdiRecipientCode,
    pec: row.pec,
    validFrom: dateText(row.validFrom),
  }
}

export const viesFactsOf = (row: ViesRowData): ViesCheckFacts => ({
  id: row.id,
  countryCode: row.countryCode,
  vatNumber: row.vatNumber,
  requestedAt: row.requestedAt,
  result: row.result,
  consultationNumber: row.consultationNumber,
  errorCode: row.errorCode,
})

// ---- views -------------------------------------------------------------------------------------------------------------

export function standingView(standing: ViesStanding): ViesStandingView {
  return {
    state: standing.state,
    message: standing.message,
    proofCheckId: standing.proof?.id ?? null,
    checkedAt: standing.latest ? toUtcIso(standing.latest.requestedAt) : null,
    validUntil: standing.validUntil ? toUtcIso(standing.validUntil) : null,
    maxAgeDays: standing.maxAgeDays,
  }
}

export function addressViewOf(row: AddressRowData): AddressView {
  return { ...addressFieldsOf(row), kinds: [...row.kinds], id: row.id, isDefaultBillTo: row.isDefaultBillTo, isDefaultShipTo: row.isDefaultShipTo, status: row.status, version: row.version, createdAt: toUtcIso(row.createdAt), updatedAt: toUtcIso(row.updatedAt) }
}

export function contactViewOf(row: ContactRowData): ContactView {
  return { ...contactFieldsOf(row), roles: [...row.roles], id: row.id, status: row.status, version: row.version, createdAt: toUtcIso(row.createdAt), updatedAt: toUtcIso(row.updatedAt) }
}

export function taxViewOf(row: TaxRowData, currentId: string | null): TaxIdentityView {
  return { ...taxFieldsOf(row), id: row.id, current: row.id === currentId, version: row.version, createdAt: toUtcIso(row.createdAt), updatedAt: toUtcIso(row.updatedAt) }
}

export function viesCheckViewOf(row: ViesRowData): ViesCheckView {
  return {
    id: row.id,
    taxIdentityId: row.taxIdentityId,
    companyId: row.companyId,
    countryCode: row.countryCode,
    vatNumber: row.vatNumber,
    requesterVatNumber: row.requesterVatNumber,
    requestedAt: toUtcIso(row.requestedAt),
    result: row.result,
    consultationNumber: row.consultationNumber,
    traderName: row.traderName,
    traderAddress: row.traderAddress,
    errorCode: row.errorCode,
    errorMeaning: row.result === 'ERROR' ? viesErrorMeaning(row.errorCode ?? '') : null,
    requestId: row.requestId,
    createdById: row.createdById,
  }
}

/** Active first, then by kind of use; inside, the oldest first. */
const byUse = (a: AddressRowData, b: AddressRowData): number =>
  (a.status === b.status ? 0 : a.status === 'ACTIVE' ? -1 : 1) || a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1)

/** The city a list row shows: the default invoice address's, else the registered office's. */
function cityOf(addresses: readonly AddressRowData[]): string | null {
  const active = addresses.filter((address) => address.status === 'ACTIVE')
  const chosen = active.find((address) => address.isDefaultBillTo) ?? active.find((address) => address.kinds.includes('REGISTERED')) ?? active[0]
  return chosen ? chosen.city : null
}

export function partyRowOf(row: PartyRowData, current: TaxRowData | null, standing: ViesStanding, addresses: readonly AddressRowData[]): PartyRow {
  return {
    id: row.id,
    companyId: row.companyId,
    code: row.code,
    kind: row.kind,
    legalName: row.legalName,
    tradeName: row.tradeName,
    roles: [...row.roles],
    status: row.status,
    country: row.country,
    currency: row.currency,
    language: row.language,
    taxMode: current?.taxMode ?? null,
    vatNumber: current?.vatNumber ?? null,
    fiscalCode: current?.fiscalCode ?? null,
    city: cityOf(addresses),
    vies: standingView(standing),
    version: row.version,
    updatedAt: toUtcIso(row.updatedAt),
  }
}

/** The VIES checks of the record (the identity in force today) shown with it. */
export const RECORD_VIES_CHECKS = 20

type Reader = FactoryClient | CommandTx

/** Everything the record shows, read in one client (a request's or a command's), at `now`. */
export async function readRecord(client: Reader, partyId: string, now: Date): Promise<PartyView> {
  const party = await client.party.findUniqueOrThrow({ where: { id: partyId }, select: PARTY_COLUMNS })
  // One query after the other: a select with several relations would make Prisma run them at once on one connection.
  const addresses = await client.partyAddress.findMany({ where: { partyId }, select: ADDRESS_COLUMNS })
  const contacts = await client.partyContact.findMany({ where: { partyId }, select: CONTACT_COLUMNS, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  const identities = await client.partyTaxIdentity.findMany({ where: { partyId }, select: TAX_COLUMNS, orderBy: [{ validFrom: 'desc' }] })
  const current = identityAt(identities.map((row) => ({ row, validFrom: dateText(row.validFrom) })), dayOf(now))?.row ?? null
  const checks = current ? await client.viesCheck.findMany({ where: { taxIdentityId: current.id }, select: VIES_COLUMNS, orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }] }) : []
  const standing = viesStanding(current ? taxFieldsOf(current) : null, checks.map(viesFactsOf), now)
  const blocked =
    party.status === 'BLOCKED'
      ? await client.auditLog.findFirst({ where: { recordType: 'Party', recordId: partyId, action: 'parties.block' }, select: { reason: true, at: true }, orderBy: [{ at: 'desc' }] })
      : null
  const active = addresses.filter((address) => address.status === 'ACTIVE')
  const activeContacts = contacts.filter((contact) => contact.status === 'ACTIVE')
  return {
    ...partyRowOf(party, current, standing, addresses),
    paymentTerms: party.paymentTerms,
    internalNote: party.internalNote,
    blocked: blocked ? { reason: blocked.reason, at: toUtcIso(blocked.at) } : null,
    addresses: [...addresses].sort(byUse).map(addressViewOf),
    contacts: [...contacts].sort((a, b) => (a.status === b.status ? 0 : a.status === 'ACTIVE' ? -1 : 1)).map(contactViewOf),
    taxIdentities: identities.map((row) => taxViewOf(row, current?.id ?? null)),
    viesChecks: checks.slice(0, RECORD_VIES_CHECKS).map(viesCheckViewOf),
    warnings: partyWarnings({
      party: { kind: party.kind, roles: party.roles, country: party.country, legalName: party.legalName },
      identity: current ? taxFieldsOf(current) : null,
      vies: standing,
      addresses: active.map((address) => ({ kinds: address.kinds, isDefaultBillTo: address.isDefaultBillTo, isDefaultShipTo: address.isDefaultShipTo, line1: address.line1, line2: address.line2, city: address.city })),
      contacts: activeContacts.map((contact) => ({ email: contact.email, roles: contact.roles })),
    }),
    createdAt: toUtcIso(party.createdAt),
    createdById: party.createdById,
  }
}

// ---- who may see and write ---------------------------------------------------------------------------------------------

/**
 * May the actor do `permission` on this party? A company's party: a grant over that company and that party (can()).
 * A tenant-wide party is shared by every company, so only a grant over every company (and that party) writes it.
 */
export function mayWrite(actor: Actor, permission: Permission, party: { readonly id: string; readonly companyId: string | null }): boolean {
  if (party.companyId !== null) return can(actor, permission, { companyId: party.companyId, partyId: party.id })
  return can(actor, permission, { partyId: party.id }) && grantsFor(actor, permission).some((grant) => grant.companies === 'all' && (grant.parties === 'all' || grant.parties.includes(party.id)))
}

export function assertMayWrite(context: RequestContext, permission: Permission, party: { readonly id: string; readonly companyId: string | null }): void {
  if (!mayWrite(actorOf(context), permission, party)) {
    throw new ForbiddenError(party.companyId === null ? 'A party for every company is changed only by a role over every company.' : undefined)
  }
}

/** The party as the caller may see it; another company's (outside the caller's grants), another tenant's or an unknown one is not found. */
export async function readParty(caller: CommandCaller, partyId: string): Promise<PartyRowData> {
  const context = contextOf(caller)
  if (!isUuid(partyId)) throw new NotFoundError('Party not found.')
  const row = await caller.withClient((client) => client.party.findUnique({ where: { id: partyId }, select: PARTY_COLUMNS }))
  if (!row || !can(actorOf(context), PARTIES_VIEW, { companyId: row.companyId, partyId: row.id })) throw new NotFoundError('Party not found.')
  return row
}

/** Locks the party row for the rest of the command (the children's writes take it first). */
export async function lockParty(tx: CommandTx, partyId: string): Promise<{ status: PartyStatus; code: string; companyId: string | null }> {
  const rows = await tx.$queryRaw<{ status: PartyStatus; code: string; companyId: string | null }[]>`
    SELECT "status"::text AS "status", "code", "companyId"::text AS "companyId" FROM "Party" WHERE "id" = ${partyId}::uuid FOR UPDATE`
  const row = rows[0]
  if (!row) throw new NotFoundError('Party not found.')
  return row
}

/** Moves the party's version (a default address changed): an open edit of the party sees a newer version. */
export async function touchParty(tx: CommandTx, partyId: string): Promise<void> {
  await tx.party.update({ where: { id: partyId }, data: { version: { increment: 1 } }, select: { id: true } })
}

type Versioned = 'address' | 'contact' | 'identity'
const TYPE_NAME: Readonly<Record<Versioned, string>> = { address: 'PartyAddress', contact: 'PartyContact', identity: 'PartyTaxIdentity' }

/** Compare-and-set of a child row's version, after the party's lock (COL-078): a stale version is a 409. */
export async function bumpVersion(tx: CommandTx, model: Versioned, id: string, expected: number): Promise<number> {
  const where = { id, version: expected }
  const data = { version: expected + 1 }
  const { count } =
    model === 'address' ? await tx.partyAddress.updateMany({ where, data }) : model === 'contact' ? await tx.partyContact.updateMany({ where, data }) : await tx.partyTaxIdentity.updateMany({ where, data })
  if (count === 1) return expected + 1
  const current =
    model === 'address'
      ? await tx.partyAddress.findUnique({ where: { id }, select: { version: true } })
      : model === 'contact'
        ? await tx.partyContact.findUnique({ where: { id }, select: { version: true } })
        : await tx.partyTaxIdentity.findUnique({ where: { id }, select: { version: true } })
  if (!current) throw new NotFoundError(`${TYPE_NAME[model]} not found.`)
  throw new ConflictError(`This ${TYPE_NAME[model]} changed since it was read (version ${expected}); it is now at version ${current.version}. Reload it and apply the change again.`)
}

/** The party is not archived (read only until it is reactivated). */
export function assertWritable(status: PartyStatus): void {
  if (status === 'ARCHIVED') throw new ApiError('invalid_state', 'This party is archived: reactivate it before changing it.')
}

// ---- one record per business partner: the duplicate check ----------------------------------------------------------------

/** Takes the transaction lock of each number of an identity (VAT numbers and codici fiscali), in a fixed order. */
export async function lockTaxNumbers(tx: Pick<CommandTx, '$executeRaw'>, tenantId: string, identity: Pick<TaxIdentityFields, 'vatNumber' | 'fiscalCode'>): Promise<void> {
  const keys = taxKeysOf(identity)
  for (const key of [...keys.vatNumbers.map((value) => `vat:${value}`), ...keys.fiscalCodes.map((value) => `cf:${value}`)].sort()) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.party.taxId', ${tenantId}::uuid, ${key}::text), 0))`
  }
}

/**
 * Refuses a VAT number or codice fiscale another party of the tenant holds (in any of its identities, archived parties
 * included): one record per business partner (A1 §2.4 A). The index on the numbers is not unique (a party keeps its
 * number across identities), so writers of the same numbers are serialised by a transaction lock per number, taken
 * after the party's own lock.
 */
export async function assertNoTaxDuplicate(tx: CommandTx, context: RequestContext, partyId: string, identity: Pick<TaxIdentityFields, 'vatNumber' | 'fiscalCode'>): Promise<void> {
  const keys = taxKeysOf(identity)
  if (keys.vatNumbers.length + keys.fiscalCodes.length === 0) return
  await lockTaxNumbers(tx, tenantOf(context), identity)
  const clash = await tx.partyTaxIdentity.findFirst({
    where: {
      partyId: { not: partyId },
      OR: [...(keys.vatNumbers.length > 0 ? [{ vatNumber: { in: [...keys.vatNumbers] } }] : []), ...(keys.fiscalCodes.length > 0 ? [{ fiscalCode: { in: [...keys.fiscalCodes] } }] : [])],
    },
    select: { vatNumber: true, party: { select: { code: true, status: true } } },
    orderBy: [{ createdAt: 'asc' }],
  })
  if (!clash) return
  const what = clash.vatNumber !== null && keys.vatNumbers.includes(clash.vatNumber) ? 'VAT number' : 'codice fiscale'
  throw new ConflictError(`This ${what} belongs to party ${clash.party.code}${clash.party.status === 'ARCHIVED' ? ' (archived)' : ''}: one record per business partner. Open that party, or give it the role it lacks.`)
}

// ---- writes (inside a command) -------------------------------------------------------------------------------------------

/** Clears the other default invoice (delivery) address of a party; answers the addresses it changed. */
export async function clearDefault(tx: CommandTx, partyId: string, which: 'isDefaultBillTo' | 'isDefaultShipTo', except: string | null): Promise<string[]> {
  const rows = await tx.partyAddress.findMany({ where: { partyId, [which]: true, ...(except ? { id: { not: except } } : {}) }, select: { id: true } })
  for (const row of rows) await tx.partyAddress.update({ where: { id: row.id }, data: { [which]: false, version: { increment: 1 } }, select: { id: true } })
  return rows.map((row) => row.id)
}

const createdBy = (context: RequestContext): string | null => (context.audience === 'office' ? context.actorId : null)

/** An address of a party, with its audit row; the caller holds the party's lock and has cleared the old defaults. */
export async function insertAddress(tools: CommandTools, party: { readonly id: string; readonly companyId: string | null }, address: AddressFields, defaults: { readonly isDefaultBillTo: boolean; readonly isDefaultShipTo: boolean }, action?: Permission): Promise<string> {
  const { tx, now, context } = tools
  const id = newId()
  await tx.partyAddress.create({ data: { id, partyId: party.id, ...address, kinds: [...address.kinds], ...defaults, createdAt: now, updatedAt: now, createdById: createdBy(context) }, select: { id: true } })
  tools.audit({ ...(action ? { action } : {}), recordType: 'PartyAddress', recordId: id, companyId: party.companyId, after: { partyId: party.id, ...address, ...defaults } })
  return id
}

export async function insertContact(tools: CommandTools, party: { readonly id: string; readonly companyId: string | null }, contact: ContactFields, action?: Permission): Promise<string> {
  const { tx, now, context } = tools
  const id = newId()
  await tx.partyContact.create({ data: { id, partyId: party.id, ...contact, roles: [...contact.roles], createdAt: now, updatedAt: now, createdById: createdBy(context) }, select: { id: true } })
  tools.audit({ ...(action ? { action } : {}), recordType: 'PartyContact', recordId: id, companyId: party.companyId, after: { partyId: party.id, ...contact } })
  return id
}

export async function insertTaxIdentity(tools: CommandTools, party: { readonly id: string; readonly companyId: string | null }, identity: TaxIdentityFields, action?: Permission): Promise<string> {
  const { tx, now, context } = tools
  const id = newId()
  await tx.partyTaxIdentity.create({ data: { id, partyId: party.id, ...identity, validFrom: dateValue(identity.validFrom), createdAt: now, updatedAt: now, createdById: createdBy(context) }, select: { id: true } })
  tools.audit({ ...(action ? { action } : {}), recordType: 'PartyTaxIdentity', recordId: id, companyId: party.companyId, after: { partyId: party.id, ...identity } })
  return id
}

export interface NewPartyRecord {
  readonly id?: string
  readonly companyId: string | null
  readonly status: 'PROSPECT' | 'ACTIVE'
  readonly fields: PartyFields
  readonly identity: TaxIdentityFields | null
  readonly addresses: readonly (AddressFields & { readonly isDefaultBillTo: boolean; readonly isDefaultShipTo: boolean })[]
  readonly contacts: readonly ContactFields[]
}

/**
 * Inserts a party with its first identity, addresses and contacts, their audit rows and the party.created event; answers
 * its id. The caller checked every rule; the duplicate check runs here (the code's uniqueness is the database's).
 */
export async function insertParty(tools: CommandTools, record: NewPartyRecord, action?: Permission): Promise<string> {
  const { tx, now, context } = tools
  const id = record.id ?? newId()
  await tx.party.create({
    data: { id, companyId: record.companyId, ...record.fields, roles: [...record.fields.roles], status: record.status, createdAt: now, updatedAt: now, createdById: createdBy(context) },
    select: { id: true },
  })
  tools.audit({ ...(action ? { action } : {}), recordType: 'Party', recordId: id, companyId: record.companyId, after: { ...record.fields, status: record.status } })
  const party = { id, companyId: record.companyId }
  if (record.identity) {
    await assertNoTaxDuplicate(tx, context, id, record.identity)
    await insertTaxIdentity(tools, party, record.identity, action)
  }
  for (const address of record.addresses) {
    const { isDefaultBillTo, isDefaultShipTo, ...fields } = address
    await insertAddress(tools, party, fields, { isDefaultBillTo, isDefaultShipTo }, action)
  }
  for (const contact of record.contacts) await insertContact(tools, party, contact, action)
  tools.emit({ type: 'party.created', subject: id, companyId: record.companyId, payload: { partyId: id, code: record.fields.code } })
  return id
}

/**
 * The first address with a use becomes its default when none is marked (a party's first invoice and delivery
 * addresses are its defaults); more than one marked is a mistake the caller reports.
 */
export function withDefaults<Address extends { readonly kinds: readonly string[]; readonly isDefaultBillTo?: boolean | undefined; readonly isDefaultShipTo?: boolean | undefined }>(
  addresses: readonly Address[],
  existing: { readonly billTo: boolean; readonly shipTo: boolean } = { billTo: false, shipTo: false },
): (Address & { isDefaultBillTo: boolean; isDefaultShipTo: boolean })[] {
  const billTo = existing.billTo || addresses.some((address) => address.isDefaultBillTo === true)
  const shipTo = existing.shipTo || addresses.some((address) => address.isDefaultShipTo === true)
  const firstBill = billTo ? -1 : addresses.findIndex((address) => address.kinds.includes('BILL_TO'))
  const firstShip = shipTo ? -1 : addresses.findIndex((address) => address.kinds.includes('SHIP_TO'))
  return addresses.map((address, index) => ({ ...address, isDefaultBillTo: address.isDefaultBillTo === true || index === firstBill, isDefaultShipTo: address.isDefaultShipTo === true || index === firstShip }))
}
