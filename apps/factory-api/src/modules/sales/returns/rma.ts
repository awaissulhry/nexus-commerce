import type { Prisma } from '@nexus/factory-db'
import { DomainError, InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { markMoney } from '@nexus/factory-domain/money/marked'
import { SALES_RETURNS_MANAGE } from '@nexus/factory-domain/sales/returns/permissions'
import {
  aboveSoldWords,
  BEFORE_GOODS,
  goodsDueByOf,
  isSafetyReturn,
  OPEN_RETURN_STATUSES,
  RETURN_LIMITS,
  RETURN_REASON_LIST,
  type ReturnPolicy,
  type ReturnStatus,
} from '@nexus/factory-domain/sales/returns/rules'
import { command, StaleVersionError, type CommandCaller, type CommandTools } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { allocateNumber } from '../../../platform/numbering/allocate'
import { reasonFor } from '../../../platform/reasons/service'
import { mayOn, officeOf, officeReturn } from './access'
import { policyOf } from './policy'
import { openSafetyEntries, type SafetyEntry } from './register'
import { lockSold, returnableRows, soldKeyOf, type ReturnableRow, type SoldKey } from './returnable'
import { asDay, closeWarningsFor, dayOf, LINE_COLUMNS, liveRepairsByLine, readRecordFacts, readRma, returnView, RMA_COLUMNS, type LineRow, type Reader, type ReturnView, type RmaRow } from './store'

/**
 * The RMA itself (B-W2a-43; SAL-333, SAL-335, SAL-340, SAL-362; design returns.new, rma.lines, returns.close): make it
 * from what the customer was invoiced or shipped, change what comes back before the goods arrive, its header, cancel
 * it, close it. Every write is ONE command(): the RMA row locked first (FOR UPDATE, at the version the screen read, in a
 * state that takes the change), the refusals in words before the …_sales_w2a_guards triggers would refuse the same, the
 * RMA's version bumped by every change (its lines' too), audit rows, events.
 *
 *   make     sales.returns.manage over the company and the customer: the lines resolved against what may come back
 *            (returnable.ts) under the trigger's own advisory locks; a reason of the RETURN list (its note when it asks
 *            one); the site the goods come back to (named, else the site they left from, else the company's only one);
 *            the number from the company's RETURN series; AUTHORISED at once by the maker (REQUESTED is the W2b
 *            portal's), the goods due by the return policy's days; a protective garment returned for a defect opens
 *            its PPE register entry in the same command (register.ts).
 *   lines    add, change (pieces, reason, serial, batch, description) or remove while REQUESTED or AUTHORISED (never the
 *            last line: cancel instead).
 *   header   owner, customer reference, contact, internal note while open; the deadline before the goods arrive.
 *   cancel   REQUESTED or AUTHORISED → CANCELLED with its reason (the goods never came).
 *   close    AUTHORISED, RECEIVED or INSPECTED → CLOSED with its finish reason, once every received line is decided;
 *            what the outcome still waits for (a replacement order, a return DDT) is answered as warnings.
 */

export interface NewLineBody {
  readonly invoiceLineId?: string | null | undefined
  readonly salesOrderLineId?: string | null | undefined
  readonly size?: string | null | undefined
  readonly quantity: number
  readonly reasonCode: string
  readonly reasonNote?: string | null | undefined
  readonly serial?: string | null | undefined
  readonly batchNumber?: string | null | undefined
  readonly description?: string | null | undefined
}

export interface CreateBody {
  readonly companyId: string
  readonly partyId: string
  readonly siteId?: string | null | undefined
  readonly contactId?: string | null | undefined
  readonly customerRef?: string | null | undefined
  readonly salesOrderId?: string | null | undefined
  readonly ownerId?: string | null | undefined
  readonly internalNote?: string | null | undefined
  /** The last day the goods may arrive; left out: the return policy's days from today. */
  readonly goodsDueBy?: BusinessDate | null | undefined
  readonly lines: readonly NewLineBody[]
}

const blank = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())
const tooLong = (value: string | null | undefined, max: number): boolean => (value ?? '').trim().length > max

function refuse(problems: readonly Issue[], words: string): never {
  throw new ValidationError(problems.length === 1 ? problems[0]!.message : words, problems)
}

const tenantOf = (tools: Pick<CommandTools, 'context'>): string => {
  const context = tools.context
  if (!('tenantId' in context) || !context.tenantId) throw new Error('a return command needs a tenant context')
  return context.tenantId
}

// ---- lines resolved against what may come back ----------------------------------------------------------------------

export interface PlannedLine {
  readonly key: SoldKey
  readonly row: ReturnableRow
  readonly quantity: number
  readonly reasonCode: string
  readonly reasonNote: string | null
  readonly serial: string | null
  readonly batchNumber: string | null
  readonly description: string
}

/**
 * Each line of the body resolved to a row of what may come back: the problems at `<path>/<i>/<field>` (400) and the
 * quantities above what may come back (409, "with the sold number"), never thrown.
 */
async function planLines(db: Reader, rows: readonly ReturnableRow[], lines: readonly NewLineBody[], path: string): Promise<{ planned: PlannedLine[]; problems: Issue[]; aboveSold: Issue[] }> {
  const problems: Issue[] = []
  const aboveSold: Issue[] = []
  const planned: PlannedLine[] = []
  const byKey = new Map(rows.map((row) => [soldKeyOf(row), row]))
  const seen = new Map<string, number>()
  const reasons = new Map<string, Awaited<ReturnType<typeof reasonFor>>>()
  for (const [index, line] of lines.entries()) {
    const at = (field?: string) => `${path}/${index}${field ? `/${field}` : ''}`
    let row: ReturnableRow | undefined
    if (line.invoiceLineId) {
      row = rows.find((entry) => entry.invoiceLineId === line.invoiceLineId)
      if (!row) problems.push({ path: at('invoiceLineId'), message: 'Not a line this customer was invoiced by this company.' })
      else if (line.salesOrderLineId && row.salesOrderLineId !== line.salesOrderLineId) problems.push({ path: at('salesOrderLineId'), message: 'This invoice line bills another order line.' })
    } else if (line.salesOrderLineId) {
      row = byKey.get(soldKeyOf({ invoiceLineId: null, salesOrderLineId: line.salesOrderLineId, size: blank(line.size) }))
      if (!row) {
        const invoiced = rows.find((entry) => entry.salesOrderLineId === line.salesOrderLineId && entry.size === blank(line.size) && entry.invoiceLineId)
        problems.push({ path: at('salesOrderLineId'), message: invoiced ? `These pieces are invoiced: pick the invoice line (${invoiced.invoice?.number ?? 'the invoice'}, line ${invoiced.invoice?.lineSeq}).` : 'Nothing of this order line and size shipped to the customer.' })
      }
    } else {
      problems.push({ path: at('invoiceLineId'), message: 'Pick what comes back: an invoice line, or an order line and size that shipped.' })
    }
    if (!Number.isInteger(line.quantity) || line.quantity < 1) problems.push({ path: at('quantity'), message: 'One piece or more.' })
    if (tooLong(line.reasonNote, RETURN_LIMITS.reasonNote)) problems.push({ path: at('reasonNote'), message: `At most ${RETURN_LIMITS.reasonNote} characters.` })
    if (tooLong(line.serial, RETURN_LIMITS.serial)) problems.push({ path: at('serial'), message: `At most ${RETURN_LIMITS.serial} characters.` })
    if (tooLong(line.batchNumber, RETURN_LIMITS.batchNumber)) problems.push({ path: at('batchNumber'), message: `At most ${RETURN_LIMITS.batchNumber} characters.` })
    if (tooLong(line.description, RETURN_LIMITS.description)) problems.push({ path: at('description'), message: `At most ${RETURN_LIMITS.description} characters.` })
    if (!reasons.has(line.reasonCode)) reasons.set(line.reasonCode, await reasonFor(db, RETURN_REASON_LIST, line.reasonCode))
    const reason = reasons.get(line.reasonCode)
    if (!reason || !reason.active) problems.push({ path: at('reasonCode'), message: 'Pick an active reason of the return list.' })
    else if (reason.needsDetail && !blank(line.reasonNote)) problems.push({ path: at('reasonNote'), message: `${reason.labelEn} needs a note: say what is wrong.` })
    if (!row) continue
    const key = soldKeyOf(row)
    if (seen.has(key)) {
      problems.push({ path: at(line.invoiceLineId ? 'invoiceLineId' : 'salesOrderLineId'), message: `The same as line ${seen.get(key)! + 1}: pick it once, with all its pieces.` })
      continue
    }
    seen.set(key, index)
    const words = Number.isInteger(line.quantity) && line.quantity >= 1 ? aboveSoldWords(line.quantity, row) : null
    if (words) aboveSold.push({ path: at('quantity'), message: words })
    planned.push({
      key: { invoiceLineId: row.invoiceLineId, salesOrderLineId: row.salesOrderLineId, size: row.size },
      row,
      quantity: line.quantity,
      reasonCode: line.reasonCode,
      reasonNote: blank(line.reasonNote),
      serial: blank(line.serial),
      batchNumber: blank(line.batchNumber) ?? (row.batchNumbers.length === 1 ? row.batchNumbers[0]! : null),
      description: blank(line.description) ?? row.description,
    })
  }
  const currencies = new Set(planned.map((line) => line.row.currency))
  if (currencies.size > 1) problems.push({ path, message: `One return credits in one currency: these lines were sold in ${[...currencies].join(' and ')}. Make one return per currency.` })
  return { planned, problems, aboveSold }
}

const discountOf = (value: string | null): string | null => (value === null || value === '0' || /^0(\.0+)?$/.test(value) ? null : value)

function lineData(line: PlannedLine, rma: { readonly id: string; readonly siteId: string; readonly partyId: string }, seq: number, now: Date, actorId: string): Prisma.ReturnLineUncheckedCreateInput {
  return {
    id: newId(),
    siteId: rma.siteId,
    partyId: rma.partyId,
    returnId: rma.id,
    seq,
    salesOrderLineId: line.key.salesOrderLineId,
    size: line.key.salesOrderLineId ? line.key.size : null,
    invoiceLineId: line.key.invoiceLineId,
    description: line.description,
    serial: line.serial,
    batchNumber: line.batchNumber,
    quantity: line.quantity,
    reasonCode: line.reasonCode,
    reasonNote: line.reasonNote,
    unitPrice: line.row.unitPrice,
    discountPct: discountOf(line.row.discountPct),
    createdAt: now,
    updatedAt: now,
    createdById: actorId,
  }
}

const lineAudit = (line: Pick<LineRow, 'seq' | 'invoiceLineId' | 'salesOrderLineId' | 'size' | 'quantity' | 'reasonCode' | 'reasonNote' | 'serial' | 'batchNumber' | 'description'> & { readonly unitPrice?: unknown }) => ({
  seq: line.seq,
  invoiceLineId: line.invoiceLineId,
  salesOrderLineId: line.salesOrderLineId,
  size: line.size,
  quantity: line.quantity,
  reasonCode: line.reasonCode,
  reasonNote: line.reasonNote,
  serial: line.serial,
  batchNumber: line.batchNumber,
  description: line.description,
  ...(line.unitPrice !== undefined ? { unitPrice: markMoney('price', line.unitPrice === null ? null : String(line.unitPrice)) } : {}),
})

// ---- the plan of a new RMA ------------------------------------------------------------------------------------------

interface ReturnPlan {
  readonly siteId: string
  readonly salesOrderId: string | null
  readonly contactId: string | null
  readonly ownerId: string
  readonly goodsDueBy: BusinessDate | null
  readonly policy: ReturnPolicy
  readonly lines: PlannedLine[]
  readonly warnings: Issue[]
}

async function planReturn(db: Reader, context: OfficeContext, body: CreateBody, now: Date): Promise<{ plan: ReturnPlan | null; problems: Issue[]; aboveSold: Issue[] }> {
  const today = businessDate(now)
  const problems: Issue[] = []
  const company = isUuid(body.companyId) ? await db.company.findUnique({ where: { id: body.companyId }, select: { id: true } }) : null
  if (!company) throw new NotFoundError('Company not found.')
  const party = isUuid(body.partyId) ? await db.party.findUnique({ where: { id: body.partyId }, select: { id: true, companyId: true, roles: true, status: true, legalName: true } }) : null
  if (!party || (party.companyId !== null && party.companyId !== company.id)) throw new NotFoundError('Customer not found.')
  if (!party.roles.includes('CUSTOMER') && !party.roles.includes('BRAND')) problems.push({ path: 'body/partyId', message: 'Not a customer: goods come back only from a customer.' })
  if (party.status === 'ARCHIVED') problems.push({ path: 'body/partyId', message: `${party.legalName} is archived.` })
  if (body.lines.length === 0) problems.push({ path: 'body/lines', message: 'Pick at least one line that comes back.' })
  if (body.lines.length > RETURN_LIMITS.lines) problems.push({ path: 'body/lines', message: `At most ${RETURN_LIMITS.lines} lines on one return.` })
  if (tooLong(body.customerRef, RETURN_LIMITS.customerRef)) problems.push({ path: 'body/customerRef', message: `At most ${RETURN_LIMITS.customerRef} characters.` })
  if (tooLong(body.internalNote, RETURN_LIMITS.internalNote)) problems.push({ path: 'body/internalNote', message: `At most ${RETURN_LIMITS.internalNote} characters.` })
  if (body.goodsDueBy && body.goodsDueBy < today) problems.push({ path: 'body/goodsDueBy', message: 'The deadline for the goods is today or later.' })

  const policy = await policyOf(db, company.id)
  const rows = await returnableRows(db, { companyId: company.id, partyId: party.id }, policy, now)
  const { planned, problems: lineProblems, aboveSold } = await planLines(db, rows, body.lines.slice(0, RETURN_LIMITS.lines), 'body/lines')
  problems.push(...lineProblems)

  // The site the goods come back to: named, else the one they left from, else the company's only active site.
  let siteId: string | null = null
  if (body.siteId) {
    const site = isUuid(body.siteId) ? await db.site.findUnique({ where: { id: body.siteId }, select: { id: true, companyId: true, status: true } }) : null
    if (!site || site.companyId !== company.id || site.status !== 'ACTIVE') problems.push({ path: 'body/siteId', message: 'An active site of the company.' })
    else siteId = site.id
  } else {
    siteId = planned.find((line) => line.row.siteId)?.row.siteId ?? null
    if (!siteId) {
      const sites = await db.site.findMany({ where: { companyId: company.id, status: 'ACTIVE' }, select: { id: true } })
      if (sites.length === 1) siteId = sites[0]!.id
      else problems.push({ path: 'body/siteId', message: 'Name the site the goods come back to.' })
    }
  }
  if (siteId && !mayOn(context, SALES_RETURNS_MANAGE, { companyId: company.id, siteId, partyId: party.id })) problems.push({ path: 'body/siteId', message: 'Your role does not reach this site.' })

  // The order the goods were sold on: named (of the company and the customer), else the one every line names.
  let salesOrderId: string | null = null
  if (body.salesOrderId) {
    const order = isUuid(body.salesOrderId) ? await db.salesOrder.findUnique({ where: { id: body.salesOrderId }, select: { id: true, companyId: true, partyId: true } }) : null
    if (!order || order.companyId !== company.id || order.partyId !== party.id) problems.push({ path: 'body/salesOrderId', message: 'An order of this customer and company.' })
    else salesOrderId = order.id
  } else {
    const orders = new Set(planned.map((line) => line.row.order?.id ?? null))
    if (orders.size === 1) salesOrderId = [...orders][0]!
  }
  let contactId: string | null = null
  if (body.contactId) {
    const contact = isUuid(body.contactId) ? await db.partyContact.findUnique({ where: { id: body.contactId }, select: { partyId: true, status: true } }) : null
    if (!contact || contact.partyId !== party.id || contact.status !== 'ACTIVE') problems.push({ path: 'body/contactId', message: 'An active contact of this customer.' })
    else contactId = body.contactId
  }
  const ownerId = body.ownerId ?? context.actorId
  if (body.ownerId) {
    const owner = isUuid(body.ownerId) ? await db.user.findUnique({ where: { id: body.ownerId }, select: { status: true } }) : null
    if (!owner || owner.status !== 'ACTIVE') problems.push({ path: 'body/ownerId', message: 'An active person of the office.' })
  }
  const warnings: Issue[] = []
  for (const [index, line] of planned.entries()) {
    if (line.row.warning) warnings.push({ path: `body/lines/${index}`, message: line.row.warning })
    if (isSafetyReturn({ ppe: line.row.ppe, reasonCode: line.reasonCode })) {
      warnings.push({ path: `body/lines/${index}`, message: line.row.salesOrderLineId ? 'A protective garment returned for a defect: its PPE register entry opens with the return.' : 'A protective garment returned for a defect: no shipment is known for it, so record it in Compliance › PPE register by hand.' })
    }
  }
  const goodsDueBy = body.goodsDueBy === undefined ? goodsDueByOf(today, policy) : body.goodsDueBy
  if (problems.length > 0 || !siteId) return { plan: null, problems, aboveSold }
  return { plan: { siteId, salesOrderId, contactId, ownerId, goodsDueBy, policy, lines: planned, warnings }, problems, aboveSold }
}

const aboveSoldError = (issues: readonly Issue[]): DomainError =>
  new DomainError('conflict', issues.length === 1 ? issues[0]!.message : 'Some lines take back more than was sold.', issues)

/** POST /sales/returns/preview: the RMA the body would make (its lines, problems, warnings, deadline). Writes nothing. */
export async function previewReturn(caller: CommandCaller, body: CreateBody) {
  const context = officeOf(caller)
  if (!mayOn(context, SALES_RETURNS_MANAGE, { companyId: body.companyId, partyId: body.partyId })) throw new NotFoundError('Customer not found.')
  return caller.withClient(async (client) => {
    const now = serverClock.now()
    const { plan, problems, aboveSold } = await planReturn(client, context, body, now)
    const number = await client.numberSeries.findFirst({ where: { companyId: body.companyId, kind: 'RETURN', status: 'ACTIVE' }, select: { id: true } })
    return {
      ok: plan !== null && aboveSold.length === 0 && number !== null,
      problems: [...problems, ...aboveSold, ...(number ? [] : [{ path: 'company/numbering', message: 'The company has no active RETURN number series: an administrator adds one under Numbering.' }])],
      warnings: plan?.warnings ?? [],
      goodsDueBy: plan?.goodsDueBy ?? null,
      siteId: plan?.siteId ?? null,
      salesOrderId: plan?.salesOrderId ?? null,
      lines: (plan?.lines ?? []).map((line) => ({ invoiceLineId: line.key.invoiceLineId, salesOrderLineId: line.key.salesOrderLineId, size: line.key.size, quantity: line.quantity, left: line.row.left, description: line.description, batchNumber: line.batchNumber, ppe: line.row.ppe })),
    }
  })
}

/** POST /sales/returns: the RMA, AUTHORISED, numbered, with its lines (and a PPE register entry for a safety return). */
export async function createReturn(caller: CommandCaller, body: CreateBody, idempotencyKey?: string): Promise<{ return: ReturnView; warnings: Issue[]; registerEntries: SafetyEntry[] }> {
  const context = officeOf(caller)
  if (!mayOn(context, SALES_RETURNS_MANAGE, { companyId: body.companyId, partyId: body.partyId })) throw new NotFoundError('Customer not found.')
  const { result } = await command(caller, { name: 'returns.create', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const today = businessDate(now)
    const tenantId = tenantOf(tools)
    // The trigger's advisory locks of what the lines name, first: the sums read below hold until the commit.
    await lockSold(tx, tenantId, body.lines.map((line) => ({ invoiceLineId: line.invoiceLineId ?? null, salesOrderLineId: line.salesOrderLineId ?? null, size: blank(line.size) })))
    const { plan, problems, aboveSold } = await planReturn(tx, context, body, now)
    if (problems.length > 0 || !plan) refuse(problems, 'The return cannot be made like this.')
    if (aboveSold.length > 0) throw aboveSoldError(aboveSold)
    // Lines that name an invoice line also count against its order line and size: lock those too.
    await lockSold(tx, tenantId, plan!.lines.map((line) => line.key))
    const id = newId()
    const number = await allocateNumber(tools, { companyId: body.companyId, kind: 'RETURN' }, { type: 'ReturnAuthorisation', id, date: today })
    const stamp = { createdAt: now, updatedAt: now, createdById: context.actorId }
    const rma = await tx.returnAuthorisation.create({
      data: {
        id,
        companyId: body.companyId,
        siteId: plan!.siteId,
        partyId: body.partyId,
        number: number.formatted,
        contactId: plan!.contactId,
        customerRef: blank(body.customerRef),
        salesOrderId: plan!.salesOrderId,
        status: 'AUTHORISED',
        requestedAt: now,
        authorisedAt: now,
        authorisedById: context.actorId,
        goodsDueBy: plan!.goodsDueBy ? asDay(plan!.goodsDueBy) : null,
        ownerId: plan!.ownerId,
        internalNote: blank(body.internalNote),
        ...stamp,
      },
      select: RMA_COLUMNS,
    })
    const lineIds: string[] = []
    for (const [index, line] of plan!.lines.entries()) {
      const data = lineData(line, rma, (index + 1) * 10, now, context.actorId)
      await tx.returnLine.create({ data, select: { id: true } })
      lineIds.push(data.id!)
      tools.audit({ action: 'returns.addLine', recordType: 'ReturnLine', recordId: data.id!, companyId: rma.companyId, siteId: rma.siteId, after: lineAudit({ ...line.key, seq: data.seq, quantity: line.quantity, reasonCode: line.reasonCode, reasonNote: line.reasonNote, serial: line.serial, batchNumber: line.batchNumber, description: line.description, unitPrice: line.row.unitPrice }) })
    }
    tools.audit({
      recordType: 'ReturnAuthorisation',
      recordId: id,
      companyId: rma.companyId,
      siteId: rma.siteId,
      after: { number: rma.number, partyId: rma.partyId, siteId: rma.siteId, salesOrderId: rma.salesOrderId, status: 'AUTHORISED', goodsDueBy: plan!.goodsDueBy, ownerId: rma.ownerId, contactId: rma.contactId, customerRef: rma.customerRef, lines: lineIds.length, pieces: plan!.lines.reduce((sum, line) => sum + line.quantity, 0) },
    })
    tools.emit({ type: 'return.authorised', subject: id, companyId: rma.companyId, siteId: rma.siteId, payload: { returnId: id, number: rma.number, partyId: rma.partyId, salesOrderId: rma.salesOrderId, lineIds, goodsDueBy: plan!.goodsDueBy } })
    const registerEntries = await openSafetyEntries(tools, rma, await tx.returnLine.findMany({ where: { returnId: id }, select: LINE_COLUMNS, orderBy: { seq: 'asc' } }))
    return { returnId: id, warnings: plan!.warnings, registerEntries }
  })
  return { return: await recordOf(caller, result.returnId), warnings: result.warnings, registerEntries: result.registerEntries }
}

// ---- the RMA row, locked --------------------------------------------------------------------------------------------

/**
 * command()'s record guard by hand on an RMA: its row FOR UPDATE, in one of `states` (else 409 in words: a closed one
 * would refuse even a version bump), at the version the caller read.
 */
export async function lockReturn(tools: Pick<CommandTools, 'tx'>, returnId: string, expectedVersion: number | undefined, states: readonly ReturnStatus[], doing: string): Promise<RmaRow> {
  const [locked] = await tools.tx.$queryRaw<{ version: number; status: ReturnStatus; number: string }[]>`SELECT "version", "status"::text AS "status", "number" FROM "ReturnAuthorisation" WHERE "id" = ${returnId}::uuid FOR UPDATE`
  if (!locked) throw new NotFoundError('Return not found.')
  if (!states.includes(locked.status)) throw new InvalidStateError(`Return ${locked.number} is ${locked.status.toLowerCase()}: ${doing} only while it is ${states.map((state) => state.toLowerCase()).join(' or ')}.`)
  if (expectedVersion !== undefined && locked.version !== expectedVersion) throw new StaleVersionError('ReturnAuthorisation', returnId, locked.version, expectedVersion)
  return (await readRma(tools.tx, returnId))!
}

/** Bumps the RMA's version (every change of it or its lines), with other columns when given. */
export async function touchReturn(tools: Pick<CommandTools, 'tx' | 'now'>, rma: Pick<RmaRow, 'id'>, data: Prisma.ReturnAuthorisationUncheckedUpdateInput = {}): Promise<RmaRow> {
  return tools.tx.returnAuthorisation.update({ where: { id: rma.id }, data: { ...data, updatedAt: tools.now, version: { increment: 1 } }, select: RMA_COLUMNS })
}

export async function recordOf(caller: CommandCaller, returnId: string): Promise<ReturnView> {
  return caller.withClient(async (client) => {
    const rma = await readRma(client, returnId)
    if (!rma) throw new NotFoundError('Return not found.')
    return returnView(await readRecordFacts(client, rma), serverClock.now())
  })
}

/** GET /sales/returns/:returnId */
export async function getReturn(caller: CommandCaller, returnId: string): Promise<{ return: ReturnView }> {
  const { rma } = await officeReturn(caller, returnId)
  return { return: await recordOf(caller, rma.id) }
}

// ---- lines before the goods arrive ----------------------------------------------------------------------------------

export async function addLines(caller: CommandCaller, returnId: string, body: { readonly version: number; readonly lines: readonly NewLineBody[] }, idempotencyKey?: string): Promise<{ return: ReturnView; lineIds: string[] }> {
  const { context, rma: seen } = await officeReturn(caller, returnId, SALES_RETURNS_MANAGE)
  if (body.lines.length === 0) refuse([{ path: 'body/lines', message: 'Pick at least one line.' }], 'Nothing to add.')
  const { result } = await command(caller, { name: 'returns.addLines', idempotencyKey, input: { returnId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const tenantId = tenantOf(tools)
    await lockSold(tx, tenantId, body.lines.map((line) => ({ invoiceLineId: line.invoiceLineId ?? null, salesOrderLineId: line.salesOrderLineId ?? null, size: blank(line.size) })))
    const rma = await lockReturn(tools, seen.id, body.version, BEFORE_GOODS, 'lines are added')
    const existing = await tx.returnLine.findMany({ where: { returnId: rma.id }, select: { id: true, seq: true, invoiceLineId: true, salesOrderLineId: true, size: true } })
    if (existing.length + body.lines.length > RETURN_LIMITS.lines) refuse([{ path: 'body/lines', message: `At most ${RETURN_LIMITS.lines} lines on one return.` }], 'Too many lines.')
    const policy = await policyOf(tx, rma.companyId)
    const rows = await returnableRows(tx, { companyId: rma.companyId, partyId: rma.partyId }, policy, now)
    const { planned, problems, aboveSold } = await planLines(tx, rows, body.lines, 'body/lines')
    for (const [index, line] of planned.entries()) {
      const twin = existing.find((entry) => soldKeyOf({ invoiceLineId: entry.invoiceLineId, salesOrderLineId: entry.salesOrderLineId, size: entry.size }) === soldKeyOf(line.key))
      if (twin) problems.push({ path: `body/lines/${index}`, message: `Already line ${twin.seq} of this return: change its pieces instead.` })
    }
    if (problems.length > 0) refuse(problems, 'These lines cannot be added.')
    if (aboveSold.length > 0) throw aboveSoldError(aboveSold)
    await lockSold(tx, tenantId, planned.map((line) => line.key))
    let seq = Math.max(0, ...existing.map((line) => line.seq))
    const lineIds: string[] = []
    for (const line of planned) {
      seq += 10
      const data = lineData(line, rma, seq, now, context.actorId)
      await tx.returnLine.create({ data, select: { id: true } })
      lineIds.push(data.id!)
      tools.audit({ action: 'returns.addLine', recordType: 'ReturnLine', recordId: data.id!, companyId: rma.companyId, siteId: rma.siteId, after: lineAudit({ ...line.key, seq, quantity: line.quantity, reasonCode: line.reasonCode, reasonNote: line.reasonNote, serial: line.serial, batchNumber: line.batchNumber, description: line.description, unitPrice: line.row.unitPrice }) })
    }
    await touchReturn(tools, rma)
    tools.emit({ type: 'return.lines_changed', subject: rma.id, companyId: rma.companyId, siteId: rma.siteId, payload: { returnId: rma.id, number: rma.number, change: 'ADDED', lineIds } })
    const registerEntries = await openSafetyEntries(tools, rma, await tx.returnLine.findMany({ where: { id: { in: lineIds } }, select: LINE_COLUMNS, orderBy: { seq: 'asc' } }))
    return { lineIds, registerEntries: registerEntries.length }
  })
  return { return: await recordOf(caller, seen.id), lineIds: result.lineIds }
}

export interface LineChange {
  readonly version: number
  readonly quantity?: number | undefined
  readonly reasonCode?: string | undefined
  readonly reasonNote?: string | null | undefined
  readonly serial?: string | null | undefined
  readonly batchNumber?: string | null | undefined
  readonly description?: string | undefined
}

export async function changeLine(caller: CommandCaller, returnId: string, lineId: string, body: LineChange, idempotencyKey?: string): Promise<{ return: ReturnView }> {
  const { rma: seen } = await officeReturn(caller, returnId, SALES_RETURNS_MANAGE)
  await command(caller, { name: 'returns.changeLine', idempotencyKey, input: { returnId, lineId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const tenantId = tenantOf(tools)
    const current = isUuid(lineId) ? await tx.returnLine.findFirst({ where: { id: lineId, returnId: seen.id }, select: LINE_COLUMNS }) : null
    if (!current) throw new NotFoundError('Return line not found.')
    await lockSold(tx, tenantId, [{ invoiceLineId: current.invoiceLineId, salesOrderLineId: current.salesOrderLineId, size: current.size }])
    const rma = await lockReturn(tools, seen.id, body.version, BEFORE_GOODS, 'what comes back changes')
    const problems: Issue[] = []
    const reasonCode = body.reasonCode ?? current.reasonCode
    const reasonNote = body.reasonNote === undefined ? current.reasonNote : blank(body.reasonNote)
    if (body.reasonCode !== undefined || body.reasonNote !== undefined) {
      const reason = await reasonFor(tx, RETURN_REASON_LIST, reasonCode)
      if (!reason || (!reason.active && reasonCode !== current.reasonCode)) problems.push({ path: 'body/reasonCode', message: 'Pick an active reason of the return list.' })
      else if (reason.needsDetail && !reasonNote) problems.push({ path: 'body/reasonNote', message: `${reason.labelEn} needs a note: say what is wrong.` })
    }
    if (body.quantity !== undefined && (!Number.isInteger(body.quantity) || body.quantity < 1)) problems.push({ path: 'body/quantity', message: 'One piece or more.' })
    if (body.description !== undefined && (body.description.trim() === '' || tooLong(body.description, RETURN_LIMITS.description))) problems.push({ path: 'body/description', message: `Say what comes back (at most ${RETURN_LIMITS.description} characters).` })
    if (tooLong(body.reasonNote, RETURN_LIMITS.reasonNote)) problems.push({ path: 'body/reasonNote', message: `At most ${RETURN_LIMITS.reasonNote} characters.` })
    if (tooLong(body.serial, RETURN_LIMITS.serial)) problems.push({ path: 'body/serial', message: `At most ${RETURN_LIMITS.serial} characters.` })
    if (tooLong(body.batchNumber, RETURN_LIMITS.batchNumber)) problems.push({ path: 'body/batchNumber', message: `At most ${RETURN_LIMITS.batchNumber} characters.` })
    if (problems.length > 0) refuse(problems, 'The line cannot be changed like this.')
    if (body.quantity !== undefined && body.quantity !== current.quantity) {
      const policy = await policyOf(tx, rma.companyId)
      const rows = await returnableRows(tx, { companyId: rma.companyId, partyId: rma.partyId, exceptLineIds: [current.id] }, policy, now)
      const row = rows.find((entry) => soldKeyOf(entry) === soldKeyOf({ invoiceLineId: current.invoiceLineId, salesOrderLineId: current.salesOrderLineId, size: current.size }))
      const words = row ? aboveSoldWords(body.quantity, row) : 'Nothing of it can come back any more.'
      if (words) throw aboveSoldError([{ path: 'body/quantity', message: words }])
    }
    const after = await tx.returnLine.update({
      where: { id: current.id },
      data: {
        ...(body.quantity !== undefined ? { quantity: body.quantity } : {}),
        reasonCode,
        reasonNote,
        ...(body.serial !== undefined ? { serial: blank(body.serial) } : {}),
        ...(body.batchNumber !== undefined ? { batchNumber: blank(body.batchNumber) } : {}),
        ...(body.description !== undefined ? { description: body.description.trim() } : {}),
        updatedAt: now,
        version: { increment: 1 },
      },
      select: LINE_COLUMNS,
    })
    await touchReturn(tools, rma)
    tools.audit({ action: 'returns.changeLine', recordType: 'ReturnLine', recordId: current.id, companyId: rma.companyId, siteId: rma.siteId, before: lineAudit(current), after: lineAudit(after) })
    tools.emit({ type: 'return.lines_changed', subject: rma.id, companyId: rma.companyId, siteId: rma.siteId, payload: { returnId: rma.id, number: rma.number, change: 'CHANGED', lineIds: [current.id] } })
    if (body.reasonCode !== undefined) await openSafetyEntries(tools, rma, [after])
    return { lineId: current.id }
  })
  return { return: await recordOf(caller, seen.id) }
}

export async function removeLine(caller: CommandCaller, returnId: string, lineId: string, body: { readonly version: number }, idempotencyKey?: string): Promise<{ return: ReturnView }> {
  const { rma: seen } = await officeReturn(caller, returnId, SALES_RETURNS_MANAGE)
  await command(caller, { name: 'returns.removeLine', idempotencyKey, input: { returnId, lineId, ...body } }, async (tools) => {
    const { tx } = tools
    const rma = await lockReturn(tools, seen.id, body.version, BEFORE_GOODS, 'lines are removed')
    const lines = await tx.returnLine.findMany({ where: { returnId: rma.id }, select: LINE_COLUMNS })
    const current = lines.find((line) => line.id === lineId)
    if (!current) throw new NotFoundError('Return line not found.')
    if (lines.length === 1) throw new InvalidStateError(`Line ${current.seq} is the return's only line: cancel the return instead.`)
    await tx.returnLine.delete({ where: { id: current.id }, select: { id: true } })
    await touchReturn(tools, rma)
    tools.audit({ action: 'returns.removeLine', recordType: 'ReturnLine', recordId: current.id, companyId: rma.companyId, siteId: rma.siteId, before: lineAudit(current) })
    tools.emit({ type: 'return.lines_changed', subject: rma.id, companyId: rma.companyId, siteId: rma.siteId, payload: { returnId: rma.id, number: rma.number, change: 'REMOVED', lineIds: [current.id] } })
    return { lineId: current.id }
  })
  return { return: await recordOf(caller, seen.id) }
}

// ---- the header -----------------------------------------------------------------------------------------------------

export interface HeaderChange {
  readonly version: number
  readonly customerRef?: string | null | undefined
  readonly contactId?: string | null | undefined
  readonly ownerId?: string | null | undefined
  readonly internalNote?: string | null | undefined
  readonly goodsDueBy?: BusinessDate | null | undefined
}

export async function changeHeader(caller: CommandCaller, returnId: string, body: HeaderChange, idempotencyKey?: string): Promise<{ return: ReturnView }> {
  const { rma: seen } = await officeReturn(caller, returnId, SALES_RETURNS_MANAGE)
  await command(caller, { name: 'returns.changeHeader', idempotencyKey, input: { returnId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const rma = await lockReturn(tools, seen.id, body.version, OPEN_RETURN_STATUSES, 'it changes')
    const problems: Issue[] = []
    if (tooLong(body.customerRef, RETURN_LIMITS.customerRef)) problems.push({ path: 'body/customerRef', message: `At most ${RETURN_LIMITS.customerRef} characters.` })
    if (tooLong(body.internalNote, RETURN_LIMITS.internalNote)) problems.push({ path: 'body/internalNote', message: `At most ${RETURN_LIMITS.internalNote} characters.` })
    if (body.goodsDueBy !== undefined) {
      if (!BEFORE_GOODS.includes(rma.status as ReturnStatus)) problems.push({ path: 'body/goodsDueBy', message: 'The goods arrived: the deadline no longer changes.' })
      else if (body.goodsDueBy !== null && body.goodsDueBy < businessDate(now)) problems.push({ path: 'body/goodsDueBy', message: 'The deadline for the goods is today or later.' })
    }
    if (body.contactId) {
      const contact = isUuid(body.contactId) ? await tx.partyContact.findUnique({ where: { id: body.contactId }, select: { partyId: true, status: true } }) : null
      if (!contact || contact.partyId !== rma.partyId || contact.status !== 'ACTIVE') problems.push({ path: 'body/contactId', message: 'An active contact of this customer.' })
    }
    if (body.ownerId) {
      const owner = isUuid(body.ownerId) ? await tx.user.findUnique({ where: { id: body.ownerId }, select: { status: true } }) : null
      if (!owner || owner.status !== 'ACTIVE') problems.push({ path: 'body/ownerId', message: 'An active person of the office.' })
    }
    if (problems.length > 0) refuse(problems, 'The return cannot be changed like this.')
    const data: Prisma.ReturnAuthorisationUncheckedUpdateInput = {}
    const fields: string[] = []
    const set = (field: 'customerRef' | 'contactId' | 'ownerId' | 'internalNote', value: string | null | undefined) => {
      if (value === undefined) return
      const next = field === 'customerRef' || field === 'internalNote' ? blank(value) : value
      if (next === rma[field]) return
      data[field] = next
      fields.push(field)
    }
    set('customerRef', body.customerRef)
    set('contactId', body.contactId)
    set('ownerId', body.ownerId)
    set('internalNote', body.internalNote)
    if (body.goodsDueBy !== undefined && body.goodsDueBy !== (rma.goodsDueBy ? dayOf(rma.goodsDueBy) : null)) {
      data.goodsDueBy = body.goodsDueBy === null ? null : asDay(body.goodsDueBy)
      fields.push('goodsDueBy')
    }
    const after = await touchReturn(tools, rma, data)
    const pick = (row: RmaRow) => Object.fromEntries(fields.map((field) => [field, field === 'goodsDueBy' ? (row.goodsDueBy ? dayOf(row.goodsDueBy) : null) : row[field as keyof RmaRow]]))
    tools.audit({ recordType: 'ReturnAuthorisation', recordId: rma.id, companyId: rma.companyId, siteId: rma.siteId, before: pick(rma), after: pick(after) })
    if (fields.length > 0) tools.emit({ type: 'return.changed', subject: rma.id, companyId: rma.companyId, siteId: rma.siteId, payload: { returnId: rma.id, number: rma.number, fields } })
    return { fields }
  })
  return { return: await recordOf(caller, seen.id) }
}

// ---- cancel and close -----------------------------------------------------------------------------------------------

function reasonOf(value: string | undefined, what: string): string {
  const reason = (value ?? '').trim()
  if (reason === '' || reason.length > RETURN_LIMITS.statusReason) refuse([{ path: 'body/reason', message: `Say why the return is ${what} (at most ${RETURN_LIMITS.statusReason} characters).` }], 'A reason is needed.')
  return reason
}

export async function cancelReturn(caller: CommandCaller, returnId: string, body: { readonly version: number; readonly reason: string }, idempotencyKey?: string): Promise<{ return: ReturnView }> {
  const { rma: seen } = await officeReturn(caller, returnId, SALES_RETURNS_MANAGE)
  const reason = reasonOf(body.reason, 'cancelled')
  await command(caller, { name: 'returns.cancel', idempotencyKey, input: { returnId, ...body } }, async (tools) => {
    const rma = await lockReturn(tools, seen.id, body.version, BEFORE_GOODS, 'it is cancelled (the goods arrived: close it instead)')
    await touchReturn(tools, rma, { status: 'CANCELLED', closedAt: tools.now, statusReason: reason })
    tools.audit({ recordType: 'ReturnAuthorisation', recordId: rma.id, companyId: rma.companyId, siteId: rma.siteId, before: { status: rma.status }, after: { status: 'CANCELLED', closedAt: toUtcIso(tools.now) }, reason })
    tools.emit({ type: 'return.status_changed', subject: rma.id, companyId: rma.companyId, siteId: rma.siteId, payload: { returnId: rma.id, number: rma.number, from: rma.status as ReturnStatus, to: 'CANCELLED' } })
    return { status: 'CANCELLED' }
  })
  return { return: await recordOf(caller, seen.id) }
}

export async function closeReturn(caller: CommandCaller, returnId: string, body: { readonly version: number; readonly reason: string }, idempotencyKey?: string): Promise<{ return: ReturnView; warnings: Issue[] }> {
  const { rma: seen } = await officeReturn(caller, returnId, SALES_RETURNS_MANAGE)
  const reason = reasonOf(body.reason, 'closed')
  const { result } = await command(caller, { name: 'returns.close', idempotencyKey, input: { returnId, ...body } }, async (tools) => {
    const { tx } = tools
    const rma = await lockReturn(tools, seen.id, body.version, ['AUTHORISED', 'RECEIVED', 'INSPECTED'], 'it is closed')
    const lines = await tx.returnLine.findMany({ where: { returnId: rma.id }, select: LINE_COLUMNS, orderBy: { seq: 'asc' } })
    const undecided = lines.filter((line) => line.receivedQuantity > 0 && line.disposition === null)
    if (undecided.length > 0) throw new InvalidStateError(`Decide every received line first (line${undecided.length === 1 ? '' : 's'} ${undecided.map((line) => line.seq).join(', ')}).`)
    // B-W2b-16: the same warnings the record shows before the click (factory-domain closeWarningsOf), now also the
    // lines decided Repair without a repair order for every garment received.
    const liveDdt = (await tx.ddt.count({ where: { sourceType: 'ReturnAuthorisation', sourceId: rma.id, cancellations: { none: {} } } })) > 0
    const warnings: Issue[] = closeWarningsFor(lines, await liveRepairsByLine(tx, lines.map((line) => line.id)), liveDdt).map((warning) => ({ path: warning.path, message: warning.message }))
    await touchReturn(tools, rma, { status: 'CLOSED', closedAt: tools.now, statusReason: reason })
    tools.audit({ recordType: 'ReturnAuthorisation', recordId: rma.id, companyId: rma.companyId, siteId: rma.siteId, before: { status: rma.status }, after: { status: 'CLOSED', closedAt: toUtcIso(tools.now), received: lines.reduce((sum, line) => sum + line.receivedQuantity, 0) }, reason })
    tools.emit({ type: 'return.status_changed', subject: rma.id, companyId: rma.companyId, siteId: rma.siteId, payload: { returnId: rma.id, number: rma.number, from: rma.status as ReturnStatus, to: 'CLOSED' } })
    return { warnings }
  })
  return { return: await recordOf(caller, seen.id), warnings: result.warnings }
}

