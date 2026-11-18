import { EMAIL_SEND } from '@nexus/factory-domain/auth/permissions/catalogue'
import { DomainError, ForbiddenError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { eventFor } from '@nexus/factory-domain/events/define'
import {
  customerMessageOf,
  DECISION_ACTIONS,
  messageLanguageOf,
  PROPOSE_ACTION,
  proposalWords,
  reasonChoices,
  REPROMISE_REFUSALS,
  repromiseProblems,
  type ProposalSize,
} from '@nexus/factory-domain/planning/promise-keep/repromise'
import { PLANNING_PROMISE_MANAGE, PLANNING_PROMISE_VIEW } from '@nexus/factory-domain/planning/promise/permissions'
import { currentPromiseOf, dayWords, promiseAskProblems, promisePlanOf, promiseRowWords, type PromiseAsk } from '@nexus/factory-domain/planning/promise/rules'
import { LINE_CHANGE_STATUSES, type SalesOrderStatus } from '@nexus/factory-domain/sales/orders/orders'
import { ORDERS_MANAGE, ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import { events as taskEvents } from '@nexus/factory-domain/tasks/events'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { countryOf } from '../../compliance/gates/facts'
import { officeContextOf } from '../access'
import { sendEmail } from '../../../platform/email-out/outbound'
import { mayBeAssigned } from '../../../platform/tasks/tasks'
import { followInCommand } from '../../../platform/threads/followers'
import { changePromiseInCommand } from '../../sales/orders/moves'
import { lockOrder } from '../../sales/orders/store'
import { certificatesOn } from '../promise/certificates'
import { orderLinePromise } from '../promise/order-lines'
import { whereOf } from '../promise/read'
import { mayPromiseAt, promiseSite, readPromiseRows } from '../promise/store'
import { dayOf, type Reader, type SiteRow } from '../store'
// B-PR-28: the customer answers the new date (a REPROMISE approval asked with the accept).
import { dueAtFor } from '@nexus/factory-domain/approvals-out/rules'
import { linkTokenHash, mintLinkToken } from '@nexus/factory-domain/links/token'
import { askCustomerInCommand, customerAnswersOf, withdrawOlderInCommand, type CustomerAnswerView } from './brand-answer'
// B-PR-27b: the re-promise an accepted customer ask proposes.
import { repromiseAsksOf, REPROMISE_SKIP_WORDS } from '@nexus/factory-domain/production-brand/accept'
import {
  customerOf,
  keepLineFor,
  makingSiteOf, // B-PR-27b
  KEEP_ORDER_STATUSES,
  lockLinePromise,
  readKeepLine,
  readProposal,
  readProposals,
  recipientsOf,
  shippedOfLines,
  sizesOfLine,
  typedOf,
  type KeepLine,
  type ProposalRecord,
} from './store'

/**
 * The re-promise workflow (B-W2b-317; PLN-175; design planning.promise › repromise; factory-domain planning/promise-keep/
 * repromise for the rules): planning proposes new dates per size from the plan with a reason and the words to the customer,
 * "Send to sales for acceptance"; sales accepts (the promise is given: RE_PROMISE rows, the line's date follows its latest
 * size through W1's promise change, and — when sales says so — the message goes to the customer on the order's thread by
 * e-mail, on the e-mail runtime's provider: FAKE locally and in tests) or declines; the planner may withdraw it.
 *
 *   GET  /planning/promises/order-lines/:orderLineId/re-promise   the draft: dates per size from the plan, the reasons, the
 *                                                                 message preview in the customer's language, who it goes to
 *   POST /planning/promises/order-lines/:orderLineId/re-promise   propose (planning.promise.manage over the site)
 *   GET  /planning/promises/re-promises?siteId&state               the proposals of the site's open orders
 *   GET  /planning/promises/re-promises/:proposalId                one proposal
 *   POST /planning/promises/re-promises/:proposalId/accept         sales (orders.manage; email.send to tell the customer)
 *   POST /planning/promises/re-promises/:proposalId/decline        sales, with its words
 *   POST /planning/promises/re-promises/:proposalId/withdraw       the planner who proposed
 *
 * A proposal is its audit row on the order and a task on the order for sales (the task's id is the proposal's): sales finds
 * it in My tasks and on the order. Nobody decides their own proposal (the Owner included): 409 in words. Every write is ONE
 * command; the order's row first (when the line's date follows), then the line's promise lock (B-W2b-301's key), the
 * proposal and the rows read again inside: a size whose promise changed since makes it STALE (409; propose again).
 * Nothing is sent by a rule: the message goes only when a person accepts with `tell`.
 *
 * B-PR-28 (production plan §3 "accept or refuse a new date"; 08-backend §4.3): sales may accept asking the customer
 * (`askBrand`): the promise is given as always (the date stands either way: capacity is shared) and, in the same command, a
 * REPROMISE approval is asked of the customer on the order (./brand-answer: its question, its APPROVAL link handed once in the
 * answer, the partner's task); the customer accepts or refuses with words in its portal (POST /portal/approvals/:id/answer) or
 * by the link; a refusal leaves the date and opens a follow-up task for us (the order waits on us while it is open). Every
 * accept withdraws an older open question about the same line. The proposal shows the customer's answer (`customerAnswer`).
 */

const [taskCreated, taskAssigned, taskCompleted, taskChanged] = taskEvents

const max0 = (value: number): number => (value > 0 ? value : 0)
const askOf = (sizes: readonly { readonly size?: string | null | undefined; readonly date: BusinessDate }[]): PromiseAsk[] => sizes.map((entry) => ({ size: entry.size ?? null, date: entry.date }))

/** The sizes asked, each with its promise now (`from`). */
function proposalSizesOf(line: KeepLine, rows: Parameters<typeof currentPromiseOf>[1], asks: readonly PromiseAsk[]): ProposalSize[] {
  const typed = typedOf(line)
  return asks.map((ask) => ({ size: ask.size, from: currentPromiseOf(ask.size, rows, typed)?.date ?? null, to: ask.date }))
}

/** PLN-179: only sizes a valid certificate covers through their date (the refusals as 409 issues in the gate's words). */
async function certificateRefusals(db: Reader, line: KeepLine, site: SiteRow, asks: readonly PromiseAsk[], now: Date, path: (index: number) => string): Promise<{ path: string; message: string }[]> {
  const { where } = await whereOf(db, site, now, countryOf(line.order.shipTo))
  const shipped = await shippedOfLines(db, [line.id])
  const sizes = sizesOfLine(line)
  const sizeOf = (size: string | null) => size ?? line.baseSize ?? line.style.baseSize ?? line.style.sizes[0] ?? ''
  const refused: { path: string; message: string }[] = []
  for (const day of [...new Set(asks.map((ask) => ask.date))].sort()) {
    const onDay = asks.flatMap((ask, index) =>
      ask.date !== day
        ? []
        : ask.size === null && line.kind !== 'MADE_TO_MEASURE'
          ? sizes.filter((entry) => entry.size !== null && max0(entry.ordered - shipped(line.id, entry.size)) > 0).map((entry) => ({ index, size: entry.size! }))
          : [{ index, size: sizeOf(ask.size) }],
    )
    const answers = await certificatesOn(db, { styleId: line.styleId, styleCode: line.style.code, asks: onDay.map((entry) => ({ key: entry.size, colourwayId: line.colourwayId, colourwayCode: line.colourway.code, size: entry.size })), market: where.market, destination: where.destination, day, now })
    for (const entry of onDay) {
      const answer = answers.get(entry.size)
      if (answer?.state === 'MISSING') refused.push({ path: path(entry.index), message: answer.words })
    }
  }
  return refused
}

function proposalView(proposal: ProposalRecord, context: OfficeContext, line: KeepLine, today: BusinessDate, names: ReadonlyMap<string, string>, /* B-PR-28 */ customer: CustomerAnswerView | null = null) {
  const person = (id: string | null | undefined) => (id && names.has(id) ? { id, name: names.get(id)! } : null)
  const actor = actorOf(context)
  const scope = { companyId: line.companyId, partyId: line.partyId }
  const waiting = proposal.state === 'WAITING'
  const own = proposal.proposedById === context.actorId
  return {
    id: proposal.id,
    state: proposal.state,
    order: { id: line.order.id, number: line.order.number, status: line.order.status },
    line: { id: line.id, seq: line.seq, style: { id: line.style.id, code: line.style.code, name: line.style.name }, colourway: line.colourway },
    customer: customerOf(line.order.party),
    siteId: proposal.siteId,
    sizes: proposal.sizes,
    reasonCode: proposal.reasonCode,
    reason: proposal.reason,
    message: proposal.message,
    recipients: proposal.recipients,
    proposedAt: toUtcIso(proposal.proposedAt),
    proposedBy: person(proposal.proposedById),
    decision: proposal.decision
      ? { decision: proposal.decision.decision, at: toUtcIso(proposal.decision.at), by: person(proposal.decision.byId), reason: proposal.decision.reason, told: proposal.decision.told, outboundId: proposal.decision.outboundId }
      : null,
    task: { id: proposal.id, status: proposal.taskStatus, assignee: person(proposal.taskAssigneeId) },
    words: `Re-promise of ${line.order.number} line ${line.seq}: ${proposalWords(proposal.sizes, (date) => dayWords(date, today))}.`,
    // B-PR-28: the customer's answer to the new date, when sales asked it (null: not asked).
    customerAnswer: customer,
    may: {
      accept: waiting && !own && can(actor, ORDERS_MANAGE, scope),
      tell: waiting && !own && can(actor, ORDERS_MANAGE, scope) && can(actor, EMAIL_SEND, { companyId: line.companyId }),
      decline: waiting && !own && can(actor, ORDERS_MANAGE, scope),
      withdraw: waiting && own,
    },
  }
}

async function namesOf(db: Reader, proposals: readonly ProposalRecord[]): Promise<Map<string, string>> {
  const ids = [...new Set(proposals.flatMap((proposal) => [proposal.proposedById, ...(proposal.decision ? [proposal.decision.byId] : []), ...(proposal.taskAssigneeId ? [proposal.taskAssigneeId] : [])]))]
  return ids.length === 0 ? new Map() : new Map((await db.user.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true } })).map((user) => [user.id, user.displayName]))
}

// ---- the draft ---------------------------------------------------------------------------------------------------------------

/** GET /planning/promises/order-lines/:orderLineId/re-promise — the dates from the plan, the reasons, the message preview. */
export async function repromiseDraft(caller: CommandCaller, orderLineId: string) {
  const plan = await orderLinePromise(caller, orderLineId)
  return caller.withClient(async (db) => {
    const { context, line, site } = await keepLineFor(caller, db, orderLineId)
    const now = serverClock.now()
    const today = businessDate(now, site.timezone)
    const sizes: ProposalSize[] = plan.sizes.flatMap((entry) => (entry.open > 0 && entry.proposed !== null && entry.current !== null && entry.current.date !== entry.proposed ? [{ size: entry.size, from: entry.current.date, to: entry.proposed }] : []))
    const recipients = await recipientsOf(db, { partyId: line.partyId, quoteVersionId: line.order.quoteVersionId, language: line.order.language })
    const language = messageLanguageOf(recipients.language)
    const reasonCode = sizes.some((entry) => entry.from !== null && entry.to > entry.from) ? 'CAPACITY' : 'EARLIER'
    const proposals = (await readProposals(db, [line.orderId])).filter((proposal) => proposal.orderLineId === line.id)
    const waiting = proposals.find((proposal) => proposal.state === 'WAITING') ?? null
    const names = await namesOf(db, waiting ? [waiting] : [])
    return {
      site: { id: site.id, code: site.code, name: site.name },
      today,
      asOf: toUtcIso(now),
      order: { id: line.order.id, number: line.order.number, status: line.order.status, customerRef: line.order.customerRef },
      line: { id: line.id, seq: line.seq, kind: line.kind, style: { id: line.style.id, code: line.style.code, name: line.style.name }, colourway: line.colourway },
      customer: customerOf(line.order.party),
      plan: plan.sizes.map((entry) => ({ size: entry.size, open: entry.open, current: entry.current?.date ?? null, proposed: entry.proposed, state: entry.state, certificate: entry.certificate ? { state: entry.certificate.state, validTo: entry.certificate.validTo, words: entry.certificate.words } : null, words: entry.words })),
      groupsWords: plan.groupsWords,
      proposed: sizes,
      reasons: reasonChoices(),
      reasonCode: sizes.length > 0 ? reasonCode : null,
      language,
      message: sizes.length > 0 ? { language, ...customerMessageOf({ language, orderNumber: line.order.number, customerRef: line.order.customerRef, lineSeq: line.seq, style: line.style, colourway: line.colourway, sizes, reasonCode }) } : null,
      recipients: recipients.to,
      waiting: waiting ? proposalView(waiting, context, line, today, names) : null,
      may: { propose: mayPromiseAt(context, PLANNING_PROMISE_MANAGE, site) && waiting === null && (KEEP_ORDER_STATUSES as readonly string[]).includes(line.order.status) },
      words:
        sizes.length === 0
          ? `${line.order.number} line ${line.seq}: the plan keeps every open size on its promise; nothing to re-promise.`
          : `${line.order.number} line ${line.seq}: the plan says ${proposalWords(sizes, (date) => dayWords(date, today))}.`,
    }
  })
}

// ---- propose -----------------------------------------------------------------------------------------------------------------

export interface ProposeBody {
  readonly sizes: readonly { readonly size?: string | null | undefined; readonly date: BusinessDate }[]
  readonly reasonCode: string
  readonly reason?: string | undefined
  readonly message?: { readonly subject?: string | undefined; readonly body?: string | undefined } | undefined
}

/** A task on the order for sales: the order's maker when they may keep it (not the planner who proposes), else nobody yet. */
async function taskInCommand(tools: CommandTools, context: OfficeContext, line: KeepLine, proposalId: string, sizes: readonly ProposalSize[], today: BusinessDate): Promise<string | null> {
  const { tx, now } = tools
  const scope = { companyId: line.companyId, siteId: null, partyId: line.partyId }
  const maker = line.order.createdById
  const assigneeId = maker && maker !== context.actorId && (await mayBeAssigned(tx, context.tenantId, maker, scope, true, now)) ? maker : null
  const title = `Accept the new date: ${line.order.number} line ${line.seq}`.slice(0, 200)
  const description = `Planning proposes ${proposalWords(sizes, (date) => dayWords(date, today))} for ${line.style.code} ${line.colourway.code}. Accept it (and tell the customer) or decline it in Planning › Promise dates.`
  await tx.task.create({
    data: {
      id: proposalId,
      companyId: line.companyId,
      siteId: null,
      partyId: line.partyId,
      title,
      description,
      recordType: 'SalesOrder',
      recordId: line.orderId,
      recordLabel: line.order.number,
      assigneeId,
      assignedById: assigneeId ? context.actorId : null,
      assignedAt: assigneeId ? now : null,
      checklist: [],
      createdAt: now,
      updatedAt: now,
      createdById: context.actorId,
    },
    select: { id: true },
  })
  tools.audit({ action: 'tasks.create', recordType: 'Task', recordId: proposalId, companyId: line.companyId, after: { title, assigneeId, status: 'OPEN', recordType: 'SalesOrder', recordId: line.orderId, by: 'planning.promise.propose' } })
  const about = { taskId: proposalId, recordType: 'SalesOrder', recordId: line.orderId }
  const where = { subject: proposalId, companyId: line.companyId, siteId: null }
  tools.emit(eventFor(taskCreated, { ...where, payload: { ...about, assigneeId } }))
  if (assigneeId) {
    tools.emit(eventFor(taskAssigned, { ...where, payload: { ...about, assigneeId, assignedById: context.actorId } }))
    await followInCommand(tools, { type: 'SalesOrder', id: line.orderId, companyId: line.companyId, siteId: null }, assigneeId, 'ASSIGNEE', context.actorId)
  }
  return assigneeId
}

// ── B-PR-27b: the checks of a proposal and its write, shared with the accept of a customer's "Urgent – asked" and ship what is
// ready (production/brand-requests, sales/change-requests: the accept proposes the date the customer asked to sales) ───────────

/** A proposal as its checks found it, ready to be written inside a command. */
export interface ProposalChecked {
  readonly context: OfficeContext
  readonly line: KeepLine
  readonly site: SiteRow
  readonly today: BusinessDate
  readonly asks: readonly PromiseAsk[]
  readonly reasonCode: string
  readonly reason: string | null
  readonly recipients: readonly string[]
  readonly message: { readonly language: 'it' | 'en'; readonly subject: string; readonly body: string }
  readonly planVersionId: string | null
}

/**
 * The checks of new dates for a line (refused in words: 400 for the sizes and days, 409 for a certificate that does not cover a
 * date), and the message to the customer in its language. The caller found the line and its site (keepLineFor, or its own read)
 * and holds planning.promise.manage there.
 */
export async function proposalChecks(db: Reader, found: { readonly context: OfficeContext; readonly line: KeepLine; readonly site: SiteRow }, body: ProposeBody, now: Date): Promise<ProposalChecked> {
  const { context, line, site } = found
  const asks = askOf(body.sizes)
  if (!(KEEP_ORDER_STATUSES as readonly string[]).includes(line.order.status)) throw new InvalidStateError(`${line.order.number} is ${line.order.status}: nothing more is promised on it.`)
  const today = businessDate(now, site.timezone)
  const shipped = await shippedOfLines(db, [line.id])
  const sizes = sizesOfLine(line)
  const rows = (await readPromiseRows(db, [line.id])).get(line.id) ?? []
  const proposed = proposalSizesOf(line, rows, asks)
  const problems = [
    ...promiseAskProblems({
      asks,
      sizes: sizes.flatMap((entry) => (entry.size ? [entry.size] : [])),
      openOf: (size) => max0((sizes.find((entry) => entry.size === size)?.ordered ?? 0) - shipped(line.id, size)),
      madeToMeasure: line.kind === 'MADE_TO_MEASURE',
      today,
      orderDate: dayOf(line.order.orderDate),
    }),
    ...repromiseProblems({ sizes: proposed, reasonCode: body.reasonCode }),
  ]
  if (problems.length > 0) throw new ValidationError('The re-promise cannot be sent like this.', problems)
  const refused = await certificateRefusals(db, line, site, asks, now, (index) => `body/sizes/${index}/date`)
  if (refused.length > 0) throw new DomainError('conflict', `Only sizes a valid certificate covers through their date are promised: ${refused[0]!.message}`, refused)
  const recipients = await recipientsOf(db, { partyId: line.partyId, quoteVersionId: line.order.quoteVersionId, language: line.order.language })
  const language = messageLanguageOf(recipients.language)
  const composed = customerMessageOf({ language, orderNumber: line.order.number, customerRef: line.order.customerRef, lineSeq: line.seq, style: line.style, colourway: line.colourway, sizes: proposed, reasonCode: body.reasonCode })
  const plan = await db.planVersion.findFirst({ where: { siteId: site.id, kind: 'WORKING' }, select: { id: true } })
  return {
    context,
    line,
    site,
    today,
    asks,
    reasonCode: body.reasonCode,
    reason: body.reason?.trim() || null,
    recipients: recipients.to,
    message: { language, subject: body.message?.subject?.trim() || composed.subject, body: body.message?.body?.trim() || composed.body },
    planVersionId: plan?.id ?? null,
  }
}

/**
 * The proposal written INSIDE the caller's command: the line's promise lock, one that waits per line (409 in words), the sizes
 * read again (a promise that moved since is refused in words), the task for sales, the audit row on the order (the proposal), and
 * order_promise.proposed.
 */
export async function proposeInCommand(tools: CommandTools, checked: ProposalChecked): Promise<{ readonly proposalId: string; readonly sizes: readonly ProposalSize[] }> {
  const { tx } = tools
  const { context, line, site, today, asks } = checked
  await lockLinePromise(tx, context.tenantId, line.id)
  if ((await readProposals(tx, [line.orderId])).some((proposal) => proposal.orderLineId === line.id && proposal.state === 'WAITING')) throw new DomainError('conflict', REPROMISE_REFUSALS.WAITING_EXISTS, [{ path: 'orderLineId', message: REPROMISE_REFUSALS.WAITING_EXISTS }])
  const fresh = (await readKeepLine(tx, line.id))!
  const rows = (await readPromiseRows(tx, [line.id])).get(line.id) ?? []
  const sizes = proposalSizesOf(fresh, rows, asks)
  const problems = repromiseProblems({ sizes, reasonCode: checked.reasonCode })
  if (problems.length > 0) throw new ValidationError('The re-promise cannot be sent like this.', problems)
  const proposalId = newId()
  const assigneeId = await taskInCommand(tools, context, fresh, proposalId, sizes, today)
  tools.audit({
    action: PROPOSE_ACTION,
    recordType: 'SalesOrder',
    recordId: line.orderId,
    companyId: line.companyId,
    siteId: site.id,
    after: { proposalId, orderLineId: line.id, siteId: site.id, planVersionId: checked.planVersionId, sizes, reasonCode: checked.reasonCode, reason: checked.reason, message: checked.message, recipients: checked.recipients, assigneeId },
    ...(checked.reason ? { reason: checked.reason } : {}),
  })
  tools.emit({ type: 'order_promise.proposed', subject: line.orderId, companyId: line.companyId, siteId: site.id, payload: { orderId: line.orderId, orderLineId: line.id, proposalId, siteId: site.id, sizes } })
  return { proposalId, sizes }
}

/** What an accept proposes: one checked proposal per line, and the lines it does not propose with why (the office's words). */
export interface AcceptProposals {
  readonly checked: readonly ProposalChecked[]
  readonly skipped: readonly { readonly orderLineId: string; readonly seq: number; readonly words: { readonly it: string; readonly en: string } }[]
}

/**
 * The re-promise an accepted ask proposes to sales (a customer's "Urgent – asked", ship what is ready): for each open goods line of
 * the order (`only`: these lines and sizes — a split's first part), every open size promised LATER than the date asked gets that
 * date (factory-domain production-brand/accept repromiseAsksOf), with the reason "Changed at your request"; sales accepts it and
 * tells the customer as with any re-promise. A line is left out, in words, when: no date was asked, it is promised by then
 * already, it has no making site, the person may not propose dates there (planning.promise.manage), a re-promise of it waits for
 * sales already, or its checks refuse it (a certificate, a day). Read in the caller's client before the accept's command;
 * `proposeInCommand` writes each inside it.
 * fix-pr-5 (lead decision, B-PR-27b): `byAccept` — the accept itself is the decision (ship what is ready, Sales' accept): the
 * proposal is made inside the accept's command under the accepter's orders.manage over the order (its caller checked it), so
 * planning.promise.manage is not asked; the proposal then waits as any other (accepted or declined as today).
 */
export async function acceptProposals(
  db: Reader,
  context: OfficeContext,
  input: { readonly orderId: string; readonly date: BusinessDate | null; readonly only?: ReadonlyMap<string, ReadonlySet<string>> | undefined; readonly now: Date; readonly byAccept?: boolean | undefined },
): Promise<AcceptProposals> {
  const lines = await db.salesOrderLine.findMany({ where: { orderId: input.orderId, kind: { in: ['SIZE_GRID', 'MADE_TO_MEASURE'] }, closedShortQuantity: null }, select: { id: true, seq: true }, orderBy: { seq: 'asc' } })
  const wanted = input.only ? lines.filter((line) => input.only!.has(line.id)) : lines
  if (input.date === null) return { checked: [], skipped: wanted.map((line) => ({ orderLineId: line.id, seq: line.seq, words: REPROMISE_SKIP_WORDS.NO_DATE })) }
  const date = input.date
  const waiting = new Set((await readProposals(db, [input.orderId])).filter((proposal) => proposal.state === 'WAITING').map((proposal) => proposal.orderLineId))
  const checked: ProposalChecked[] = []
  const skipped: AcceptProposals['skipped'][number][] = []
  for (const entry of wanted) {
    const line = await readKeepLine(db, entry.id)
    if (!line) continue
    const site = await makingSiteOf(db, line)
    if (!site) {
      skipped.push({ orderLineId: line.id, seq: line.seq, words: REPROMISE_SKIP_WORDS.NO_SITE })
      continue
    }
    // fix-pr-5: an accept that is the decision (byAccept) needs no promise right at the site (its caller holds orders.manage).
    if (input.byAccept !== true && (!mayPromiseAt(context, PLANNING_PROMISE_VIEW, site) || !mayPromiseAt(context, PLANNING_PROMISE_MANAGE, site))) {
      skipped.push({ orderLineId: line.id, seq: line.seq, words: REPROMISE_SKIP_WORDS.NO_RIGHT })
      continue
    }
    if (waiting.has(line.id)) {
      skipped.push({ orderLineId: line.id, seq: line.seq, words: { it: 'Una nuova data di questa riga aspetta già le vendite.', en: REPROMISE_REFUSALS.WAITING_EXISTS } })
      continue
    }
    const shipped = await shippedOfLines(db, [line.id])
    const rows = (await readPromiseRows(db, [line.id])).get(line.id) ?? []
    const typed = typedOf(line)
    const only = input.only?.get(line.id)
    const sizes = sizesOfLine(line)
      .filter((size) => !only || size.size === null || only.has(size.size))
      .map((size) => ({ size: size.size, open: max0(size.ordered - shipped(line.id, size.size)), promised: currentPromiseOf(size.size, rows, typed)?.date ?? null }))
    const asks = repromiseAsksOf(sizes, date)
    if (asks.length === 0) {
      skipped.push({ orderLineId: line.id, seq: line.seq, words: REPROMISE_SKIP_WORDS.KEPT })
      continue
    }
    try {
      checked.push(await proposalChecks(db, { context, line, site }, { sizes: asks, reasonCode: ACCEPT_REASON_CODE }, input.now))
    } catch (error) {
      if (!(error instanceof DomainError)) throw error
      skipped.push({ orderLineId: line.id, seq: line.seq, words: { it: error.message, en: error.message } })
    }
  }
  return { checked, skipped }
}

/** The reason an accepted ask's re-promise carries (the customer reads it in its words: "Changed at your request"). */
const ACCEPT_REASON_CODE = 'YOUR_CHANGE'
// ── end B-PR-27b ──

/** POST /planning/promises/order-lines/:orderLineId/re-promise — send new dates to sales for acceptance. */
export async function proposeRepromise(caller: CommandCaller, orderLineId: string, body: ProposeBody, idempotencyKey?: string) {
  // B-PR-27b: the checks and the write are shared (proposalChecks, proposeInCommand).
  const checked = await caller.withClient(async (db) => proposalChecks(db, await keepLineFor(caller, db, orderLineId, PLANNING_PROMISE_MANAGE), body, serverClock.now()))
  const outcome = await command(caller, { name: PROPOSE_ACTION, idempotencyKey, input: { orderLineId, ...body } }, (tools) => proposeInCommand(tools, checked))
  return { proposal: await proposalAfter(caller, outcome.result.proposalId), replayed: outcome.replayed }
}

// ---- reads -------------------------------------------------------------------------------------------------------------------

/** A proposal and its line, seen by the caller (else not found). */
async function proposalFor(caller: CommandCaller, db: Reader, proposalId: string) {
  const proposal = await readProposal(db, proposalId)
  if (!proposal) throw new NotFoundError('Re-promise not found.')
  const { context, line, site } = await keepLineFor(caller, db, proposal.orderLineId)
  return { context, line, site, proposal }
}

async function proposalAfter(caller: CommandCaller, proposalId: string) {
  return caller.withClient(async (db) => {
    const { context, line, site, proposal } = await proposalFor(caller, db, proposalId)
    // B-PR-28
    const customer = (await customerAnswersOf(db, [proposal])).get(proposal.id) ?? null
    return proposalView(proposal, context, line, businessDate(serverClock.now(), site.timezone), await namesOf(db, [proposal]), customer)
  })
}

/** GET /planning/promises/re-promises/:proposalId */
export async function getRepromise(caller: CommandCaller, proposalId: string) {
  return proposalAfter(caller, proposalId)
}

/** GET /planning/promises/re-promises — the proposals of the site's open orders (default: those waiting for sales). */
export async function listRepromises(caller: CommandCaller, query: { readonly siteId: string; readonly state?: ProposalRecord['state'] | 'ALL' | undefined }) {
  return caller.withClient(async (db) => {
    const site = await promiseSite(caller, query.siteId, PLANNING_PROMISE_VIEW, db)
    const context = officeContextOf(caller)
    const now = serverClock.now()
    const today = businessDate(now, site.timezone)
    const orders = await db.salesOrder.findMany({ where: { companyId: site.companyId, status: { in: [...KEEP_ORDER_STATUSES] } }, select: { id: true }, take: 2000 })
    const proposals = (await readProposals(db, orders.map((order) => order.id))).filter((proposal) => proposal.siteId === site.id && (query.state === 'ALL' || proposal.state === (query.state ?? 'WAITING')))
    const names = await namesOf(db, proposals)
    const answers = await customerAnswersOf(db, proposals) // B-PR-28
    const views = []
    for (const proposal of proposals) {
      const line = await readKeepLine(db, proposal.orderLineId)
      if (!line || !can(actorOf(context), ORDERS_VIEW, { companyId: line.companyId, partyId: line.partyId })) continue
      views.push(proposalView(proposal, context, line, today, names, answers.get(proposal.id) ?? null))
    }
    return { site: { id: site.id, code: site.code, name: site.name }, today, asOf: toUtcIso(now), proposals: views }
  })
}

// ---- decide ------------------------------------------------------------------------------------------------------------------

/** The decision's checks before its command: seen, waiting, not one's own (accept, decline), sales over the order. */
async function decisionChecks(caller: CommandCaller, proposalId: string, who: 'SALES' | 'PROPOSER') {
  return caller.withClient(async (db) => {
    const { context, line, site, proposal } = await proposalFor(caller, db, proposalId)
    const actor = actorOf(context)
    if (who === 'SALES' && !can(actor, ORDERS_MANAGE, { companyId: line.companyId, partyId: line.partyId })) throw new ForbiddenError()
    if (who === 'PROPOSER' && !mayPromiseAt(context, PLANNING_PROMISE_MANAGE, site)) throw new ForbiddenError()
    if (proposal.state !== 'WAITING') throw new DomainError('conflict', `${REPROMISE_REFUSALS.NOT_WAITING} It is ${proposal.state.toLowerCase()}.`, [{ path: 'refusal/NOT_WAITING', message: REPROMISE_REFUSALS.NOT_WAITING }])
    if (who === 'SALES' && proposal.proposedById === context.actorId) throw new DomainError('conflict', REPROMISE_REFUSALS.OWN_PROPOSAL, [{ path: 'refusal/OWN_PROPOSAL', message: REPROMISE_REFUSALS.OWN_PROPOSAL }])
    if (who === 'PROPOSER' && proposal.proposedById !== context.actorId) throw new DomainError('conflict', REPROMISE_REFUSALS.NOT_PROPOSER, [{ path: 'refusal/NOT_PROPOSER', message: REPROMISE_REFUSALS.NOT_PROPOSER }])
    return { context, line, site, proposal }
  })
}

/** Inside a decision's command: the proposal read again under the line's lock, still waiting. */
async function stillWaiting(tools: CommandTools, context: OfficeContext, proposal: ProposalRecord): Promise<ProposalRecord> {
  await lockLinePromise(tools.tx, context.tenantId, proposal.orderLineId)
  const fresh = (await readProposals(tools.tx, [proposal.orderId])).find((entry) => entry.id === proposal.id)
  if (!fresh || fresh.state !== 'WAITING') throw new DomainError('conflict', REPROMISE_REFUSALS.NOT_WAITING, [{ path: 'refusal/NOT_WAITING', message: REPROMISE_REFUSALS.NOT_WAITING }])
  return fresh
}

/** The task closed with the decision (DONE when accepted, CANCELLED otherwise). */
async function closeTask(tools: CommandTools, context: OfficeContext, proposal: ProposalRecord, status: 'DONE' | 'CANCELLED'): Promise<void> {
  const { tx, now } = tools
  const task = await tx.task.findUnique({ where: { id: proposal.id }, select: { id: true, version: true, status: true, companyId: true, siteId: true } })
  if (!task || task.status !== 'OPEN') return
  await tx.task.update({ where: { id: task.id }, data: { status, closedAt: now, closedById: context.actorId, snoozedUntil: null, version: task.version + 1, updatedAt: now }, select: { id: true } })
  tools.audit({ action: 'tasks.setStatus', recordType: 'Task', recordId: task.id, companyId: task.companyId, siteId: task.siteId, before: { status: 'OPEN' }, after: { status, by: status === 'DONE' ? DECISION_ACTIONS.ACCEPTED : 'planning.promise.decide' } })
  const about = { taskId: task.id, recordType: 'SalesOrder', recordId: proposal.orderId }
  const where = { subject: task.id, companyId: task.companyId, siteId: task.siteId }
  if (status === 'DONE') tools.emit(eventFor(taskCompleted, { ...where, payload: about }))
  else tools.emit(eventFor(taskChanged, { ...where, payload: { ...about, status, fields: ['status'] } }))
}

export interface AcceptBody {
  /** Send the message to the customer on the order's thread (by e-mail). */
  readonly tell: boolean
  /** B-PR-28: ask the customer to accept or refuse the new date (a REPROMISE approval; the date stands either way). */
  readonly askBrand?: boolean | undefined
  /** Other addresses than the proposal's (the order's buyer). */
  readonly to?: readonly string[] | undefined
  readonly subject?: string | undefined
  readonly body?: string | undefined
}

/** B-PR-28: how the APPROVAL link of the customer's question becomes its address (the office sign-in's link builder). */
export interface LinkBuilder {
  link(path: string, token: string): string
}

/** POST /planning/promises/re-promises/:proposalId/accept — sales gives the word. */
export async function acceptRepromise(caller: CommandCaller, proposalId: string, body: AcceptBody, idempotencyKey?: string, /* B-PR-28 */ links?: LinkBuilder) {
  const checked = await decisionChecks(caller, proposalId, 'SALES')
  const { context, line, site, proposal } = checked
  if (body.tell && !can(actorOf(context), EMAIL_SEND, { companyId: line.companyId })) throw new ForbiddenError()
  const now = serverClock.now()
  const today = businessDate(now, site.timezone)
  if (proposal.sizes.some((entry) => entry.to < today)) throw new DomainError('conflict', `${REPROMISE_REFUSALS.STALE} A proposed day has passed.`, [{ path: 'refusal/STALE', message: REPROMISE_REFUSALS.STALE }])
  const to = body.to && body.to.length > 0 ? [...body.to] : proposal.recipients
  if (body.tell && to.length === 0) throw new DomainError('conflict', REPROMISE_REFUSALS.NO_RECIPIENT, [{ path: 'body/to', message: REPROMISE_REFUSALS.NO_RECIPIENT }])
  const asks: PromiseAsk[] = proposal.sizes.map((entry) => ({ size: entry.size, date: entry.to }))
  const refused = await caller.withClient((db) => certificateRefusals(db, line, site, asks, now, (index) => `sizes/${index}`))
  if (refused.length > 0) throw new DomainError('conflict', `Only sizes a valid certificate covers through their date are promised: ${refused[0]!.message}`, refused)
  const sender = await caller.withClient((db) => db.user.findUnique({ where: { id: context.actorId }, select: { id: true, displayName: true, email: true } }))
  if (body.tell && !sender) throw new ForbiddenError()
  // B-PR-28: the customer's question, its id and its link's token made outside the command (the engine's own ask does the same).
  const brandAsk = body.askBrand === true ? (() => {
    const requestId = newId()
    const linkId = newId()
    const token = mintLinkToken({ tenantId: context.tenantId, partyId: line.partyId, linkId })
    return { requestId, linkId, token, dueAt: dueAtFor('REPROMISE', null, now) }
  })() : null
  const outcome = await command(caller, { name: DECISION_ACTIONS.ACCEPTED, idempotencyKey, input: { proposalId, ...body } }, async (tools) => {
    const { tx, now: at } = tools
    // The order's row first (W1's lock order: the line's date follows its latest size through W1's change), then the line's.
    await lockOrder(tx, line.orderId)
    const fresh = await stillWaiting(tools, context, proposal)
    const current = (await readKeepLine(tx, line.id))!
    const rows = (await readPromiseRows(tx, [line.id])).get(line.id) ?? []
    const typed = typedOf(current)
    const stale = fresh.sizes.findIndex((entry) => (currentPromiseOf(entry.size, rows, typed)?.date ?? null) !== entry.from)
    if (stale >= 0) throw new DomainError('conflict', REPROMISE_REFUSALS.STALE, [{ path: 'refusal/STALE', message: REPROMISE_REFUSALS.STALE }, { path: `sizes/${stale}`, message: REPROMISE_REFUSALS.STALE }])
    const planned = promisePlanOf({ asks, sizes: sizesOfLine(current).flatMap((entry) => (entry.size ? [entry.size] : [])), rows, typed, reasonCode: fresh.reasonCode, reason: fresh.reason })
    const plan = fresh.planVersionId ? await tx.planVersion.findFirst({ where: { id: fresh.planVersionId, siteId: site.id }, select: { id: true } }) : null
    const working = plan ?? (await tx.planVersion.findFirst({ where: { siteId: site.id, kind: 'WORKING' }, select: { id: true } }))
    const told = body.tell ? at : null
    const written: { id: string; size: string | null; promisedDate: string; kind: 'FIRST' | 'RE_PROMISE'; reasonCode: string | null; backfill: boolean; words: string }[] = []
    for (const row of planned.rows) {
      const id = newId()
      await tx.promiseRecord.create({
        data: {
          id,
          salesOrderLineId: line.id,
          partyId: line.partyId,
          size: row.size,
          promisedDate: new Date(`${row.promisedDate}T00:00:00.000Z`),
          kind: row.kind,
          reasonCode: row.reasonCode,
          reason: row.reason,
          // Sales gave the word; the typed date as the line's first promise was made with the order.
          promisedById: row.backfill ? (line.order.createdById ?? context.actorId) : context.actorId,
          promisedAt: row.backfill ? line.order.createdAt : at,
          siteId: row.backfill || !working ? null : site.id,
          planVersionId: row.backfill ? null : (working?.id ?? null),
          customerToldAt: row.backfill ? null : told,
          createdById: context.actorId,
        },
        select: { id: true },
      })
      written.push({ id, size: row.size, promisedDate: row.promisedDate, kind: row.kind, reasonCode: row.reasonCode, backfill: row.backfill, words: promiseRowWords(row, today) })
    }
    if (written.length > 0) {
      tools.emit({ type: 'order_promise.recorded', subject: line.orderId, companyId: line.companyId, siteId: site.id, payload: { orderId: line.orderId, orderLineId: line.id, siteId: working ? site.id : null, rows: written.map((row) => ({ size: row.size, promisedDate: row.promisedDate, kind: row.kind })) } })
    }
    // The line's date (W1) follows its latest open size: the portal, the order and every W1 reader see the new promise.
    const after = [...rows, ...written.map((row) => ({ id: row.id, size: row.size, promisedDate: row.promisedDate, kind: row.kind, promisedAt: row.backfill ? line.order.createdAt : at }))]
    const shipped = await shippedOfLines(tx, [line.id])
    const openSizes = sizesOfLine(current).filter((entry) => max0(entry.ordered - shipped(line.id, entry.size)) > 0)
    const lineDate = openSizes.reduce<BusinessDate | null>((best, entry) => {
      const date = currentPromiseOf(entry.size, after, typed)?.date ?? null
      return date !== null && (best === null || date > best) ? date : best
    }, null)
    const status = (await tx.salesOrder.findUniqueOrThrow({ where: { id: line.orderId }, select: { status: true } })).status as SalesOrderStatus
    let followed: BusinessDate | null = null
    if (lineDate !== null && lineDate !== typed && lineDate >= today && LINE_CHANGE_STATUSES.includes(status)) {
      await changePromiseInCommand(tools, { id: line.orderId, number: line.order.number, companyId: line.companyId }, { promiseDate: lineDate, reason: `${fresh.reasonCode}: re-promise accepted`, lineIds: [line.id] }, { history: false })
      followed = lineDate
    }
    // The message to the customer, on the order's thread (a person sends it now).
    let outboundId: string | null = null
    if (body.tell && sender) {
      const sent = await sendEmail(tools, {
        record: { type: 'SalesOrder', id: line.orderId },
        sender: { userId: sender.id, name: sender.displayName, email: sender.email },
        to,
        subject: body.subject?.trim() || fresh.message.subject,
        body: body.body?.trim() || fresh.message.body,
        locale: fresh.message.language,
      })
      outboundId = sent.outbound.id
    }
    await closeTask(tools, context, fresh, 'DONE')
    // B-PR-28: an older open question about this line's date is withdrawn (the date moved again); then, when sales says so, the
    // customer is asked about this one (the date stands either way).
    await withdrawOlderInCommand(tools, { orderId: line.orderId, orderLineId: line.id, actorId: context.actorId })
    const asked = brandAsk
      ? await askCustomerInCommand(tools, {
          context,
          line: current,
          proposal: fresh,
          sizes: fresh.sizes,
          requestId: brandAsk.requestId,
          linkId: brandAsk.linkId,
          tokenHash: linkTokenHash(brandAsk.token.value),
          dueAt: brandAsk.dueAt,
          locale: fresh.message.language,
          askedBy: sender ? { id: sender.id, name: sender.displayName } : null,
        })
      : null
    tools.audit({
      action: DECISION_ACTIONS.ACCEPTED,
      recordType: 'SalesOrder',
      recordId: line.orderId,
      companyId: line.companyId,
      siteId: site.id,
      before: { sizes: fresh.sizes.map((entry) => ({ size: entry.size, current: entry.from })) },
      after: { proposalId: fresh.id, decision: 'ACCEPTED', told: body.tell, outboundId, rows: written.length, lineDate: followed, /* B-PR-28 */ askedCustomer: asked?.requestId ?? null },
    })
    tools.emit({ type: 'order_promise.decided', subject: line.orderId, companyId: line.companyId, siteId: site.id, payload: { orderId: line.orderId, orderLineId: line.id, proposalId: fresh.id, decision: 'ACCEPTED', told: body.tell } })
    return { written, told: body.tell, outboundId, lineDate: followed, brandRequestId: asked?.requestId ?? null }
  })
  // B-PR-28: the link of the customer's question, once (a replay never hands it again: the token is not kept).
  const brandRequestId = outcome.result.brandRequestId ?? null
  const url = brandRequestId && brandAsk && !outcome.replayed && links ? links.link('/l', brandAsk.token.value) : null
  return { ...outcome.result, replayed: outcome.replayed, proposal: await proposalAfter(caller, proposalId), brandAsk: brandRequestId ? { requestId: brandRequestId, url } : null }
}

/** POST /planning/promises/re-promises/:proposalId/decline — sales says no, with its words. */
export async function declineRepromise(caller: CommandCaller, proposalId: string, body: { readonly reason: string }, idempotencyKey?: string) {
  const { context, line, site, proposal } = await decisionChecks(caller, proposalId, 'SALES')
  const reason = body.reason.trim()
  if (reason.length === 0) throw new ValidationError('Say why the new date is declined.', [{ path: 'body/reason', message: 'Say why (the planner reads it).' }])
  const outcome = await command(caller, { name: DECISION_ACTIONS.DECLINED, idempotencyKey, input: { proposalId, ...body } }, async (tools) => {
    const fresh = await stillWaiting(tools, context, proposal)
    await closeTask(tools, context, fresh, 'CANCELLED')
    tools.audit({ action: DECISION_ACTIONS.DECLINED, recordType: 'SalesOrder', recordId: line.orderId, companyId: line.companyId, siteId: site.id, after: { proposalId: fresh.id, decision: 'DECLINED' }, reason })
    tools.emit({ type: 'order_promise.decided', subject: line.orderId, companyId: line.companyId, siteId: site.id, payload: { orderId: line.orderId, orderLineId: line.id, proposalId: fresh.id, decision: 'DECLINED', told: false } })
    return { proposalId: fresh.id }
  })
  return { replayed: outcome.replayed, proposal: await proposalAfter(caller, proposalId) }
}

/** POST /planning/promises/re-promises/:proposalId/withdraw — the planner who proposed takes it back. */
export async function withdrawRepromise(caller: CommandCaller, proposalId: string, idempotencyKey?: string) {
  const { context, line, site, proposal } = await decisionChecks(caller, proposalId, 'PROPOSER')
  const outcome = await command(caller, { name: DECISION_ACTIONS.WITHDRAWN, idempotencyKey, input: { proposalId } }, async (tools) => {
    const fresh = await stillWaiting(tools, context, proposal)
    await closeTask(tools, context, fresh, 'CANCELLED')
    tools.audit({ action: DECISION_ACTIONS.WITHDRAWN, recordType: 'SalesOrder', recordId: line.orderId, companyId: line.companyId, siteId: site.id, after: { proposalId: fresh.id, decision: 'WITHDRAWN' } })
    tools.emit({ type: 'order_promise.decided', subject: line.orderId, companyId: line.companyId, siteId: site.id, payload: { orderId: line.orderId, orderLineId: line.id, proposalId: fresh.id, decision: 'WITHDRAWN', told: false } })
    return { proposalId: fresh.id }
  })
  return { replayed: outcome.replayed, proposal: await proposalAfter(caller, proposalId) }
}
