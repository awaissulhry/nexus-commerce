import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { lineHistoryOf, sizeHistoryOf, sizeTimeline } from '@nexus/factory-domain/planning/promise-keep/history'
import { PROMISE_REASON_CODES, PROMISE_REASON_WORDS, dayWords, type PromiseReasonCode, type StoredPromise } from '@nexus/factory-domain/planning/promise/rules'
import type { CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { dayOf } from '../store'
import { keepLineFor, originalOf, readProposals, shippedOfLines, sizesOfLine, typedOf } from './store'

/**
 * One promise history per line (B-W2b-317; PLN-173; design planning.promise › lines "History popover on the Changes cell",
 * Sales › Order "Promise history"; "sales shows the first promise"): every PromiseRecord row of the line in the order it
 * was made — the first promise (kept forever), each re-promise with its reason (code and its customer words, the office's
 * note), who promised it (an office person, inside this one record), whether the customer was told — and per size its first
 * promise, its promise now, its changes and slips; the line's re-promises and what became of them. Read with
 * planning.promise.view over the line's making site and orders.view over its order.
 */

const reasonWords = (code: string | null) => (code && (PROMISE_REASON_CODES as readonly string[]).includes(code) ? PROMISE_REASON_WORDS[code as PromiseReasonCode] : null)

/** GET /planning/promises/order-lines/:orderLineId/history */
export async function promiseHistory(caller: CommandCaller, orderLineId: string) {
  return caller.withClient(async (db) => {
    const { line, site } = await keepLineFor(caller, db, orderLineId)
    const now = serverClock.now()
    const today = businessDate(now, site.timezone)
    const rows = await db.promiseRecord.findMany({
      where: { salesOrderLineId: line.id },
      select: { id: true, size: true, promisedDate: true, kind: true, reasonCode: true, reason: true, promisedAt: true, promisedById: true, customerToldAt: true, planVersionId: true },
      orderBy: [{ promisedAt: 'asc' }, { id: 'asc' }],
    })
    const stored: StoredPromise[] = rows.map((row) => ({ id: row.id, size: row.size, promisedDate: dayOf(row.promisedDate), kind: row.kind, promisedAt: row.promisedAt }))
    const typed = typedOf(line)
    const original = originalOf(line)
    const shipped = await shippedOfLines(db, [line.id])
    const sizes = sizesOfLine(line)
    const proposals = (await readProposals(db, [line.orderId])).filter((proposal) => proposal.orderLineId === line.id)
    const people = [...new Set([...rows.map((row) => row.promisedById), ...proposals.flatMap((proposal) => [proposal.proposedById, ...(proposal.decision ? [proposal.decision.byId] : [])])])]
    const names = people.length === 0 ? new Map<string, string>() : new Map((await db.user.findMany({ where: { id: { in: people } }, select: { id: true, displayName: true } })).map((user) => [user.id, user.displayName]))
    const person = (id: string | null) => (id && names.has(id) ? { id, name: names.get(id)! } : null)
    // How far each row moved the sizes it reached (the largest move), for the words.
    const shiftOf = new Map<string, number>()
    for (const entry of sizes) {
      for (const step of sizeTimeline(entry.size, stored)) {
        if (step.shiftDays === null) continue
        const seen = shiftOf.get(step.rowId)
        if (seen === undefined || Math.abs(step.shiftDays) > Math.abs(seen)) shiftOf.set(step.rowId, step.shiftDays)
      }
    }
    const summary = lineHistoryOf(
      sizes.map((entry) => entry.size),
      stored,
      typed,
      original,
    )
    return {
      site: { id: site.id, code: site.code, name: site.name },
      today,
      asOf: toUtcIso(now),
      order: { id: line.order.id, number: line.order.number, status: line.order.status, promiseDate: line.order.promiseDate ? dayOf(line.order.promiseDate) : null, originalPromiseDate: original },
      line: { id: line.id, seq: line.seq, kind: line.kind, style: { id: line.style.id, code: line.style.code, name: line.style.name }, colourway: line.colourway, promiseDate: line.promiseDate ? dayOf(line.promiseDate) : null },
      first: summary.first,
      current: summary.current,
      changes: summary.changes,
      slips: summary.slips,
      sizes: sizes.map((entry) => {
        const history = sizeHistoryOf(entry.size, stored, typed, original)
        return {
          size: entry.size,
          ordered: entry.ordered,
          open: Math.max(0, entry.ordered - shipped(line.id, entry.size)),
          first: history.first,
          current: history.current ? { date: history.current.date, source: history.current.source, kind: history.current.kind } : null,
          changes: history.changes,
          slips: history.slips,
          driftDays: history.driftDays,
        }
      }),
      rows: rows.map((row) => {
        const shift = shiftOf.get(row.id) ?? null
        const reason = reasonWords(row.reasonCode)
        const who = row.size === null ? 'Every size' : `Size ${row.size}`
        return {
          id: row.id,
          size: row.size,
          promisedDate: dayOf(row.promisedDate),
          kind: row.kind,
          reasonCode: row.reasonCode,
          reasonWords: reason,
          reason: row.reason,
          promisedAt: toUtcIso(row.promisedAt),
          promisedBy: person(row.promisedById),
          customerToldAt: row.customerToldAt ? toUtcIso(row.customerToldAt) : null,
          fromPlan: row.planVersionId !== null,
          shiftDays: shift,
          words:
            row.kind === 'FIRST'
              ? `${who}: first promise ${dayWords(dayOf(row.promisedDate), today)}.`
              : `${who}: re-promised ${dayWords(dayOf(row.promisedDate), today)}${shift !== null && shift !== 0 ? ` (${shift > 0 ? `+${shift}` : shift} days)` : ''}${reason ? ` · ${reason.en}` : ''}${row.customerToldAt ? ' · customer told' : ''}.`,
        }
      }),
      proposals: proposals.map((proposal) => ({
        id: proposal.id,
        state: proposal.state,
        sizes: proposal.sizes,
        reasonCode: proposal.reasonCode,
        reason: proposal.reason,
        proposedAt: toUtcIso(proposal.proposedAt),
        proposedBy: person(proposal.proposedById),
        decidedAt: proposal.decision ? toUtcIso(proposal.decision.at) : null,
        decidedBy: proposal.decision ? person(proposal.decision.byId) : null,
        decisionReason: proposal.decision?.reason ?? null,
        told: proposal.decision?.told ?? false,
      })),
    }
  })
}
