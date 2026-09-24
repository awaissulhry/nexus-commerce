'use client'
import { useState } from 'react'
import { DetailPopover } from '../components/DetailPopover'
import { Button, Pill } from '../primitives'

/**
 * A-45 — the toggletip that can hold actions. Verify: open with the pointer (rest 350 ms), with a click, with
 * Enter and with Space; Tab stays inside; Esc closes and returns focus to the trigger; a click outside closes.
 */
export function DetailPopoverExample() {
  const [went, setWent] = useState<string | null>(null)
  return <div id="detail-popover-example" style={{ display: 'flex', alignItems: 'center', gap: 'var(--nds-space-8)' }}>
    <DetailPopover trigger={<Pill tone="danger" size="sm">Blocked · 82%</Pill>}
      triggerLabel="Amazon · IT, German: Blocked, 82% of required values filled, 2 required fields empty. Show details."
      label="Completeness for Amazon · IT, German">
      {({ close }) => <div className="nds-detailpop-body">
        <div className="nds-detailpop-h">Amazon · IT · German — 82% (18 of 20 required)</div>
        <div className="nds-detailpop-gh">Required and empty (2)</div>
        <ul className="nds-detailpop-list">
          {['GTIN', 'Brand'].map(label => <li key={label} className="nds-detailpop-item">
            <span className="nds-detailpop-label">{label}</span>
            <Button variant="quiet" size="xs" onClick={() => { close(); setWent(label) }}>Go to {label}</Button>
          </li>)}
        </ul>
        <div className="nds-detailpop-foot">Computed 6 h ago · this is not publish eligibility</div>
      </div>}
    </DetailPopover>
    <span style={{ fontSize: 'var(--nds-font-size-xs)', color: 'var(--nds-text)' }}>Last action: {went ? `Go to ${went}` : 'none'}</span>
  </div>
}
