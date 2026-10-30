import type { DocumentLanguage } from '@nexus/factory-domain/documents/model'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { purchaseOrderDocumentNumber } from '@nexus/factory-domain/purchasing/document'
import { answerOfState, changeWords, priceDiff, revisionDiff, type ChangeLabels, type RevisionDiff, type RevisionPrices, type RevisionState } from '@nexus/factory-domain/purchasing/revisions/revisions'
import type { CommandCaller } from '../../../core/command'
import { officeContextOf, officeOrder, seesCost, type Reader } from '../store'
import { keptStateOf, previousOf, readState, stateOf } from './state'

/**
 * Reading a purchase order's revisions (B-W2a-52; SCM-058; design purchasing.orders record › Confirmations & changes ›
 * Revisions "v1, v2: date, by, diff (ChangeValue per line), confirmed?", "Open PDF of each revision"): each revision row
 * with what changed from the one before (header fields; per line added, removed, cancelled or the fields from → to), the
 * supplier's answer to it (the state it was left in when the next revision started, or the order now for the current
 * one), the buyer's change note and its PDF; the prices that changed only for a caller with the cost grain. A draft of a
 * later revision shows its changes so far. The words are the supplier's (`changeWords`): the send's mail and the link
 * page use them too.
 */

/** Names for the lines and colours a set of states mentions (the material's code and name; the colour's name). */
export async function labelsFor(db: Reader, states: readonly (RevisionState | null)[]): Promise<ChangeLabels> {
  const lines = states.flatMap((state) => state?.lines ?? [])
  const itemIds = [...new Set(lines.map((line) => line.itemId))]
  const colourIds = [...new Set(lines.flatMap((line) => (line.itemColourId ? [line.itemColourId] : [])))]
  const items = new Map((itemIds.length === 0 ? [] : await db.item.findMany({ where: { id: { in: itemIds } }, select: { id: true, code: true, name: true } })).map((item) => [item.id, item]))
  const colours = new Map((colourIds.length === 0 ? [] : await db.itemColour.findMany({ where: { id: { in: colourIds } }, select: { id: true, name: true } })).map((colour) => [colour.id, colour.name]))
  const byLine = new Map(lines.map((line) => [line.id, line]))
  return {
    lineLabel: (lineId) => {
      const line = byLine.get(lineId)
      const item = line ? items.get(line.itemId) : undefined
      const code = line?.supplierArticleCode ?? item?.code ?? ''
      return [code, item?.name ?? ''].filter((part) => part !== '').join(' ')
    },
    colourName: (colourId) => colours.get(colourId) ?? null,
  }
}

/** What the draft of `revision` changes against the state it replaces (the send's mail, its check, the link page). */
export async function draftChangesOf(db: Reader, orderId: string, revision: number, language: DocumentLanguage): Promise<{ diff: RevisionDiff; words: string[] } | null> {
  const previous = await previousOf(db, orderId, revision)
  if (!previous) return null
  const { order, lines } = await readState(db, orderId)
  const after = stateOf(order, lines, 'SENT')
  const diff = revisionDiff(previous.state, after)
  return { diff, words: changeWords(diff, language, await labelsFor(db, [previous.state, after])) }
}

/** A revision's prices as the contract marks them (the cost grain on every amount). */
const plainPrices = (prices: RevisionPrices | null) =>
  prices === null
    ? null
    : { currency: prices.currency, netAmount: asMoney('cost', prices.netAmount), lines: prices.lines.map((line) => ({ id: line.id, seq: line.seq, unitPrice: asMoney('cost', line.unitPrice), netAmount: asMoney('cost', line.netAmount) })) }

const diffView = (diff: RevisionDiff) => ({
  header: diff.header.map((change) => ({ ...change })),
  lines: diff.lines.map((line) => ({ lineId: line.lineId, seq: line.seq, itemId: line.itemId, kind: line.kind, changes: line.changes.map((change) => ({ ...change })) })),
  count: diff.count,
})

/** GET /purchasing/orders/:purchaseOrderId/revisions (purchasing.view; the prices with the cost grain). */
export async function listRevisions(caller: CommandCaller, orderId: string, language: DocumentLanguage = 'en') {
  const context = officeContextOf(caller)
  const order = await officeOrder(caller, orderId)
  const withCost = seesCost(context)
  return caller.withClient(async (client) => {
    const rows = await client.purchaseOrderRevision.findMany({
      where: { purchaseOrderId: order.id },
      orderBy: { revision: 'asc' },
      select: { id: true, revision: true, sentAt: true, sentById: true, before: true, after: true, beforePrices: true, afterPrices: true, changeNote: true, documentFileId: true },
    })
    const people = new Map((await client.user.findMany({ where: { id: { in: [...new Set(rows.flatMap((row) => (row.sentById ? [row.sentById] : [])))] } }, select: { id: true, displayName: true } })).map((user) => [user.id, user.displayName]))
    const states = rows.flatMap((row) => [row.before as unknown as RevisionState | null, row.after as unknown as RevisionState])
    // The answer each revision got: the state kept when the next one started (or the next row's `before`), else the order now.
    const answers = await Promise.all(
      rows.map(async (row) => {
        if (row.revision === order.revision && order.status !== 'DRAFT') return { status: order.status, confirmation: order.confirmedAt ? { at: toUtcIso(order.confirmedAt), via: order.confirmedVia, byName: order.confirmedByName, supplierRef: order.supplierRef } : null }
        const next = rows.find((other) => other.revision === row.revision + 1)
        const kept = next?.before ? (next.before as unknown as RevisionState) : ((await keptStateOf(client, order.id, row.revision + 1))?.state ?? null)
        return kept ? { status: kept.status, confirmation: kept.confirmation } : { status: 'SENT', confirmation: null }
      }),
    )
    const draft = order.status === 'DRAFT' && order.revision > 1 ? await draftChangesOf(client, order.id, order.revision, language) : null
    const labels = await labelsFor(client, states)
    return {
      purchaseOrderId: order.id,
      number: order.number,
      revision: order.revision,
      status: order.status,
      /** A draft of a later revision: what it changes so far against the revision the supplier holds. */
      draft: draft ? { revision: order.revision, documentNumber: purchaseOrderDocumentNumber(order.number, order.revision), changes: diffView(draft.diff), words: draft.words } : null,
      revisions: rows.map((row, index) => {
        const before = row.before as unknown as RevisionState | null
        const after = row.after as unknown as RevisionState
        const diff = revisionDiff(before, after)
        const answer = answers[index]!
        const beforePrices = row.beforePrices as unknown as RevisionPrices | null
        const afterPrices = row.afterPrices as unknown as RevisionPrices
        const changed = priceDiff(beforePrices, afterPrices)
        const prices = withCost
          ? {
              before: plainPrices(beforePrices),
              after: plainPrices(afterPrices)!,
              changed: {
                netAmount: asMoney('cost', changed.netAmount ? { ...changed.netAmount } : null),
                lines: changed.lines.map((line) => ({ lineId: line.lineId, seq: line.seq, unitPrice: asMoney('cost', line.unitPrice ? { ...line.unitPrice } : null), netAmount: asMoney('cost', { ...line.netAmount }) })),
              },
            }
          : undefined
        return {
          id: row.id,
          revision: row.revision,
          documentNumber: purchaseOrderDocumentNumber(order.number, row.revision),
          sentAt: toUtcIso(row.sentAt),
          sentById: row.sentById,
          sentByName: row.sentById ? (people.get(row.sentById) ?? null) : null,
          changeNote: row.changeNote,
          documentFileId: row.documentFileId,
          changes: diffView(diff),
          words: changeWords(diff, language, labels),
          answer: answerOfState(answer.status, answer.confirmation !== null),
          confirmation: answer.confirmation,
          lines: after.lines.length,
          prices: asMoney('cost', prices),
        }
      }),
    }
  })
}
