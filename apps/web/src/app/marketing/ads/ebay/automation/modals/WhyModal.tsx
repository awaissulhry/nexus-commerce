'use client'

/**
 * ER3.2 (delta 6) — the Why pane: renders the evaluator's real reasoning for
 * one suggestion — rule link, window facts, each condition's value vs its
 * comparison (benchmark-resolved since ER3.2), clamp notes. No storytelling:
 * only what the engine recorded.
 */
import Link from 'next/link'
import { Button, Pill } from '@/design-system/primitives'
import { DataGrid } from '@/design-system/components'
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
  // `_k` because a condition has no id and `DataGrid` keys by value, not by index — two identical
  // conditions in one rule would otherwise share a key and React would reuse the wrong row.
  const rows = (r.conditionResults ?? r.conditions?.map((c) => ({ ...c, value: null, cmp: null, pass: null })) ?? [])
    .map((c, i) => ({ ...c, _k: String(i) }))
  return (
    <H10Modal open={open} onClose={onClose} title="Why this suggestion" subtitle={title}
   footer={<><span style={{ flex: 1 }} /><Button onClick={onClose}>Close</Button></>}>
      <p className="eb-be-hint" style={{ marginBottom: 8 }}>
        Rule: <b>{ruleName ?? r.rule ?? '—'}</b>
        {campaignId && <> · <Link className="nds-btn link" href={`/marketing/ads/ebay/campaigns/${campaignId}`}>open campaign →</Link></>}
      </p>
      {rows.length > 0 && (
        <DataGrid<typeof rows[number]>
          className="eb-why-table"
          size="sm"
          rows={rows}
          rowKey={(c) => c._k}
          columns={[
            { key: 'cond', label: 'Condition', render: (c) => conditionSentence(c) },
            { key: 'val', label: 'Value', render: (c) => fmtVal(c, c.value) },
            { key: 'cmp', label: 'Compared to', render: (c) => fmtVal(c, c.cmp) },
            { key: 'res', label: 'Result', render: (c) => (c.pass === true ? <Pill tone="success">met</Pill> : c.pass === false ? <Pill tone="neutral">not met</Pill> : <Pill tone="warning">unknown</Pill>) },
          ]}
        />
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
