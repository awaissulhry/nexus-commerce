'use client'

/**
 * U9 — the selection toolbar Helium 10 puts on Apply Rules: **[Automation] [Bid Automation]
 * [Target ACoS] [Min/Max Bid]**, applied to the checked campaigns.
 * (U13, 2026-08-20, added the second one; U9 shipped the other three.)
 *
 * Study `docs/2026-08-16-ra-h10-reference-study.md` §3.1 and §7.10. H10's fifth verb,
 * **[+ Assign Rule]**, arrived with W2 (2026-08-20) — see below.
 *
 * ── D6, answered by the operator 2026-08-18 with these measurements ─────────────────────────────
 * · **Grains stay** (all four). H10 has campaigns only; this page keeps Portfolios / Product lines /
 *   Markets as a documented departure, so the selection toolbar renders on the CAMPAIGN grain only —
 *   every verb writes a campaign field, and an aggregate row is not a campaign.
 * · **No Bid Rule / Budget Rule columns.** Measured on prod: **0 of 51 rules are campaign- or
 *   portfolio-scoped** (43 account-wide, 8 market), so a column naming the rule that applies would
 *   print the same value on all 220 rows — the decorative-column class this programme removes. The
 *   existing "Automations" column already carries the truthful version.
 * · **"+ Assign Rule" was withheld on 2026-08-18** because `scopeCampaignId` is single-valued and
 *   assigning would MOVE a rule. D1 (2026-08-20, `CampaignRuleAssignment`) removed that blocker:
 *   assignment is campaign → rule, many-to-many, staged through the same Apply bar as the Budget
 *   Rule cell. **W2 ships the verb for budget rules** — the one kind whose end-to-end machinery
 *   (backfill → resolver → reach → staged Apply) is proven. Bid/placement kinds wait on the D4+
 *   decision, because the FIRST assignment on an account-wide rule narrows it from 220 campaigns
 *   to the assigned set, and that cutover belongs to the operator.
 *
 * ── The three endpoints, each already proven by another surface ─────────────────────────────────
 * · Automation → `PATCH /campaigns/:id/live-writes { enabled }` — the WRITE GATE, which is what
 *   this page's "Automations" column shows (Managed / Off-limits). Control Room bulk-writes it the
 *   same way. Note this is NOT `bidAutomation`: that is the Ad Manager's bid-algorithm switch, a
 *   different field, and setting it from a column that shows the gate would be a lie.
 * · Target ACoS → `PATCH /campaigns/:id/automation { targetAcos }` — 🔴 a **FRACTION**, not a
 *   percentage. `CampaignsGrid` and the campaign Details tab both divide by 100 before sending, and
 *   `PUT /campaigns/:id/goal` already refuses the whole-number form (the AIREON 30-vs-0.3 trap).
 * · Min/Max Bid → `PATCH /campaigns/:id/guardrails { minBidCents, maxBidCents }` — the same route
 *   AR.S1's per-row dialog uses. **Only what was typed is sent**: an untouched bound left as `null`
 *   would clear it on every selected campaign, which is Control Room's own hard-won rule.
 *
 * Every verb reports per-campaign outcomes: a refusal at the gate is the gate working, so failures
 * are counted and named rather than swallowed.
 */
import { useState } from 'react'
import { Button, Input } from '@/design-system/primitives'
import { getBackendUrl } from '@/lib/backend-url'
import { emitAdsChange } from '../_shared/adsBus'

type Verb = 'automation' | 'bidauto' | 'acos' | 'bounds'

/**
 * 🔴 Two of these four say "automation" and they write DIFFERENT fields. That is not a naming
 * slip, it is the account's actual shape, so the labels keep them apart rather than blurring them:
 *
 *   **Automation**      → `liveBidWritesEnabled`, the write GATE. 82 of 220 open. This is the one
 *                         the Automations column shows, and the only per-campaign field every
 *                         executor honours.
 *   **Bid Automation**  → `dynamicBidding.bidAutomation`, H10's own switch and the one the Bid
 *                         Automation column shows. Off on 220 of 220. U13 (2026-08-20) added it so
 *                         the bulk menu and the new per-row switch write the same field — the
 *                         operator's study asks for this control in both places.
 *
 * Each popover names its field in a full sentence, because a four-word button cannot.
 */
const LABEL: Record<Verb, string> = { automation: 'Automation', bidauto: 'Bid Automation', acos: 'Target ACoS', bounds: 'Min/Max Bid' }

export interface BulkResult { ok: number; failed: Array<{ id: string; why: string }> }

async function patch(path: string, body: unknown): Promise<string | null> {
  try {
    const r = await fetch(`${getBackendUrl()}${path}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    const j = await r.json().catch(() => ({}))
    if (!r.ok || j?.ok === false) return String(j?.error ?? `HTTP ${r.status}`)
    return null
  } catch (e) { return (e as Error).message || 'network' }
}

export function ArBulkVerbs({ ids, names, onDone, onAssignRule }: {
  ids: string[]
  /** id → campaign name, so a refusal names the campaign rather than an opaque id. */
  names: Map<string, string>
  onDone: () => void
  /** W2 — "+ Assign Rule": opens the shared budget-rule modal over the whole selection.
   *  Assignment STAGES (the page's Apply bar commits), so unlike the four writing verbs this
   *  button reports no result here — the STAGED chips and the bar are the report. */
  onAssignRule: () => void
}) {
  const [open, setOpen] = useState<Verb | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<BulkResult | null>(null)
  /**
   * W2 (fixes the U9 defect all four verbs shared) — whether THIS popover session wrote anything.
   * `onDone` clears the page's selection, and the grid renders `selectionActions` only while the
   * selection is non-empty — so calling it from `run()` unmounted the popover together with the
   * "{ok} written · {n} refused" line it had just rendered. Measured on prod 2026-08-20: `.res`
   * was null after a successful apply, and a PARTIAL success destroyed the refusal list naming
   * the campaigns — the one thing that report exists for. The selection now clears when the
   * popover CLOSES, not when the write lands.
   */
  const [wrote, setWrote] = useState(false)

  // Automation (the write gate)
  const [autoOn, setAutoOn] = useState(true)
  // Bid Automation (H10's field) — starts OFF, because 220 of 220 are off and a bulk verb should
  // not pre-select the change nobody has made.
  const [bidAutoOn, setBidAutoOn] = useState(false)
  // Target ACoS
  const [acos, setAcos] = useState('')
  // Bounds
  const [minB, setMinB] = useState('')
  const [maxB, setMaxB] = useState('')

  const close = () => {
    // Order matters: onDone unmounts this component, so it goes last and nothing follows it.
    setOpen(null); setResult(null); setWrote(false)
    if (wrote) onDone()
  }

  const run = async (verb: Verb) => {
    setBusy(true)
    const failed: BulkResult['failed'] = []
    let ok = 0
    for (const id of ids) {
      let why: string | null = null
      if (verb === 'automation') {
        why = await patch(`/api/advertising/campaigns/${id}/live-writes`, { enabled: autoOn })
      } else if (verb === 'bidauto') {
        // U13 — the same route and field as the per-row switch and as the Ad Manager's own bulk
        // modal. Three writers, one field, one unit.
        why = await patch(`/api/advertising/campaigns/${id}/automation`, { bidAutomation: bidAutoOn })
      } else if (verb === 'acos') {
        // 🔴 fraction, not percent.
        why = await patch(`/api/advertising/campaigns/${id}/automation`, { targetAcos: Number(acos) / 100 })
      } else {
        const body: Record<string, number> = {}
        if (minB.trim() !== '') body.minBidCents = Math.round(Number(minB) * 100)
        if (maxB.trim() !== '') body.maxBidCents = Math.round(Number(maxB) * 100)
        why = await patch(`/api/advertising/campaigns/${id}/guardrails`, body)
      }
      if (why) failed.push({ id, why }); else ok++
    }
    setBusy(false)
    setResult({ ok, failed })
    if (ok > 0) {
      // After the writes settle, once — the grid and every other open tab re-read. The
      // selection is deliberately NOT cleared here (see `wrote` above): the popover must
      // survive to show the result, refusals included.
      emitAdsChange('ads.guardrail.changed')
      setWrote(true)
    }
  }

  const acosNum = Number(acos)
  const acosValid = acos.trim() !== '' && Number.isFinite(acosNum) && acosNum > 0 && acosNum <= 100
  const boundsValid = (minB.trim() !== '' || maxB.trim() !== '')
    && (minB.trim() === '' || Number.isFinite(Number(minB)))
    && (maxB.trim() === '' || Number.isFinite(Number(maxB)))
    && !(minB.trim() !== '' && maxB.trim() !== '' && Number(minB) > Number(maxB))

  const n = ids.length
  const noun = `${n} campaign${n === 1 ? '' : 's'}`

  return (
    <span className="h10-bulkrow h10-ar-bulk">
      {/* H10's slot for it: right after [Automation]. Rendering it first of the five would put a
          staging verb ahead of the gate, which is not the order the study shows. */}
      {(['automation', 'assign', 'bidauto', 'acos', 'bounds'] as const).map((v) => v === 'assign' ? (
        /* Collapses any open popover WITHOUT the close() path — close() may clear the selection
           (after a write), and this button is about to open a modal over that very selection. */
        <Button key="assign" variant="ghost" onClick={() => { setOpen(null); setResult(null); onAssignRule() }}>
          + Assign Rule
        </Button>
      ) : (
        <span key={v} className="h10-ar-bulkwrap">
          <Button variant="ghost" aria-expanded={open === v} onClick={() => { if (open === v) close(); else { setResult(null); setOpen(v) } }}>
            {LABEL[v]}
          </Button>
          {open === v && (
            <div className="h10-ar-pop" role="dialog" aria-label={`${LABEL[v]} for ${noun}`}>
              <b>{LABEL[v]}</b>
              <p className="sub">Applies to the {noun} selected.</p>

              {v === 'automation' && (
                <div className="rads">
                  {/* The label says what the switch IS — this page's Automations column is the
                      write gate, not the Ad Manager's bid-algorithm toggle. */}
                  <label><input type="radio" name="arauto" checked={autoOn} onChange={() => setAutoOn(true)} /> Managed — armed automation may write here</label>
                  <label><input type="radio" name="arauto" checked={!autoOn} onChange={() => setAutoOn(false)} /> Off-limits — every write is refused at the gate</label>
                </div>
              )}

              {v === 'bidauto' && (
                <div className="rads">
                  <label><input type="radio" name="arbidauto" checked={bidAutoOn} onChange={() => setBidAutoOn(true)} /> On — bid suggestions apply themselves here</label>
                  <label><input type="radio" name="arbidauto" checked={!bidAutoOn} onChange={() => setBidAutoOn(false)} /> Off — bid suggestions stay proposals</label>
                  {/* Said plainly, where the decision is made. The field stores durably; nothing
                      reads it yet, and an operator setting it deserves to know that now rather
                      than discover it from an absence of writes. */}
                  <p className="sub">Recorded on each campaign. No bid optimizer reads this field yet, so on its own it applies nothing — the write gate above is what decides whether automation may write at all.</p>
                </div>
              )}

              {v === 'acos' && (
                <label className="fld">Target ACoS
                  <Input size="sm" fieldClassName="in" suffix="%" className="ar-fig" inputMode="decimal" value={acos} onChange={(e) => setAcos(e.target.value)} aria-label="Target ACoS percent" />
                </label>
              )}

              {v === 'bounds' && (
                <>
                  <label className="fld">Min bid <Input size="sm" fieldClassName="in" prefix="€" className="ar-fig" inputMode="decimal" value={minB} onChange={(e) => setMinB(e.target.value)} aria-label="Minimum bid" /></label>
                  <label className="fld">Max bid <Input size="sm" fieldClassName="in" prefix="€" className="ar-fig" inputMode="decimal" value={maxB} onChange={(e) => setMaxB(e.target.value)} aria-label="Maximum bid" /></label>
                  <p className="sub">Leave one blank to leave it as it is — a blank is not a clear.</p>
                </>
              )}

              {result && (
                <p className={`res ${result.failed.length ? 'warn' : 'ok'}`} role="status">
                  {result.ok} written{result.failed.length > 0 && <> · {result.failed.length} refused</>}
                  {result.failed.slice(0, 3).map((f) => (
                    <em key={f.id}>{names.get(f.id) ?? f.id}: {f.why}</em>
                  ))}
                </p>
              )}

              <div className="acts">
                <button type="button" className="cancel" onClick={close}>{result ? 'Close' : 'Cancel'}</button>
                <button
                  type="button" className="apply"
                  disabled={busy || (v === 'acos' && !acosValid) || (v === 'bounds' && !boundsValid)}
                  onClick={() => void run(v)}
                >{busy ? 'Writing…' : 'Apply'}</button>
              </div>
            </div>
          )}
        </span>
      ))}
    </span>
  )
}
