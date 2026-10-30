import type { Prisma } from '@nexus/factory-db'
import { ForbiddenError, InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere, type Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate, businessDayStart } from '@nexus/factory-domain/core/time'
import { markMoney } from '@nexus/factory-domain/money/marked'
import { PURCHASING_CLAIMS_MANAGE } from '@nexus/factory-domain/purchasing/claims/permissions'
import {
  answerProblems,
  cancelProblems,
  CLAIM_LIMITS,
  CLAIM_REASON_LIST,
  claimReasonText,
  closeProblems,
  editProblems,
  expectedCredit,
  foundAtFor,
  nextSeq,
  OPEN_CLAIM_STATUSES,
  readClaimReason,
  reasonProblems,
  type ClaimFoundAt,
  type ClaimKind,
  type ClaimOutcome,
  type ClaimRemedy,
  type ClaimStatus,
} from '@nexus/factory-domain/purchasing/claims/rules'
import { PURCHASING_VIEW } from '@nexus/factory-domain/purchasing/permissions'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { allocateNumber } from '../../../platform/numbering/allocate'
import { actorIdOf, officeContextOf, type Reader } from '../store'
import { followDiscrepancies } from './follow'
import { lineValue, linesFromDiscrepancies, linesFromLot, resolveLine, returnLineProblems, type LineInput, type ResolvedLine } from './lines'
import { CLAIM_COLUMNS, CLAIM_RECORD, claimInCommand, LINE_COLUMNS, officeClaim, readLines, type ClaimRow } from './store'
import { claimDetailOf, claimSummaries, type ClaimDetailView, type ClaimSummaryView } from './views'

/**
 * Supplier claims (B-W2a-44; SCM-134; design purchasing.claims SCR-131 "Returns & claims", the record's Claim, Goods
 * returned, Credit and Activity tabs). Office only; every write is ONE command (an existing claim's: its version bump
 * holds the row; the …_supply_w2a_guards triggers hold the same rules).
 *
 *   create   a DRAFT claim to one supplier from one site: kind RETURN (the goods go back) or CLAIM (they stay), where
 *            the problem was found, a reason of the tenant's CLAIM list (+ words), the remedy (default a credit), and
 *            its lines: typed, from the discrepancies of a receipt, or from a lot (every hide in stock, or its stock per
 *            place). The supplier, site, receipt and order follow from the lines unless named; the number comes from
 *            the company's CLAIM series; the credit asked = the lines' value (each line at its lot's cost) for a credit.
 *   change   while DRAFT: everything; after: the remedy, the credit asked (the amount agreed) and the internal note;
 *            closed or cancelled: the internal note only. Lines are added, changed and removed while DRAFT.
 *   answer   the supplier's answer to a SENT claim: ACCEPTED (its discrepancies AGREED) or REJECTED (it may be sent
 *            again with more evidence), with what it said, the remedy and the amount agreed.
 *   close    a sent, accepted or rejected claim is CLOSED with how it was settled (its discrepancies CLOSED with it);
 *            a draft is CANCELLED with a reason.
 *
 * Sending (send.ts) and the goods going back (returns.ts) are their own files.
 */

const now = (): Date => serverClock.now()
const blankToNull = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())
const refuse = (problems: readonly Issue[]) => new ValidationError(problems.length === 1 ? problems[0]!.message : 'The claim is not valid as it stands.', problems)
const conflict = (problems: readonly string[]) => new InvalidStateError(problems.join(' '))

const scopeOf = (context: OfficeContext) => scopeWhere(actorOf(context), PURCHASING_VIEW, { company: 'companyId', site: 'siteId', party: 'partyId' }) as Prisma.SupplierClaimWhereInput

/** The claim as the answers show it, read again in the command. */
export async function detailInCommand(tools: Pick<CommandTools, 'tx' | 'now'>, claimId: string): Promise<ClaimDetailView> {
  return claimDetailOf(tools.tx, await claimInCommand(tools.tx, claimId), tools.now)
}

// ---- reads -------------------------------------------------------------------------------------------------------------

export interface ListQuery {
  readonly status?: ClaimStatus | undefined
  /** Default true: the claims not settled yet; false: every state. */
  readonly open?: boolean | undefined
  readonly kind?: ClaimKind | undefined
  readonly partyId?: string | undefined
  readonly siteId?: string | undefined
  readonly lotId?: string | undefined
  readonly goodsReceiptId?: string | undefined
  readonly q?: string | undefined
  readonly cursor?: string | undefined
  readonly limit: number
}

/** purchasing.view: the claims the caller reaches, newest first (a cursor of ids). */
export async function listClaims(caller: CommandCaller, query: ListQuery): Promise<{ items: ClaimSummaryView[]; nextCursor: string | null }> {
  const context = officeContextOf(caller)
  const where: Prisma.SupplierClaimWhereInput = {
    AND: [
      scopeOf(context),
      query.status ? { status: query.status } : query.open === false ? {} : { status: { in: [...OPEN_CLAIM_STATUSES] } },
      query.kind ? { kind: query.kind } : {},
      query.partyId ? { partyId: query.partyId } : {},
      query.siteId ? { siteId: query.siteId } : {},
      query.goodsReceiptId ? { goodsReceiptId: query.goodsReceiptId } : {},
      query.lotId ? { lines: { some: { lotId: query.lotId } } } : {},
      query.q
        ? {
            OR: [
              { number: { contains: query.q, mode: 'insensitive' } },
              { reason: { contains: query.q, mode: 'insensitive' } },
              { party: { code: { contains: query.q, mode: 'insensitive' } } },
              { party: { legalName: { contains: query.q, mode: 'insensitive' } } },
              { lines: { some: { lot: { code: { contains: query.q, mode: 'insensitive' } } } } },
              { lines: { some: { item: { code: { contains: query.q, mode: 'insensitive' } } } } },
            ],
          }
        : {},
      query.cursor ? { id: { lt: query.cursor } } : {},
    ],
  }
  return caller.withClient(async (client) => {
    const rows = await client.supplierClaim.findMany({ where, orderBy: { id: 'desc' }, take: query.limit + 1, select: CLAIM_COLUMNS })
    const page = rows.slice(0, query.limit)
    return { items: await claimSummaries(client, page, now()), nextCursor: rows.length > query.limit ? page[page.length - 1]!.id : null }
  })
}

/** purchasing.view: the tiles — open, waiting for the supplier, credit expected (accepted for a credit), closed this month. */
export async function claimCounts(caller: CommandCaller, query: { readonly siteId?: string | undefined; readonly partyId?: string | undefined }) {
  const context = officeContextOf(caller)
  const at = now()
  const monthStart = businessDayStart(`${businessDate(at).slice(0, 7)}-01`)
  const base: Prisma.SupplierClaimWhereInput[] = [scopeOf(context), query.siteId ? { siteId: query.siteId } : {}, query.partyId ? { partyId: query.partyId } : {}]
  return caller.withClient(async (client) => {
    const open = await client.supplierClaim.count({ where: { AND: [...base, { status: { in: [...OPEN_CLAIM_STATUSES] } }] } })
    const waitingForSupplier = await client.supplierClaim.count({ where: { AND: [...base, { status: 'SENT' }] } })
    const creditExpected = await client.supplierClaim.count({ where: { AND: [...base, { status: 'ACCEPTED', remedy: 'CREDIT' }] } })
    const closedThisMonth = await client.supplierClaim.count({ where: { AND: [...base, { status: 'CLOSED', closedAt: { gte: monthStart } }] } })
    return { open, waitingForSupplier, creditExpected, closedThisMonth }
  })
}

/** purchasing.view: one claim with its lines, the goods that went back, its DDTs, its credit and what may be done now. */
export async function getClaim(caller: CommandCaller, claimId: string): Promise<{ claim: ClaimDetailView }> {
  const { claim } = await officeClaim(caller, claimId)
  return { claim: await caller.withClient((client) => claimDetailOf(client, claim, now())) }
}

// ---- create ------------------------------------------------------------------------------------------------------------

export interface ClaimFrom {
  readonly discrepancyIds?: readonly string[] | undefined
  readonly lotId?: string | undefined
  readonly hideIds?: readonly string[] | undefined
}

export interface CreateInput {
  readonly kind: ClaimKind
  readonly partyId?: string | undefined
  readonly siteId?: string | undefined
  readonly goodsReceiptId?: string | null | undefined
  readonly purchaseOrderId?: string | null | undefined
  readonly foundAt?: ClaimFoundAt | undefined
  readonly reasonCode: string
  readonly reasonNote?: string | null | undefined
  /** Default a credit; null: not chosen yet (it must be before the claim is sent). */
  readonly remedy?: ClaimRemedy | null | undefined
  readonly internalNote?: string | null | undefined
  /** Lines made from a receipt's discrepancies, or from a lot (before the typed lines). */
  readonly from?: ClaimFrom | undefined
  readonly lines?: readonly LineInput[] | undefined
}

export type ClaimSource = 'OFFICE' | 'DISCREPANCIES' | 'LOT' | 'RETURN'

/** The CLAIM reason checked against the tenant's list. */
async function reasonOf(db: Reader, code: string, note: string | null | undefined, prefix = 'body'): Promise<string> {
  const row = await db.reasonCode.findFirst({ where: { list: CLAIM_REASON_LIST, code }, select: { active: true, needsDetail: true } })
  const problems = reasonProblems(row, code, note, prefix)
  if (problems.length > 0) throw refuse(problems)
  return claimReasonText(code, note)
}

/** The goods receipt a claim names: of its supplier and site (and of its order, when both). */
async function receiptOf(db: Reader, receiptId: string, header: { partyId: string; siteId: string }, path: string) {
  const receipt = isUuid(receiptId) ? await db.goodsReceipt.findUnique({ where: { id: receiptId }, select: { id: true, siteId: true, supplierId: true, purchaseOrderId: true, number: true } }) : null
  if (!receipt || receipt.siteId !== header.siteId || receipt.supplierId !== header.partyId) throw refuse([{ path, message: "Not a goods receipt of the claim's supplier at its site." }])
  return receipt
}

async function orderOf(db: Reader, orderId: string, header: { partyId: string; siteId: string }, path: string) {
  const order = isUuid(orderId) ? await db.purchaseOrder.findUnique({ where: { id: orderId }, select: { id: true, siteId: true, partyId: true } }) : null
  if (!order || order.siteId !== header.siteId || order.partyId !== header.partyId) throw refuse([{ path, message: "Not a purchase order of the claim's supplier for its site." }])
  return order
}

export interface ResolvedClaim {
  readonly kind: ClaimKind
  readonly companyId: string
  readonly siteId: string
  readonly partyId: string
  readonly partyCode: string
  readonly currency: string
  readonly goodsReceiptId: string | null
  readonly purchaseOrderId: string | null
  readonly foundAt: ClaimFoundAt
  readonly reason: string
  readonly remedy: ClaimRemedy | null
  readonly lines: readonly ResolvedLine[]
  readonly source: ClaimSource
}

const SUPPLYING_ROLES = ['SUPPLIER', 'SUBCONTRACTOR', 'BRAND']

/** The lines a claim gets from its source (discrepancies, a lot) and typed, resolved in the caller's scope. */
export async function resolveClaimLines(tx: CommandTools['tx'], input: { readonly from?: ClaimFrom | undefined; readonly lines?: readonly LineInput[] | undefined }): Promise<ResolvedLine[]> {
  const inputs: { input: LineInput; at: string }[] = []
  if (input.from?.discrepancyIds && input.from.discrepancyIds.length > 0) {
    for (const [index, line] of (await linesFromDiscrepancies(tx, input.from.discrepancyIds)).entries()) inputs.push({ input: line, at: `body/from/discrepancyIds/${index}` })
  }
  if (input.from?.lotId) {
    for (const line of await linesFromLot(tx, input.from.lotId, input.from.hideIds)) inputs.push({ input: line, at: 'body/from' })
  }
  for (const [index, line] of (input.lines ?? []).entries()) inputs.push({ input: line, at: `body/lines/${index}` })
  if (inputs.length > CLAIM_LIMITS.lines) throw refuse([{ path: 'body/lines', message: `A claim has at most ${CLAIM_LIMITS.lines} lines.` }])
  const lines: ResolvedLine[] = []
  for (const { input: line, at } of inputs) lines.push(await resolveLine(tx, line, at))
  return lines
}

/** Every line's goods are at the claim's site and came from its supplier (one claim per site and supplier). */
function assertLinesAgree(lines: readonly ResolvedLine[], header: { readonly siteId: string; readonly partyId: string }): void {
  for (const line of lines) {
    if (line.siteId !== null && line.siteId !== header.siteId) throw refuse([{ path: line.at, message: "This line's goods are at another site: make one claim per site." }])
    if (line.partyId !== null && line.partyId !== header.partyId) throw refuse([{ path: line.at, message: "This line's goods came from another supplier: make one claim per supplier." }])
  }
}

/**
 * The claim's header and lines resolved in the command's transaction (the caller's scope): the lines from their source,
 * then the supplier, site, receipt and order from the lines unless named; every line agrees with them.
 */
export async function resolveClaim(tools: Pick<CommandTools, 'tx'>, input: CreateInput, source: ClaimSource): Promise<ResolvedClaim> {
  const { tx } = tools
  const lines = await resolveClaimLines(tx, input)
  const siteId = input.siteId ?? lines.find((line) => line.siteId !== null)?.siteId ?? null
  const partyId = input.partyId ?? lines.find((line) => line.partyId !== null)?.partyId ?? null
  if (!siteId) throw refuse([{ path: 'body/siteId', message: 'Name the site the goods are at.' }])
  if (!partyId) throw refuse([{ path: 'body/partyId', message: 'Name the supplier: no line says who delivered its goods.' }])
  assertLinesAgree(lines, { siteId, partyId })

  const site = isUuid(siteId) ? await tx.site.findUnique({ where: { id: siteId }, select: { id: true, companyId: true } }) : null
  if (!site) throw refuse([{ path: 'body/siteId', message: 'Not a site you can see.' }])
  const party = isUuid(partyId) ? await tx.party.findUnique({ where: { id: partyId }, select: { id: true, code: true, companyId: true, roles: true } }) : null
  if (!party || (party.companyId !== null && party.companyId !== site.companyId)) throw refuse([{ path: 'body/partyId', message: "Not a supplier of the site's company." }])
  if (!party.roles.some((role) => SUPPLYING_ROLES.includes(role))) throw refuse([{ path: 'body/partyId', message: 'The party supplies nothing to us: give it the SUPPLIER role first.' }])
  const company = await tx.company.findUnique({ where: { id: site.companyId }, select: { currency: true } })

  // The receipt: named, else the one every line came on; the order: named, else the receipt's.
  const header = { partyId: party.id, siteId: site.id }
  const receiptIds = [...new Set(lines.map((line) => line.receiptId))]
  const goodsReceiptId = input.goodsReceiptId !== undefined ? input.goodsReceiptId : receiptIds.length === 1 ? (receiptIds[0] ?? null) : null
  const receipt = goodsReceiptId ? await receiptOf(tx, goodsReceiptId, header, 'body/goodsReceiptId') : null
  const purchaseOrderId = input.purchaseOrderId !== undefined ? input.purchaseOrderId : (receipt?.purchaseOrderId ?? null)
  if (purchaseOrderId) {
    await orderOf(tx, purchaseOrderId, header, 'body/purchaseOrderId')
    if (receipt?.purchaseOrderId && receipt.purchaseOrderId !== purchaseOrderId) throw refuse([{ path: 'body/purchaseOrderId', message: `Receipt ${receipt.number} came on another purchase order.` }])
  }
  const kind = input.kind
  const problems = returnLineProblems(kind, lines)
  if (problems.length > 0) throw refuse(problems)
  return {
    kind,
    companyId: site.companyId,
    siteId: site.id,
    partyId: party.id,
    partyCode: party.code,
    currency: company?.currency ?? 'EUR',
    goodsReceiptId,
    purchaseOrderId,
    foundAt: input.foundAt ?? (input.from?.discrepancyIds?.length ? 'RECEIPT' : foundAtFor(lines.find((line) => line.lotStatus !== null)?.lotStatus ?? null)),
    reason: await reasonOf(tx, input.reasonCode, input.reasonNote),
    remedy: input.remedy !== undefined ? input.remedy : 'CREDIT',
    lines,
    source,
  }
}

/** The caller may do every one of `permissions` over the claim's company, site and supplier (403 in words otherwise). */
export function assertMayAll(context: OfficeContext, permissions: readonly Permission[], scope: { companyId: string; siteId: string; partyId: string }): void {
  const missing = permissions.filter((permission) => !can(actorOf(context), permission, scope))
  if (!can(actorOf(context), PURCHASING_VIEW, scope)) throw new ForbiddenError('You do not see the claims of this supplier at this site.')
  if (missing.length > 0) throw new ForbiddenError(`This needs ${missing.join(' and ')} over the supplier at this site.`)
}

/** Writes the resolved claim (DRAFT) and its lines in the caller's command: its number from the company's CLAIM series. */
export async function createClaimInCommand(tools: CommandTools, claim: ResolvedClaim, extra: { readonly internalNote?: string | null | undefined } = {}): Promise<{ id: string; number: string; lineIds: string[] }> {
  const { tx } = tools
  const id = newId()
  const number = await allocateNumber(tools, { companyId: claim.companyId, kind: 'CLAIM' }, { type: CLAIM_RECORD, id })
  const values = claim.lines.map((line) => lineValue(line, claim.currency))
  const expected = expectedCredit(claim.remedy, values)
  await tx.supplierClaim.create({
    data: {
      id,
      companyId: claim.companyId,
      siteId: claim.siteId,
      number: number.formatted,
      partyId: claim.partyId,
      kind: claim.kind,
      goodsReceiptId: claim.goodsReceiptId,
      purchaseOrderId: claim.purchaseOrderId,
      foundAt: claim.foundAt,
      reason: claim.reason,
      remedy: claim.remedy,
      currency: claim.currency,
      expectedCreditAmount: expected,
      internalNote: blankToNull(extra.internalNote),
      createdAt: tools.now,
      updatedAt: tools.now,
      createdById: actorIdOf(tools),
    },
    select: { id: true },
  })
  const lineIds = await insertLines(tools, { id, siteId: claim.siteId, partyId: claim.partyId, currency: claim.currency }, claim.lines, [])
  tools.audit({
    recordType: CLAIM_RECORD,
    recordId: id,
    companyId: claim.companyId,
    siteId: claim.siteId,
    after: {
      number: number.formatted,
      kind: claim.kind,
      partyId: claim.partyId,
      goodsReceiptId: claim.goodsReceiptId,
      purchaseOrderId: claim.purchaseOrderId,
      foundAt: claim.foundAt,
      reason: claim.reason,
      remedy: claim.remedy,
      currency: claim.currency,
      expectedCreditAmount: markMoney('cost', expected),
      lines: claim.lines.length,
      source: claim.source,
    },
  })
  tools.emit({
    type: 'supplier_claim.created',
    subject: id,
    companyId: claim.companyId,
    siteId: claim.siteId,
    payload: { supplierClaimId: id, number: number.formatted, status: 'DRAFT', kind: claim.kind, partyId: claim.partyId, siteId: claim.siteId, lines: claim.lines.length, source: claim.source },
  })
  return { id, number: number.formatted, lineIds }
}

/** Inserts lines after the claim's existing ones (seq 10, 20, …), each audited. */
async function insertLines(tools: CommandTools, claim: { id: string; siteId: string; partyId: string; currency: string }, lines: readonly ResolvedLine[], seqs: readonly number[]): Promise<string[]> {
  const taken = [...seqs]
  const ids: string[] = []
  for (const line of lines) {
    const seq = nextSeq(taken)
    taken.push(seq)
    const id = newId()
    const value = lineValue(line, claim.currency)
    await tools.tx.supplierClaimLine.create({
      data: {
        id,
        siteId: claim.siteId,
        partyId: claim.partyId,
        claimId: claim.id,
        seq,
        discrepancyId: line.discrepancyId,
        receiptLineId: line.receiptLineId,
        itemId: line.item.id,
        itemColourId: line.itemColourId,
        lotId: line.lotId,
        hideId: line.hideId,
        quantity: line.quantity,
        uom: line.uom,
        baseQuantity: line.baseQuantity,
        reason: line.reason,
        unitCost: value.unitCost,
        creditAmount: value.creditAmount,
        note: line.note,
        createdAt: tools.now,
        updatedAt: tools.now,
        createdById: actorIdOf(tools),
      },
      select: { id: true },
    })
    tools.audit({
      action: 'purchasing.claims.addLine',
      recordType: 'SupplierClaimLine',
      recordId: id,
      after: { claimId: claim.id, seq, discrepancyId: line.discrepancyId, itemId: line.item.id, itemColourId: line.itemColourId, lotId: line.lotId, hideId: line.hideId, quantity: line.quantity, uom: line.uom, baseQuantity: line.baseQuantity, unitCost: markMoney('cost', value.unitCost), creditAmount: markMoney('cost', value.creditAmount) },
    })
    ids.push(id)
  }
  return ids
}

/** purchasing.claims.manage: a draft claim (see the file's comment). */
export async function createClaim(caller: CommandCaller, input: CreateInput, idempotencyKey?: string): Promise<{ claim: ClaimDetailView }> {
  const context = officeContextOf(caller)
  const { result } = await command(caller, { name: 'purchasing.claims.create', idempotencyKey, input }, async (tools) => {
    const source: ClaimSource = input.from?.discrepancyIds?.length ? 'DISCREPANCIES' : input.from?.lotId ? 'LOT' : 'OFFICE'
    const claim = await resolveClaim(tools, input, source)
    assertMayAll(context, [PURCHASING_CLAIMS_MANAGE], claim)
    const { id } = await createClaimInCommand(tools, claim, { internalNote: input.internalNote })
    return { claim: await detailInCommand(tools, id) }
  })
  return result
}

// ---- change ------------------------------------------------------------------------------------------------------------

export interface UpdateInput {
  readonly version: number
  readonly kind?: ClaimKind | undefined
  readonly foundAt?: ClaimFoundAt | undefined
  readonly reasonCode?: string | undefined
  readonly reasonNote?: string | null | undefined
  readonly remedy?: ClaimRemedy | null | undefined
  readonly goodsReceiptId?: string | null | undefined
  readonly purchaseOrderId?: string | null | undefined
  /** The credit asked: the amount agreed with the supplier (cost grain); null: none. */
  readonly expectedCreditAmount?: number | null | undefined
  readonly internalNote?: string | null | undefined
}

const DRAFT_ONLY = ['kind', 'foundAt', 'reasonCode', 'reasonNote', 'goodsReceiptId', 'purchaseOrderId'] as const

/** The credit asked again from the lines, after they or the remedy changed (an amount agreed is kept: `keep`). */
async function refreshCredit(tools: CommandTools, claim: Pick<ClaimRow, 'id'>, remedy: ClaimRemedy | null): Promise<number | null> {
  const lines = await tools.tx.supplierClaimLine.findMany({ where: { claimId: claim.id }, select: { creditAmount: true } })
  const expected = expectedCredit(remedy, lines)
  await tools.tx.supplierClaim.update({ where: { id: claim.id }, data: { expectedCreditAmount: expected }, select: { id: true } })
  return expected
}

function changed(tools: CommandTools, claim: ClaimRow, status: ClaimStatus, fields: readonly string[]) {
  tools.emit({ type: 'supplier_claim.updated', subject: claim.id, companyId: claim.companyId, siteId: claim.siteId, payload: { supplierClaimId: claim.id, number: claim.number, status, fields: [...fields] } })
}

/** purchasing.claims.manage: the claim's header (see the file's comment). */
export async function updateClaim(caller: CommandCaller, claimId: string, input: UpdateInput, idempotencyKey?: string): Promise<{ claim: ClaimDetailView }> {
  await officeClaim(caller, claimId, PURCHASING_CLAIMS_MANAGE)
  const { result } = await command(
    caller,
    { name: 'purchasing.claims.update', idempotencyKey, input: { claimId, ...input }, record: { type: 'SupplierClaim', id: claimId, expectedVersion: input.version } },
    async (tools) => {
      const claim = await claimInCommand(tools.tx, claimId)
      const status = claim.status as ClaimStatus
      const given = Object.entries(input).filter(([key, value]) => key !== 'version' && value !== undefined).map(([key]) => key)
      if (status === 'CLOSED' || status === 'CANCELLED') {
        const others = given.filter((key) => key !== 'internalNote')
        if (others.length > 0) throw conflict([`Claim ${claim.number} is ${status.toLowerCase()}; only its internal note changes.`])
      } else if (status !== 'DRAFT') {
        const draftOnly = given.filter((key) => (DRAFT_ONLY as readonly string[]).includes(key))
        if (draftOnly.length > 0) throw conflict(editProblems({ number: claim.number, status }, 'what it is about changes'))
      }
      if (input.remedy === null && status !== 'DRAFT') throw refuse([{ path: 'body/remedy', message: 'A sent claim asks for a credit or a replacement.' }])
      const data: Prisma.SupplierClaimUncheckedUpdateInput = {}
      if (input.kind !== undefined) data.kind = input.kind
      if (input.foundAt !== undefined) data.foundAt = input.foundAt
      if (input.reasonCode !== undefined || input.reasonNote !== undefined) {
        const code = input.reasonCode ?? readClaimReason(claim.reason).code
        if (!code) throw refuse([{ path: 'body/reasonCode', message: 'Choose a reason of the claim list.' }])
        data.reason = await reasonOf(tools.tx, code, input.reasonNote !== undefined ? input.reasonNote : readClaimReason(claim.reason).note)
      }
      const header = { partyId: claim.partyId, siteId: claim.siteId }
      if (input.goodsReceiptId !== undefined) {
        data.goodsReceiptId = input.goodsReceiptId === null ? null : (await receiptOf(tools.tx, input.goodsReceiptId, header, 'body/goodsReceiptId')).id
      }
      if (input.purchaseOrderId !== undefined) data.purchaseOrderId = input.purchaseOrderId === null ? null : (await orderOf(tools.tx, input.purchaseOrderId, header, 'body/purchaseOrderId')).id
      if (input.remedy !== undefined) data.remedy = input.remedy
      if (input.internalNote !== undefined) data.internalNote = blankToNull(input.internalNote)
      if (input.expectedCreditAmount !== undefined) data.expectedCreditAmount = input.expectedCreditAmount
      if (input.kind === 'RETURN' && claim.kind !== 'RETURN') {
        const lines = await readLines(tools.tx, claimId)
        const untracked = lines.filter((line) => line.lotId === null)
        if (untracked.length > 0) {
          const items = await tools.tx.item.findMany({ where: { id: { in: untracked.map((line) => line.itemId) } }, select: { id: true, code: true, tracking: true } })
          const tracked = items.find((item) => item.tracking !== 'NONE')
          if (tracked) throw refuse([{ path: 'body/kind', message: `${tracked.code} is tracked: a return names the lot (and the hide) of each line; change the lines first.` }])
        }
      }
      if (Object.keys(data).length > 0) await tools.tx.supplierClaim.update({ where: { id: claimId }, data, select: { id: true } })
      const remedy = (input.remedy !== undefined ? input.remedy : claim.remedy) as ClaimRemedy | null
      let expected = input.expectedCreditAmount !== undefined ? input.expectedCreditAmount : claim.expectedCreditAmount
      if (input.remedy !== undefined && input.expectedCreditAmount === undefined && input.remedy !== claim.remedy) expected = await refreshCredit(tools, claim, remedy)
      tools.audit({
        recordType: CLAIM_RECORD,
        recordId: claimId,
        companyId: claim.companyId,
        siteId: claim.siteId,
        before: { kind: claim.kind, foundAt: claim.foundAt, reason: claim.reason, remedy: claim.remedy, goodsReceiptId: claim.goodsReceiptId, purchaseOrderId: claim.purchaseOrderId, expectedCreditAmount: markMoney('cost', claim.expectedCreditAmount), internalNote: claim.internalNote },
        after: { ...data, expectedCreditAmount: markMoney('cost', expected) },
      })
      changed(tools, claim, status, given)
      return { claim: await detailInCommand(tools, claimId) }
    },
  )
  return result
}

/** purchasing.claims.manage: lines added to a draft (typed, or made from discrepancies or a lot). */
export async function addLines(caller: CommandCaller, claimId: string, input: { readonly version: number; readonly from?: ClaimFrom | undefined; readonly lines?: readonly LineInput[] | undefined }, idempotencyKey?: string): Promise<{ claim: ClaimDetailView }> {
  await officeClaim(caller, claimId, PURCHASING_CLAIMS_MANAGE)
  const { result } = await command(
    caller,
    { name: 'purchasing.claims.addLines', idempotencyKey, input: { claimId, ...input }, record: { type: 'SupplierClaim', id: claimId, expectedVersion: input.version } },
    async (tools) => {
      const claim = await claimInCommand(tools.tx, claimId)
      const problems = editProblems({ number: claim.number, status: claim.status as ClaimStatus })
      if (problems.length > 0) throw conflict(problems)
      const existing = await readLines(tools.tx, claimId)
      const lines = await resolveClaimLines(tools.tx, input)
      assertLinesAgree(lines, claim)
      const tracked = returnLineProblems(claim.kind as ClaimKind, lines)
      if (tracked.length > 0) throw refuse(tracked)
      if (lines.length === 0) throw refuse([{ path: 'body/lines', message: 'Name the lines to add.' }])
      if (existing.length + lines.length > CLAIM_LIMITS.lines) throw refuse([{ path: 'body/lines', message: `A claim has at most ${CLAIM_LIMITS.lines} lines.` }])
      await insertLines(tools, claim, lines, existing.map((line) => line.seq))
      await refreshCredit(tools, claim, claim.remedy as ClaimRemedy | null)
      changed(tools, claim, 'DRAFT', ['lines'])
      return { claim: await detailInCommand(tools, claimId) }
    },
  )
  return result
}

export interface EditLineInput {
  readonly version: number
  readonly quantity?: string | undefined
  readonly uom?: LineInput['uom']
  readonly baseQuantity?: string | undefined
  readonly reason?: string | null | undefined
  readonly unitCost?: string | null | undefined
  readonly note?: string | null | undefined
}

async function lineOf(tools: Pick<CommandTools, 'tx'>, claimId: string, lineId: string) {
  const line = isUuid(lineId) ? await tools.tx.supplierClaimLine.findUnique({ where: { id: lineId }, select: LINE_COLUMNS }) : null
  if (!line || line.claimId !== claimId) throw new NotFoundError('Claim line not found on this claim.')
  return line
}

/** purchasing.claims.manage: a draft's line: how much, its words, its cost (cost grain). Its goods change by remove + add. */
export async function editLine(caller: CommandCaller, claimId: string, lineId: string, input: EditLineInput, idempotencyKey?: string): Promise<{ claim: ClaimDetailView }> {
  await officeClaim(caller, claimId, PURCHASING_CLAIMS_MANAGE)
  const { result } = await command(
    caller,
    { name: 'purchasing.claims.editLine', idempotencyKey, input: { claimId, lineId, ...input }, record: { type: 'SupplierClaim', id: claimId, expectedVersion: input.version } },
    async (tools) => {
      const claim = await claimInCommand(tools.tx, claimId)
      const problems = editProblems({ number: claim.number, status: claim.status as ClaimStatus })
      if (problems.length > 0) throw conflict(problems)
      const line = await lineOf(tools, claimId, lineId)
      const quantityGiven = input.quantity !== undefined || input.uom !== undefined || input.baseQuantity !== undefined
      const resolved = await resolveLine(
        tools.tx,
        {
          ...(line.discrepancyId ? { discrepancyId: line.discrepancyId } : {}),
          ...(line.receiptLineId ? { receiptLineId: line.receiptLineId } : {}),
          itemId: line.itemId,
          itemColourId: line.itemColourId,
          lotId: line.lotId,
          hideId: line.hideId,
          quantity: input.quantity ?? line.quantity.toFixed(4),
          uom: input.uom ?? line.uom,
          ...(input.baseQuantity !== undefined ? { baseQuantity: input.baseQuantity } : !quantityGiven ? { baseQuantity: line.baseQuantity.toFixed(4) } : {}),
          reason: input.reason !== undefined ? input.reason : line.reason,
          unitCost: input.unitCost !== undefined ? input.unitCost : line.unitCost === null ? null : line.unitCost.toFixed(6),
          note: input.note !== undefined ? input.note : line.note,
        },
        'body',
      )
      const value = lineValue(resolved, claim.currency)
      await tools.tx.supplierClaimLine.update({
        where: { id: lineId },
        data: { quantity: resolved.quantity, uom: resolved.uom, baseQuantity: resolved.baseQuantity, reason: resolved.reason, unitCost: value.unitCost, creditAmount: value.creditAmount, note: resolved.note, version: { increment: 1 } },
        select: { id: true },
      })
      tools.audit({
        action: 'purchasing.claims.editLine',
        recordType: 'SupplierClaimLine',
        recordId: lineId,
        before: { quantity: line.quantity.toFixed(4), uom: line.uom, baseQuantity: line.baseQuantity.toFixed(4), reason: line.reason, unitCost: markMoney('cost', line.unitCost?.toFixed(6) ?? null), creditAmount: markMoney('cost', line.creditAmount), note: line.note },
        after: { quantity: resolved.quantity, uom: resolved.uom, baseQuantity: resolved.baseQuantity, reason: resolved.reason, unitCost: markMoney('cost', value.unitCost), creditAmount: markMoney('cost', value.creditAmount), note: resolved.note },
      })
      await refreshCredit(tools, claim, claim.remedy as ClaimRemedy | null)
      changed(tools, claim, 'DRAFT', ['lines'])
      return { claim: await detailInCommand(tools, claimId) }
    },
  )
  return result
}

/** purchasing.claims.manage: a draft's line removed. */
export async function removeLine(caller: CommandCaller, claimId: string, lineId: string, query: { readonly version: number }, idempotencyKey?: string): Promise<{ claim: ClaimDetailView }> {
  await officeClaim(caller, claimId, PURCHASING_CLAIMS_MANAGE)
  const { result } = await command(
    caller,
    { name: 'purchasing.claims.removeLine', idempotencyKey, input: { claimId, lineId, ...query }, record: { type: 'SupplierClaim', id: claimId, expectedVersion: query.version } },
    async (tools) => {
      const claim = await claimInCommand(tools.tx, claimId)
      const problems = editProblems({ number: claim.number, status: claim.status as ClaimStatus })
      if (problems.length > 0) throw conflict(problems)
      const line = await lineOf(tools, claimId, lineId)
      await tools.tx.supplierClaimLine.delete({ where: { id: lineId }, select: { id: true } })
      tools.audit({ action: 'purchasing.claims.removeLine', recordType: 'SupplierClaimLine', recordId: lineId, before: { claimId, seq: line.seq, itemId: line.itemId, lotId: line.lotId, hideId: line.hideId, quantity: line.quantity.toFixed(4), uom: line.uom } })
      await refreshCredit(tools, claim, claim.remedy as ClaimRemedy | null)
      changed(tools, claim, 'DRAFT', ['lines'])
      return { claim: await detailInCommand(tools, claimId) }
    },
  )
  return result
}

// ---- the supplier's answer, close, cancel ------------------------------------------------------------------------------

export interface AnswerInput {
  readonly version: number
  readonly outcome: ClaimOutcome
  /** What the supplier said (required). */
  readonly answer: string
  /** The remedy it gives (a replacement instead of the credit asked …). */
  readonly remedy?: ClaimRemedy | undefined
  /** The credit agreed (cost grain); default the lines' value for a credit. */
  readonly expectedCreditAmount?: number | null | undefined
}

/** purchasing.claims.manage: the supplier's answer to a sent claim (its discrepancies AGREED when it accepts). */
export async function answerClaim(caller: CommandCaller, claimId: string, input: AnswerInput, idempotencyKey?: string): Promise<{ claim: ClaimDetailView }> {
  await officeClaim(caller, claimId, PURCHASING_CLAIMS_MANAGE)
  const { result } = await command(
    caller,
    { name: 'purchasing.claims.answer', idempotencyKey, input: { claimId, ...input }, record: { type: 'SupplierClaim', id: claimId, expectedVersion: input.version } },
    async (tools) => {
      const claim = await claimInCommand(tools.tx, claimId)
      const problems = answerProblems({ number: claim.number, status: claim.status as ClaimStatus })
      if (problems.length > 0) throw conflict(problems)
      const remedy = input.remedy ?? (claim.remedy as ClaimRemedy)
      const lines = await tools.tx.supplierClaimLine.findMany({ where: { claimId }, select: { creditAmount: true } })
      const expected = input.expectedCreditAmount !== undefined ? input.expectedCreditAmount : remedy !== claim.remedy ? expectedCredit(remedy, lines) : claim.expectedCreditAmount
      await tools.tx.supplierClaim.update({
        where: { id: claimId },
        data: { status: input.outcome, supplierAnswer: input.answer.trim(), answeredAt: tools.now, remedy, expectedCreditAmount: expected },
        select: { id: true },
      })
      const agreed = input.outcome === 'ACCEPTED' ? await followDiscrepancies(tools, claim, 'AGREED') : 0
      tools.audit({
        action: 'purchasing.claims.answer',
        recordType: CLAIM_RECORD,
        recordId: claimId,
        companyId: claim.companyId,
        siteId: claim.siteId,
        before: { status: claim.status, remedy: claim.remedy, expectedCreditAmount: markMoney('cost', claim.expectedCreditAmount) },
        after: { status: input.outcome, supplierAnswer: input.answer.trim(), remedy, expectedCreditAmount: markMoney('cost', expected), discrepanciesAgreed: agreed },
      })
      tools.emit({ type: 'supplier_claim.answered', subject: claimId, companyId: claim.companyId, siteId: claim.siteId, payload: { supplierClaimId: claimId, number: claim.number, status: input.outcome, remedy } })
      return { claim: await detailInCommand(tools, claimId) }
    },
  )
  return result
}

/**
 * Closes a sent, accepted or rejected claim inside the caller's command, with how it was settled: its discrepancies are
 * CLOSED with it. The supplier's credit note matched in Finance (B-W2a-62) settles an accepted claim with this.
 */
export async function closeClaimInCommand(tools: CommandTools, claimId: string, note: string): Promise<void> {
  const claim = await claimInCommand(tools.tx, claimId)
  const problems = closeProblems({ number: claim.number, status: claim.status as ClaimStatus })
  if (problems.length > 0) throw conflict(problems)
  await tools.tx.supplierClaim.update({ where: { id: claimId }, data: { status: 'CLOSED', closedAt: tools.now, closeNote: note.trim() }, select: { id: true } })
  const closed = await followDiscrepancies(tools, claim, 'CLOSED', note)
  tools.audit({ action: 'purchasing.claims.close', recordType: CLAIM_RECORD, recordId: claimId, companyId: claim.companyId, siteId: claim.siteId, before: { status: claim.status }, after: { status: 'CLOSED', closeNote: note.trim(), discrepanciesClosed: closed } })
  tools.emit({ type: 'supplier_claim.closed', subject: claimId, companyId: claim.companyId, siteId: claim.siteId, payload: { supplierClaimId: claimId, number: claim.number, status: 'CLOSED', discrepanciesClosed: closed } })
}

/** purchasing.claims.manage: a sent, accepted or rejected claim closed with how it was settled. */
export async function closeClaim(caller: CommandCaller, claimId: string, input: { readonly version: number; readonly note: string }, idempotencyKey?: string): Promise<{ claim: ClaimDetailView }> {
  await officeClaim(caller, claimId, PURCHASING_CLAIMS_MANAGE)
  const { result } = await command(
    caller,
    { name: 'purchasing.claims.close', idempotencyKey, input: { claimId, ...input }, record: { type: 'SupplierClaim', id: claimId, expectedVersion: input.version } },
    async (tools) => {
      await closeClaimInCommand(tools, claimId, input.note)
      return { claim: await detailInCommand(tools, claimId) }
    },
  )
  return result
}

/** purchasing.claims.manage: a draft cancelled with a reason. */
export async function cancelClaim(caller: CommandCaller, claimId: string, input: { readonly version: number; readonly reason: string }, idempotencyKey?: string): Promise<{ claim: ClaimDetailView }> {
  await officeClaim(caller, claimId, PURCHASING_CLAIMS_MANAGE)
  const { result } = await command(
    caller,
    { name: 'purchasing.claims.cancel', idempotencyKey, input: { claimId, ...input }, record: { type: 'SupplierClaim', id: claimId, expectedVersion: input.version } },
    async (tools) => {
      const claim = await claimInCommand(tools.tx, claimId)
      const problems = cancelProblems({ number: claim.number, status: claim.status as ClaimStatus })
      if (problems.length > 0) throw conflict(problems)
      await tools.tx.supplierClaim.update({ where: { id: claimId }, data: { status: 'CANCELLED', cancelledAt: tools.now, cancelReason: input.reason.trim() }, select: { id: true } })
      tools.audit({ action: 'purchasing.claims.cancel', recordType: CLAIM_RECORD, recordId: claimId, companyId: claim.companyId, siteId: claim.siteId, reason: input.reason.trim(), before: { status: claim.status }, after: { status: 'CANCELLED' } })
      tools.emit({ type: 'supplier_claim.cancelled', subject: claimId, companyId: claim.companyId, siteId: claim.siteId, payload: { supplierClaimId: claimId, number: claim.number, status: 'CANCELLED' } })
      return { claim: await detailInCommand(tools, claimId) }
    },
  )
  return result
}

