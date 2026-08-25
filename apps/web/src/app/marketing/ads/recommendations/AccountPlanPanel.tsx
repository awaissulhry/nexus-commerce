'use client'

/**
 * ⛔ PARKED (SG.7, operator decision 2026-08-21) — imported by nothing live. The Recommendations
 * feed moved onto the Suggestions page's shared anatomy and this panel was parked with it (only
 * the equally-parked RecommendationsClient still references it). KEEP: it is an ACR.6 roadmap
 * surface — AI Advertising is where plans are operated today; re-home it there when that page
 * grows an account-plan slot.
 *
 * ACR.6 (R3) — the account plan: one north star, one readable plan, one apply.
 *
 * Every card below this panel is a single action you accept or dismiss. This is the other altitude:
 * pick a goal for the whole account, read what that goal implies as plain sentences, then apply the
 * lot. Same engine either way — `/autopilot/simulate` walks the same bid model the individual
 * recommendations come from — so the two surfaces cannot recommend contradictory things.
 *
 * Operator decision 2026-08-05: keep it, as a panel here rather than as its own page (the legacy
 * `/marketing/advertising/autopilot`, which Stage 6 retires).
 *
 * THE BLAST RADIUS IS THE DESIGN CONSTRAINT. A card applies one change; this applies every change
 * the plan lists at once. So:
 *   · nothing runs until you press Preview — mounting the panel fetches nothing;
 *   · Apply is only offered once a plan is on screen and only if it actually proposes something;
 *   · the confirm is a Modal that states the count and the account mode, replacing the legacy
 *     page's `window.confirm` (a browser dialog would also freeze this console's automation);
 *   · the allowlist is named twice, because "applied" and "written to Amazon" are different facts —
 *     campaigns off the live-write allowlist are reported as skipped, not silently dropped.
 */
import { useCallback, useState } from 'react'
import { ChevronDown, Rocket, Check } from 'lucide-react'
import { Button } from '@/design-system/primitives/Button'
import { Input } from '@/design-system/primitives/Input'
import { RadioCard } from '@/design-system/primitives/RadioCard'
import { Modal } from '@/design-system/components/Modal'
import { getBackendUrl } from '@/lib/backend-url'

type Mode = 'profit' | 'balanced' | 'growth'

interface Action { kind: 'bid' | 'top_of_search'; scope: string; summary: string; deltaLabel: string; basis: string }
interface Plan {
  northStar: { mode: Mode; label: string }
  headline: string
  counts: { bidChanges: number; topOfSearchChanges: number }
  actions: Action[]
}
interface ApplyResult {
  bid: { applied: number; skippedNotAllowlisted: number }
  topOfSearch: { applied: number; skippedNotAllowlisted: number; evaluated: number }
}

const NORTH_STARS: Array<{ mode: Mode; title: string; blurb: string }> = [
  { mode: 'profit', title: 'Maximise profit', blurb: 'Spend conservatively — keep more of each sale.' },
  { mode: 'balanced', title: 'Balanced', blurb: 'A middle ground between profit and growth.' },
  { mode: 'growth', title: 'Grow aggressively', blurb: 'Spend up to break-even to win volume and rank.' },
]

export function AccountPlanPanel({ mode: accountMode, toast }: { mode: string; toast: (m: string, tone?: 'success' | 'danger' | 'info') => void }) {
  const [open, setOpen] = useState(false)
  const [goal, setGoal] = useState<Mode>('profit')
  const [marketplace, setMarketplace] = useState('')
  const [plan, setPlan] = useState<Plan | null>(null)
  const [loading, setLoading] = useState(false)
  const [applying, setApplying] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [applied, setApplied] = useState<ApplyResult | null>(null)
  const [err, setErr] = useState('')

  const sandbox = accountMode === 'sandbox'
  const changes = plan ? plan.counts.bidChanges + plan.counts.topOfSearchChanges : 0

  const preview = useCallback(async () => {
    setLoading(true); setErr(''); setApplied(null); setPlan(null)
    try {
      const p = new URLSearchParams({ mode: goal })
      if (marketplace.trim()) p.set('marketplace', marketplace.trim().toUpperCase())
      const r = await fetch(`${getBackendUrl()}/api/advertising/autopilot/simulate?${p}`, { cache: 'no-store' }).then((x) => x.json())
      if (r?.error) throw new Error(r.error)
      setPlan(r as Plan)
    } catch (e) { setErr((e as Error).message || 'Could not build a plan.') } finally { setLoading(false) }
  }, [goal, marketplace])

  const apply = useCallback(async () => {
    setConfirming(false); setApplying(true); setErr('')
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/autopilot/apply`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: goal, marketplace: marketplace.trim().toUpperCase() || undefined }),
      }).then((x) => x.json())
      if (r?.error || r?.ok === false) throw new Error(r.error || 'Apply failed.')
      setApplied(r as ApplyResult)
      toast(sandbox ? 'Plan applied — simulated in sandbox' : 'Plan applied — written where the allowlist permits', 'success')
      await preview() // re-plan against the new state, so the panel never shows a stale plan
    } catch (e) { setErr((e as Error).message); toast('Apply failed', 'danger') } finally { setApplying(false) }
  }, [goal, marketplace, preview, sandbox, toast])

  return (
    <section className="rec-plan">
      <button type="button" className="rec-plan-t" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Rocket size={13} aria-hidden />
        <span>Account plan — set one goal, apply the whole plan</span>
        <ChevronDown size={15} className={open ? 'open' : ''} aria-hidden />
      </button>

      {open && (
        <div className="rec-plan-b">
          <p className="rec-plan-lede">
            The cards below are one decision each. This is the account-level version: pick a goal, read what
            it implies, apply it in one go. Same bid engine, so the two can never disagree.
          </p>

          <div className="rec-plan-stars" role="radiogroup" aria-label="North star">
            {NORTH_STARS.map((n) => (
              <RadioCard
                key={n.mode}
                name="rec-north-star"
                value={n.mode}
                title={n.title}
                description={n.blurb}
                checked={goal === n.mode}
                selected={goal === n.mode}
                onChange={() => { setGoal(n.mode); setPlan(null); setApplied(null) }}
              />
            ))}
          </div>

          <div className="rec-plan-ctl">
            <label className="rec-plan-f">
              <span>Marketplace</span>
              <Input size="sm" fieldClassName="rec-plan-in" value={marketplace} onChange={(e) => setMarketplace(e.target.value)} placeholder="all" aria-label="Marketplace code, blank for all" />
            </label>
            <Button variant="secondary" size="sm" disabled={loading} onClick={() => void preview()}>
              {loading ? 'Building the plan…' : 'Preview plan'}
            </Button>
            {plan && changes > 0 && (
              <Button variant={sandbox ? 'primary' : 'danger'} size="sm" disabled={applying} onClick={() => setConfirming(true)}>
                {applying ? 'Applying…' : `Apply ${changes} change${changes === 1 ? '' : 's'}`}
              </Button>
            )}
            <span className="rec-plan-note">
              Nothing runs until you press Preview. Applying writes only to campaigns on the live-write
              allowlist; the rest are reported as skipped.
            </span>
          </div>

          {err && <div className="rec-plan-err">{err}</div>}

          {applied && (
            <div className="rec-plan-ok">
              <Check size={14} aria-hidden />
              <span>
                Bids: <b>{applied.bid.applied}</b> written{applied.bid.skippedNotAllowlisted > 0 ? `, ${applied.bid.skippedNotAllowlisted} skipped (not allowlisted)` : ''}.
                {' '}Top-of-search: <b>{applied.topOfSearch.applied}</b> written{applied.topOfSearch.skippedNotAllowlisted > 0 ? `, ${applied.topOfSearch.skippedNotAllowlisted} skipped` : ''}.
              </span>
            </div>
          )}

          {plan && (
            <div className="rec-plan-out">
              <div className="rec-plan-out-h">
                <b>{plan.headline}</b>
                <span>{plan.northStar.label} · {plan.counts.bidChanges} bid change{plan.counts.bidChanges === 1 ? '' : 's'} · {plan.counts.topOfSearchChanges} top-of-search change{plan.counts.topOfSearchChanges === 1 ? '' : 's'}</span>
              </div>
              {plan.actions.length === 0 ? (
                <div className="rec-plan-empty">Nothing to change right now — this goal is already met.</div>
              ) : (
                <ul className="rec-plan-acts">
                  {plan.actions.map((a, i) => (
                    <li key={`${a.kind}-${a.scope}-${i}`}>
                      <span className={`rec-plan-kind ${a.kind === 'top_of_search' ? 'tos' : 'bid'}`}>{a.kind === 'top_of_search' ? 'ToS' : 'Bid'}</span>
                      <span className="rec-plan-sum">{a.summary}<em title={a.basis}>{a.basis}</em></span>
                      <span className="rec-plan-d">{a.deltaLabel}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}

      {confirming && plan && (
        <Modal
          open
          onClose={() => setConfirming(false)}
          title={`Apply the ${plan.northStar.label.toLowerCase()} plan?`}
          subtitle={sandbox
            ? 'Sandbox — every change is simulated; nothing reaches Amazon.'
            : 'Live — changes reach Amazon for campaigns on the write allowlist. Everything else is skipped and reported.'}
          footer={<>
            <Button variant="secondary" size="sm" onClick={() => setConfirming(false)}>Cancel</Button>
            <Button variant={sandbox ? 'primary' : 'danger'} size="sm" onClick={() => void apply()}>
              {sandbox ? `Simulate ${changes} change${changes === 1 ? '' : 's'}` : `Apply ${changes} change${changes === 1 ? '' : 's'}`}
            </Button>
          </>}
        >
          <p className="rec-plan-cf">
            This applies <b>{plan.counts.bidChanges}</b> bid change{plan.counts.bidChanges === 1 ? '' : 's'} and{' '}
            <b>{plan.counts.topOfSearchChanges}</b> top-of-search change{plan.counts.topOfSearchChanges === 1 ? '' : 's'} in one pass
            {marketplace.trim() ? <> across <b>{marketplace.trim().toUpperCase()}</b></> : <> across <b>every market</b></>}.
            Individual cards below let you apply the same moves one at a time instead.
          </p>
        </Modal>
      )}
    </section>
  )
}
