import type { Prisma } from '@nexus/factory-db'
import { ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { asMoney } from '@nexus/factory-domain/money/marked'
import type { ApproveBody, BulkApproveBody, EditBody, PrepareBody, ReasonBody, RemindersQuery, SendBody } from '@nexus/factory-domain/receivables/contracts'
import { stepWords, type EffectiveSettings, type LadderStep } from '@nexus/factory-domain/receivables/ladder'
import { firstOpenDueDate, instalmentsOf } from '@nexus/factory-domain/receivables/ledger'
import { RECEIVABLES_REMINDERS_APPROVE, RECEIVABLES_REMINDERS_MANAGE, RECEIVABLES_VIEW } from '@nexus/factory-domain/receivables/permissions'
import { claimLine, claimNow, HELD_REASONS, reminderByHand, type HeldReason, type OpenInvoice, type PlannedReminder } from '@nexus/factory-domain/receivables/reminders'
import { reminderLanguageOf, reminderText } from '@nexus/factory-domain/receivables/wording'
import type { CommandCaller, CommandTools } from '../../core/command'
import { actorOf, type OfficeContext, type RequestContext } from '../../core/context'
import { sendEmail } from '../../platform/email-out/outbound'
import { recordGeneratedFile, type PreparedGeneratedFile } from '../../platform/files/files'
import { cancelReminderRow, insertReminder, ladderPassInCommand } from './ladder'
import { letterPdf } from './pdf'
import {
  assertMay,
  COMPANY_REF,
  holdsPrice,
  invoiceContactsOf,
  knownReminderOf,
  lockCustomer,
  lockReminder,
  mayOn,
  officeContextOf,
  officeReminder,
  openInvoices,
  PARTY_REF,
  peopleOf,
  readReminder,
  receivablesClock,
  receivablesCommand,
  refused,
  REMINDER_COLUMNS,
  remindersOf,
  senderOf,
  settingsFor,
  tenantIdOf,
  today,
  type CustomerScope,
  type OpenInvoiceRow,
  type Reader,
  type ReminderRow,
} from './store'

/**
 * Payment reminders a person approves (B-W2a-55; FIN-110, FIN-111; design finance.receivables "Reminders to approve":
 * "Approve and send n · Skip with reason · Edit text"; W2a plan §2 Owner switch, GATE-ACCOUNTANT). Every move is ONE
 * command under the customer's advisory lock, then the reminder's row FOR UPDATE at the version the person read (409 when
 * it moved on), with its audit row and event:
 *
 *   prepare   POST /receivables/reminders (reminders.manage): by hand, from the ageing row or an order's payment schedule
 *             ("Send reminder"): the next level of the chosen open invoices, all that is open on them; one open reminder
 *             per customer and level
 *   edit      PATCH …/:id (reminders.manage): subject and text while PREPARED; another language writes it again
 *   approve   POST …/:id/approve (reminders.approve): a PERSON approves (never the ladder), with the final text; `send`
 *             sends it in the same command, refused as a whole while the company's reminders are switched off
 *   send      POST …/:id/send (reminders.approve): an APPROVED one, only while switched on (the Owner's; the database
 *             refuses SENT too): an e-mail to the customer's invoice contacts on the reminder's thread (email out, FAKE
 *             locally and in tests), a letter (its PDF stored on the reminder), or a call (what was said)
 *   skip      POST …/:id/skip (reminders.manage): with a reason; the level is not sent for its invoices
 *   cancel    POST …/:id/cancel (reminders.manage): with a reason; the ladder may prepare it again
 *   bulk      POST /receivables/reminders/approve (reminders.approve): up to 50 at once, all or none
 * An open reminder whose amount is no longer what is due (paid or credited since) is refused (CHANGED) and cancelled by
 * the ladder's next pass, which prepares it again with the open amounts.
 */

// ---- views ----------------------------------------------------------------------------------------------------------------

interface ViewContext {
  readonly context: RequestContext
  readonly companies: Map<string, { id: string; code: string; legalName: string }>
  readonly parties: Map<string, { id: string; code: string; legalName: string }>
  readonly invoices: Map<string, { id: string; number: string | null; issueDate: Date | null; grossTotal: number; paymentTerms: unknown }>
  readonly open: Map<string, OpenInvoiceRow>
  readonly settings: Map<string, EffectiveSettings>
  readonly people: Map<string, string | null>
  readonly unplaced: Set<string>
  readonly creditDrafts: Set<string>
  readonly contacts: Set<string>
  readonly emails: Map<string, { id: string; status: string; to: string[] }>
  readonly letters: Map<string, string>
}

const key = (companyId: string, partyId: string) => `${companyId}|${partyId}`
const day = (value: Date | null) => (value ? businessDate(value, 'UTC') : null)

async function viewContext(db: Reader, context: RequestContext, rows: readonly ReminderRow[]): Promise<ViewContext> {
  const companyIds = [...new Set(rows.map((row) => row.companyId))]
  const partyIds = [...new Set(rows.map((row) => row.partyId))]
  const invoiceIds = [...new Set(rows.flatMap((row) => row.invoiceIds))]
  const reminderIds = rows.map((row) => row.id)
  const companies = new Map((await db.company.findMany({ where: { id: { in: companyIds } }, select: COMPANY_REF })).map((row) => [row.id, row]))
  const parties = new Map((await db.party.findMany({ where: { id: { in: partyIds } }, select: PARTY_REF })).map((row) => [row.id, row]))
  const invoices = new Map((await db.invoice.findMany({ where: { id: { in: invoiceIds } }, select: { id: true, number: true, issueDate: true, grossTotal: true, paymentTerms: true } })).map((row) => [row.id, row]))
  const open = new Map((invoiceIds.length === 0 ? [] : await openInvoices(db, { invoiceIds })).map((row) => [row.id, row]))
  const settings = new Map<string, EffectiveSettings>()
  for (const companyId of companyIds) settings.set(companyId, await settingsFor(db, companyId))
  const people = await peopleOf(db, rows.flatMap((row) => [row.createdById, row.approvedById, row.skippedById]))
  // Money on account not allocated yet (payments received − allocations − refunds of it): "a payment being processed?"
  const received = await db.payment.groupBy({ by: ['companyId', 'partyId'], where: { status: 'RECEIVED', partyId: { in: partyIds }, companyId: { in: companyIds } }, _sum: { amount: true } })
  const allocated = await db.paymentAllocation.groupBy({ by: ['companyId', 'partyId'], where: { partyId: { in: partyIds }, companyId: { in: companyIds }, payment: { status: 'RECEIVED' } }, _sum: { amount: true } })
  const refunded = await db.refund.groupBy({ by: ['companyId', 'partyId'], where: { partyId: { in: partyIds }, companyId: { in: companyIds }, paymentId: { not: null }, status: { in: ['DUE', 'PAID'] } }, _sum: { amount: true } })
  const sumOf = (list: { companyId: string; partyId: string; _sum: { amount: number | null } }[], k: string) => list.find((entry) => key(entry.companyId, entry.partyId) === k)?._sum.amount ?? 0
  const unplaced = new Set(received.map((entry) => key(entry.companyId, entry.partyId)).filter((k) => sumOf(received, k) - sumOf(allocated, k) - sumOf(refunded, k) > 0))
  const creditDrafts = new Set((invoiceIds.length === 0 ? [] : await db.invoice.findMany({ where: { docType: 'TD04', status: 'DRAFT', creditOfId: { in: invoiceIds } }, select: { creditOfId: true } })).map((row) => row.creditOfId!))
  const contacts = new Set<string>()
  for (const partyId of partyIds) if ((await invoiceContactsOf(db, partyId)).length > 0) contacts.add(partyId)
  const mails = reminderIds.length === 0 ? [] : await db.emailOutbound.findMany({ where: { recordType: 'PaymentReminder', recordId: { in: reminderIds } }, orderBy: [{ queuedAt: 'desc' }, { id: 'desc' }], select: { id: true, recordId: true, status: true, to: true } })
  const emails = new Map<string, { id: string; status: string; to: string[] }>()
  for (const mail of mails) if (mail.recordId && !emails.has(mail.recordId)) emails.set(mail.recordId, { id: mail.id, status: mail.status, to: mail.to })
  const files = reminderIds.length === 0 ? [] : await db.storedFile.findMany({ where: { recordType: 'PaymentReminder', recordId: { in: reminderIds }, status: 'AVAILABLE' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true, recordId: true } })
  const letters = new Map<string, string>()
  for (const file of files) if (!letters.has(file.recordId)) letters.set(file.recordId, file.id)
  return { context, companies, parties, invoices, open, settings, people, unplaced, creditDrafts, contacts, emails, letters }
}

const stepOf = (settings: EffectiveSettings | undefined, level: number): LadderStep | null => settings?.ladder.find((step) => step.level === level) ?? null

function heldOf(row: ReminderRow, view: ViewContext): HeldReason[] {
  const held: HeldReason[] = []
  const settings = view.settings.get(row.companyId)
  const open = row.status === 'PREPARED' || row.status === 'APPROVED'
  if (!open) return held
  if (view.unplaced.has(key(row.companyId, row.partyId))) held.push('UNPLACED_PAYMENT')
  if (row.invoiceIds.some((id) => view.creditDrafts.has(id))) held.push('CREDIT_NOTE_DRAFT')
  if (claimNow(knownReminderOf(row), view.open, settings?.ladder ?? []) !== row.amountDue) held.push('CHANGED')
  if (row.action === 'EMAIL' && !view.contacts.has(row.partyId)) held.push('NO_CONTACT')
  if (!settings?.remindersEnabled) held.push('SWITCHED_OFF')
  return held
}

function reminderViewOf(row: ReminderRow, view: ViewContext) {
  const company = view.companies.get(row.companyId)
  const party = view.parties.get(row.partyId)
  const settings = view.settings.get(row.companyId)
  const step = stepOf(settings, row.level)
  const office = view.context.audience === 'office' ? (view.context as OfficeContext) : null
  const may = (permission: typeof RECEIVABLES_REMINDERS_MANAGE | typeof RECEIVABLES_REMINDERS_APPROVE) => office !== null && mayOn(office, permission, row)
  const person = (id: string | null) => (id ? { id, name: view.people.get(id) ?? null } : null)
  const price = holdsPrice(view.context)
  return {
    id: row.id,
    company: { id: row.companyId, code: company?.code ?? '', name: company?.legalName ?? '' },
    customer: { id: row.partyId, code: party?.code ?? '', name: party?.legalName ?? '' },
    level: row.level,
    step: step ? { offsetDays: step.offsetDays, words: { en: stepWords(step.offsetDays, 'en'), it: stepWords(step.offsetDays, 'it') } } : null,
    action: row.action,
    status: row.status,
    byHand: row.createdById !== null,
    invoices: row.invoiceIds.map((id) => {
      const invoice = view.invoices.get(id)
      const open = view.open.get(id)
      const issueDate = day(invoice?.issueDate ?? null)
      const dueDate = open ? (firstOpenDueDate(open.instalments) ?? open.instalments.at(-1)?.dueDate ?? null) : invoice && issueDate ? (instalmentsOf(invoice.paymentTerms, invoice.grossTotal, issueDate).instalments[0]?.dueDate ?? null) : null
      return { id, number: invoice?.number ?? null, issueDate, dueDate, openNow: asMoney('price', open ? open.instalments.reduce((sum, entry) => sum + entry.open, 0) : 0) }
    }),
    amountDue: asMoney('price', row.amountDue),
    interestAmount: asMoney('price', row.interestAmount),
    currency: row.currency,
    oldestDueDate: day(row.oldestDueDate)!,
    language: row.language,
    text: asMoney('price', price ? { subject: row.subject, body: row.body } : { subject: null, body: null }),
    held: heldOf(row, view).map((code) => ({ code, words: HELD_REASONS[code] })),
    preparedAt: toUtcIso(row.createdAt),
    preparedBy: person(row.createdById),
    approvedAt: row.approvedAt ? toUtcIso(row.approvedAt) : null,
    approvedBy: person(row.approvedById),
    sentAt: row.sentAt ? toUtcIso(row.sentAt) : null,
    callNote: row.callNote,
    skippedAt: row.skippedAt ? toUtcIso(row.skippedAt) : null,
    skippedBy: person(row.skippedById),
    skipReason: row.skipReason,
    cancelledAt: row.cancelledAt ? toUtcIso(row.cancelledAt) : null,
    cancelReason: row.cancelReason,
    email: view.emails.get(row.id) ?? null,
    letterFileId: view.letters.get(row.id) ?? null,
    actions: {
      edit: row.status === 'PREPARED' && may(RECEIVABLES_REMINDERS_MANAGE),
      approve: row.status === 'PREPARED' && may(RECEIVABLES_REMINDERS_APPROVE),
      send: row.status === 'APPROVED' && may(RECEIVABLES_REMINDERS_APPROVE) && settings?.remindersEnabled === true,
      skip: row.status === 'PREPARED' && may(RECEIVABLES_REMINDERS_MANAGE),
      cancel: (row.status === 'PREPARED' || row.status === 'APPROVED') && may(RECEIVABLES_REMINDERS_MANAGE),
    },
    version: row.version,
  }
}

export type ReminderViewOut = ReturnType<typeof reminderViewOf>

export async function reminderViews(db: Reader, context: RequestContext, rows: readonly ReminderRow[]): Promise<ReminderViewOut[]> {
  if (rows.length === 0) return []
  const view = await viewContext(db, context, rows)
  return rows.map((row) => reminderViewOf(row, view))
}

// ---- reads ----------------------------------------------------------------------------------------------------------------

const VIEW_STATUSES: Readonly<Record<RemindersQuery['view'], Prisma.PaymentReminderWhereInput>> = {
  toApprove: { status: 'PREPARED' },
  waiting: { status: 'APPROVED' },
  sent: { status: 'SENT' },
  closed: { status: { in: ['SKIPPED', 'CANCELLED'] } },
  all: {},
}

function scopeOf(context: OfficeContext): Prisma.PaymentReminderWhereInput {
  return scopeWhere(actorOf(context), RECEIVABLES_VIEW, { company: 'companyId', party: 'partyId' }) as Prisma.PaymentReminderWhereInput
}

async function countsIn(db: Reader, where: Prisma.PaymentReminderWhereInput) {
  const since = new Date(receivablesClock().now().getTime() - 30 * 86_400_000)
  const [toApprove, waiting, sent30Days] = [
    await db.paymentReminder.count({ where: { AND: [where, { status: 'PREPARED' }] } }),
    await db.paymentReminder.count({ where: { AND: [where, { status: 'APPROVED' }] } }),
    await db.paymentReminder.count({ where: { AND: [where, { status: 'SENT', sentAt: { gte: since } }] } }),
  ]
  return { toApprove, waiting, sent30Days }
}

/** GET /receivables/reminders (receivables.view): the reminders to approve (default) or another view, newest first. */
export async function listReminders(caller: CommandCaller, query: RemindersQuery) {
  const context = officeContextOf(caller)
  const scope = scopeOf(context)
  const filters: Prisma.PaymentReminderWhereInput = { AND: [scope, query.companyId ? { companyId: query.companyId } : {}, query.partyId ? { partyId: query.partyId } : {}, query.level ? { level: query.level } : {}] }
  return caller.withClient(async (db) => {
    const rows = await db.paymentReminder.findMany({
      where: { AND: [filters, VIEW_STATUSES[query.view]] },
      orderBy: query.view === 'toApprove' ? [{ oldestDueDate: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }] : [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      select: REMINDER_COLUMNS,
    })
    const page = rows.slice(0, query.limit)
    return { reminders: await reminderViews(db, context, page), counts: await countsIn(db, filters), nextCursor: rows.length > query.limit ? page.at(-1)!.id : null }
  })
}

/** GET /receivables/reminders/counts (receivables.view): the header's "Reminders to approve (n)". */
export async function reminderCounts(caller: CommandCaller, query: { readonly companyId?: string | undefined }) {
  const context = officeContextOf(caller)
  return caller.withClient((db) => countsIn(db, { AND: [scopeOf(context), query.companyId ? { companyId: query.companyId } : {}] }))
}

/** GET /receivables/reminders/:id (receivables.view). */
export async function getReminder(caller: CommandCaller, reminderId: string) {
  const context = officeContextOf(caller)
  const row = await officeReminder(caller, reminderId, RECEIVABLES_VIEW, RECEIVABLES_VIEW)
  return { reminder: (await caller.withClient((db) => reminderViews(db, context, [row])))[0]! }
}

async function oneView(tools: CommandTools, id: string) {
  const row = (await readReminder(tools.tx, id))!
  return (await reminderViews(tools.tx, tools.context, [row]))[0]!
}

// ---- prepare by hand ------------------------------------------------------------------------------------------------------

/** POST /receivables/reminders (reminders.manage): a reminder by hand for a customer's open invoices (see the file's comment). */
export async function prepareReminder(caller: CommandCaller, body: PrepareBody, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const scope: CustomerScope = { companyId: body.companyId, partyId: body.partyId }
  assertMay(context, RECEIVABLES_VIEW, RECEIVABLES_REMINDERS_MANAGE, scope)
  const { result } = await receivablesCommand(caller, { name: 'receivables.prepare', idempotencyKey, input: body }, async (tools) => {
    const { tx } = tools
    const day = today()
    // The ladder's pass first (stale reminders cancelled), under the customer's lock it takes.
    await ladderPassInCommand(tools, scope, { prepare: false, day })
    const settings = await settingsFor(tx, scope.companyId)
    if (settings.ladder.length === 0) throw refused('NO_LADDER')
    const open = await openInvoices(tx, { companyId: scope.companyId, partyId: scope.partyId, invoiceIds: body.invoiceIds ?? null, salesOrderId: body.salesOrderId ?? null, asOf: day })
    if (body.invoiceIds) {
      const problems: Issue[] = body.invoiceIds.flatMap((id, index) => (open.some((invoice) => invoice.id === id) ? [] : [{ path: `body/invoiceIds/${index}`, message: 'Not an open invoice (TD01 or TD24) of this customer in this company.' }]))
      if (problems.length > 0) throw new ValidationError('These invoices cannot be reminded.', problems)
    }
    if (open.length === 0) throw refused('NOTHING_OPEN')
    const currencies = [...new Set(open.map((invoice) => invoice.currency))]
    if (currencies.length > 1) throw new ValidationError('One reminder asks for one currency.', [{ path: 'body/invoiceIds', message: `Choose the invoices of one currency (${currencies.join(', ')}).` }])
    const reminders = (await remindersOf(tx, scope, open.map((invoice) => invoice.id))).map(knownReminderOf)
    const planned = reminderByHand(settings.ladder, open, reminders, day, { mode: settings.lateInterestMode, agreedPct: settings.lateInterestAgreedPct })
    if (!planned) throw refused('NOTHING_OPEN')
    const blocking = reminders.find((reminder) => (reminder.status === 'PREPARED' || reminder.status === 'APPROVED') && reminder.level === planned.level && reminder.currency === planned.currency)
    if (blocking) throw refused('OPEN_AT_LEVEL', 'reminder/OPEN_AT_LEVEL', `A reminder of this level (${planned.level}) is already waiting for this customer (${blocking.id}): approve, skip or cancel it first.`)
    const id = await insertReminder(tools, scope, planned, settings, open.find((invoice) => invoice.iban)?.iban ?? null, context.actorId)
    // Its timers follow the new coverage.
    await ladderPassInCommand(tools, scope, { prepare: false, day })
    return { reminder: await oneView(tools, id) }
  })
  return result
}

// ---- edit, skip, cancel ---------------------------------------------------------------------------------------------------

async function onReminder<Result>(caller: CommandCaller, reminderId: string, permission: typeof RECEIVABLES_REMINDERS_MANAGE | typeof RECEIVABLES_REMINDERS_APPROVE, spec: { readonly name: 'receivables.edit' | 'receivables.skip' | 'receivables.cancel' | 'receivables.approve' | 'receivables.send'; readonly idempotencyKey?: string | undefined; readonly input: unknown; readonly version: number }, work: (tools: CommandTools, row: ReminderRow) => Promise<Result>) {
  const row = await officeReminder(caller, reminderId, RECEIVABLES_VIEW, permission)
  const { result } = await receivablesCommand(caller, { name: spec.name, idempotencyKey: spec.idempotencyKey, input: { reminderId, ...(spec.input as object) } }, async (tools) => {
    await lockCustomer(tools.tx, tenantIdOf(tools.context), row)
    return work(tools, await lockReminder(tools.tx, reminderId, spec.version, 'body/version'))
  })
  return result
}

function assertPrepared(row: ReminderRow): void {
  if (row.status === 'SENT' || row.status === 'SKIPPED' || row.status === 'CANCELLED') throw refused('FINAL')
  if (row.status !== 'PREPARED') throw refused('NOT_PREPARED')
}

/** What the reminder claims on its invoices again, as on the day it was prepared (equal: not stale), with its lines. */
async function claimOf(tools: Pick<CommandTools, 'tx'>, row: ReminderRow, settings: EffectiveSettings, asOf: BusinessDate) {
  const open = await openInvoices(tools.tx, { invoiceIds: row.invoiceIds, asOf })
  const byId = new Map<string, OpenInvoice>(open.map((invoice) => [invoice.id, invoice]))
  const known = knownReminderOf(row)
  const offset = known.byHand ? null : (settings.ladder.find((step) => step.level === row.level)?.offsetDays ?? null)
  const lines = row.invoiceIds.map((id) => byId.get(id)).filter((invoice): invoice is OpenInvoice => invoice !== undefined).map((invoice) => claimLine(invoice, offset, known.preparedOn, { mode: 'NONE', agreedPct: null })).filter((line) => line !== null)
  return { claimed: claimNow(known, byId, settings.ladder), lines, offset, iban: open.find((invoice) => invoice.iban)?.iban ?? null }
}

/** PATCH /receivables/reminders/:id (reminders.manage): the text or language while it waits for approval. */
export async function editReminder(caller: CommandCaller, reminderId: string, body: EditBody, idempotencyKey?: string) {
  return onReminder(caller, reminderId, RECEIVABLES_REMINDERS_MANAGE, { name: 'receivables.edit', idempotencyKey, input: body, version: body.version }, async (tools, row) => {
    assertPrepared(row)
    let subject = body.subject ?? row.subject
    let text = body.body ?? row.body
    const language = body.language ?? row.language
    if (body.language && body.language !== row.language && (body.subject === undefined || body.body === undefined)) {
      const settings = await settingsFor(tools.tx, row.companyId)
      const claim = await claimOf(tools, row, settings, today())
      if (claim.claimed !== row.amountDue) throw refused('CHANGED')
      const step = settings.ladder.find((entry) => entry.level === row.level)
      const planned: PlannedReminder = { level: row.level, action: row.action, template: step?.template ?? null, offsetDays: claim.offset, currency: row.currency, invoiceIds: row.invoiceIds, lines: claim.lines, amountDue: row.amountDue, interestAmount: row.interestAmount, oldestDueDate: day(row.oldestDueDate)! }
      const party = await tools.tx.party.findUniqueOrThrow({ where: { id: row.partyId }, select: { legalName: true } })
      const company = await tools.tx.company.findUniqueOrThrow({ where: { id: row.companyId }, select: { legalName: true } })
      const rewritten = reminderText(planned.template, { language: reminderLanguageOf(body.language), customerName: party.legalName, companyName: company.legalName, currency: row.currency, action: row.action, offsetDays: claim.offset, lines: claim.lines, amountDue: row.amountDue, interestAmount: row.interestAmount, interestMode: settings.lateInterestMode, recoveryChargeAmount: settings.recoveryChargeAmount, iban: claim.iban })
      subject = body.subject ?? rewritten.subject
      text = body.body ?? rewritten.body
    }
    await tools.tx.paymentReminder.update({ where: { id: row.id }, data: { subject, body: text, language, version: row.version + 1, updatedAt: tools.now }, select: { id: true } })
    tools.audit({ action: 'receivables.edit', recordType: 'PaymentReminder', recordId: row.id, companyId: row.companyId, before: { language: row.language }, after: { language, subjectChanged: subject !== row.subject, bodyChanged: text !== row.body } })
    tools.emit({ type: 'payment_reminder.changed', subject: row.id, companyId: row.companyId, payload: { reminderId: row.id, partyId: row.partyId, level: row.level } })
    return { reminder: await oneView(tools, row.id) }
  })
}

/** POST /receivables/reminders/:id/skip (reminders.manage): not sent, with the reason ("promise to pay", "dispute open"). */
export async function skipReminder(caller: CommandCaller, reminderId: string, body: ReasonBody, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  return onReminder(caller, reminderId, RECEIVABLES_REMINDERS_MANAGE, { name: 'receivables.skip', idempotencyKey, input: body, version: body.version }, async (tools, row) => {
    assertPrepared(row)
    await tools.tx.paymentReminder.update({ where: { id: row.id }, data: { status: 'SKIPPED', skippedAt: tools.now, skippedById: context.actorId, skipReason: body.reason, version: row.version + 1, updatedAt: tools.now }, select: { id: true } })
    tools.audit({ action: 'receivables.skip', recordType: 'PaymentReminder', recordId: row.id, companyId: row.companyId, before: { status: row.status }, after: { status: 'SKIPPED' }, reason: body.reason })
    tools.emit({ type: 'payment_reminder.skipped', subject: row.id, companyId: row.companyId, payload: { reminderId: row.id, partyId: row.partyId, level: row.level } })
    return { reminder: await oneView(tools, row.id) }
  })
}

/** POST /receivables/reminders/:id/cancel (reminders.manage): a waiting or approved one, with the reason. */
export async function cancelReminder(caller: CommandCaller, reminderId: string, body: ReasonBody, idempotencyKey?: string) {
  return onReminder(caller, reminderId, RECEIVABLES_REMINDERS_MANAGE, { name: 'receivables.cancel', idempotencyKey, input: body, version: body.version }, async (tools, row) => {
    if (row.status !== 'PREPARED' && row.status !== 'APPROVED') throw refused('FINAL')
    await cancelReminderRow(tools, row, body.reason, false)
    return { reminder: await oneView(tools, row.id) }
  })
}

// ---- approve and send -----------------------------------------------------------------------------------------------------

interface Sendable {
  readonly callNote?: string | undefined
  /** A LETTER's PDF, put in the store before the command. */
  readonly letter?: PreparedGeneratedFile | null
}

/** Inside the command, the reminder APPROVED and locked: it goes out (see the file's comment). */
async function sendInCommand(tools: CommandTools, row: ReminderRow, context: OfficeContext, input: Sendable, path: string): Promise<void> {
  const { tx, now } = tools
  const settings = await settingsFor(tx, row.companyId)
  if (!settings.remindersEnabled) throw refused('SWITCHED_OFF', `${path}/SWITCHED_OFF`)
  const claim = await claimOf(tools, row, settings, today())
  if (claim.claimed !== row.amountDue) throw refused('CHANGED', `${path}/CHANGED`)
  let outboundId: string | null = null
  let fileId: string | null = null
  if (row.action === 'EMAIL') {
    const contacts = await invoiceContactsOf(tx, row.partyId)
    if (contacts.length === 0) throw refused('NO_CONTACT', `${path}/NO_CONTACT`)
    const sent = await sendEmail(tools, { record: { type: 'PaymentReminder', id: row.id }, sender: await senderOf(tx, context), to: contacts.map((contact) => contact.email), subject: row.subject, body: row.body ?? '', locale: row.language })
    outboundId = sent.outbound.id
  } else if (row.action === 'LETTER') {
    if (!input.letter) throw refused('NO_TEXT', `${path}/NO_TEXT`)
    fileId = (await recordGeneratedFile(tools, input.letter, { action: 'receivables.letter', details: { layout: 'REMINDER_LETTER/1', level: row.level, language: row.language } })).id
  } else if (!input.callNote) {
    throw refused('CALL_NOTE', `${path}/CALL_NOTE`)
  }
  if (row.action !== 'CALL' && input.callNote) throw refused('NOT_A_CALL', `${path}/NOT_A_CALL`)
  const current = (await readReminder(tx, row.id))!
  await tx.paymentReminder.update({ where: { id: row.id }, data: { status: 'SENT', sentAt: now, callNote: row.action === 'CALL' ? input.callNote : null, version: current.version + 1, updatedAt: now }, select: { id: true } })
  tools.audit({ action: 'receivables.send', recordType: 'PaymentReminder', recordId: row.id, companyId: row.companyId, before: { status: 'APPROVED' }, after: { status: 'SENT', action: row.action, outboundId, fileId } })
  tools.emit({ type: 'payment_reminder.sent', subject: row.id, companyId: row.companyId, payload: { reminderId: row.id, partyId: row.partyId, level: row.level, action: row.action, outboundId, fileId } })
}

/** Approves a PREPARED reminder inside the command (a person, the final text), and sends it when asked. */
async function approveInCommand(tools: CommandTools, row: ReminderRow, context: OfficeContext, input: { readonly subject?: string | undefined; readonly body?: string | undefined; readonly send: boolean } & Sendable, path: string): Promise<void> {
  assertPrepared(row)
  const settings = await settingsFor(tools.tx, row.companyId)
  if (input.send && !settings.remindersEnabled) throw refused('SWITCHED_OFF', `${path}/SWITCHED_OFF`)
  const claim = await claimOf(tools, row, settings, today())
  if (claim.claimed !== row.amountDue) throw refused('CHANGED', `${path}/CHANGED`)
  const subject = input.subject ?? row.subject
  const body = input.body ?? row.body
  if (row.action !== 'CALL' && (!subject?.trim() || !body?.trim())) throw refused('NO_TEXT', `${path}/NO_TEXT`)
  await tools.tx.paymentReminder.update({ where: { id: row.id }, data: { status: 'APPROVED', approvedAt: tools.now, approvedById: context.actorId, subject, body, version: row.version + 1, updatedAt: tools.now }, select: { id: true } })
  tools.audit({ action: 'receivables.approve', recordType: 'PaymentReminder', recordId: row.id, companyId: row.companyId, before: { status: row.status }, after: { status: 'APPROVED', textEdited: subject !== row.subject || body !== row.body, sending: input.send } })
  tools.emit({ type: 'payment_reminder.approved', subject: row.id, companyId: row.companyId, payload: { reminderId: row.id, partyId: row.partyId, level: row.level, sending: input.send } })
  if (input.send) await sendInCommand(tools, { ...row, status: 'APPROVED', subject, body }, context, input, path)
}

/** A LETTER's PDF, made and put before the command (the store is outside any transaction); checked read-only first. */
async function letterFor(caller: CommandCaller, row: ReminderRow, text: { subject: string | null; body: string | null }): Promise<PreparedGeneratedFile | null> {
  if (row.action !== 'LETTER') return null
  const settings = await caller.withClient((db) => settingsFor(db, row.companyId))
  if (!settings.remindersEnabled) throw refused('SWITCHED_OFF')
  return letterPdf(caller, row, text, settings, today())
}

/** POST /receivables/reminders/:id/approve (reminders.approve). */
export async function approveReminder(caller: CommandCaller, reminderId: string, body: ApproveBody, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const peek = await officeReminder(caller, reminderId, RECEIVABLES_VIEW, RECEIVABLES_REMINDERS_APPROVE)
  if (peek.status !== 'PREPARED') assertPrepared(peek)
  const letter = body.send ? await letterFor(caller, peek, { subject: body.subject ?? peek.subject, body: body.body ?? peek.body }) : null
  return onReminder(caller, reminderId, RECEIVABLES_REMINDERS_APPROVE, { name: 'receivables.approve', idempotencyKey, input: body, version: body.version }, async (tools, row) => {
    await approveInCommand(tools, row, context, { ...body, letter }, 'reminder')
    return { reminder: await oneView(tools, row.id) }
  })
}

/** POST /receivables/reminders/:id/send (reminders.approve): an approved reminder goes out (only while switched on). */
export async function sendReminder(caller: CommandCaller, reminderId: string, body: SendBody, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const peek = await officeReminder(caller, reminderId, RECEIVABLES_VIEW, RECEIVABLES_REMINDERS_APPROVE)
  if (peek.status !== 'APPROVED') throw refused(peek.status === 'PREPARED' ? 'NOT_APPROVED' : 'FINAL')
  const letter = await letterFor(caller, peek, peek)
  return onReminder(caller, reminderId, RECEIVABLES_REMINDERS_APPROVE, { name: 'receivables.send', idempotencyKey, input: body, version: body.version }, async (tools, row) => {
    if (row.status !== 'APPROVED') throw refused(row.status === 'PREPARED' ? 'NOT_APPROVED' : 'FINAL')
    await sendInCommand(tools, row, context, { callNote: body.callNote, letter }, 'reminder')
    return { reminder: await oneView(tools, row.id) }
  })
}

/** POST /receivables/reminders/approve (reminders.approve): up to 50 at once ("Approve and send n"), all or none. */
export async function approveMany(caller: CommandCaller, body: BulkApproveBody, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const rows: ReminderRow[] = []
  for (const item of body.items) rows.push(await officeReminder(caller, item.id, RECEIVABLES_VIEW, RECEIVABLES_REMINDERS_APPROVE))
  if (new Set(rows.map((row) => row.id)).size !== rows.length) throw new ValidationError('Each reminder once.', [{ path: 'body/items', message: 'A reminder is named twice.' }])
  const letters = new Map<string, PreparedGeneratedFile | null>()
  if (body.send) for (const row of rows) if (row.status === 'PREPARED') letters.set(row.id, await letterFor(caller, row, row))
  const { result } = await receivablesCommand(caller, { name: 'receivables.approveMany', idempotencyKey, input: body }, async (tools) => {
    const tenantId = tenantIdOf(tools.context)
    // Every customer's lock first, in one order, then the rows in id order.
    const customers = [...new Map(rows.map((row) => [`${row.companyId}|${row.partyId}`, { companyId: row.companyId, partyId: row.partyId }])).values()].sort((a, b) => a.companyId.localeCompare(b.companyId) || a.partyId.localeCompare(b.partyId))
    for (const scope of customers) await lockCustomer(tools.tx, tenantId, scope)
    const problems: Issue[] = []
    for (const [index, item] of body.items.entries()) {
      const path = `body/items/${index}`
      try {
        const row = await lockReminder(tools.tx, item.id, item.version, `${path}/version`)
        await approveInCommand(tools, row, context, { send: body.send, letter: letters.get(row.id) ?? null }, path)
      } catch (error) {
        const issues = (error as { issues?: readonly Issue[] }).issues
        if (!issues) throw error
        problems.push(...issues.map((issue) => ({ path: issue.path.startsWith(path) ? issue.path : `${path}/${issue.path.split('/').at(-1)}`, message: issue.message })))
      }
    }
    if (problems.length > 0) throw new ValidationError('None of the reminders was approved: some cannot be.', problems)
    const after = await tools.tx.paymentReminder.findMany({ where: { id: { in: rows.map((row) => row.id) } }, select: REMINDER_COLUMNS })
    const order = new Map(body.items.map((item, index) => [item.id, index]))
    return { reminders: await reminderViews(tools.tx, tools.context, after.sort((a, b) => order.get(a.id)! - order.get(b.id)!)) }
  })
  return result
}

