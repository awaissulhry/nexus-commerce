import type { Prisma } from '@nexus/factory-db'
import type { ApprovalField, PreviewChange } from '@nexus/factory-domain/approvals/rules'
import { InvalidStateError, type Issue } from '@nexus/factory-domain/core/errors'
import { fromMinorUnits, isMinorUnits } from '@nexus/factory-domain/core/money'
import { INVENTORY_COUNTS_VIEW } from '@nexus/factory-domain/inventory/counts/permissions'
import { differenceOf, differencePercent, differs, type LineFacts } from '@nexus/factory-domain/inventory/counts/rules'
import { COUNT_ITEM_KINDS } from '@nexus/factory-domain/inventory/counts/rules'
import { quantityText } from '@nexus/factory-domain/inventory/ledger/moves'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import type { CommandTools, CommandTx } from '../../../core/command'
import { lockCount, readCount, readLines, updateCount, type CountRow, type LineRow } from '../../../modules/inventory/counts/store'
import { ownVarianceRefusals, VARIANCE_RECORD } from '../../../modules/inventory/counts-depth/reads'
import { tenantOf } from '../../../modules/inventory/counts-depth/store'
import { blockForCount } from '../../../modules/inventory/locations-depth/blocks'
import type { ApprovalKindDefinition, ApprovalSubject, Reader, TaskRef } from './kind'

/**
 * COUNT_VARIANCE (B-W2b-299; SCM-229 "a variance above the rule asks a recount by another person, then a yes"; design
 * warehouse.counts cn-approval): a SUBMITTED stock count's differences, before they are approved. The counts' submit asks it
 * in its own command (modules/inventory/counts-depth/variance.ts) when an approval rule the Owner switched on holds; with no
 * rule the count is approved as W2a approves it (by a person who did not count the differences, over the value limit).
 *
 *   facts      the differences' worth (the cost grain; in the company's currency, the stored figure of the submit; unknown
 *              when a line has no cost or another currency), how many lines differ, the largest difference in percent of
 *              what was expected, how many hides differ, the count's kind, the scope's kind of material, the site's code
 *   snapshot   the count as submitted: its number and kind, every line's expected and final count and reason, the stored
 *              worth (a SUBMITTED count's lines never change: the database's history rule; a send back takes the request back)
 *   yes        APPROVED by the approver (never one who counted, recounted or scanned a line that differs while the separation
 *              switch is on: the words before the database's own rule), in the approver's command; then anyone with
 *              inventory.adjust applies it
 *   no         back to COUNTING with the reason (a recount): the place blocked again for a count of a place
 */

const HELD_NOT_SUBMITTED = (number: string, status: string) => `Count ${number} is ${status}: its differences are asked a yes once it is submitted.`

class CountVarianceRefusal extends InvalidStateError {
  override name = 'CountVarianceRefusal'
  override readonly issues: readonly Issue[]
  constructor(message: string, code: string) {
    super(message)
    this.issues = [{ path: `problem/${code}`, message }]
  }
}

const factsOf = (line: LineRow): LineFacts => ({
  expected: line.expectedQuantity.toString(),
  counted: line.countedQuantity === null ? null : line.countedQuantity.toString(),
  recountRequested: line.recountRequestedAt !== null,
  recount: line.recountQuantity === null ? null : line.recountQuantity.toString(),
})

async function readSubject(client: Reader, recordId: string): Promise<ApprovalSubject | null> {
  const count = await readCount(client, recordId)
  if (!count) return null
  const lines = await readLines(client, recordId)
  const site = await client.site.findUnique({ where: { id: count.siteId }, select: { code: true, company: { select: { currency: true } } } })
  if (!site) return null
  const differing = lines.filter((line) => differs(factsOf(line)))
  const percents = differing.map((line) => differencePercent(factsOf(line))).filter((value): value is string => value !== null)
  const largest = percents.length === 0 ? null : percents.map((value) => new Dec(value).abs()).reduce((max, value) => (value.greaterThan(max) ? value : max)).toFixed(1)
  const currency = site.company.currency
  const amount = count.differenceAmount
  const value = amount !== null && isMinorUnits(amount) ? fromMinorUnits(amount, currency).toFixed() : null
  const lineSnapshot = lines.map((line) => {
    const facts = factsOf(line)
    const difference = differenceOf(facts)
    return { seq: line.seq, expected: quantityText(facts.expected), final: facts.recount ?? facts.counted, difference: difference === null ? null : quantityText(difference), reasonCode: line.reasonCode }
  })
  const submitted = count.status === 'SUBMITTED'
  const changes: PreviewChange[] = [
    { field: 'status', from: count.status, to: 'APPROVED', grain: null },
    { field: 'differences', from: null, to: lineSnapshot.filter((line) => line.difference !== null && !new Dec(line.difference).isZero()), grain: null },
    ...(amount !== null ? [{ field: 'differenceAmount', from: null, to: amount, grain: 'cost' as const }] : []),
  ]
  return {
    companyId: count.companyId,
    siteId: count.siteId,
    label: `${count.number} · ${site.code}`,
    summary: `Count ${count.number} at ${site.code}: ${differing.length} line(s) of ${lines.length} differ`.slice(0, 500),
    facts: {
      differenceValue: value,
      differingLines: String(differing.length),
      largestDifferencePercent: largest,
      hidesDiffering: String(differing.filter((line) => line.hideId !== null).length),
      countKind: count.kind,
      itemKind: count.itemKind,
      siteCode: site.code,
    },
    snapshot: { countId: count.id, number: count.number, kind: count.kind, lines: lineSnapshot, differenceAmount: amount, currency, submittedAt: count.submittedAt ? count.submittedAt.toISOString() : null },
    changes,
    held: submitted ? null : HELD_NOT_SUBMITTED(count.number, count.status),
  }
}

function changed(tools: Pick<CommandTools, 'emit'>, row: CountRow, change: 'APPROVED' | 'SENT_BACK', previousStatus: CountRow['status'], lines: number): void {
  tools.emit({
    type: 'inventory.count_changed',
    subject: row.id,
    companyId: row.companyId,
    siteId: row.siteId,
    payload: {
      countId: row.id,
      number: row.number,
      kind: row.kind,
      status: row.status,
      previousStatus,
      change,
      lines,
      approvalRequired: row.submittedAt ? row.approvalRequired : null,
      scopeLocationId: row.locationId,
      scopeItemId: row.itemId,
      scopeLotId: row.lotId,
      scopeItemKind: row.itemKind,
    },
  })
}

/** The yes, in the approver's command: the count APPROVED by them (the counter never: the separation rule in words first). */
async function approveOnYes(tools: CommandTools, task: TaskRef): Promise<void> {
  const row = await lockCount(tools.tx, task.recordId)
  if (row.status !== 'SUBMITTED') throw new CountVarianceRefusal(HELD_NOT_SUBMITTED(row.number, row.status), 'NOT_SUBMITTED')
  const lines = await readLines(tools.tx, row.id)
  const approver = task.decidedById!
  const own = await ownVarianceRefusals(tools.tx, tenantOf(tools.context), row, lines, approver, true)
  if (own.length > 0) throw new CountVarianceRefusal(own[0]!.message, own[0]!.code)
  const written = await updateCount(tools, row, { status: 'APPROVED', approvedAt: tools.now, approvedById: approver, approvalNote: 'Approved in Approvals.' }, { action: 'inventory.counts.approve', reason: `The yes of request ${task.id}.` })
  changed(tools, written, 'APPROVED', row.status, lines.length)
}

/** The no: back to COUNTING with the approver's reason (a recount), as the counts' own send back does. */
async function sendBackOnNo(tools: CommandTools, task: TaskRef): Promise<void> {
  const row = await lockCount(tools.tx, task.recordId)
  if (row.status !== 'SUBMITTED') return
  const decided = await tools.tx.approvalTask.findUnique({ where: { id: task.id }, select: { rejectReason: true, rejectReasonCode: true } })
  const reason = [decided?.rejectReasonCode, decided?.rejectReason].filter((part): part is string => !!part && part.trim() !== '').join(' — ').slice(0, 500) || 'Not approved in Approvals.'
  const written = await updateCount(
    tools,
    row,
    { status: 'COUNTING', submittedAt: null, submittedById: null, differenceAmount: null, approvalRequired: true, rejectedAt: tools.now, rejectedById: task.decidedById, rejectReason: reason },
    { action: 'inventory.counts.sendBack', reason },
  )
  await blockForCount(tools, written)
  changed(tools, written, 'SENT_BACK', row.status, await tools.tx.stockCountLine.count({ where: { countId: row.id } }))
}

const KIND_OPTIONS = [...COUNT_ITEM_KINDS].map((value) => ({ value, label: { en: value.charAt(0) + value.slice(1).toLowerCase(), it: value.charAt(0) + value.slice(1).toLowerCase() } }))

export const COUNT_VARIANCE_KIND: ApprovalKindDefinition = Object.freeze({
  kind: 'COUNT_VARIANCE',
  recordType: VARIANCE_RECORD,
  label: { en: 'Count differences', it: 'Differenze di inventario' },
  view: INVENTORY_COUNTS_VIEW,
  // Only the counts' submit asks (POST /inventory/stock-counts/:countId/submit): never the generic route.
  ask: null,
  fields: Object.freeze<ApprovalField[]>([
    { id: 'differenceValue', label: { en: 'differences value', it: 'valore delle differenze' }, kind: 'number', grain: 'cost', min: 0 },
    { id: 'differingLines', label: { en: 'lines that differ', it: 'righe con differenza' }, kind: 'number', unit: null, min: 0 },
    { id: 'largestDifferencePercent', label: { en: 'largest difference', it: 'differenza più grande' }, kind: 'number', unit: '%', min: 0 },
    { id: 'hidesDiffering', label: { en: 'hides that differ', it: 'pelli con differenza' }, kind: 'number', unit: null, min: 0 },
    {
      id: 'countKind',
      label: { en: 'count kind', it: 'tipo di conteggio' },
      kind: 'choice',
      options: [
        { value: 'CYCLE', label: { en: 'Cycle count', it: 'Conteggio ciclico' } },
        { value: 'YEAR_END', label: { en: 'Year-end inventory', it: 'Inventario di fine anno' } },
      ],
    },
    { id: 'itemKind', label: { en: 'material kind', it: 'tipo di materiale' }, kind: 'choice', options: KIND_OPTIONS },
    { id: 'siteCode', label: { en: 'site code', it: 'codice sede' }, kind: 'text' },
  ]),
  read: readSubject,
  async lock(tx: CommandTx, recordId: string) {
    await lockCount(tx, recordId)
  },
  async recent(client: Reader, companyId: string | null, limit: number) {
    const where: Prisma.StockCountWhereInput = { status: { in: ['SUBMITTED', 'APPROVED', 'APPLIED', 'SIGNED_OFF'] }, ...(companyId ? { companyId } : {}) }
    const rows = await client.stockCount.findMany({ where, orderBy: [{ id: 'desc' }], take: limit, select: { id: true } })
    return rows.map((row) => row.id)
  },
  onApproved: approveOnYes,
  onRejected: sendBackOnNo,
})
