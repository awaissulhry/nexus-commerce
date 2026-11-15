import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { DomainError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate, businessDayStart, toUtcIso } from '@nexus/factory-domain/core/time'
import { cleanBody } from '@nexus/factory-domain/threads/rules'
import { matchesScope } from '@nexus/factory-domain/insights/attention'
import { NUDGE_KINDS, NUDGE_REFUSALS, nudgeNote, nudgeRefusal, WAITING_KINDS, WAITING_RULES, waitingFor, waitingKindsFor, type NudgeRefusal, type WaitingCandidate } from '@nexus/factory-domain/insights/waiting'
// B-W2b-388: mail with no reply in 3 working days, links not opened.
import { LINK_UNOPENED_HOURS, linkUnopenedWords, messageReplyWords, REPLY_LOOKBACK_DAYS, REPLY_WORKING_DAYS } from '@nexus/factory-domain/insights/waiting'
import { addWorkingDaysFor } from '../../platform/calendars/service'
import { recordLabelOf } from '../../platform/threads/labels'
import { approvalRequestWords, poConfirmationWords, quoteAnswerWords } from '@nexus/factory-domain/insights/words'
import { PURCHASING_VIEW } from '@nexus/factory-domain/purchasing/permissions'
import { QUOTES_VIEW } from '@nexus/factory-domain/sales/quotes/permissions'
import { command, type CommandCaller, type CommandTx } from '../../core/command'
import { ruleContext } from '../../platform/notifications/fan-out'
import { quoteDeciders } from '../../platform/notifications/rules/approvals'
import { ensureThread, writeMessage } from '../../platform/threads/threads'
import { dayOrNull, partyNames, SOURCE_LIMIT } from './sources/common'
import { amountsView } from './today'
import { officeContextOf, scopeFilterOf, viewerOf } from './viewer'

/**
 * GET /home/waiting-on-others (B-W1-52; design home.today `waiting-on`): what the person asked for or sent and still
 * waits on: their quote approval requests not decided, the purchase orders they sent and the supplier has not confirmed,
 * the quote versions they sent and the customer has not answered. Only records they still see (factory-domain
 * insights/waiting waitsFor); amounts follow their grains. Nudge is W2a. Read only.
 */

export async function waitingOnOthers(caller: CommandCaller, query: { readonly companyId?: string | undefined; readonly siteId?: string | undefined }) {
  const viewer = viewerOf(caller)
  const filter = await scopeFilterOf(caller, query)
  const kinds = waitingKindsFor(viewer.actor)
  const me = viewer.personId
  const candidates = await caller.withClient(async (db) => {
    const found: WaitingCandidate[] = []
    if (kinds.includes('APPROVAL_REQUEST') || kinds.includes('QUOTE_ANSWER')) {
      const quoteScope = scopeWhere(viewer.actor, QUOTES_VIEW, { company: 'companyId', party: 'partyId' }) as Prisma.QuoteWhereInput
      const approvals = await db.quoteApproval.findMany({ where: { status: 'PENDING', createdById: me }, take: SOURCE_LIMIT, select: { versionId: true, reasons: true, createdAt: true, createdById: true } })
      const sent = await db.quoteVersion.findMany({ where: { status: 'SENT', sentById: me }, take: SOURCE_LIMIT, select: { id: true } })
      const versions = await db.quoteVersion.findMany({
        where: { id: { in: [...approvals.map((row) => row.versionId), ...sent.map((row) => row.id)] }, quote: quoteScope },
        select: { id: true, quoteId: true, revision: true, status: true, currency: true, netAmount: true, marginPct: true, marginAmount: true, validUntil: true, sentAt: true, sentById: true },
      })
      const quotes = versions.length > 0 ? await db.quote.findMany({ where: { id: { in: [...new Set(versions.map((row) => row.quoteId))] } }, select: { id: true, number: true, companyId: true, partyId: true } }) : []
      const names = await partyNames(db, quotes.map((row) => row.partyId))
      for (const approval of approvals) {
        const version = versions.find((row) => row.id === approval.versionId)
        const quote = version ? quotes.find((row) => row.id === version.quoteId) : undefined
        if (!version || !quote) continue
        const margin = approval.reasons.includes('MARGIN_FLOOR')
        found.push({
          kind: 'APPROVAL_REQUEST',
          record: { type: 'Quote', id: quote.id, label: quote.number },
          scope: { companyId: quote.companyId, siteId: null, partyId: quote.partyId },
          requestedBy: approval.createdById,
          sentence: approvalRequestWords({ number: quote.number, customer: names.get(quote.partyId) ?? 'the customer', reasons: approval.reasons }),
          waitingFor: 'An approver of quotes',
          since: approval.createdAt,
          due: dayOrNull(version.validUntil),
          amounts: {
            currency: version.currency,
            netAmount: version.netAmount,
            marginPct: version.marginPct === null ? null : version.marginPct.toString(),
            marginAmount: version.marginAmount,
            inSentence: margin ? 'marginPct' : 'netAmount',
          },
        })
      }
      for (const version of versions.filter((row) => row.status === 'SENT')) {
        const quote = quotes.find((row) => row.id === version.quoteId)
        if (!quote) continue
        const customer = names.get(quote.partyId) ?? 'the customer'
        found.push({
          kind: 'QUOTE_ANSWER',
          record: { type: 'Quote', id: quote.id, label: quote.number },
          scope: { companyId: quote.companyId, siteId: null, partyId: quote.partyId },
          requestedBy: version.sentById,
          sentence: quoteAnswerWords({ number: quote.number, revision: version.revision, customer }),
          waitingFor: customer,
          since: version.sentAt ?? viewer.now,
          due: dayOrNull(version.validUntil),
          amounts: { currency: version.currency, netAmount: version.netAmount, inSentence: 'netAmount' },
        })
      }
    }
    if (kinds.includes('PO_CONFIRMATION')) {
      const scope = scopeWhere(viewer.actor, PURCHASING_VIEW, { company: 'companyId', site: 'siteId', party: 'partyId' }) as Prisma.PurchaseOrderWhereInput
      const orders = await db.purchaseOrder.findMany({
        where: { AND: [scope, { status: 'SENT', sentById: me }] },
        orderBy: [{ sentAt: 'asc' }, { id: 'asc' }],
        take: SOURCE_LIMIT,
        select: { id: true, number: true, companyId: true, siteId: true, partyId: true, currency: true, netAmount: true, requestedDate: true, sentAt: true, sentById: true, createdAt: true },
      })
      const names = await partyNames(db, orders.map((row) => row.partyId))
      for (const order of orders) {
        const supplier = names.get(order.partyId) ?? 'the supplier'
        found.push({
          kind: 'PO_CONFIRMATION',
          record: { type: 'PurchaseOrder', id: order.id, label: order.number },
          scope: { companyId: order.companyId, siteId: order.siteId, partyId: order.partyId },
          requestedBy: order.sentById,
          sentence: poConfirmationWords({ number: order.number, supplier }),
          waitingFor: supplier,
          since: order.sentAt ?? order.createdAt,
          due: dayOrNull(order.requestedDate),
          amounts: { currency: order.currency, purchaseAmount: order.netAmount, inSentence: 'purchaseAmount' },
        })
      }
    }
    // B-W2b-388: the mail I sent from a record's conversation that its party has not answered in 3 working days (the last
    // mail of mine per conversation, within the last 30 days), and the links I made that nobody opened yet.
    if (kinds.includes('MESSAGE_REPLY')) {
      const lookback = new Date(viewer.now.getTime() - REPLY_LOOKBACK_DAYS * 86_400_000)
      const sent = await db.message.findMany({
        where: { direction: 'OUTBOUND', authorKind: 'USER', authorId: me, at: { gte: lookback, lte: viewer.now } },
        orderBy: [{ at: 'desc' }, { id: 'desc' }],
        take: SOURCE_LIMIT,
        select: { id: true, threadId: true, at: true, thread: { select: { recordType: true, recordId: true, companyId: true, siteId: true, partyId: true } } },
      })
      const lastPerThread = new Map<string, (typeof sent)[number]>()
      for (const message of sent) if (!lastPerThread.has(message.threadId)) lastPerThread.set(message.threadId, message)
      const answered = lastPerThread.size === 0 ? [] : await db.message.findMany({ where: { threadId: { in: [...lastPerThread.keys()] }, direction: 'INBOUND', at: { gte: lookback } }, select: { threadId: true, at: true } })
      const names = await partyNames(db, [...lastPerThread.values()].map((message) => message.thread.partyId))
      const dueBy = new Map<string, string | null>()
      for (const message of lastPerThread.values()) {
        if (answered.some((reply) => reply.threadId === message.threadId && reply.at > message.at)) continue
        const sentDay = businessDate(message.at)
        const calendarKey = `${message.thread.companyId ?? ''}:${sentDay}`
        if (!dueBy.has(calendarKey)) {
          dueBy.set(calendarKey, message.thread.companyId ? (await addWorkingDaysFor(db, { scope: 'COMPANY', id: message.thread.companyId }, sentDay, REPLY_WORKING_DAYS)).date : plainWorkingDays(sentDay, REPLY_WORKING_DAYS))
        }
        const due = dueBy.get(calendarKey) ?? null
        if (due === null || viewer.today <= due) continue
        const label = await recordLabelOf(db, message.thread.recordType, message.thread.recordId)
        if (label === null) continue
        const party = message.thread.partyId ? (names.get(message.thread.partyId) ?? 'The party') : 'The party'
        found.push({
          kind: 'MESSAGE_REPLY',
          record: { type: message.thread.recordType, id: message.thread.recordId, label },
          scope: { companyId: message.thread.companyId, siteId: message.thread.siteId, partyId: message.thread.partyId },
          requestedBy: me,
          sentence: messageReplyWords({ label, party }),
          waitingFor: party,
          since: message.at,
          due: null,
        })
      }
    }
    if (kinds.includes('LINK_UNOPENED')) {
      const links = await db.oneOffLink.findMany({
        where: { createdById: me, lastUsedAt: null, revokedAt: null, expiresAt: { gt: viewer.now }, createdAt: { lte: new Date(viewer.now.getTime() - LINK_UNOPENED_HOURS * 3_600_000) } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: SOURCE_LIMIT,
        select: { id: true, companyId: true, partyId: true, recordType: true, recordId: true, createdAt: true, expiresAt: true },
      })
      const names = await partyNames(db, links.map((link) => link.partyId))
      for (const link of links) {
        const label = await recordLabelOf(db, link.recordType, link.recordId)
        if (label === null) continue
        const party = names.get(link.partyId) ?? 'The party'
        found.push({
          kind: 'LINK_UNOPENED',
          record: { type: link.recordType, id: link.recordId, label },
          scope: { companyId: link.companyId, siteId: null, partyId: link.partyId },
          requestedBy: me,
          sentence: linkUnopenedWords({ label, party }),
          waitingFor: party,
          since: link.createdAt,
          due: dayOrNull(link.expiresAt),
        })
      }
    }
    return found
  })
  const items = waitingFor(viewer, candidates).filter((item) => matchesScope(item, filter))
  // W2a: may the person nudge it now (an approval they asked for, not nudged today)?
  const nudged = await caller.withClient((db) => nudgedToday(db, me, items.filter((item) => NUDGE_KINDS.includes(item.kind)).map((item) => item.record.id), businessDayStart(viewer.today)))
  return {
    asOf: toUtcIso(viewer.now),
    counts: { total: items.length, byKind: WAITING_KINDS.filter((kind) => kinds.includes(kind)).map((kind) => ({ kind, label: WAITING_RULES[kind].label, count: items.filter((item) => item.kind === kind).length })) },
    items: items.map((item) => ({
      key: item.key,
      kind: item.kind,
      record: item.record,
      companyId: item.companyId,
      siteId: item.siteId,
      partyId: item.partyId,
      sentence: item.sentence,
      waitingFor: item.waitingFor,
      since: toUtcIso(item.since),
      ageDays: item.ageDays,
      due: item.due,
      figures: amountsView(item.amounts),
      /** W2a: Nudge (POST …/:key/nudge): allowed now, or the refusal's code (OUTSIDE, TODAY_ALREADY). */
      nudge: NUDGE_KINDS.includes(item.kind) ? (nudged.has(item.record.id) ? { allowed: false, refusal: 'TODAY_ALREADY' as const } : { allowed: true, refusal: null }) : { allowed: false, refusal: 'OUTSIDE' as const },
    })),
    live: { events: [...new Set(kinds.flatMap((kind) => WAITING_RULES[kind].live))].sort() },
  }
}

/** B-W2b-388: a record of no company has no calendar: Monday to Friday. */
function plainWorkingDays(day: string, days: number): string {
  const date = new Date(`${day}T12:00:00.000Z`)
  let left = days
  while (left > 0) {
    date.setUTCDate(date.getUTCDate() + 1)
    const weekday = date.getUTCDay()
    if (weekday !== 0 && weekday !== 6) left -= 1
  }
  return date.toISOString().slice(0, 10)
}

// ---- Nudge (W2a, B-W2a-20; design home.today waiting-on "Nudge (sends a reminder in the record's thread, once a day at most)")

/** The nudges the person made today, by record id (the audit rows `insights.nudge` of the record, by them, since the day began). */
export async function nudgedToday(db: FactoryClient | CommandTx, personId: string, recordIds: readonly string[], dayStart: Date): Promise<Set<string>> {
  if (recordIds.length === 0) return new Set()
  const rows = await db.auditLog.findMany({ where: { action: 'insights.nudge', actorId: personId, recordId: { in: [...new Set(recordIds)] }, at: { gte: dayStart } }, select: { recordId: true } })
  return new Set(rows.map((row) => row.recordId))
}

const nudgeRefused = (code: NudgeRefusal) => new DomainError('conflict', NUDGE_REFUSALS[code], [{ path: `nudge/${code}`, message: NUDGE_REFUSALS[code] }])

/**
 * POST /home/waiting-on-others/:key/nudge: remind the people I wait on, once a business day per record. Only an approval
 * I asked for (a customer or supplier is reminded from its record's mail, behind its module's rules). ONE command: a
 * reminder note on the record's thread (written by the system, naming me), the audit row `insights.nudge` on the record
 * (what "once a day" reads), and `attention.nudged`, which tells each person who may decide (platform/notifications).
 */
export async function nudge(caller: CommandCaller, key: string, idempotencyKey?: string) {
  const viewer = viewerOf(caller)
  const context = officeContextOf(caller)
  const answer = await waitingOnOthers(caller, {})
  const item = answer.items.find((entry) => entry.key === key)
  if (!item) throw new NotFoundError('This is not something you wait on (any more).')
  if (!NUDGE_KINDS.includes(item.kind)) throw nudgeRefused('OUTSIDE')
  const { result } = await command(caller, { name: 'insights.nudge', idempotencyKey, input: { key } }, async (tools) => {
    const { tx, now } = tools
    if ((await nudgedToday(tx, context.actorId, [item.record.id], businessDayStart(viewer.today))).size > 0) throw nudgeRefused('TODAY_ALREADY')
    const deciders = await quoteDeciders(ruleContext(tx, context.tenantId, now), item.record.id)
    const refusal = nudgeRefusal(item.kind, false, deciders.length)
    if (refusal !== null) throw nudgeRefused(refusal)
    const me = await tx.user.findUnique({ where: { id: context.actorId }, select: { displayName: true } })
    const { thread } = await ensureThread(tools, { type: item.record.type, id: item.record.id }, context.actorId)
    const message = await writeMessage(tools, thread, {
      direction: 'INTERNAL_NOTE',
      channel: 'APP',
      author: { kind: 'SYSTEM', id: null, name: null },
      bodyText: cleanBody(nudgeNote({ label: item.record.label, ageDays: item.ageDays, byName: me?.displayName ?? 'a colleague' })),
    })
    tools.audit({ action: 'insights.nudge', recordType: item.record.type, recordId: item.record.id, companyId: item.companyId, siteId: item.siteId, after: { key, kind: item.kind, messageId: message.id, deciders: deciders.length } })
    tools.emit({ type: 'attention.nudged', subject: item.record.id, companyId: item.companyId, siteId: item.siteId, payload: { key, kind: item.kind, recordType: item.record.type, recordId: item.record.id, messageId: message.id, byId: context.actorId } })
    return { key, nudgedAt: toUtcIso(now), messageId: message.id, told: deciders.length }
  })
  return result
}
