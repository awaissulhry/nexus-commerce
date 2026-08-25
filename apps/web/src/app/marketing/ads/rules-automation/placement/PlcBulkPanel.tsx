'use client'

/**
 * ⛔ PARKED 2026-08-17 (U2) — NOT MOUNTED, NOT DELETED.
 *
 * What it is: "Set across scope…" — the preview-then-confirm bulk multiplier write (?bulk=1).
 * Why it left: the Placement tab is now Helium 10's shape — one rules grid and nothing else
 *   (`PlacementRulesClient.tsx`; study `docs/2026-08-16-ra-h10-reference-study.md` §3.8, §7.3).
 * Candidate home: Bulk Operations — a bulk write surface. Its endpoint (`/placements/preview` + `PATCH /placements/:id/lane`) is untouched.
 *
 * Nothing here was changed and no endpoint was retired — the PLC.3 multiplier write path is still
 * served. The file stays at this path on purpose: re-mounting it is one import.
 * Manifest: `docs/2026-08-16-ra-parked-sections.md`.
 */

/**
 * PLC.3 — the scope-bulk editor, and the preview that has to come first.
 *
 * The headline action: *"Set Rest of Search to 60% on every ENABLED campaign in the GALE line, in
 * IT."* One action, one preview, one confirmation, one result — with every row that will NOT be
 * written named, and every refusal printed in the gate's own words.
 *
 * ── Why the preview is not optional ──────────────────────────────────────────────────────────
 *
 * The page already knows four things the operator cannot see on the grid, and all four change
 * whether the action is a good idea:
 *
 *   · 32 of the 74 ENABLED IT campaigns are steered by a rank schedule, which snaps the multiplier
 *     back to its target's `biasPct` **within fifteen minutes**. A write that appears to work and
 *     is undone before you next look is worse than one that refuses.
 *   · pinned campaigns refuse at the gate, before Amazon is called.
 *   · gate-closed campaigns refuse the same way — and every PAUSED campaign in this account is
 *     gate-closed, so "it's only paused, it's safe" is not a thing you can act on here.
 *   · a campaign already at the value is a no-op, and 30% of the engine's own history rows are
 *     writes of a value that was already there (study §4.5). A manual bulk must not add to that.
 *
 * ── The one-directional truth ────────────────────────────────────────────────────────────────
 *
 * Amazon's multipliers are 0–900 and **cannot bid a lane down**. So a correction is always "raise
 * the other lane" or "zero this one", and this panel never offers a control that implies otherwise.
 * The server sends that sentence in the payload rather than the client asserting it.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { DataGrid } from '@/design-system/components'
import { createPortal } from 'react-dom'
import { AlertTriangle, Loader2, ShieldAlert, X } from 'lucide-react'
import { Button, Input, Select, ToolbarButton } from '@/design-system/primitives'
import { getBackendUrl } from '@/lib/backend-url'

export type LaneKey = 'top' | 'rest' | 'product'
export type FlagKey = 'inverted' | 'compounding' | 'unmanaged' | 'decorative'
type SkipReason = 'archived' | 'pinned' | 'gate-closed' | 'no-change'

const LANE_LABEL: Record<LaneKey, string> = { top: 'Top of search', rest: 'Rest of search', product: 'Product pages' }

/** What each skip means in words. The counter and the row chip read from one map. */
const SKIP_WORD: Record<SkipReason, string> = {
  archived: 'archived',
  pinned: 'pinned',
  'gate-closed': 'gate shut',
  'no-change': 'already there',
}
const SKIP_WHY: Record<SkipReason, string> = {
  archived: 'An archived campaign cannot be written to.',
  pinned: 'Placement is pinned on this campaign — held by hand. Clear the pin to let a write through.',
  'gate-closed': 'The per-campaign write gate is shut, so the write is refused before Amazon is called. Every PAUSED campaign in this account is in this state.',
  'no-change': 'This lane is already at the value. Writing it would add a row to the ledger and change nothing.',
}

interface PreviewRow {
  campaignId: string
  name: string
  marketplace: string | null
  status: string
  biddingStrategy: string | null
  owner: 'schedule' | 'plan' | 'none'
  ownerLabel: string | null
  current: Record<LaneKey, number>
  proposed: Record<LaneKey, number>
  skip: SkipReason | null
  revertedByEngine: boolean
  maxBaseBidCents: number | null
  effectiveBidBefore: number | null
  effectiveBidAfter: number | null
  compoundingAfter: boolean
}

interface Preview {
  lane: LaneKey
  pct: number
  scope: { market: string; boundBy: string; campaigns: number; contradiction: string | null }
  counts: {
    willWrite: number
    revertedByEngine: number
    skipped: Record<SkipReason, number>
    compoundingCreated: number
  }
  rows: PreviewRow[]
  note: string
}

export interface BulkScope {
  market: string
  line: string
  portfolio: string
  campaign: string
  flag: FlagKey | 'all'
}

interface WriteOutcome {
  campaignId: string
  name: string
  ok: boolean
  /** the gate's own sentence, verbatim — never a paraphrase and never "HTTP 200" */
  reason?: string
  deniedAt?: string
}

const eur = (c: number) => `€${(c / 100).toFixed(2)}`
const num = (n: number) => n.toLocaleString('en-IE')

/** More than this many campaigns and a click is not enough — you type the count. */
const TYPED_CONFIRM_ABOVE = 10

export function PlcBulkPanel({ scope, lane, onClose, onDone }: {
  scope: BulkScope
  /** the lane the grid is currently filtered to, if any — the obvious default */
  lane: LaneKey | 'all'
  onClose: () => void
  onDone: () => void
}) {
  const [laneSel, setLaneSel] = useState<LaneKey>(lane === 'all' ? 'rest' : lane)
  const [pctDraft, setPctDraft] = useState('60')
  const [status, setStatus] = useState<'enabled' | 'all'>('enabled')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [typed, setTyped] = useState('')
  const [running, setRunning] = useState(false)
  const [outcomes, setOutcomes] = useState<WriteOutcome[] | null>(null)

  const pct = Number(pctDraft)
  const pctValid = Number.isFinite(pct) && pct >= 0 && pct <= 900

  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !running) onClose() }
    document.addEventListener('keydown', k)
    return () => document.removeEventListener('keydown', k)
  }, [onClose, running])

  // Every change to the action invalidates the preview. A stale preview beside a changed number is
  // the one thing this panel must never show, so the result is cleared rather than left to look
  // current.
  useEffect(() => { setPreview(null); setOutcomes(null); setTyped('') }, [laneSel, pctDraft, status])

  const loadPreview = useCallback(async () => {
    if (!pctValid) return
    setLoading(true); setErr(null)
    const p = new URLSearchParams({ market: scope.market, lane: laneSel, pct: String(Math.round(pct)), status })
    if (scope.line) p.set('line', scope.line)
    if (scope.portfolio) p.set('portfolio', scope.portfolio)
    if (scope.campaign) p.set('campaign', scope.campaign)
    if (scope.flag !== 'all') p.set('flag', scope.flag)
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/placements/preview?${p.toString()}`, { cache: 'no-store' })
      const j = await r.json()
      if (!r.ok) throw new Error(j?.error ?? `Preview failed (${r.status})`)
      setPreview(j as Preview)
    } catch (e) { setErr((e as Error).message); setPreview(null) } finally { setLoading(false) }
  }, [scope, laneSel, pct, pctValid, status])

  const writable = useMemo(() => (preview?.rows ?? []).filter((r) => r.skip == null), [preview])
  const needsTyped = writable.length > TYPED_CONFIRM_ABOVE
  const confirmed = !needsTyped || typed.trim() === String(writable.length)

  /**
   * The commit — sequential, one PATCH per campaign, exactly as `GuardrailGrid.runBulk` does.
   *
   * Sequential rather than parallel because each write is judged on its own: pinned refuses, gate
   * shut refuses, the rest land, and the bar has to be able to report exactly what happened rather
   * than choosing between "all failed" and hiding a partial result.
   *
   * 🔴 The refusal is read from `reason`, not from `j.error`. A blocked placement write returns
   * **HTTP 200** with `{ ok: false, mode: 'blocked' }`, so `GuardrailGrid`'s pattern —
   * `j.error ?? \`HTTP ${r.status}\`` — would report "HTTP 200" as the reason an operator's write
   * was refused. `reason` carries the gate's own sentence (PLC.3 added it to the service return).
   */
  const commit = async () => {
    if (!preview || running || !confirmed) return
    setRunning(true)
    const results: WriteOutcome[] = []
    const reason = `manual — ${LANE_LABEL[laneSel]} set to ${Math.round(pct)}% across ${scope.market === 'all' ? 'all markets' : scope.market}`
    for (const row of writable) {
      try {
        const r = await fetch(`${getBackendUrl()}/api/advertising/placements/${row.campaignId}/lane`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lane: laneSel, percentage: Math.round(pct), reason }),
        })
        const j = (await r.json().catch(() => ({}))) as { ok?: boolean; mode?: string; reason?: string; deniedAt?: string; error?: string }
        if (!r.ok) { results.push({ campaignId: row.campaignId, name: row.name, ok: false, reason: j.error ?? `The request failed (${r.status})` }); continue }
        if (j.ok === false) {
          results.push({
            campaignId: row.campaignId, name: row.name, ok: false,
            // In order: the gate's sentence · a named blocked mode · anything the route said.
            reason: j.reason ?? (j.mode === 'blocked' ? 'The write gate refused this campaign.' : j.error ?? 'Refused, with no reason given.'),
            deniedAt: j.deniedAt,
          })
          continue
        }
        results.push({ campaignId: row.campaignId, name: row.name, ok: true })
      } catch (e) {
        results.push({ campaignId: row.campaignId, name: row.name, ok: false, reason: (e as Error).message })
      }
    }
    setRunning(false)
    setOutcomes(results)
    onDone()
  }

  const body = (
    <div className="h10-plc3-back" onClick={() => { if (!running) onClose() }}>
      <div className="h10-plc3-panel" role="dialog" aria-modal="true" aria-label="Set a placement multiplier across this scope" onClick={(e) => e.stopPropagation()}>
        <div className="h10-plc3-ph">
          <div>
            <h3>Set a multiplier across this scope</h3>
            <p>
              {scope.market === 'all' ? 'All markets' : scope.market}
              {scope.line && ' · one product line'}
              {scope.portfolio && ' · one portfolio'}
              {scope.campaign && ' · one campaign'}
              {scope.flag !== 'all' && ` · only ${scope.flag} campaigns`}
              {' — the scope in the bar above. '}
              <b>The search box is deliberately not part of it</b>: it narrows what you are looking at, not what you act on.
            </p>
          </div>
          <ToolbarButton icon={<X size={18} aria-hidden />} label="Close" tooltip={false} onClick={onClose} disabled={running} />
        </div>

        <div className="h10-plc3-pb">
          <div className="h10-plc3-form">
            <label className="h10-plc3-field">
              <span className="cap">Lane</span>
              <Select size="sm" value={laneSel} onChange={(e) => setLaneSel(e.target.value as LaneKey)} disabled={running}>
                {(['top', 'rest', 'product'] as LaneKey[]).map((l) => <option key={l} value={l}>{LANE_LABEL[l]}</option>)}
              </Select>
            </label>
            <label className="h10-plc3-field">
              <span className="cap">Multiplier %</span>
              <Input
                size="sm" fieldClassName="h10-plc3-num" className="h10-plc3-numin"
                inputMode="numeric" value={pctDraft} disabled={running}
                onChange={(e) => setPctDraft(e.target.value.replace(/[^0-9]/g, '').slice(0, 3))}
                aria-label="Multiplier percent, 0 to 900"
              />
            </label>
            <label className="h10-plc3-field">
              <span className="cap">Campaigns</span>
              <Select size="sm" value={status} onChange={(e) => setStatus(e.target.value as 'enabled' | 'all')} disabled={running}>
                <option value="enabled">Enabled only</option>
                <option value="all">Every status</option>
              </Select>
            </label>
            <Button size="sm" onClick={loadPreview} disabled={!pctValid || loading || running}>
              {loading ? <><Loader2 size={12} className="spin" /> Checking…</> : 'Preview'}
            </Button>
          </div>

          {!pctValid && <p className="h10-plc3-refusal"><AlertTriangle size={13} aria-hidden /><span>A multiplier is a whole number between 0 and 900.</span></p>}
          {err && <p className="h10-plc3-refusal" role="alert"><AlertTriangle size={13} aria-hidden /><span>{err}</span></p>}

          {preview && (
            <>
              {/* 🔴 One-directional, from the server rather than asserted here. */}
              <p className="h10-plc3-result"><span>{preview.note}</span></p>

              <div className="h10-plc3-tally">
                <div className="h10-plc3-tallycell">
                  <b>{num(preview.counts.willWrite)}</b>
                  <span>will be written{preview.scope.campaigns > 0 && <> · of {num(preview.scope.campaigns)} in scope</>}</span>
                </div>
                <div className={`h10-plc3-tallycell ${preview.counts.revertedByEngine > 0 ? 'warn' : ''}`}>
                  <b>{num(preview.counts.revertedByEngine)}</b>
                  <span>an engine reverts within ~15 min</span>
                </div>
                <div className="h10-plc3-tallycell">
                  <b>{num(Object.values(preview.counts.skipped).reduce((a, b) => a + b, 0))}</b>
                  <span>
                    skipped — {(Object.entries(preview.counts.skipped) as Array<[SkipReason, number]>)
                      .filter(([, v]) => v > 0).map(([k, v]) => `${v} ${SKIP_WORD[k]}`).join(', ') || 'none'}
                  </span>
                </div>
                <div className={`h10-plc3-tallycell ${preview.counts.compoundingCreated > 0 ? 'stop' : ''}`}>
                  <b>{num(preview.counts.compoundingCreated)}</b>
                  <span>would newly compound an up-and-down bid</span>
                </div>
              </div>

              {preview.counts.compoundingCreated > 0 && (
                <p className="h10-plc3-refusal">
                  <ShieldAlert size={13} aria-hidden />
                  <span>
                    <b>This would create the account&rsquo;s first compounding campaign.</b> Amazon charges
                    base × (1 + top %), and up-and-down bidding lets Amazon add up to another +100% at top of
                    search on top of that — so a Top multiplier above 100% can reach 4× the base bid.
                    0 campaigns are in that state today.
                  </span>
                </p>
              )}

              {preview.counts.revertedByEngine > 0 && (
                <p className="h10-plc3-warn">
                  <AlertTriangle size={13} aria-hidden />
                  <span>
                    {/* 🔴 `{' '}` after the bold, not a literal space. Measured in the deployed DOM:
                        the text node rendered as "…fifteen minutesthe engine…" because a JSX text
                        node that starts with a space and then wraps loses it. The sibling node two
                        lines up kept its space, which is what makes this one easy to miss. */}
                    <b>{num(preview.counts.revertedByEngine)} of these are steered by a rank schedule.</b>{' '}
                    The write will land, and <b>within about fifteen minutes</b>{' '}
                    the engine will snap the multiplier back to its target&rsquo;s own value. To change
                    those for good, change the target on{' '}
                    <a className="lnk" href="/marketing/ads/rules-automation/dayparting">Rank &amp; Dayparting</a>.
                  </span>
                </p>
              )}

              <DataGrid
                className="h10-plc3-rows"
                rows={preview.rows}
                rowKey={(r) => r.campaignId}
                columns={[
                  { key: 'campaign', label: 'Campaign', render: (r) => (<>{r.name}<br /><span className="h10-plc3-sub">{r.marketplace ?? '—'} · {r.status.toLowerCase()}</span></>) },
                  { key: 'owner', label: 'Steered by', render: (r) => (r.owner === 'none' ? <span className="h10-plc3-nobody">nobody</span> : <>{r.ownerLabel ?? r.owner}</>) },
                  { key: 'lane', label: LANE_LABEL[laneSel], align: 'right', render: (r) => (<>{r.current[laneSel]}% → <b>{r.proposed[laneSel]}%</b></>) },
                  { key: 'eff', label: 'Effective bid', align: 'right', render: (r) => (r.effectiveBidBefore == null
                    ? <span className="h10-plc3-nobase">no base bid</span>
                    : <>{eur(r.effectiveBidBefore)} → {eur(r.effectiveBidAfter!)}</>) },
                  { key: 'verdict', label: 'Verdict', render: (r) => (r.skip
                    ? <span className="skip" title={SKIP_WHY[r.skip]}>{SKIP_WORD[r.skip]}</span>
                    : r.revertedByEngine
                      ? <span className="rev" title={`${r.ownerLabel ?? 'A rank schedule'} holds this campaign — the engine snaps the multiplier back to its target's value within ~15 minutes.`}>writes, then reverts</span>
                      : <span className="go">writes</span>) },
                ]}
              />
            </>
          )}

          {outcomes && (
            <div className="h10-plc3-result">
              <b>{outcomes.filter((o) => o.ok).length} written · {outcomes.filter((o) => !o.ok).length} refused</b>
              {outcomes.filter((o) => !o.ok).map((o) => (
                <p className="h10-plc3-refusal" key={o.campaignId}>
                  <AlertTriangle size={13} aria-hidden />
                  <span>
                    <b>{o.name}</b>{o.deniedAt && <span className="where">{o.deniedAt}</span>} — {o.reason}
                  </span>
                </p>
              ))}
            </div>
          )}
        </div>

        <div className="h10-plc3-pf">
          {preview && writable.length > 0 && needsTyped && !outcomes ? (
            <label className="h10-plc3-confirm">
              <span>This touches <b>{writable.length}</b> campaigns. Type <b>{writable.length}</b> to confirm:</span>
              <Input size="sm" fieldClassName="h10-plc3-confirmin" value={typed} onChange={(e) => setTyped(e.target.value)} disabled={running} aria-label={`Type ${writable.length} to confirm`} />
            </label>
          ) : <span />}
          <div className="h10-plc3-actions">
            <Button size="sm" onClick={onClose} disabled={running}>{outcomes ? 'Close' : 'Cancel'}</Button>
            {!outcomes && (
              <Button
                variant="primary" size="sm"
                onClick={commit}
                disabled={!preview || writable.length === 0 || !confirmed || running}
                title={!preview ? 'Preview first' : writable.length === 0 ? 'Nothing in this scope would be written' : undefined}
              >
                {running ? <><Loader2 size={12} className="spin" /> Writing…</> : `Write ${writable.length} campaign${writable.length === 1 ? '' : 's'}`}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )

  // Portalled to `document.body`: a panel rendered inside the grid card is clipped by the card's
  // own overflow, which this section has already paid for once.
  return typeof document === 'undefined' ? null : createPortal(body, document.body)
}
