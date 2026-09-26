'use client'
import { useState } from 'react'
import { DetailPopover } from '../components/DetailPopover'
import { ProgressBar } from '../components/ProgressBar'
import { ProgressDetailCard } from '../grid/renderers/ProgressDetailCard'
import { progressDetailModel, progressTone, type ProgressValue } from '../grid/renderers/progress'

/**
 * The progress meter and its card (2026-09-26) — the sheet's progress columns. Colour rule A: red = a required field is
 * empty, yellow = only optional fields are empty, green = nothing is empty, grey = cannot be said. Verify: the four
 * tones; open the card by pointer, click, Enter or Space; ↑ ↓ Home End move through the list, which scrolls between a
 * fixed header and footer; Enter on a field "goes to" it; Esc returns focus to the trigger.
 */
const field = (label: string) => ({ field: label.toLowerCase().replace(/\W+/g, '_'), label })
const SAMPLE: ProgressValue = {
  pct: 43, required: { filled: 5, total: 7 }, optional: { filled: 4, total: 16 },
  requiredEmpty: [field('Manufacturer'), field('Model name')],
  optionalEmpty: ['Material', 'Care instructions', 'Closure type', 'Lining', 'Season', 'Collar style', 'Pocket count', 'Sleeve type', 'Theme', 'Occasion', 'Pattern', 'Water resistance'].map(field),
  otherIssues: [{ field: 'ean', label: 'EAN', reason: 'Not a valid EAN-13 (check digit).' }],
  computedAt: new Date(Date.now() - 6 * 3_600_000).toISOString(),
}
const TONES: Array<{ label: string; value: ProgressValue | null }> = [
  { label: 'Required empty', value: SAMPLE },
  { label: 'Optional empty', value: { ...SAMPLE, pct: 12, required: { filled: 7, total: 7 }, requiredEmpty: [] } },
  { label: 'Complete', value: { ...SAMPLE, pct: 100, required: { filled: 7, total: 7 }, optional: { filled: 16, total: 16 }, requiredEmpty: [], optionalEmpty: [] } },
  { label: 'Not measured', value: null },
]

export function ProgressExample() {
  const [went, setWent] = useState<string | null>(null)
  return <div id="progress-example" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--nds-space-10)', maxWidth: 360 }}>
    {TONES.map(t => <div key={t.label} style={{ display: 'grid', gridTemplateColumns: '120px 1fr', alignItems: 'center', gap: 'var(--nds-space-8)', fontSize: 'var(--nds-font-size-sm)', color: 'var(--nds-text)' }}>
      <span>{t.label}</span>
      <ProgressBar tone={progressTone(t.value)} value={t.value?.pct ?? null} showValue ariaLabel={`${t.label}: ${t.value?.pct ?? '—'}%`} />
    </div>)}
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--nds-space-8)' }}>
      <DetailPopover trigger={<ProgressBar tone="missing" value={43} showValue />} triggerClassName="nds-progress-trigger" panelClassName="nds-detailpop-scroll nds-progress-pop"
        triggerLabel="Amazon · IT, AIREON-NERO-L: 43% filled, required fields empty. Show what is missing." label="Amazon · IT — what is missing on AIREON-NERO-L">
        {({ close }) => <ProgressDetailCard close={close} onGoTo={f => setWent(f)} footerLink={{ label: 'All products for Amazon · IT', href: '#progress-example' }}
          model={progressDetailModel({ scopeLabel: 'Amazon · IT', subject: 'AIREON-NERO-L', value: SAMPLE, now: Date.now(), actionFor: () => ({ kind: 'goto', label: 'Go to' }) })} />}
      </DetailPopover>
      <span style={{ fontSize: 'var(--nds-font-size-xs)', color: 'var(--nds-text)' }}>Last action: {went ? `Go to ${went}` : 'none'}</span>
    </div>
  </div>
}
