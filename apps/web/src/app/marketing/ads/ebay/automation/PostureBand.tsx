'use client'

/**
 * ER3.2 (delta 8) — the posture band, decompressed from v1's single cramped
 * flex row into three labelled segments: Posture · Monthly ceilings · Kill
 * switch, plus the digest cross-link the critique flagged as missing.
 */
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { postEbayAds, eurC } from '../_lib'

export interface StatePayload {
  state: { globalMode: string; halted: boolean; haltReason: string | null }
  ceilings: Array<{ marketplace: string; mtdCents: number; capCents: number; pct: number }>
}

const MODE_HELP: Record<string, string> = {
  OFF: 'Engine dormant — nothing evaluates',
  SUGGEST: 'Proposals only — autopilot rules downgrade to suggestions',
  AUTO: 'Rule modes decide — PROPOSE suggests, AUTOPILOT applies within guardrails',
}

export function PostureBand({ state, busy, act }: {
  state: StatePayload | null
  busy: boolean
  act: (fn: () => Promise<unknown>, done?: string) => Promise<void>
}) {
  const [capInput, setCapInput] = useState('300')
  useEffect(() => {
    const cap = state?.ceilings.find((c) => c.marketplace === 'EBAY_IT')
    if (cap) setCapInput(String(Math.round(cap.capCents / 100)))
  }, [state])

  return (
    <div className="eb-posture-band">
      <section className="eb-posture-seg" aria-label="Posture">
        <h4>Posture</h4>
        <div className="eb-posture-dial">
          {(['OFF', 'SUGGEST', 'AUTO'] as const).map((m) => (
            <button key={m} type="button" className={`h10-am-btn ${state?.state.globalMode === m ? 'on' : ''}`} disabled={busy}
              title={MODE_HELP[m]}
              onClick={() => void act(() => postEbayAds('/automation/state', { globalMode: m }), `mode → ${m}`)}>
              {m === 'OFF' ? 'Off' : m === 'SUGGEST' ? 'Suggest' : 'Auto'}
            </button>
          ))}
        </div>
        <p className="eb-posture-hint">{MODE_HELP[state?.state.globalMode ?? 'OFF']}</p>
      </section>

      <section className="eb-posture-seg" aria-label="Monthly ceilings">
        <h4>Monthly ceilings</h4>
        <div className="eb-posture-ceil">
          {state?.ceilings.map((cl) => (
            <span key={cl.marketplace} className={`h10-pill ${cl.pct >= 80 ? 'warn' : 'arch'}`} title="MTD attributed ad fees vs the monthly cap (General has no native cap — this is it)">
              {cl.marketplace.replace('EBAY_', '')}: {eurC(cl.mtdCents)} / {eurC(cl.capCents)} · {cl.pct}%
            </span>
          ))}
          <label className="eb-posture-caplbl">EBAY_IT €
            <input className="h10-cd-input" style={{ width: 76, marginLeft: 6 }} type="number" min={10} value={capInput} onChange={(e) => setCapInput(e.target.value)} />
          </label>
          <button type="button" className="h10-am-btn sm" disabled={busy}
            onClick={() => void act(() => postEbayAds('/automation/ceilings', { marketplace: 'EBAY_IT', monthlyCapCents: Math.round(Number(capInput) * 100) }), 'ceiling saved')}>
            Save
          </button>
        </div>
        <p className="eb-posture-hint">Attributed fees month-to-date; automation halts at 100%.</p>
      </section>

      <section className="eb-posture-seg" aria-label="Kill switch">
        <h4>Kill switch</h4>
        <button type="button" className="h10-am-btn" disabled={busy || state?.state.halted}
          onClick={() => void act(() => postEbayAds('/automation/state', { halted: true, haltReason: 'operator kill switch' }), 'HALTED')}>
          ⛔ Halt everything
        </button>
        <p className="eb-posture-hint">
          {state?.state.halted ? `Halted — ${state.state.haltReason ?? 'no reason recorded'}` : 'Stops every rule and pending apply instantly.'}
          {' · '}<Link href="/marketing/ads/ebay/digest" className="h10-am-link">Weekly digest →</Link>
        </p>
      </section>
    </div>
  )
}
