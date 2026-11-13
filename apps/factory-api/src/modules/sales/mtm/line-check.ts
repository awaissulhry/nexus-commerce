import type { LineCheck, LineFinding } from '../line-checks/index'
import { serverClock } from '../../../core/time'
import { checkUnit } from './check'

/**
 * The made-to-measure line rule (B-W2b-358; PRD-017, PRD-288, SAL-292, SAL-300; one line of api sales/line-checks LINE_CHECKS):
 * every MADE_TO_MEASURE line of the quote version or order, read by its id (a typed office order has none: it takes no unit),
 * checked by ./check.ts. BLOCKS: made-to-measure not started for the style (MTM_NOT_STARTED), outside the certified range of
 * the basic model (MTM_OUTSIDE_RANGE: "the quote line shows an error and Make order is held"). WARNING: measures the factory has
 * not confirmed (the order waits for the review), a newer revision of the rider, measures older than 12 months. The codes are
 * factory-domain sales/mtm/codes (sales/quotes/send SEND_CHECK_CODES lists them).
 */
export const mtmLineCheck: LineCheck = {
  key: 'made-to-measure',
  async run(db, document) {
    const ids = document.lines.flatMap((line) => (line.id ? [line.id] : []))
    if (ids.length === 0) return []
    const rows =
      document.kind === 'QUOTE'
        ? await db.quoteLine.findMany({ where: { id: { in: ids }, kind: 'MADE_TO_MEASURE' }, select: { id: true, seq: true, styleId: true, colourwayId: true, measurementProfileId: true, baseSize: true } })
        : await db.salesOrderLine.findMany({ where: { id: { in: ids }, kind: 'MADE_TO_MEASURE' }, select: { id: true, seq: true, styleId: true, colourwayId: true, measurementProfileId: true, baseSize: true } })
    const findings: LineFinding[] = []
    for (const row of [...rows].sort((a, b) => a.seq - b.seq)) {
      if (!row.measurementProfileId) continue
      const answer = await checkUnit(db, { kind: document.kind, seq: row.seq, styleId: row.styleId, colourwayId: row.colourwayId, profileId: row.measurementProfileId, baseSize: row.baseSize, now: serverClock.now() })
      if (!answer) continue
      for (const finding of answer.findings) {
        findings.push({ check: 'made-to-measure', code: finding.code, severity: finding.severity, lineIds: [row.id], seqs: [row.seq], message: finding.message, details: { profileId: answer.profile.id, revision: answer.profile.revision, review: answer.profile.reviewStatus, verdict: answer.check.verdict } })
      }
    }
    return findings
  },
}
