import { REGISTER_LIMITS } from '@nexus/factory-domain/compliance/register/rules'
import { isSafetyReturn, type ReturnCause } from '@nexus/factory-domain/sales/returns/rules'
import type { CommandTools } from '../../../core/command'
import { addToRegisterEntryFor, openRegisterEntryFor } from '../../compliance/register/hook'
import { readEntryBySource } from '../../compliance/register/store'
import { soldFactsOf, lineKeyOf, type LineRow, type RmaRow } from './store'

/**
 * A protective garment returned for a defect (or found defective or misused at the inspection) goes into the PPE
 * register (Reg. (EU) 2016/425 art. 8(4): the manufacturer keeps a register of complaints; W1's register, B-W1-43), in
 * the same command as the return or the decision: ONE entry per return (B-W2b-F1, Z4:02: its source is the
 * ReturnAuthorisation; the register's partial unique index holds one entry per source), kind COMPLAINT, the customer as
 * the reporting party, the style, risk ASSESSING. Its lists name every shipment the return's safety lines left on (lines
 * from several shipments share the one entry), with their batches and serials as read:
 *
 *   the first call    the safety lines it is given open the entry together (one description, every line in it)
 *   a later line      (added to the RMA, its reason changed, or decided later) adds its shipment, batch and serial to
 *                     the entry while it is OPEN, and its words when they still fit (compliance's addToRegisterEntryFor);
 *                     a line the entry names already adds nothing
 *   left to a person  a line of another style than the entry's (one entry concerns one style), a line that comes after
 *                     the entry was CLOSED, or a line with no shipment known (a sample invoiced alone): none is written,
 *                     the line's words say to record it in Compliance › PPE register by hand
 *
 * Office and system commands only (the floor's grading opens it at the decision).
 */

export interface SafetyEntry {
  readonly lineId: string
  readonly seq: number
  /** null: nothing to open it from (no shipment known), the line's words say so. */
  readonly entryId: string | null
  readonly reference: string | null
  readonly opened: boolean
  readonly words: string
}

/** A safety line with what the register needs of it. */
interface SafetyLine {
  readonly line: LineRow
  readonly styleId: string
  readonly shipmentId: string
  /** "Line 10: …, returned for defect." (the entry's description names each line by it). */
  readonly sentence: string
}

const byHand = (seq: number) => `record line ${seq} in Compliance › PPE register by hand.`

export async function openSafetyEntries(tools: CommandTools, rma: Pick<RmaRow, 'id' | 'number' | 'companyId' | 'partyId' | 'requestedAt'>, lines: readonly LineRow[]): Promise<SafetyEntry[]> {
  if (tools.context.audience !== 'office' && tools.context.audience !== 'system') return []
  const { tx } = tools
  const sold = await soldFactsOf(tx, lines)
  const answers = new Map<string, SafetyEntry>()
  const safety: SafetyLine[] = []
  for (const line of lines) {
    const facts = sold.get(lineKeyOf(line))
    const ppe = facts?.style?.ppe ?? false
    if (!isSafetyReturn({ ppe, reasonCode: line.reasonCode, cause: line.cause as ReturnCause | null })) continue
    const orderLineId = facts?.orderLine?.id ?? null
    const shipment = orderLineId
      ? await tx.shipmentLine.findFirst({
          where: { salesOrderLineId: orderLineId, ...(line.size ? { size: line.size } : {}), shipment: { status: { in: ['SHIPPED', 'DELIVERED'] } } },
          select: { shipmentId: true },
          orderBy: { createdAt: 'desc' },
        })
      : null
    if (!shipment || !facts?.style) {
      answers.set(line.id, { lineId: line.id, seq: line.seq, entryId: null, reference: null, opened: false, words: `Line ${line.seq} names no shipment: ${byHand(line.seq)}` })
      continue
    }
    const why = line.cause ? `found ${line.cause.toLowerCase().replace('_', ' ')} at the inspection` : `returned for ${line.reasonCode.toLowerCase().replace(/_/g, ' ')}`
    const sentence = `Line ${line.seq}: ${line.description}, ${why}.${line.reasonNote ? ` The customer: ${line.reasonNote}` : ''}${line.conditionNote ? ` Condition: ${line.conditionNote}` : ''}`
    safety.push({ line, styleId: facts.style.id, shipmentId: shipment.shipmentId, sentence })
  }

  if (safety.length > 0) {
    const source = { type: 'ReturnAuthorisation', id: rma.id } as const
    const existing = await readEntryBySource(tx, source.type, source.id)
    const styleId = existing?.styleId ?? safety[0]!.styleId
    const joining = safety.filter((entry) => entry.styleId === styleId)
    const facts = (entries: readonly SafetyLine[]) => ({
      shipmentIds: entries.map((entry) => entry.shipmentId),
      serials: entries.flatMap((entry) => (entry.line.serial ? [entry.line.serial] : [])),
      batchNumbers: entries.flatMap((entry) => (entry.line.batchNumber ? [entry.line.batchNumber] : [])),
    })
    let entry: { id: string; reference: string }
    if (!existing) {
      const opened = await openRegisterEntryFor(tools, {
        companyId: rma.companyId,
        kind: 'COMPLAINT',
        styleId,
        ...facts(joining),
        // "Return RMA-2026-0001 line 10: … Line 20: …" (W2a's words for one line).
        description: `Return ${rma.number} ${joining.map((line) => line.sentence).join(' ').replace(/^Line /, 'line ')}`.slice(0, REGISTER_LIMITS.description),
        partyId: rma.partyId,
        reportedAt: rma.requestedAt,
        source,
      })
      entry = { id: opened.entryId, reference: opened.reference }
      const first = joining[0]!.line
      for (const { line } of joining) {
        answers.set(line.id, line === first
          ? { lineId: line.id, seq: line.seq, entryId: entry.id, reference: entry.reference, opened: true, words: `PPE register entry ${entry.reference} opened.` }
          : { lineId: line.id, seq: line.seq, entryId: entry.id, reference: entry.reference, opened: false, words: `In PPE register entry ${entry.reference} (the return's), with line ${first.seq}.` })
      }
    } else {
      entry = { id: existing.id, reference: existing.reference }
      // A line the description names already (the same line decided later) adds no words again.
      const fresh = joining.filter(({ line }) => !existing.description.toLowerCase().includes(`line ${line.seq}:`))
      const added = await addToRegisterEntryFor(tools, existing.id, { ...facts(joining), description: fresh.map((line) => line.sentence).join(' ') })
      for (const { line } of joining) {
        answers.set(line.id, {
          lineId: line.id,
          seq: line.seq,
          entryId: entry.id,
          reference: entry.reference,
          opened: false,
          words: added.closed ? `The return's PPE register entry ${entry.reference} is closed: ${byHand(line.seq)}` : `In PPE register entry ${entry.reference} (the return's).`,
        })
      }
    }
    for (const { line } of safety.filter((candidate) => candidate.styleId !== styleId)) {
      answers.set(line.id, { lineId: line.id, seq: line.seq, entryId: null, reference: null, opened: false, words: `Line ${line.seq} is of another style than the return's PPE register entry ${entry.reference}: ${byHand(line.seq)}` })
    }
  }
  return lines.flatMap((line) => answers.get(line.id) ?? [])
}
