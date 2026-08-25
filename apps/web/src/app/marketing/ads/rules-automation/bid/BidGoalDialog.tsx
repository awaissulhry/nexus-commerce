'use client'

/**
 * ⛔ PARKED 2026-08-16 (U1) — NOT MOUNTED, NOT DELETED.
 *
 * What it is: the per-campaign bidder/goal dialog (PUT /campaigns/:id/goal).
 * Why it left: the Bid tab is now Helium 10's shape — one rules grid and nothing else
 *   (`BidRulesClient.tsx`; study `docs/2026-08-16-ra-h10-reference-study.md` §3.2, §7.2).
 * Candidate home: Apply Rules — H10 sets Bid Algorithm and Target ACoS there.
 *
 * Nothing here was changed, no endpoint was retired, and the file stays at this path on purpose:
 * re-mounting it is one import. Manifest: `docs/2026-08-16-ra-parked-sections.md`.
 */

/**
 * BID.S6 — the bidder assignment dialog, opened from a campaign row's Bidder cell.
 *
 * The bidder is DERIVED, not stored (schedule ▸ goal ▸ manual ▸ none, `bidderByCampaign`'s
 * precedence), so "assignment" is honest about what each path actually is:
 *
 *   · Schedule — a campaign is bid by a schedule by BEING IN one. That is the Rank & Dayparting
 *     page's coverage panel (one owner), so this dialog links there; it does not grow a second
 *     membership editor.
 *   · Goal — declares `dynamicBidding.targetAcos` (the field the bidder derivation and the
 *     target-ACoS tooling read; `Campaign.targetAcosPct` is a documented mistake). A LOCAL
 *     declaration: nothing syncs to Amazon and no engine acts on it unprompted today — the copy
 *     says exactly that, because a control that overstates its own power teaches the operator
 *     wrong. Values are entered as percent and sent as a fraction; the AIREON `30`-as-a-fraction
 *     trap dies at the API with a named error.
 *   · Manual / none — outcomes, not choices. The dialog says why they cannot be picked.
 */
import { useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, Check, ExternalLink, Target } from 'lucide-react'
import { Input } from '@/design-system/primitives'
import { getBackendUrl } from '@/lib/backend-url'
import { BIDDER_LABEL, type BidCampaignRow } from './types'

export function BidGoalDialog({ campaign, onClose, onDone }: {
  campaign: BidCampaignRow
  onClose: () => void
  onDone: () => void
}) {
  const [pct, setPct] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const num = Number(pct)
  const valid = Number.isFinite(num) && num >= 1 && num <= 100

  const save = async (clear: boolean) => {
    if (busy || (!clear && !valid)) return
    setBusy(true); setErr(null)
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/campaigns/${campaign.id}/goal`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetAcos: clear ? null : num / 100 }),
      })
      const j = await r.json()
      if (!r.ok || j?.error) throw new Error(j?.error ?? `(${r.status})`)
      setNote(clear
        ? 'Goal cleared. The bidder derivation falls back to manual-or-none on the next load.'
        : `Goal declared: ${num}% target ACoS. The Bidder column reads “Goal” on the next load. Nothing acts on it unprompted — arming the optimiser is a separate, operator-gated step.`)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="h10-bd4-back" role="dialog" aria-modal="true" aria-label="Bidder" onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose() }}>
      <div className="h10-bd4-card">
        <h3><Target size={14} aria-hidden /> Bidder — {campaign.name}</h3>
        <p className="h10-bd6-current">
          Today: <b>{BIDDER_LABEL[campaign.bidder]}</b>{campaign.bidderName ? <> ({campaign.bidderName})</> : null}.
          {' '}The bidder is derived, precedence schedule ▸ goal ▸ manual ▸ none — this dialog changes the facts it is derived from.
        </p>

        {note != null ? (
          <>
            <p className="h10-bd4-ok" role="status"><Check size={13} aria-hidden /> {note}</p>
            <div className="h10-bd4-row"><button type="button" className="h10-bd4-primary" onClick={onDone}>Done</button></div>
          </>
        ) : (
          <>
            <div className="h10-bd6-path">
              <h4>Bid by schedule</h4>
              <p>A schedule bids a campaign by holding it. Membership is owned by Rank &amp; Dayparting&rsquo;s coverage panel —{' '}
                <Link href="/marketing/ads/rules-automation/dayparting#rd-p6">add this campaign to a schedule there <ExternalLink size={11} aria-hidden /></Link>.
                {campaign.bidder === 'schedule' && <> It is already in “{campaign.bidderName}”.</>}
              </p>
            </div>

            <div className="h10-bd6-path">
              <h4>Bid toward a goal</h4>
              <p>Declares a target ACoS on this campaign. A local declaration: it names the intent, flips the Bidder column to “Goal”, and feeds the target-ACoS tooling — no engine moves a bid from it unprompted, and nothing syncs to Amazon.</p>
              <div className="h10-bd6-goalrow">
                <label className="h10-bd4-field">
                  Target ACoS (%)
                  <Input type="number" value={pct} min={1} max={100} step="1" placeholder="e.g. 30" onChange={(e) => setPct(e.target.value)} />
                </label>
                <button type="button" className="h10-bd4-primary" disabled={busy || !valid} onClick={() => void save(false)}>
                  {busy ? 'Saving…' : 'Declare goal'}
                </button>
                {campaign.bidder === 'goal' && (
                  <button type="button" className="h10-bd4-cancel" disabled={busy} onClick={() => void save(true)}>Clear goal</button>
                )}
              </div>
            </div>

            <p className="h10-bd6-derived">
              <b>Manual</b> and <b>no bidder</b> are outcomes, not choices: manual means a person moved a bid here within 60 days; no bidder means nothing did. Neither can be assigned.
            </p>
            {err != null && <p className="h10-bd4-err" role="alert"><AlertTriangle size={13} aria-hidden /> {err}</p>}
            <div className="h10-bd4-row"><button type="button" className="h10-bd4-cancel" disabled={busy} onClick={onClose}>Close</button></div>
          </>
        )}
      </div>
    </div>
  )
}
