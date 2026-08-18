'use client'

/**
 * U9 — the selection toolbar Helium 10 puts on Apply Rules: **[Automation] [Target ACoS]
 * [Min/Max Bid]**, applied to the checked campaigns.
 *
 * Study `docs/2026-08-16-ra-h10-reference-study.md` §3.1 and §7.10. H10 shows a fourth verb,
 * **[+ Assign Rule]**, and it is deliberately NOT built here — see the operator decision below.
 *
 * ── D6, answered by the operator 2026-08-18 with these measurements ─────────────────────────────
 * · **Grains stay** (all four). H10 has campaigns only; this page keeps Portfolios / Product lines /
 *   Markets as a documented departure, so the selection toolbar renders on the CAMPAIGN grain only —
 *   the three verbs write campaign fields, and an aggregate row is not a campaign.
 * · **No Bid Rule / Budget Rule columns.** Measured on prod: **0 of 51 rules are campaign- or
 *   portfolio-scoped** (43 account-wide, 8 market), so a column naming the rule that applies would
 *   print the same value on all 220 rows — the decorative-column class this programme removes. The
 *   existing "Automations" column already carries the truthful version.
 * · **No "+ Assign Rule".** `scopeCampaignId` is SINGLE-VALUED, so assigning a rule to a second
 *   campaign MOVES it off the first. With 0 rules currently campaign-bound, the first use of that
 *   button would silently unbind whatever it touched next. It waits for additive `scope*Ids`
 *   columns; a control that quietly destroys a binding is worse than a missing one.
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
import { getBackendUrl } from '@/lib/backend-url'
import { emitAdsChange } from '../_shared/adsBus'

type Verb = 'automation' | 'acos' | 'bounds'

const LABEL: Record<Verb, string> = { automation: 'Automation', acos: 'Target ACoS', bounds: 'Min/Max Bid' }

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

export function ArBulkVerbs({ ids, names, onDone }: {
  ids: string[]
  /** id → campaign name, so a refusal names the campaign rather than an opaque id. */
  names: Map<string, string>
  onDone: () => void
}) {
  const [open, setOpen] = useState<Verb | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<BulkResult | null>(null)

  // Automation
  const [autoOn, setAutoOn] = useState(true)
  // Target ACoS
  const [acos, setAcos] = useState('')
  // Bounds
  const [minB, setMinB] = useState('')
  const [maxB, setMaxB] = useState('')

  const close = () => { setOpen(null); setResult(null) }

  const run = async (verb: Verb) => {
    setBusy(true)
    const failed: BulkResult['failed'] = []
    let ok = 0
    for (const id of ids) {
      let why: string | null = null
      if (verb === 'automation') {
        why = await patch(`/api/advertising/campaigns/${id}/live-writes`, { enabled: autoOn })
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
      // After the writes settle, once — the grid and every other open tab re-read.
      emitAdsChange('ads.guardrail.changed')
      onDone()
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
      {(['automation', 'acos', 'bounds'] as const).map((v) => (
        <span key={v} className="h10-ar-bulkwrap">
          <button type="button" className="h10-am-btn bulk" aria-expanded={open === v} onClick={() => { setResult(null); setOpen(open === v ? null : v) }}>
            {LABEL[v]}
          </button>
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

              {v === 'acos' && (
                <label className="fld">Target ACoS
                  <span className="in"><input inputMode="decimal" value={acos} onChange={(e) => setAcos(e.target.value)} aria-label="Target ACoS percent" /><i>%</i></span>
                </label>
              )}

              {v === 'bounds' && (
                <>
                  <label className="fld">Min bid <span className="in"><i>€</i><input inputMode="decimal" value={minB} onChange={(e) => setMinB(e.target.value)} aria-label="Minimum bid" /></span></label>
                  <label className="fld">Max bid <span className="in"><i>€</i><input inputMode="decimal" value={maxB} onChange={(e) => setMaxB(e.target.value)} aria-label="Maximum bid" /></span></label>
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
