import type { Prisma } from '@nexus/factory-db'
import { ConflictError, InvalidStateError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { checkAddress, defaultProblems, type AddressFields } from '@nexus/factory-domain/parties/addresses'
import { checkContact, duplicateEmails, type ContactFields } from '@nexus/factory-domain/parties/contacts'
import type { CreatePartyBody, ListPartiesQuery, PartyRow, PartyView, UpdatePartyBody } from '@nexus/factory-domain/parties/contracts'
import { PARTIES_BLOCK, PARTIES_MANAGE, PARTIES_VIEW } from '@nexus/factory-domain/parties/permissions'
import { changeParty, newParty, partyMachine, reasonProblems, type PartyField, type PartyFields, type PartyPatch, type PartyStatus } from '@nexus/factory-domain/parties/rules'
import { checkTaxIdentity, compactTaxNumber, identityAt, type TaxIdentityFields } from '@nexus/factory-domain/parties/tax'
import { viesStanding } from '@nexus/factory-domain/parties/vies'
import { command, type CommandCaller, type CommandTx } from '../../core/command'
import { actorOf } from '../../core/context'
import { serverClock } from '../../core/time'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { afterCodeCursor, decodeCodeCursor, encodeCodeCursor } from './cursor'
import {
  ADDRESS_COLUMNS,
  assertMayWrite,
  CONTACT_COLUMNS,
  assertWritable,
  contextOf,
  dateText,
  dayOf,
  insertParty,
  isUniqueViolation,
  PARTY_COLUMNS,
  PARTY_SCOPE,
  partyFieldsOf,
  partyRowOf,
  readParty,
  readRecord,
  TAX_COLUMNS,
  taxFieldsOf,
  today,
  VIES_COLUMNS,
  viesFactsOf,
  warningsOf,
  withDefaults,
  type PartyRowData,
} from './store'

/**
 * Customers and suppliers (plan A1 §2.4 A; A2 SCR-032, SCR-033, SCR-056, SCR-057; features SAL-001, SAL-003..006,
 * SCM-001): the list, one party, its creation with its first tax identity, addresses and contacts, its edits and its
 * status moves, each through command() with its audit rows and its event. The domain (factory-domain parties/*)
 * decides what a party may be; this file adds what only the database knows: the code is free, the company exists, no
 * other party holds its tax numbers.
 */

const prefixed = (issues: readonly Issue[], at = 'body'): Issue[] => issues.map((issue) => ({ path: `${at}/${issue.path}`, message: issue.message }))
const invalid = (issues: readonly Issue[]): ValidationError => new ValidationError('The party is not valid.', issues)
const codeConflict = (code: string) => new ConflictError(`The party code ${code} is taken.`)

// ---- reads -------------------------------------------------------------------------------------------------------------

/**
 * The parties the caller may see, by code, one page at a time (SCR-032 with role=CUSTOMER,BRAND; SCR-056 with the
 * supplier roles). Each row says what the record still lacks (`attention`, `invoiceBlocked`). With `attention` the
 * filter needs every candidate's facts (its warnings are worked out here, not stored): the candidates are read whole,
 * filtered, then paged by (code, id) in that order; `count` counts the filtered rows.
 */
export async function listParties(caller: CommandCaller, query: ListPartiesQuery): Promise<{ parties: PartyRow[]; nextCursor: string | null; count: number }> {
  const context = contextOf(caller)
  const search = query.q?.trim()
  const number = search ? compactTaxNumber(search) : ''
  const statuses = query.status?.includes('ALL') ? null : ((query.status as PartyStatus[] | undefined) ?? ['PROSPECT', 'ACTIVE', 'BLOCKED'])
  const filters: Prisma.PartyWhereInput[] = [
    scopeWhere(actorOf(context), PARTIES_VIEW, PARTY_SCOPE) as Prisma.PartyWhereInput,
    statuses ? { status: { in: statuses } } : {},
    search
      ? {
          OR: [
            { code: { contains: search, mode: 'insensitive' } },
            { legalName: { contains: search, mode: 'insensitive' } },
            { tradeName: { contains: search, mode: 'insensitive' } },
            ...(number.length >= 3 ? [{ taxIdentities: { some: { OR: [{ vatNumber: { contains: number } }, { fiscalCode: { contains: number } }] } } }] : []),
          ],
        }
      : {},
    query.role ? { roles: { hasSome: query.role } } : {},
    query.country ? { country: query.country } : {},
    query.kind ? { kind: query.kind } : {},
    query.taxMode ? { taxIdentities: { some: { taxMode: query.taxMode } } } : {},
    query.companyId ? { OR: [{ companyId: query.companyId }, { companyId: null }] } : {},
  ]
  const cursor = decodeCodeCursor(query.cursor)
  const now = serverClock.now()

  if (query.attention) {
    const wanted = query.attention
    const candidates = await caller.withClient((client) => client.party.findMany({ where: { AND: filters }, select: PARTY_COLUMNS }))
    const rows = (await rowsOf(caller, candidates, now))
      .filter((row) => (wanted === 'VIES' ? row.attention.includes('VIES_NOT_PROVEN') : row.invoiceBlocked))
      .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    const after = cursor ? rows.filter((row) => row.code > cursor.code || (row.code === cursor.code && row.id > cursor.id)) : rows
    const page = after.slice(0, query.limit)
    const last = page.at(-1)
    return { parties: page, nextCursor: after.length > query.limit && last ? encodeCodeCursor(last) : null, count: rows.length }
  }

  const [rows, count] = await caller.withClient((client) =>
    Promise.all([
      client.party.findMany({ where: { AND: [...filters, afterCodeCursor(cursor)] }, select: PARTY_COLUMNS, orderBy: [{ code: 'asc' }, { id: 'asc' }], take: query.limit + 1 }),
      client.party.count({ where: { AND: filters } }),
    ]),
  )
  const page = rows.slice(0, query.limit)
  const last = page.at(-1)
  return { parties: await rowsOf(caller, page, now), nextCursor: rows.length > query.limit && last ? encodeCodeCursor(last) : null, count }
}

/** The list rows of these parties: the identity in force, its VIES standing, the city and what each still lacks. */
async function rowsOf(caller: CommandCaller, parties: readonly PartyRowData[], now: Date): Promise<PartyRow[]> {
  const ids = parties.map((row) => row.id)
  const { identities, addresses, contacts, checks } = await caller.withClient(async (client) => {
    // One query after the other on one connection (see readRecord).
    const identities = currentIdentities(await client.partyTaxIdentity.findMany({ where: { partyId: { in: ids } }, select: TAX_COLUMNS }), dayOf(now))
    const addresses = await client.partyAddress.findMany({ where: { partyId: { in: ids }, status: 'ACTIVE' }, select: ADDRESS_COLUMNS })
    const contacts = await client.partyContact.findMany({ where: { partyId: { in: ids }, status: 'ACTIVE' }, select: CONTACT_COLUMNS })
    const checks = await client.viesCheck.findMany({ where: { taxIdentityId: { in: [...identities.values()].map((row) => row.id) } }, select: VIES_COLUMNS })
    return { identities, addresses, contacts, checks }
  })
  const byParty = <Row extends { readonly partyId: string }>(rows: readonly Row[]) => {
    const map = new Map<string, Row[]>()
    for (const row of rows) map.set(row.partyId, [...(map.get(row.partyId) ?? []), row])
    return map
  }
  const addressesOf = byParty(addresses)
  const contactsOf = byParty(contacts)
  return parties.map((row) => {
    const current = identities.get(row.id) ?? null
    const standing = viesStanding(current ? taxFieldsOf(current) : null, checks.filter((check) => check.taxIdentityId === current?.id).map(viesFactsOf), now)
    const own = addressesOf.get(row.id) ?? []
    return partyRowOf(row, current, standing, own, warningsOf(row, current, standing, own, contactsOf.get(row.id) ?? []))
  })
}

function currentIdentities<Row extends { readonly partyId: string; readonly validFrom: Date }>(rows: readonly Row[], day: string): Map<string, Row> {
  const byParty = new Map<string, { row: Row; validFrom: string }[]>()
  for (const row of rows) byParty.set(row.partyId, [...(byParty.get(row.partyId) ?? []), { row, validFrom: dateText(row.validFrom) }])
  const current = new Map<string, Row>()
  for (const [partyId, entries] of byParty) {
    const found = identityAt(entries, day)
    if (found) current.set(partyId, found.row)
  }
  return current
}

/** One party with its addresses, contacts, tax identities, VIES checks and warnings (SCR-033, SCR-057). */
export async function getParty(caller: CommandCaller, partyId: string): Promise<PartyView> {
  await readParty(caller, partyId)
  return caller.withClient((client) => readRecord(client, partyId, serverClock.now()))
}

/** The record as the command left it (its answer), read inside the command. */
export const viewInTx = (tx: CommandTx, partyId: string, now: Date): Promise<PartyView> => readRecord(tx, partyId, now)

// ---- create ------------------------------------------------------------------------------------------------------------

async function codeTaken(tx: CommandTx, code: string, except?: string): Promise<boolean> {
  return (await tx.party.findFirst({ where: { code, ...(except ? { id: { not: except } } : {}) }, select: { id: true } })) !== null
}

/** Checks a new party's children; answers them normalised, or the issues. */
export function childrenOf(body: Pick<CreatePartyBody, 'taxIdentity' | 'addresses' | 'contacts'>, day: string) {
  const issues: Issue[] = []
  let identity: TaxIdentityFields | null = null
  if (body.taxIdentity) {
    const outcome = checkTaxIdentity({ ...body.taxIdentity, validFrom: body.taxIdentity.validFrom ?? day })
    if (outcome.ok) identity = outcome.identity
    else issues.push(...prefixed(outcome.issues, 'body/taxIdentity'))
  }
  const addresses: (AddressFields & { isDefaultBillTo: boolean; isDefaultShipTo: boolean })[] = []
  const given = body.addresses ?? []
  if (given.filter((address) => address.isDefaultBillTo === true).length > 1) issues.push({ path: 'body/addresses', message: 'One default invoice address.' })
  if (given.filter((address) => address.isDefaultShipTo === true).length > 1) issues.push({ path: 'body/addresses', message: 'One default delivery address.' })
  for (const [index, address] of withDefaults(given).entries()) {
    const outcome = checkAddress(address)
    const defaults = { isDefaultBillTo: address.isDefaultBillTo, isDefaultShipTo: address.isDefaultShipTo }
    if (!outcome.ok) issues.push(...prefixed(outcome.issues, `body/addresses/${index}`))
    else {
      issues.push(...prefixed(defaultProblems(outcome.address.kinds, defaults), `body/addresses/${index}`))
      addresses.push({ ...outcome.address, ...defaults })
    }
  }
  const contacts: ContactFields[] = []
  for (const [index, contact] of (body.contacts ?? []).entries()) {
    const outcome = checkContact(contact)
    if (outcome.ok) contacts.push(outcome.contact)
    else issues.push(...prefixed(outcome.issues, `body/contacts/${index}`))
  }
  for (const email of duplicateEmails(contacts)) issues.push({ path: 'body/contacts', message: `Two contacts share ${email}.` })
  return { issues, identity, addresses, contacts }
}

/** parties.create: a party with its first tax identity, addresses and contacts (SAL-001, SCM-001). */
export async function createParty(caller: CommandCaller, body: CreatePartyBody, idempotencyKey?: string): Promise<PartyView> {
  const context = contextOf(caller)
  const companyId = body.companyId ?? null
  const id = newId()
  assertMayWrite(context, PARTIES_MANAGE, { id, companyId })
  const { companyId: _company, status: _status, taxIdentity: _identity, addresses: _addresses, contacts: _contacts, ...fields } = body
  const outcome = newParty(fields)
  const children = childrenOf(body, today())
  const issues = [...(outcome.ok ? [] : prefixed(outcome.issues)), ...children.issues]
  if (issues.length > 0 || !outcome.ok) throw invalid(issues)
  const party = outcome.party

  const { result } = await command(caller, { name: 'parties.create', idempotencyKey, input: body }, async (tools) => {
    const { tx } = tools
    if (companyId !== null && !(await tx.company.findUnique({ where: { id: companyId }, select: { id: true } }))) throw invalid([{ path: 'body/companyId', message: 'No such company.' }])
    if (await codeTaken(tx, party.code)) throw codeConflict(party.code)
    await insertParty(tools, { id, companyId, status: body.status ?? 'ACTIVE', fields: party, identity: children.identity, addresses: children.addresses, contacts: children.contacts })
    return viewInTx(tx, id, tools.now)
  }).catch((error: unknown) => {
    if (isUniqueViolation(error)) throw codeConflict(party.code)
    throw error
  })
  return result
}

// ---- update ------------------------------------------------------------------------------------------------------------

/** parties.update: the fields sent (versioned, COL-078). The company, status and children have their own routes. */
export async function updateParty(caller: CommandCaller, partyId: string, body: UpdatePartyBody, idempotencyKey?: string): Promise<PartyView> {
  const context = contextOf(caller)
  const seen = await readParty(caller, partyId)
  assertMayWrite(context, PARTIES_MANAGE, seen)
  assertWritable(seen.status)
  const { version, ...patch } = body
  const preview = changeParty(partyFieldsOf(seen), patch as PartyPatch)
  if (!preview.ok) throw invalid(prefixed(preview.issues))
  if (preview.changed.length === 0) return getParty(caller, partyId)

  const { result } = await command(
    caller,
    { name: 'parties.update', idempotencyKey, input: { partyId, ...body }, record: { type: 'Party', id: partyId, expectedVersion: version } },
    async (tools) => {
      const { tx } = tools
      const row = await tx.party.findUniqueOrThrow({ where: { id: partyId }, select: PARTY_COLUMNS })
      assertWritable(row.status)
      const current = partyFieldsOf(row)
      const change = changeParty(current, patch as PartyPatch)
      if (!change.ok) throw invalid(prefixed(change.issues))
      const next = change.party
      if (change.changed.includes('code') && (await codeTaken(tx, next.code, partyId))) throw codeConflict(next.code)
      const changes = Object.fromEntries(change.changed.map((field) => [field, next[field]])) as Partial<PartyFields>
      await tx.party.update({ where: { id: partyId }, data: { ...changes, roles: changes.roles ? [...changes.roles] : undefined }, select: { id: true } })
      const before = Object.fromEntries(change.changed.map((field: PartyField) => [field, current[field]]))
      tools.audit({ recordType: 'Party', recordId: partyId, companyId: row.companyId, before, after: changes })
      tools.emit({ type: 'party.updated', subject: partyId, companyId: row.companyId, payload: { partyId, code: next.code, fields: [...change.changed] } })
      return viewInTx(tx, partyId, tools.now)
    },
  ).catch((error: unknown) => {
    if (isUniqueViolation(error)) throw new ConflictError('The party code is taken.')
    throw error
  })
  return result
}

// ---- status ------------------------------------------------------------------------------------------------------------

/** The status moves, each its own route and command: where it starts, where it ends, who may, whether a reason is needed. */
export const MOVES = {
  activate: { name: 'parties.activate', from: ['PROSPECT'], to: 'ACTIVE', permission: PARTIES_MANAGE, reason: false },
  block: { name: 'parties.block', from: ['ACTIVE'], to: 'BLOCKED', permission: PARTIES_BLOCK, reason: true },
  unblock: { name: 'parties.unblock', from: ['BLOCKED'], to: 'ACTIVE', permission: PARTIES_BLOCK, reason: false },
  archive: { name: 'parties.archive', from: ['PROSPECT', 'ACTIVE'], to: 'ARCHIVED', permission: PARTIES_MANAGE, reason: false },
  reactivate: { name: 'parties.reactivate', from: ['ARCHIVED'], to: 'ACTIVE', permission: PARTIES_MANAGE, reason: false },
} as const satisfies Record<string, { name: `parties.${string}`; from: readonly PartyStatus[]; to: PartyStatus; permission: string; reason: boolean }>
export type PartyMove = keyof typeof MOVES

const MOVE_REFUSAL: Readonly<Record<PartyMove, string>> = {
  activate: 'Only a prospect is activated.',
  block: 'Only an active party is blocked.',
  unblock: 'Only a blocked party is unblocked.',
  archive: 'A blocked party is unblocked before it is archived, so the block is never lost; an archived one is archived already.',
  reactivate: 'Only an archived party is reactivated.',
}

/** parties.activate | block | unblock | archive | reactivate (versioned); a block keeps its reason in the audit row. */
export async function moveParty(caller: CommandCaller, partyId: string, move: PartyMove, body: { version: number; reason?: string | undefined }, idempotencyKey?: string): Promise<PartyView> {
  const context = contextOf(caller)
  const spec = MOVES[move]
  const seen = await readParty(caller, partyId)
  assertMayWrite(context, spec.permission, seen)
  const problems = reasonProblems(body.reason, spec.reason)
  if (problems.length > 0) throw invalid(prefixed(problems))
  if (!(spec.from as readonly PartyStatus[]).includes(seen.status)) throw new InvalidStateError(MOVE_REFUSAL[move])
  const reason = body.reason?.trim() || undefined

  const { result } = await command(
    caller,
    { name: spec.name, idempotencyKey, input: { partyId, ...body }, record: { type: 'Party', id: partyId, expectedVersion: body.version, transition: { machine: partyMachine, to: spec.to } } },
    async (tools) => {
      const { tx, record } = tools
      const from = record!.from as PartyStatus
      if (!(spec.from as readonly PartyStatus[]).includes(from)) throw new InvalidStateError(MOVE_REFUSAL[move])
      tools.audit({ recordType: 'Party', recordId: partyId, companyId: seen.companyId, before: { status: from }, after: { status: spec.to }, ...(reason ? { reason } : {}) })
      tools.emit({ type: 'party.status_changed', subject: partyId, companyId: seen.companyId, payload: { partyId, code: seen.code, from, status: spec.to } })
      const view = await viewInTx(tx, partyId, tools.now)
      // The block's own audit row is written after this work: the answer names it from here.
      return spec.to === 'BLOCKED' ? { ...view, blocked: { reason: reason ?? null, at: toUtcIso(tools.now) } } : view
    },
  )
  return result
}

export type { PartyRowData }
