import type { Prisma } from '@nexus/factory-db'
import { DomainError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import type { ScheduleBody, TermsBody, TermsView } from '@nexus/factory-domain/sales/quote-terms/contracts'
import { deliveryTermsProblems, INCOTERM_WORDS, INCOTERMS, incotermWords, planSchedule, remainderOf, SHIP_WORDS, validityOf, type StoredAcceptanceMode } from '@nexus/factory-domain/sales/quote-terms/rules'
import { QUOTES_MANAGE } from '@nexus/factory-domain/sales/quotes/permissions'
import { command, COMMAND_SETTINGS, type CommandCaller, type CommandTools } from '../../../core/command'
import { assertDraft } from '../quotes/quotes'
import { day, decimal, officeQuote, readCurrentVersion, readLineRecords, readQuote, type QuoteRow, type Reader, type VersionRow } from '../quotes/store'

/**
 * A quote's delivery terms and delivery schedule (B-W2b-294; SAL-151 "Delivery schedule on a line", SAL-162 "Incoterms and
 * delivery terms", SAL-145 validity; design sales.quotes quote.terms.delivery and quote.terms.validity, the line drawer's
 * "Delivery schedule (W2b)"):
 *
 *   GET /sales/quotes/:quoteId/terms                              quotes.view: the current version's Incoterm and place, ship
 *                                                                 complete or as ready, the acceptance mode, the validity (its
 *                                                                 state, the reminder's day, when it expired) and each line's
 *                                                                 schedule with what is left for the promise date
 *   PUT /sales/quotes/:quoteId/terms                              quotes.manage: Incoterm (Incoterms 2020) and its place, ship
 *                                                                 complete, acceptance mode (sign, or sign and pay the deposit)
 *   PUT /sales/quotes/:quoteId/lines/:lineId/deliveries           quotes.manage: a line's whole schedule (dates, sizes, pieces)
 *
 * Writes change the DRAFT version only (W1's rule; the database's QuoteVersion_w2b5_terms and QuoteLineDelivery_guard say so
 * too) and are ONE command on the Quote: its version is the edit-conflict guard. The schedule and the terms go with a new
 * version and to the order (./carry.ts).
 */

const blank = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())
const actorIdOf = (tools: Pick<CommandTools, 'context'>): string | null => (tools.context.audience === 'office' ? tools.context.actorId : null)

export const TERMS_COLUMNS = { incoterm: true, incotermPlace: true, shipComplete: true, acceptanceMode: true, reminderSentAt: true, sentAt: true, closedAt: true } as const satisfies Prisma.QuoteVersionSelect

const sizesOf = (value: unknown): Record<string, number> | null => {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) return null
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, number] => typeof entry[1] === 'number'))
}

/** The terms read of a version (the record's Terms & delivery tab). */
export async function termsViewOf(db: Reader, quote: QuoteRow, version: VersionRow, now: Date): Promise<TermsView> {
  const today = businessDate(now)
  const extra = await db.quoteVersion.findUniqueOrThrow({ where: { id: version.id }, select: TERMS_COLUMNS })
  const lines = await readLineRecords(db, version.id)
  const deliveries = lines.length === 0 ? [] : await db.quoteLineDelivery.findMany({ where: { lineId: { in: lines.map((line) => line.id) } }, select: { id: true, lineId: true, deliveryDate: true, sizeQuantities: true, quantity: true, note: true }, orderBy: [{ deliveryDate: 'asc' }, { id: 'asc' }] })
  const styles = new Map((await db.style.findMany({ where: { id: { in: [...new Set(lines.map((line) => line.styleId))] } }, select: { id: true, code: true } })).map((row) => [row.id, row.code]))
  const colourways = new Map((await db.colourway.findMany({ where: { id: { in: [...new Set(lines.map((line) => line.colourwayId))] } }, select: { id: true, code: true } })).map((row) => [row.id, row.code]))
  const party = await db.party.findUnique({ where: { id: quote.partyId }, select: { incoterm: true } })
  const language = version.language === 'en' ? 'en' : 'it'
  const validUntil = day(version.validUntil)
  const validity = validityOf({ status: version.status, validUntil, sentOn: extra.sentAt ? businessDate(extra.sentAt) : null, reminderSentAt: extra.reminderSentAt, current: version.revision === quote.currentRevision }, today)
  return {
    quoteId: quote.id,
    versionId: version.id,
    revision: version.revision,
    status: version.status,
    editable: version.status === 'DRAFT',
    language,
    incoterm: extra.incoterm,
    incotermPlace: extra.incotermPlace,
    incotermWords: incotermWords(extra.incoterm, extra.incotermPlace, language),
    shipComplete: extra.shipComplete,
    shipWords: extra.shipComplete ? SHIP_WORDS[language].complete : SHIP_WORDS[language].asReady,
    acceptanceMode: extra.acceptanceMode as StoredAcceptanceMode,
    depositPct: decimal(version.depositPct),
    promiseDate: day(version.promiseDate),
    customerIncoterm: party?.incoterm ?? null,
    validity: {
      validUntil,
      firmOffer: version.firmOffer,
      state: validity.state,
      daysLeft: validity.daysLeft,
      reminderOn: validity.reminderOn,
      reminderSentAt: extra.reminderSentAt ? toUtcIso(extra.reminderSentAt) : null,
      expiredAt: version.status === 'EXPIRED' && extra.closedAt ? toUtcIso(extra.closedAt) : null,
    },
    lines: lines.map((line) => {
      const own = deliveries.filter((row) => row.lineId === line.id).map((row) => ({ id: row.id, deliveryDate: day(row.deliveryDate)!, sizes: sizesOf(row.sizeQuantities), quantity: row.quantity, note: row.note }))
      return {
        lineId: line.id,
        seq: line.seq,
        kind: line.kind,
        label: [styles.get(line.styleId), colourways.get(line.colourwayId)].filter(Boolean).join(' '),
        quantity: line.quantity,
        deliveries: own,
        atPromiseDate: line.kind === 'SIZE_GRID' ? remainderOf({ seq: line.seq, kind: line.kind, sizes: line.sizes }, own.map((row) => ({ sizeQuantities: row.sizes }))) : {},
      }
    }),
    quoteVersion: quote.version,
    incoterms: INCOTERMS.map((code) => ({ code, words: INCOTERM_WORDS[code][language], seaOnly: INCOTERM_WORDS[code].seaOnly })),
  }
}

/** GET /sales/quotes/:quoteId/terms */
export async function getTerms(caller: CommandCaller, quoteId: string): Promise<TermsView> {
  const quote = await officeQuote(caller, quoteId)
  return caller.withClient(async (db) => termsViewOf(db, quote, await readCurrentVersion(db, quote), COMMAND_SETTINGS.clock.now()))
}

/** A command on the quote's DRAFT version (the quote's version is the guard), answering the terms read. */
async function onDraft(caller: CommandCaller, quote: QuoteRow, spec: { readonly name: `quotes.${string}`; readonly idempotencyKey: string | undefined; readonly input: unknown; readonly version: number }, work: (tools: CommandTools, current: QuoteRow, version: VersionRow) => Promise<void>): Promise<TermsView> {
  const { result } = await command(caller, { name: spec.name, idempotencyKey: spec.idempotencyKey, input: spec.input, record: { type: 'Quote', id: quote.id, expectedVersion: spec.version } }, async (tools) => {
    const current = (await readQuote(tools.tx, quote.id))!
    const version = await readCurrentVersion(tools.tx, current)
    assertDraft(version)
    await work(tools, current, version)
    const after = (await readQuote(tools.tx, quote.id))!
    return termsViewOf(tools.tx, after, await readCurrentVersion(tools.tx, after), tools.now)
  })
  return result
}

/** PUT /sales/quotes/:quoteId/terms */
export async function saveTerms(caller: CommandCaller, quoteId: string, body: TermsBody, idempotencyKey?: string): Promise<TermsView> {
  const quote = await officeQuote(caller, quoteId, QUOTES_MANAGE)
  const fields = (['incoterm', 'incotermPlace', 'shipComplete', 'acceptanceMode'] as const).filter((field) => body[field] !== undefined)
  if (fields.length === 0) throw new ValidationError('Nothing to change.', [{ path: 'body', message: 'Send at least one of incoterm, incotermPlace, shipComplete, acceptanceMode.' }])
  return onDraft(caller, quote, { name: 'quotes.terms', idempotencyKey, input: { quoteId, ...body }, version: body.version }, async (tools, current, version) => {
    const { tx } = tools
    const before = await tx.quoteVersion.findUniqueOrThrow({ where: { id: version.id }, select: TERMS_COLUMNS })
    const incoterm = body.incoterm === undefined ? before.incoterm : blank(body.incoterm)
    const next = {
      incoterm,
      // Clearing the Incoterm clears its place (both or neither).
      incotermPlace: body.incotermPlace !== undefined ? blank(body.incotermPlace) : incoterm === null ? null : before.incotermPlace,
      shipComplete: body.shipComplete ?? before.shipComplete,
      acceptanceMode: (body.acceptanceMode ?? before.acceptanceMode) as StoredAcceptanceMode,
    }
    const issues = deliveryTermsProblems({ ...next, depositPct: decimal(version.depositPct) })
    if (issues.length > 0) throw new ValidationError(issues.length === 1 ? issues[0]!.message : 'The delivery terms cannot be saved.', issues)
    await tx.quoteVersion.update({ where: { id: version.id }, data: next, select: { id: true } })
    tools.audit({ action: 'quotes.terms', recordType: 'Quote', recordId: current.id, companyId: current.companyId, before: { versionId: version.id, incoterm: before.incoterm, incotermPlace: before.incotermPlace, shipComplete: before.shipComplete, acceptanceMode: before.acceptanceMode }, after: { versionId: version.id, ...next } })
    tools.emit({ type: 'quote.updated', subject: current.id, companyId: current.companyId, payload: { quoteId: current.id, versionId: version.id, fields: [...fields] } })
  })
}

/** PUT /sales/quotes/:quoteId/lines/:lineId/deliveries: the line's whole schedule (none: every piece at the promise date). */
export async function saveSchedule(caller: CommandCaller, quoteId: string, lineId: string, body: ScheduleBody, idempotencyKey?: string): Promise<TermsView> {
  const quote = await officeQuote(caller, quoteId, QUOTES_MANAGE)
  return onDraft(caller, quote, { name: 'quotes.schedule', idempotencyKey, input: { quoteId, lineId, ...body }, version: body.version }, async (tools, current, version) => {
    const { tx, now } = tools
    const line = (await readLineRecords(tx, version.id)).find((entry) => entry.id === lineId)
    if (!line) throw new NotFoundError('Quote line not found.')
    const { deliveries, issues } = planSchedule({ seq: line.seq, kind: line.kind, sizes: line.sizes }, body.deliveries, businessDate(now))
    if (issues.length > 0) throw new ValidationError(issues.length === 1 ? issues[0]!.message : `The delivery schedule of line ${line.seq} cannot be saved.`, issues)
    const before = await tx.quoteLineDelivery.findMany({ where: { lineId: line.id }, select: { deliveryDate: true, sizeQuantities: true, quantity: true, note: true }, orderBy: [{ deliveryDate: 'asc' }, { id: 'asc' }] })
    await tx.quoteLineDelivery.deleteMany({ where: { lineId: line.id } })
    const actorId = actorIdOf(tools)
    for (const delivery of deliveries) {
      await tx.quoteLineDelivery
        .create({ data: { id: newId(), lineId: line.id, partyId: current.partyId, deliveryDate: new Date(`${delivery.deliveryDate}T00:00:00.000Z`), ...(delivery.sizeQuantities === null ? {} : { sizeQuantities: delivery.sizeQuantities as Prisma.InputJsonValue }), quantity: delivery.quantity, note: delivery.note, createdById: actorId }, select: { id: true } })
        .catch(scheduleRefusal)
    }
    tools.audit({
      action: 'quotes.schedule',
      recordType: 'Quote',
      recordId: current.id,
      companyId: current.companyId,
      before: { versionId: version.id, lineId: line.id, seq: line.seq, deliveries: before.map((row) => ({ deliveryDate: day(row.deliveryDate), sizes: sizesOf(row.sizeQuantities), quantity: row.quantity, note: row.note })) },
      after: { versionId: version.id, lineId: line.id, seq: line.seq, deliveries },
    })
    tools.emit({ type: 'quote.lines_changed', subject: current.id, companyId: current.companyId, payload: { quoteId: current.id, versionId: version.id, change: 'changed', lineId: line.id } })
  })
}

/** The database's refusal of a schedule (…_sales_pricing_w2b_guards, a race) as a 409 in its words; anything else unchanged. */
export function scheduleRefusal(error: unknown): never {
  const cause = (error as { meta?: { driverAdapterError?: { cause?: { originalCode?: unknown; originalMessage?: unknown } } } } | null)?.meta?.driverAdapterError?.cause
  if ((cause?.originalCode === '23514' || cause?.originalCode === '23505') && typeof cause.originalMessage === 'string') {
    const words = cause.originalMessage.replace(/^sales pricing: /, '').replace(/ [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '')
    throw new DomainError('conflict', `${words.charAt(0).toUpperCase()}${words.slice(1)}.`, [{ path: 'body/deliveries', message: words }])
  }
  throw error
}
