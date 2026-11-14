import type { AttentionCandidate } from '@nexus/factory-domain/insights/attention'
import { shipmentAtRiskWords } from '@nexus/factory-domain/insights/words'
import { shipmentsAtRiskFor } from '../../shipping/queue/queue'
import { asDay, type Source } from './common'

/**
 * Shipments at risk of missing their promise (B-W2b-386; LOG-110; design warehouse.shipments "At risk of missing the
 * promise"): the shipping queue's own at-risk reading (modules/shipping/queue: each open shipment's ship-by day — the current
 * promise of its garments — against its site's day and its carrier's cut-off on the site's clock, and its holds) for every
 * site the reader sees: late, past the cut-off (urgent), held, or not packed with the cut-off near. The customer's name is
 * the order's; never a person's.
 */
export const shipmentsAtRisk: Source = async ({ caller }) => {
  const { rows, complete } = await shipmentsAtRiskFor(caller)
  const candidates: AttentionCandidate[] = rows.flatMap((row) => {
    if (row.risk !== 'LATE' && row.risk !== 'HELD' && row.risk !== 'MISSED_CUT_OFF' && row.risk !== 'AT_RISK') return []
    const shipBy = row.shipBy ?? ''
    return [
      {
        kind: 'SHIPMENT_AT_RISK' as const,
        state: row.risk,
        severity: row.risk === 'LATE' || row.risk === 'MISSED_CUT_OFF' ? ('HIGH' as const) : ('MEDIUM' as const),
        record: { type: 'Shipment', id: row.id, label: row.number },
        scope: { companyId: row.companyId, siteId: row.siteId, partyId: row.partyId },
        ...shipmentAtRiskWords({ risk: row.risk, number: row.number, customer: row.partyName, shipBy }),
        due: row.shipBy,
        since: row.shipBy ? asDay(row.shipBy) : new Date(0),
        condition: [row.risk, ...row.holdReasons],
      },
    ]
  })
  return { kind: 'SHIPMENT_AT_RISK', candidates, complete }
}
