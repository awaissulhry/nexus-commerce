import { z } from 'zod'
import type { Prisma } from '@nexus/factory-db'
import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { can, holds } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { events as emailInEvents } from '@nexus/factory-domain/email-in/events'
import { addressDomain, normalizeAddress } from '@nexus/factory-domain/email/rules'
import { INQUIRY_ADDRESS_LIMIT, inquiryAddressIn, inquiryAddressProblems } from '@nexus/factory-domain/mail-depth/rules'
import { SALES_INQUIRIES_VIEW } from '@nexus/factory-domain/sales/inquiries/permissions'
import { prospectFromMail, prospectProblems, requestFromMail } from '@nexus/factory-domain/sales/inquiries/rules'
import { SALES_SETTINGS_MANAGE } from '@nexus/factory-domain/sales/quotes/permissions'
import { QUOTE_RULE_DEFAULTS } from '@nexus/factory-domain/sales/quotes/rules'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { companyOfDomain, officeOf, replyDomainsOf, type Reader } from '../../../platform/email-in/team-inbox/store'
import { defineHandler, type EventHandler } from '../../../platform/outbox/dispatch'
import { mayWrite } from '../../product/materials/store'
import { insertInquiry, type NewInquiry } from './inquiries'
import { MAIL_COLUMNS } from './join'
import { databaseRefusal } from './store'

/**
 * Inquiries from mail by themselves (B-W2b-394; follow-up ML1:02 of B-W2b-295/-322: "mail to an inquiry address makes an
 * inquiry by itself; the triage no longer lists a mail already made into one"; SAL-033 "an email to the sales address creates an
 * inquiry"):
 *
 *   GET /sales/inquiries/addresses?companyId   the addresses whose mail makes an inquiry, in force for a company (its own sales
 *                                              settings, else the tenant's), sales.inquiries.view
 *   PUT /sales/inquiries/addresses             {companyId?, version?, addresses}: a company's own, or the tenant's (a grant over
 *                                              every company), sales.settings.manage; ONE command (audit, sales_settings.changed)
 *
 * Each address is lower case, once, at most 20, at one of the company's receiving domains (the reply domains of its sending
 * identities: mail elsewhere never reaches the factory), and is no other company's inquiry address (B-W2b-366: the database
 * does not see across rows). Empty: none — an inquiry is made from a mail by hand only, as before.
 *
 * The worker's handler `sales.inquiryFromAddress` of email.inbound_sorted: a mail to one of them that a person has not made into
 * an inquiry yet — waiting in Mail to sort (TRIAGE), or joined to its sender's own thread because the sender is a known contact
 * with a passing DMARC (MATCHED by SENDER) — becomes an inquiry of source MAIL as the tenant's system: the known customer and
 * contact when the sorting found one, else a prospect from its From line; its subject and text are what is asked; its
 * attachments stay files of the mail (named as the tech pack by a person). NEW, nobody assigned (the inquiries' queue). Mail
 * to sort no longer lists it (platform/email-in/triage.ts). A held mail (DMARC failure, spam) waits for a person as before.
 * Nothing is sent to anyone.
 */

const sortedPayload = emailInEvents[2].payload

const addressesAnswer = output({
  /** In force for the company asked (its own list, else the tenant's), lower case. */
  addresses: z.array(z.string()),
  source: z.enum(['COMPANY', 'TENANT', 'NONE']),
  /** The version of the settings row of the scope asked (null: none yet). */
  version: z.number().int().nullable(),
  hasOwnSettings: z.boolean(),
  mayManage: z.boolean(),
})
export const inquiryAddressesContract = defineContract({ querystring: input({ companyId: id().optional() }), response: { 200: addressesAnswer } })
export const saveInquiryAddressesContract = defineContract({
  body: input({ companyId: id().optional(), version: z.number().int().min(1).optional(), addresses: z.array(z.string().max(254)).max(INQUIRY_ADDRESS_LIMIT) }),
  response: { 200: addressesAnswer },
})

interface AddressRow {
  readonly id: string
  readonly companyId: string | null
  readonly inquiryAddresses: string[]
  readonly version: number
}

const ADDRESS_COLUMNS = { id: true, companyId: true, inquiryAddresses: true, version: true } as const satisfies Prisma.SalesSettingsSelect

/** The addresses in force for a company: its own row's, else the tenant-wide row's. */
function inForce(rows: readonly AddressRow[], companyId: string | null): { readonly addresses: string[]; readonly source: 'COMPANY' | 'TENANT' | 'NONE'; readonly row: AddressRow | null } {
  const own = companyId === null ? null : (rows.find((row) => row.companyId === companyId) ?? null)
  const tenant = rows.find((row) => row.companyId === null) ?? null
  if (own) return { addresses: own.inquiryAddresses, source: 'COMPANY', row: own }
  if (tenant) return { addresses: tenant.inquiryAddresses, source: 'TENANT', row: tenant }
  return { addresses: [], source: 'NONE', row: null }
}

/** GET /sales/inquiries/addresses */
export async function inquiryAddresses(caller: CommandCaller, query: { readonly companyId?: string | undefined }) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  const companyId = query.companyId ?? null
  if (companyId !== null ? !can(actor, SALES_INQUIRIES_VIEW, { companyId }) : !holds(actor, SALES_INQUIRIES_VIEW)) throw new NotFoundError('Company not found.')
  return caller.withClient(async (db) => {
    const rows = await db.salesSettings.findMany({ where: { OR: [{ companyId: null }, ...(companyId ? [{ companyId }] : [])] }, select: ADDRESS_COLUMNS })
    const found = inForce(rows, companyId)
    const own = companyId === null ? (rows.find((row) => row.companyId === null) ?? null) : (rows.find((row) => row.companyId === companyId) ?? null)
    return { addresses: found.addresses, source: found.source, version: own?.version ?? null, hasOwnSettings: own !== null, mayManage: mayWrite(actor, SALES_SETTINGS_MANAGE, companyId) }
  })
}

/** What is wrong with a list for a company (its receiving domains; no other company's address). */
async function addressProblems(db: Reader, companyId: string | null, addresses: readonly string[]): Promise<Issue[]> {
  const problems = inquiryAddressProblems(addresses)
  if (problems.length > 0) return problems
  const domains = new Set(await replyDomainsOf(db, companyId))
  const others = await db.salesSettings.findMany({ where: companyId === null ? { companyId: { not: null } } : { OR: [{ companyId: null }, { companyId: { not: companyId } }] }, select: { companyId: true, inquiryAddresses: true } })
  addresses.forEach((value, index) => {
    const address = normalizeAddress(value)
    if (!domains.has(addressDomain(address))) problems.push({ path: `body/addresses/${index}`, message: 'An address at one of the company’s receiving domains (where its mail arrives).' })
    // The tenant's own list is shared by the companies without a list of their own: only another company's row clashes.
    else if (others.some((row) => row.companyId !== null && row.inquiryAddresses.includes(address))) problems.push({ path: `body/addresses/${index}`, message: 'Another company’s inquiries come to this address.' })
  })
  return problems
}

/** PUT /sales/inquiries/addresses */
export async function saveInquiryAddresses(caller: CommandCaller, body: { readonly companyId?: string | undefined; readonly version?: number | undefined; readonly addresses: readonly string[] }, idempotencyKey?: string) {
  const context = officeOf(caller)
  const companyId = body.companyId ?? null
  if (!mayWrite(actorOf(context), SALES_SETTINGS_MANAGE, companyId)) throw new ForbiddenError(companyId === null ? 'The tenant-wide sales settings are changed only by a role over every company.' : undefined)
  const addresses = body.addresses.map(normalizeAddress)
  const id = companyId ?? context.tenantId
  const existing = await caller.withClient(async (db) => {
    if (companyId !== null && !(await db.company.findUnique({ where: { id: companyId }, select: { id: true } }))) throw new NotFoundError('Company not found.')
    const problems = await addressProblems(db, companyId, addresses)
    if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : 'The inquiry addresses cannot be saved like this.', problems)
    return db.salesSettings.findUnique({ where: { id }, select: ADDRESS_COLUMNS })
  })
  if (!existing && companyId !== null) {
    throw new ValidationError('This company follows the tenant-wide sales settings: change the tenant’s inquiry addresses, or give the company its own sales settings first.', [{ path: 'body/companyId', message: 'No sales settings of its own.' }])
  }
  if (existing && body.version === undefined) throw new ConflictError('These sales settings exist: send their version to change them.')
  if (!existing && body.version !== undefined) throw new ConflictError('These sales settings do not exist yet: save them without a version.')
  await command(caller, { name: 'sales.saveInquiryAddresses', idempotencyKey, input: { companyId, addresses }, ...(existing ? { record: { type: 'SalesSettings', id, expectedVersion: body.version } } : {}) }, async (tools) => {
    const { tx, now } = tools
    if (existing) {
      await tx.salesSettings.update({ where: { id }, data: { inquiryAddresses: addresses, updatedAt: now }, select: { id: true } })
    } else {
      // The tenant's row with the quote defaults (the rules in force without a row), then the addresses on it.
      const defaults = QUOTE_RULE_DEFAULTS
      await tx.salesSettings.create({ data: { id, companyId: null, marginFloorPct: defaults.marginFloorPct, discountLimitPct: defaults.discountLimitPct, defaultValidityDays: defaults.defaultValidityDays, defaultDepositPct: defaults.defaultDepositPct, inquiryAddresses: addresses, createdAt: now, updatedAt: now, createdById: context.actorId }, select: { id: true } })
    }
    tools.audit({ recordType: 'SalesSettings', recordId: id, companyId, before: { inquiryAddresses: existing?.inquiryAddresses ?? [] }, after: { companyId, inquiryAddresses: addresses } })
    tools.emit({ type: 'sales_settings.changed', subject: id, companyId, payload: { settingsId: id, fields: ['inquiryAddresses'] } })
    return null
  }).catch(databaseRefusal)
  return inquiryAddresses(caller, companyId === null ? {} : { companyId })
}

// ---- the worker: an inquiry from a mail to an inquiry address -------------------------------------------------------------

const AUTO_MAIL = { ...MAIL_COLUMNS, matchedBy: true } as const satisfies Prisma.InboundEmailSelect

/** The company and the customer (or prospect) of a mail to an inquiry address; null: it makes no inquiry. */
async function planOf(db: Reader, inboundEmailId: string): Promise<{ made: NewInquiry; address: string } | null> {
  const mail = await db.inboundEmail.findUnique({ where: { id: inboundEmailId }, select: AUTO_MAIL })
  if (!mail || !(mail.status === 'TRIAGE' || (mail.status === 'MATCHED' && mail.matchedBy === 'SENDER'))) return null
  if (await db.inquiry.findFirst({ where: { sourceEmailId: mail.id }, select: { id: true } })) return null
  const rows = await db.salesSettings.findMany({ select: ADDRESS_COLUMNS })
  const recipients = [...mail.envelopeTo, ...mail.to, ...mail.cc]
  let companyId = mail.companyId
  let address: string | null = null
  if (companyId !== null) address = inquiryAddressIn(recipients, inForce(rows, companyId).addresses)
  else {
    // A tenant-wide account's mail: the company whose list (or whose reply domain, for the tenant's list) names the address.
    for (const row of rows) {
      const found = inquiryAddressIn(recipients, row.inquiryAddresses)
      if (!found) continue
      address = found
      companyId = row.companyId ?? (await companyOfDomain(db, addressDomain(found)))
      break
    }
  }
  if (address === null || companyId === null) return null
  if (!(await db.numberSeries.findFirst({ where: { companyId, kind: 'INQUIRY', status: 'ACTIVE' }, select: { id: true } }))) return null
  // The customer the sorting found (a contact of theirs): a customer or brand of this company, not archived.
  const party = mail.senderPartyId && mail.senderContactId ? await db.party.findUnique({ where: { id: mail.senderPartyId }, select: { id: true, companyId: true, roles: true, status: true } }) : null
  const customer = party && (party.companyId === null || party.companyId === companyId) && party.status !== 'ARCHIVED' && party.roles.some((role) => role === 'CUSTOMER' || role === 'BRAND') ? party : null
  if (!customer && mail.status === 'MATCHED') return null
  const prospect = customer ? null : prospectFromMail(mail)
  if (prospect && prospectProblems(prospect, 'mail').length > 0) return null
  return {
    address,
    made: {
      companyId,
      source: 'MAIL',
      sourceEmailId: mail.id,
      receivedAt: mail.receivedAt,
      partyId: customer?.id ?? null,
      contactId: customer ? mail.senderContactId : null,
      prospect,
      request: requestFromMail(mail),
      wantedDate: null,
      targetUnitPrice: null,
      currency: null,
      techPackFileIds: [],
      techPackVersion: null,
      note: null,
      lines: [],
      assigneeId: null,
    },
  }
}

/** Makes the inquiry of one mail to an inquiry address (see the module comment). Answers its id, or null when none is made. */
export async function inquiryFromAddress(caller: CommandCaller, inboundEmailId: string, options: { readonly causationId?: string } = {}): Promise<string | null> {
  const plan = await caller.withClient((db) => planOf(db, inboundEmailId))
  if (!plan) return null
  const { result } = await command(caller, { name: 'sales.inquiries.fromAddress', input: { inboundEmailId }, ...(options.causationId ? { causationId: options.causationId } : {}) }, async (tools) => {
    const { tx } = tools
    await tx.$queryRaw`SELECT id FROM "InboundEmail" WHERE id = ${inboundEmailId}::uuid FOR UPDATE`
    const mail = await tx.inboundEmail.findUniqueOrThrow({ where: { id: inboundEmailId }, select: { id: true, companyId: true, status: true, matchedBy: true } })
    const made = await tx.inquiry.findFirst({ where: { sourceEmailId: inboundEmailId }, select: { id: true } })
    if (made || !(mail.status === 'TRIAGE' || (mail.status === 'MATCHED' && mail.matchedBy === 'SENDER'))) {
      tools.audit({ action: 'sales.inquiries.fromAddressSkipped', recordType: 'InboundEmail', recordId: inboundEmailId, companyId: mail.companyId, after: { status: mail.status, inquiryId: made?.id ?? null } })
      return null
    }
    const { id, number } = await insertInquiry(tools, plan.made)
    // The mail's own audit row: it became an inquiry by the address it came to (never the address in the log).
    tools.audit({ action: 'sales.inquiries.fromAddress', recordType: 'InboundEmail', recordId: inboundEmailId, companyId: mail.companyId, after: { inquiryId: id, number, partyId: plan.made.partyId, receivedAt: toUtcIso(plan.made.receivedAt) } })
    return id
  }).catch(databaseRefusal)
  return result
}

export const INQUIRY_FROM_ADDRESS_HANDLER = 'sales.inquiryFromAddress'

/** The worker's handler (background.ts W2B_394_HANDLERS). A mail made into an inquiry meanwhile by a person is left as it is. */
export function inquiryFromAddressHandler(): EventHandler {
  return defineHandler({
    name: INQUIRY_FROM_ADDRESS_HANDLER,
    events: ['email.inbound_sorted'],
    attempts: 5,
    async handle(event, tools) {
      const { inboundEmailId, status } = sortedPayload.parse(event.payload)
      if (status !== 'TRIAGE' && status !== 'MATCHED') return
      try {
        await inquiryFromAddress(tools.caller, inboundEmailId, { causationId: event.eventId })
      } catch (error) {
        // A person made it into an inquiry at the same moment (one per mail): nothing more to do.
        if (error instanceof ConflictError) return
        throw error
      }
    },
  })
}
