import type { FastifyRequest } from 'fastify'
import type { Prisma } from '@nexus/factory-db'
import { PORTAL_APPROVE } from '@nexus/factory-domain/auth/partners/permissions'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import type { DocumentLanguage } from '@nexus/factory-domain/documents/model'
import { proposedLineOf } from '@nexus/factory-domain/purchasing/confirm/proposal'
import { purchaseOrderDocumentNumber } from '@nexus/factory-domain/purchasing/document'
import type { PurchaseOrderStatus } from '@nexus/factory-domain/purchasing/orders'
import { PORTAL_DECLINE_REASONS, PORTAL_LINE_ANSWERS, portalAnswerSummary, portalCountsOf, portalLineOfStored, type PortalAnsweredLine } from '@nexus/factory-domain/purchasing/portal-orders/answer'
import { CHIP_STATUSES, CHIP_WORDS, defaultChipOf, ORDER_CHIPS, portalAnswerProblem, SUPPLIER_STATE_WORDS, supplierStateOf, type OrderChip } from '@nexus/factory-domain/purchasing/portal-orders/views'
import { answerOfState, changeWords, revisionDiff, type RevisionLine, type RevisionState } from '@nexus/factory-domain/purchasing/revisions/revisions'
import { actorOf, requireContext } from '../../../core/context'
import { portalSessionOf, type PortalSession } from '../../../platform/auth/portal/authenticator'
import { systemCallerOf } from '../../../platform/files/files'
import { expectedLinesOf } from '../orders'
import { labelsFor } from '../revisions/read'
import { dayOf, decimal, quantityText, type Reader } from '../store'
import { SUPPLIER_LINE_COLUMNS, SUPPLIER_ORDER_COLUMNS } from '../supplier-view'
import { siteAddressOf } from '../views'

/**
 * The supplier's purchase orders in the portal (B-W2b-174; SCM-094 "PO list and detail"; design portal.supplier.orders: the
 * chips, "Your purchase orders", the record's Lines with "What changed in version N", Confirm or propose with "Answers so
 * far"). Two readers, as W1's confirm link (../confirm/read.ts):
 *
 *   the session's own scope   (factory_partner_runtime, the party's row-level-security wall and the partner role's column
 *                             grants: no price, amount, internal note or office person): the orders, lines, revisions and
 *                             the supplier's own answers. Another party's order is as unknown as a wrong id (404).
 *   the tenant's system scope  for THIS party's orders only, and only what the partner role may not read but the order's
 *                             paper says anyway: the material's code and name, the colour's name, the buying company's name,
 *                             the delivery site's address, the sender's name, what was received of each line (quantities),
 *                             and the articles of ours the supplier may offer as a substitute (its approved sources: code
 *                             and name, never their price).
 *
 * Only the portal's company's orders, and only orders we sent: a draft never sent is not the supplier's; an order we are
 * changing (a DRAFT of revision 2 or later) shows the revision the supplier holds, as it was sent (its revision row), never
 * the draft's edits.
 */

const LIST_MAX = 500
const CHOICES_MAX = 50

export const localeOf = (session: PortalSession, asked?: string | null): DocumentLanguage => (asked === 'it' || asked === 'en' ? asked : session.person.locale === 'en' ? 'en' : 'it')
const iso = (value: Date | null): string | null => (value === null ? null : toUtcIso(value))
const system = (request: FastifyRequest, session: PortalSession) => systemCallerOf(request)(session.tenantId)

/** The orders of the portal's company the supplier holds (row-level security keeps them to the session's party). */
const heldWhere = (session: PortalSession): Prisma.PurchaseOrderWhereInput => ({ companyId: session.company.id, OR: [{ sentAt: { not: null } }, { revision: { gt: 1 } }] })

function searchOf(q: string | undefined): Prisma.PurchaseOrderWhereInput {
  const text = q?.trim()
  if (!text) return {}
  return {
    OR: [
      { number: { contains: text, mode: 'insensitive' } },
      { supplierRef: { contains: text, mode: 'insensitive' } },
      { proposalSupplierRef: { contains: text, mode: 'insensitive' } },
      { lines: { some: { supplierArticleCode: { contains: text, mode: 'insensitive' } } } },
    ],
  }
}

/** The revision as the supplier holds it: the order's own for a sent order, the one before for a draft being changed. */
const heldRevisionOf = (order: { readonly status: string; readonly revision: number }): number => (order.status === 'DRAFT' ? order.revision - 1 : order.revision)

/** May this person answer (the capability portal.approve over the order's company and party; never an office preview)? */
export function mayAnswer(request: FastifyRequest, session: PortalSession, order: { readonly companyId: string; readonly partyId: string }): boolean {
  if (session.preview) return false
  return can(actorOf(requireContext(request)), PORTAL_APPROVE, { companyId: order.companyId, partyId: order.partyId })
}

// ---- the list ---------------------------------------------------------------------------------------------------------------

export interface PortalListQuery {
  readonly chip?: OrderChip | undefined
  readonly q?: string | undefined
}

/** GET /portal/purchase-orders: the chips with their counts, the orders of a chip, late ones marked (no price). */
export async function listPortalOrders(request: FastifyRequest, query: PortalListQuery, now: Date) {
  const session = portalSessionOf(request)
  const today = businessDate(now)
  const rows = await request.withClient((client) =>
    client.purchaseOrder.findMany({
      where: { AND: [heldWhere(session), searchOf(query.q)] },
      orderBy: [{ sentAt: 'desc' }, { number: 'desc' }],
      take: LIST_MAX + 1,
      select: {
        id: true,
        number: true,
        status: true,
        revision: true,
        orderDate: true,
        requestedDate: true,
        sentAt: true,
        confirmBy: true,
        supplierRef: true,
        proposalSupplierRef: true,
        version: true,
        lines: { where: { cancelledAt: null }, select: { needDate: true } },
      },
    }),
  )
  const page = rows.slice(0, LIST_MAX)
  // Drafts being changed: what the supplier holds is the revision before (its row), never the draft's edits.
  const drafts = page.filter((row) => row.status === 'DRAFT').map((row) => row.id)
  const held = new Map<string, RevisionState>()
  if (drafts.length > 0) {
    const revisions = await request.withClient((client) => client.purchaseOrderRevision.findMany({ where: { purchaseOrderId: { in: drafts } }, orderBy: { revision: 'desc' }, select: { purchaseOrderId: true, revision: true, after: true } }))
    for (const row of revisions) if (!held.has(row.purchaseOrderId)) held.set(row.purchaseOrderId, row.after as unknown as RevisionState)
  }
  // Late and next expected: the open lines still waiting for goods (receipts are read in the system scope, quantities only).
  const expected = await system(request, session).withClient((client) => expectedLinesOf(client as Prisma.TransactionClient, [{ partyId: session.partyId, companyId: session.company.id }], today))
  const nextOf = new Map<string, string>()
  const late = new Set<string>()
  for (const line of expected.lines) {
    if (line.state === 'LATE') late.add(line.purchaseOrderId)
    const next = nextOf.get(line.purchaseOrderId)
    if (!next || line.expectedDate < next) nextOf.set(line.purchaseOrderId, line.expectedDate)
  }
  const counts = new Map<OrderChip, number>(ORDER_CHIPS.map((chip) => [chip, 0]))
  for (const row of page) {
    counts.set('ALL', counts.get('ALL')! + 1)
    for (const chip of ORDER_CHIPS) if (chip !== 'ALL' && CHIP_STATUSES[chip].includes(row.status as PurchaseOrderStatus)) counts.set(chip, counts.get(chip)! + 1)
  }
  const chip = query.chip ?? defaultChipOf(counts.get('TO_CONFIRM')!)
  const shown = chip === 'ALL' ? page : page.filter((row) => CHIP_STATUSES[chip].includes(row.status as PurchaseOrderStatus))
  return {
    asOf: toUtcIso(now),
    chip,
    chips: ORDER_CHIPS.map((entry) => ({ chip: entry, count: counts.get(entry)!, words: CHIP_WORDS[entry] })),
    counts: { toConfirm: counts.get('TO_CONFIRM')!, late: page.filter((row) => late.has(row.id)).length },
    items: shown.map((row) => {
      const state = supplierStateOf(row.status)
      const heldState = held.get(row.id)
      const needDates = heldState ? heldState.lines.filter((line) => !line.cancelled).map((line) => line.needDate) : row.lines.map((line) => dayOf(line.needDate)!)
      const revision = heldRevisionOf(row)
      return {
        id: row.id,
        number: row.number,
        documentNumber: purchaseOrderDocumentNumber(row.number, revision),
        revision,
        status: row.status,
        state,
        words: SUPPLIER_STATE_WORDS[state],
        supplierRef: row.supplierRef ?? row.proposalSupplierRef,
        sentAt: iso(row.sentAt),
        orderDate: dayOf(row.orderDate)!,
        lines: needDates.length,
        earliestNeedDate: needDates.length === 0 ? null : [...needDates].sort()[0]!,
        nextExpected: nextOf.get(row.id) ?? null,
        late: late.has(row.id),
        confirmBy: row.status === 'SENT' ? iso(row.confirmBy) : null,
        canAnswer: row.status === 'SENT',
        version: row.version,
      }
    }),
    complete: rows.length <= LIST_MAX && expected.complete,
    live: { events: PORTAL_ORDER_EVENTS },
  }
}

/** The events after which a portal page of purchase orders reads again (the partner's live channel, B-W2b-167). */
export const PORTAL_ORDER_EVENTS: string[] = ['partner_task.opened', 'partner_task.closed', 'partner_task.reopened']

// ---- the record ---------------------------------------------------------------------------------------------------------------

const ORDER_COLUMNS = {
  ...SUPPLIER_ORDER_COLUMNS,
  companyId: true,
  siteId: true,
  confirmBy: true,
  proposedAt: true,
  proposedByName: true,
  proposalSupplierRef: true,
  proposalNote: true,
  proposalDecision: true,
  proposalDecidedAt: true,
} as const satisfies Prisma.PurchaseOrderSelect

const LINE_COLUMNS = {
  ...SUPPLIER_LINE_COLUMNS,
  proposedQuantity: true,
  proposedDate: true,
  proposedSplitQuantity: true,
  proposedSplitDate: true,
  proposalReason: true,
  proposedSubstituteItemId: true,
  proposedSubstituteNote: true,
  proposalNeedsBuyer: true,
} as const satisfies Prisma.PurchaseOrderLineSelect

type PortalOrderRow = Prisma.PurchaseOrderGetPayload<{ select: typeof ORDER_COLUMNS }>
type PortalLineRow = Prisma.PurchaseOrderLineGetPayload<{ select: typeof LINE_COLUMNS }>

/** One order the supplier holds, in the session's scope, or 404 (another party's, another company's, or a draft never sent). */
export async function heldOrder(client: Reader, session: PortalSession, orderId: string): Promise<PortalOrderRow> {
  const order = isUuid(orderId) ? await client.purchaseOrder.findFirst({ where: { AND: [{ id: orderId }, heldWhere(session)] }, select: ORDER_COLUMNS }) : null
  if (!order) throw new NotFoundError('Purchase order not found.')
  return order
}

export const heldLines = (client: Reader, orderId: string): Promise<PortalLineRow[]> => client.purchaseOrderLine.findMany({ where: { purchaseOrderId: orderId }, orderBy: { seq: 'asc' }, select: LINE_COLUMNS })

/** A stored proposal line read back with its substitute and the buyer's yes (null: the line holds no proposal). */
export function proposalOfLine(line: PortalLineRow): PortalAnsweredLine | null {
  const read = proposedLineOf({
    id: line.id,
    seq: line.seq,
    quantity: quantityText(line.quantity),
    uom: line.uom,
    needDate: dayOf(line.needDate)!,
    proposedQuantity: line.proposedQuantity === null ? null : quantityText(line.proposedQuantity),
    proposedDate: dayOf(line.proposedDate),
    proposedSplitQuantity: line.proposedSplitQuantity === null ? null : quantityText(line.proposedSplitQuantity),
    proposedSplitDate: dayOf(line.proposedSplitDate),
    proposalReason: line.proposalReason,
  })
  return read ? portalLineOfStored(read, line) : null
}

interface Labels {
  readonly items: Map<string, { readonly code: string; readonly name: string; readonly baseUom: string; readonly kind: string }>
  readonly colours: Map<string, string>
}

async function labelsOf(tenant: Reader, itemIds: readonly string[], colourIds: readonly string[]): Promise<Labels> {
  const items = itemIds.length === 0 ? [] : await tenant.item.findMany({ where: { id: { in: [...new Set(itemIds)] } }, select: { id: true, code: true, name: true, baseUom: true, kind: true } })
  const colours = colourIds.length === 0 ? [] : await tenant.itemColour.findMany({ where: { id: { in: [...new Set(colourIds)] } }, select: { id: true, name: true } })
  return { items: new Map(items.map((item) => [item.id, item])), colours: new Map(colours.map((colour) => [colour.id, colour.name])) }
}

/** The articles of ours the supplier may offer instead of a line's, per line: its approved sources of the same kind (no price). */
async function substituteChoices(tenant: Reader, session: PortalSession, lines: readonly { readonly id: string; readonly itemId: string }[], labels: Labels) {
  const sources = await tenant.supplierItem.findMany({
    where: { partyId: session.partyId, status: 'ACTIVE', OR: [{ companyId: null }, { companyId: session.company.id }] },
    orderBy: [{ supplierArticleCode: 'asc' }, { id: 'asc' }],
    take: 500,
    select: { itemId: true, supplierArticleCode: true, item: { select: { code: true, name: true, kind: true } } },
  })
  const byItem = new Map<string, { itemId: string; code: string; name: string; kind: string }>()
  for (const source of sources) if (!byItem.has(source.itemId)) byItem.set(source.itemId, { itemId: source.itemId, code: source.supplierArticleCode ?? source.item.code, name: source.item.name, kind: source.item.kind })
  return Object.fromEntries(
    lines.map((line) => {
      const kind = labels.items.get(line.itemId)?.kind ?? null
      const choices = [...byItem.values()].filter((choice) => choice.itemId !== line.itemId && (kind === null || choice.kind === kind)).slice(0, CHOICES_MAX)
      return [line.id, choices.map(({ itemId, code, name }) => ({ itemId, code, name }))]
    }),
  )
}

/** The ids of our items offered as a substitute on any line of the order (the answer checks a substitute against them). */
export async function choiceIdsOf(request: FastifyRequest, session: PortalSession, lines: readonly { readonly id: string; readonly itemId: string }[]): Promise<Set<string>> {
  const choices = await system(request, session).withClient(async (tenant) => substituteChoices(tenant, session, lines, await labelsOf(tenant, lines.map((line) => line.itemId), [])))
  return new Set(Object.values(choices).flatMap((list) => list.map((choice) => choice.itemId)))
}

/** A line view from a live line (the order the supplier holds is the live one: not a draft). */
function liveLineView(line: PortalLineRow, labels: Labels, received: Map<string, string>) {
  const item = labels.items.get(line.itemId)
  const proposal = proposalOfLine(line)
  const ended = line.cancelledAt ? ('CANCELLED' as const) : line.closedShortAt ? ('CLOSED_SHORT' as const) : null
  const substitute = proposal?.substitute ?? null
  const substituteItem = substitute?.itemId ? labels.items.get(substitute.itemId) : undefined
  return {
    id: line.id,
    seq: line.seq,
    code: line.supplierArticleCode ?? item?.code ?? null,
    name: item?.name ?? null,
    colour: line.itemColourId ? { name: labels.colours.get(line.itemColourId) ?? null, supplierCode: line.supplierColourCode } : null,
    description: line.description,
    quantity: quantityText(line.quantity),
    uom: line.uom,
    baseQuantity: quantityText(line.baseQuantity),
    baseUom: item?.baseUom ?? null,
    needDate: dayOf(line.needDate)!,
    grade: line.grade,
    thicknessMinMm: decimal(line.thicknessMinMm),
    thicknessMaxMm: decimal(line.thicknessMaxMm),
    oneDyeBatch: line.oneDyeBatch,
    areaTolerancePct: decimal(line.areaTolerancePct),
    estimatedHides: line.estimatedHides,
    requiresCrViTest: line.requiresCrViTest,
    note: line.note,
    confirmedQuantity: line.confirmedQuantity === null ? null : quantityText(line.confirmedQuantity),
    confirmedDate: dayOf(line.confirmedDate),
    /** Received so far, in the line's base unit (posted receipts). */
    receivedBase: received.get(line.id) ?? '0.0000',
    ended,
    /** Confirmed by an earlier answer: not answered again. */
    locked: line.confirmedQuantity !== null,
    proposal: proposal
      ? {
          kind: proposal.kind,
          quantity: proposal.quantity,
          date: proposal.date,
          deliveries: proposal.deliveries.map((part) => ({ ...part })),
          reason: proposal.reason,
          changes: [...proposal.changes],
          substitute: substitute ? { itemId: substitute.itemId, code: substituteItem?.code ?? null, name: substituteItem?.name ?? null, note: substitute.note } : null,
          needsBuyer: proposal.needsBuyer,
        }
      : null,
    version: line.version,
  }
}

/** A line view of a revision the supplier holds (a draft being changed shows the revision as sent). */
function heldLineView(line: RevisionLine, labels: Labels) {
  const item = labels.items.get(line.itemId)
  return {
    id: line.id,
    seq: line.seq,
    code: line.supplierArticleCode ?? item?.code ?? null,
    name: item?.name ?? null,
    colour: line.itemColourId ? { name: labels.colours.get(line.itemColourId) ?? null, supplierCode: line.supplierColourCode ?? null } : null,
    description: line.description,
    quantity: line.quantity,
    uom: line.uom,
    baseQuantity: null,
    baseUom: item?.baseUom ?? null,
    needDate: line.needDate,
    grade: line.grade ?? null,
    thicknessMinMm: line.thicknessMinMm ?? null,
    thicknessMaxMm: line.thicknessMaxMm ?? null,
    oneDyeBatch: line.oneDyeBatch ?? false,
    areaTolerancePct: line.areaTolerancePct ?? null,
    estimatedHides: null,
    requiresCrViTest: false,
    note: line.note ?? null,
    confirmedQuantity: line.confirmedQuantity,
    confirmedDate: line.confirmedDate,
    receivedBase: '0.0000',
    ended: line.cancelled ? ('CANCELLED' as const) : line.closedShort ? ('CLOSED_SHORT' as const) : null,
    locked: true,
    proposal: null,
    version: 0,
  }
}

type RevisionRow = { revision: number; sentAt: Date; before: Prisma.JsonValue; after: Prisma.JsonValue; changeNote: string | null }

/** The answer a state was left with (an earlier revision's, from the row that replaced it), in a word and its facts. */
function answerOfStateView(state: RevisionState | null) {
  if (!state) return null
  return {
    answer: answerOfState(state.status, state.confirmation !== null),
    confirmation: state.confirmation ? { at: state.confirmation.at, byName: state.confirmation.byName, supplierRef: state.confirmation.supplierRef } : null,
    decline: state.decline ? { at: state.decline.at, reason: state.decline.reason } : null,
    proposal: state.proposal ? { at: state.proposal.at, byName: state.proposal.byName, supplierRef: state.proposal.supplierRef, note: state.proposal.note, decision: state.proposal.decision } : null,
  }
}

/**
 * GET /portal/purchase-orders/:purchaseOrderId: the order in the supplier's terms (no price), its lines with what was
 * confirmed, proposed and received, what changed in this version, the answers so far and ours, what the supplier may answer
 * now (the line answers, the decline reasons, the articles it may offer instead).
 */
export async function portalOrder(request: FastifyRequest, orderId: string) {
  const session = portalSessionOf(request)
  const language = localeOf(session)
  const own = await request.withClient(async (client) => {
    const order = await heldOrder(client, session, orderId)
    const lines = await heldLines(client, order.id)
    const revisions: RevisionRow[] = await client.purchaseOrderRevision.findMany({ where: { purchaseOrderId: order.id }, orderBy: { revision: 'asc' }, select: { revision: true, sentAt: true, before: true, after: true, changeNote: true } })
    return { order, lines, revisions }
  })
  const { order, lines, revisions } = own
  const heldRevision = heldRevisionOf(order)
  const heldRow = revisions.find((row) => row.revision === heldRevision) ?? null
  const draft = order.status === 'DRAFT'
  const heldState = draft && heldRow ? (heldRow.after as unknown as RevisionState) : null
  const tenant = await system(request, session).withClient(async (client) => {
    const stateLines = heldState?.lines ?? []
    const labels = await labelsOf(
      client,
      [...lines.map((line) => line.itemId), ...lines.flatMap((line) => (line.proposedSubstituteItemId ? [line.proposedSubstituteItemId] : [])), ...stateLines.map((line) => line.itemId)],
      [...lines.flatMap((line) => (line.itemColourId ? [line.itemColourId] : [])), ...stateLines.flatMap((line) => (line.itemColourId ? [line.itemColourId] : []))],
    )
    const company = await client.company.findUnique({ where: { id: order.companyId }, select: { legalName: true, tradeName: true } })
    const site = await client.site.findUnique({ where: { id: order.siteId }, select: { name: true, address: true } })
    const sender = await client.purchaseOrder.findUnique({ where: { id: order.id }, select: { sentById: true } })
    const buyerName = sender?.sentById ? ((await client.user.findUnique({ where: { id: sender.sentById }, select: { displayName: true } }))?.displayName ?? null) : null
    const sums = lines.length === 0 ? [] : await client.goodsReceiptLine.groupBy({ by: ['purchaseOrderLineId'], where: { purchaseOrderLineId: { in: lines.map((line) => line.id) }, receipt: { status: 'POSTED' } }, _sum: { baseQuantity: true } })
    const received = new Map(sums.map((row) => [row.purchaseOrderLineId!, (row._sum.baseQuantity ?? null) === null ? '0.0000' : row._sum.baseQuantity!.toFixed(4)]))
    const answerable = !draft && order.status === 'SENT'
    const choices = answerable ? await substituteChoices(client, session, lines.filter((line) => line.cancelledAt === null && line.closedShortAt === null), labels) : {}
    const states = revisions.flatMap((row) => [row.before as unknown as RevisionState | null, row.after as unknown as RevisionState])
    const changeLabels = await labelsFor(client, states)
    return { labels, company, site, buyerName, received, choices, changeLabels }
  })

  const problem = portalAnswerProblem(order.status)
  const proposals = lines.flatMap((line) => {
    const read = line.cancelledAt === null && line.closedShortAt === null ? proposalOfLine(line) : null
    return read ? [read] : []
  })
  // What changed in the version the supplier holds (from version 2 on): the row's own diff, in the supplier's words.
  const changesOf = (row: RevisionRow) => {
    const before = row.before as unknown as RevisionState | null
    const after = row.after as unknown as RevisionState
    const diff = revisionDiff(before, after)
    return {
      revision: row.revision,
      documentNumber: purchaseOrderDocumentNumber(order.number, row.revision),
      sentAt: toUtcIso(row.sentAt),
      changeNote: row.changeNote,
      words: changeWords(diff, language, tenant.changeLabels),
      lines: diff.lines.map((line) => ({ lineId: line.lineId, seq: line.seq, kind: line.kind, changes: line.changes.map((change) => ({ ...change })) })),
      header: diff.header.map((change) => ({ ...change })),
    }
  }
  // "Answers so far": each version as sent, the answer it got (kept with the next version), and ours on a proposal.
  const history = revisions.map((row) => {
    const next = revisions.find((other) => other.revision === row.revision + 1)
    const kept = next ? answerOfStateView(next.before as unknown as RevisionState | null) : null
    const current = row.revision === order.revision && !draft
    const answer = current
      ? {
          answer: answerOfState(order.status, order.confirmedAt !== null),
          confirmation: order.confirmedAt ? { at: toUtcIso(order.confirmedAt), byName: order.confirmedByName, supplierRef: order.supplierRef } : null,
          decline: order.declinedAt ? { at: toUtcIso(order.declinedAt), reason: order.declineReason } : null,
          proposal: order.proposedAt ? { at: toUtcIso(order.proposedAt), byName: order.proposedByName, supplierRef: order.proposalSupplierRef, note: order.proposalNote, decision: order.proposalDecision } : null,
        }
      : kept
    return { revision: row.revision, documentNumber: purchaseOrderDocumentNumber(order.number, row.revision), sentAt: toUtcIso(row.sentAt), ...(answer ?? { answer: 'WAITING' as const, confirmation: null, decline: null, proposal: null }) }
  })
  const state = supplierStateOf(order.status)
  const header = heldState ?? null
  return {
    order: {
      id: order.id,
      number: order.number,
      documentNumber: purchaseOrderDocumentNumber(order.number, heldRevision),
      revision: heldRevision,
      status: order.status,
      state,
      words: SUPPLIER_STATE_WORDS[state],
      orderDate: dayOf(order.orderDate)!,
      requestedDate: header ? header.requestedDate : dayOf(order.requestedDate),
      incoterms: header ? header.incoterms : order.incoterms,
      paymentTerms: header ? header.paymentTerms : order.paymentTerms,
      note: header ? header.note : order.note,
      sentAt: iso(order.sentAt) ?? (heldRow ? toUtcIso(heldRow.sentAt) : null),
      confirmBy: order.status === 'SENT' ? iso(order.confirmBy) : null,
      confirmedAt: iso(order.confirmedAt),
      confirmedByName: order.confirmedByName,
      supplierRef: order.supplierRef,
      confirmNote: order.confirmNote,
      declinedAt: iso(order.declinedAt),
      declineReason: order.declineReason,
      cancelledAt: iso(order.cancelledAt),
      version: order.version,
    },
    from: { legalName: tenant.company?.legalName ?? '', tradeName: tenant.company?.tradeName ?? null, buyerName: tenant.buyerName },
    deliverTo: tenant.site ? siteAddressOf(tenant.site) : null,
    lines: heldState ? heldState.lines.map((line) => heldLineView(line, tenant.labels)) : lines.map((line) => liveLineView(line, tenant.labels, tenant.received)),
    proposal: order.proposedAt && !draft
      ? {
          at: toUtcIso(order.proposedAt),
          byName: order.proposedByName,
          supplierRef: order.proposalSupplierRef,
          note: order.proposalNote,
          summary: portalAnswerSummary(portalCountsOf(proposals)),
          decision: order.proposalDecision,
          decidedAt: iso(order.proposalDecidedAt),
        }
      : null,
    answer: {
      canAnswer: problem === null,
      message: problem,
      /** The person may answer (portal.approve); else their admin gives them the capability. */
      mayAnswer: mayAnswer(request, session, order),
      lineAnswers: [...PORTAL_LINE_ANSWERS],
      declineReasons: [...PORTAL_DECLINE_REASONS],
      substitutes: tenant.choices,
    },
    /** What changed in the version the supplier holds (version 1: null). */
    changes: heldRow && heldRow.revision > 1 ? changesOf(heldRow) : null,
    history,
    copy: { href: `/portal/purchase-orders/${order.id}/copy` },
    live: { events: PORTAL_ORDER_EVENTS },
  }
}

/** GET /portal/purchase-orders/:purchaseOrderId/revisions: every version we sent and what changed in it (no price, no who). */
export async function portalRevisions(request: FastifyRequest, orderId: string, asked?: string | null) {
  const session = portalSessionOf(request)
  const language = localeOf(session, asked)
  const own = await request.withClient(async (client) => {
    const order = await heldOrder(client, session, orderId)
    const rows: RevisionRow[] = await client.purchaseOrderRevision.findMany({ where: { purchaseOrderId: order.id }, orderBy: { revision: 'asc' }, select: { revision: true, sentAt: true, before: true, after: true, changeNote: true } })
    return { order, rows }
  })
  const states = own.rows.flatMap((row) => [row.before as unknown as RevisionState | null, row.after as unknown as RevisionState])
  const labels = await system(request, session).withClient((client) => labelsFor(client, states))
  return {
    purchaseOrderId: own.order.id,
    number: own.order.number,
    revisions: own.rows.map((row) => {
      const diff = revisionDiff(row.before as unknown as RevisionState | null, row.after as unknown as RevisionState)
      return {
        revision: row.revision,
        documentNumber: purchaseOrderDocumentNumber(own.order.number, row.revision),
        sentAt: toUtcIso(row.sentAt),
        changeNote: row.changeNote,
        words: changeWords(diff, language, labels),
        lines: diff.lines.map((line) => ({ lineId: line.lineId, seq: line.seq, kind: line.kind, changes: line.changes.map((change) => ({ ...change })) })),
        header: diff.header.map((change) => ({ ...change })),
      }
    }),
  }
}
