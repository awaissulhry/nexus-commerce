'use client'

/**
 * ER3.2 (delta 6) — the Why pane: renders the evaluator's real reasoning for
 * one suggestion — rule link, window facts, each condition's value vs its
 * comparison (benchmark-resolved since ER3.2), clamp notes. No storytelling:
 * only what the engine recorded.
 */
import Link from 'next/link'
import { H10Modal } from '../../_lib/modal'
import { eurC } from '../../_lib'
import { type WhyReasoning, conditionSentence, CENTS_METRICS, PCT_METRICS, type RuleCondition } from '../_lib/rules'

const fmtVal = (c: RuleCondition, v: number | null): string => {
  if (v == null) return '—'
  if (CENTS_METRICS.includes(c.metric)) return eurC(Math.round(v))
  if (PCT_METRICS.includes(c.metric)) return `${v.toFixed(2)}%`
  if (c.metric === 'rate_minus_breakeven') return `${v.toFixed(1)} pts`
  return Math.round(v).toLocaleString('en-IE')
}

export function WhyModal({ open, onClose, title, reasoning, ruleName, campaignId, estimatedImpact }: {
  open: boolean; onClose: () => void; title: string
  reasoning: WhyReasoning | null; ruleName: string | null; campaignId?: string
  estimatedImpact?: { feesDeltaCentsPerWeek?: number; salesAtRiskCentsPerWeek?: number; assumption: string } | null
}) {
  const r = reasoning ?? {}
  const rows = r.conditionResults ?? r.conditions?.map((c) => ({ ...c, value: null, cmp: null, pass: null })) ?? []
  return (
    <H10Modal open={open} onClose={onClose} title="Why this suggestion" subtitle={title}
      footer={<><span style={{ flex: 1 }} /><button type="button" className="h10-am-btn" onClick={onClose}>Close</button></>}>
      <p className="eb-be-hint" style={{ marginBottom: 8 }}>
        Rule: <b>{ruleName ?? r.rule ?? '—'}</b>
        {campaignId && <> · <Link className="h10-am-link" href={`/marketing/ads/ebay/campaigns/${campaignId}`}>open campaign →</Link></>}
      </p>
      {rows.length > 0 && (
        <table className="eb-why-table">
          <thead><tr><th>Condition</th><th>Value</th><th>Compared to</th><th>Result</th></tr></thead>
          <tbody>
            {rows.map((c, i) => (
              <tr key={i}>
                <td>{conditionSentence(c)}</td>
                <td>{fmtVal(c, c.value)}</td>
                <td>{fmtVal(c, c.cmp)}</td>
                <td>{c.pass === true ? <span className="h10-pill ok">met</span> : c.pass === false ? <span className="h10-pill arch">not met</span> : <span className="h10-pill arch" title="Recorded before ER3.2 — per-condition values weren't captured">n/a</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="eb-be-hint" style={{ marginTop: 8 }}>
        {r.facts && <>Window facts: {r.facts.impressions.toLocaleString('en-IE')} impressions · {r.facts.clicks} clicks · {eurC(r.facts.adFeesCents)} fees · {eurC(r.facts.salesCents)} sales · {r.facts.soldQty} sold. </>}
        {r.ratePct != null && <>Current rate <b>{r.ratePct}%</b>. </>}
        {r.breakEven != null && <>Break-even <b>{r.breakEven}%</b>. </>}
        {r.clampNote && <>Guardrail: <b>{r.clampNote}</b>.</>}
      </p>
      {estimatedImpact && (
        <p className="eb-be-hint" style={{ marginTop: 6 }}>
          Estimated / week: {estimatedImpact.feesDeltaCentsPerWeek != null && <b>{estimatedImpact.feesDeltaCentsPerWeek <= 0 ? '−' : '+'}€{(Math.abs(estimatedImpact.feesDeltaCentsPerWeek) / 100).toFixed(2)} fees</b>}
          {estimatedImpact.salesAtRiskCentsPerWeek != null && estimatedImpact.salesAtRiskCentsPerWeek > 0 && <> · <b>€{(estimatedImpact.salesAtRiskCentsPerWeek / 100).toFixed(2)} sales at risk</b></>}
          {' — '}{estimatedImpact.assumption}
        </p>
      )}
    </H10Modal>
  )
}
