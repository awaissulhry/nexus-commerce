import { DISCREPANCY_LIMITS, discrepancyMachine, type DiscrepancyStatus } from '@nexus/factory-domain/inventory/receipts/discrepancies'
import type { CommandTools } from '../../../core/command'
import { actorIdOf } from '../store'
import type { ClaimRow } from './store'

/**
 * The receipt discrepancies a claim pursues follow it (B-W2a-31's rules, its `discrepancyMachine`): sent to the supplier
 * with the claim (OPEN → SENT, the claim's mail is the report), agreed when the supplier accepts it (SENT → AGREED),
 * closed with the claim (any → CLOSED, the claim's number and close note appended to the resolution). A discrepancy
 * already past the move keeps its state (a SENT one stays SENT when the claim is sent again; a CREDITED one only closes).
 * Inside the claim's command, under each receipt's discrepancy lock (`factory.receipt-discrepancy|company|receipt`, the
 * lock the receipts module takes for its own writes), one audit row and one `inventory.receipt_discrepancy_changed` per
 * discrepancy moved. Answers how many moved.
 */
export async function followDiscrepancies(tools: CommandTools, claim: Pick<ClaimRow, 'id' | 'number' | 'companyId' | 'siteId'>, to: 'SENT' | 'AGREED' | 'CLOSED', note?: string | null): Promise<number> {
  const { tx, now } = tools
  const lines = await tx.supplierClaimLine.findMany({ where: { claimId: claim.id, discrepancyId: { not: null } }, select: { discrepancyId: true } })
  const ids = [...new Set(lines.map((line) => line.discrepancyId!))]
  if (ids.length === 0) return 0
  const receipts = [...new Set((await tx.receiptDiscrepancy.findMany({ where: { id: { in: ids } }, select: { receiptId: true } })).map((row) => row.receiptId))].sort()
  for (const receiptId of receipts) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.receipt-discrepancy', ${claim.companyId}::uuid, ${receiptId}::uuid), 0))`
  }
  const rows = await tx.receiptDiscrepancy.findMany({ where: { id: { in: ids } }, select: { id: true, seq: true, kind: true, status: true, receiptId: true, resolutionNote: true }, orderBy: [{ receiptId: 'asc' }, { seq: 'asc' }] })
  let moved = 0
  for (const row of rows) {
    const from = row.status as DiscrepancyStatus
    if (!(discrepancyMachine.transitions[from] ?? []).includes(to)) continue
    const said = `Claim ${claim.number}${note?.trim() ? `: ${note.trim()}` : ''}`
    const resolution = to === 'CLOSED' ? [row.resolutionNote, said].filter((part): part is string => Boolean(part)).join(' · ').slice(0, DISCREPANCY_LIMITS.resolution) : row.resolutionNote
    await tx.receiptDiscrepancy.update({
      where: { id: row.id },
      data: {
        status: to,
        ...(to === 'SENT' ? { sentAt: now, sentById: actorIdOf(tools) } : {}),
        ...(to === 'CLOSED' ? { closedAt: now, resolutionNote: resolution } : {}),
        version: { increment: 1 },
      },
      select: { id: true },
    })
    tools.audit({
      action: 'purchasing.claims.followDiscrepancy',
      recordType: 'ReceiptDiscrepancy',
      recordId: row.id,
      companyId: claim.companyId,
      siteId: claim.siteId,
      before: { status: from },
      after: { status: to, claimId: claim.id, claim: claim.number, ...(to === 'CLOSED' ? { resolutionNote: resolution } : {}) },
    })
    tools.emit({
      type: 'inventory.receipt_discrepancy_changed',
      subject: row.receiptId,
      companyId: claim.companyId,
      siteId: claim.siteId,
      payload: { receiptId: row.receiptId, discrepancyId: row.id, seq: row.seq, kind: row.kind, status: to, change: to === 'SENT' ? 'CHANGED' : 'SETTLED' },
    })
    moved += 1
  }
  return moved
}
