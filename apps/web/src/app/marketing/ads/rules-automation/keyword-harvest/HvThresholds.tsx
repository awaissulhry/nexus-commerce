'use client'

/**
 * ⛔ PARKED 2026-08-18 (U7) — NOT MOUNTED, NOT DELETED.
 *
 * What it is: the five harvest criteria as live controls, over the stored policy.
 * Why it left: the Keyword Harvest tab is now Helium 10's shape — the pill
 *   [ Rules View | Ad Group View ] over one card, and nothing else
 *   (`KeywordHarvestRulesClient.tsx`; study `docs/2026-08-16-ra-h10-reference-study.md` §3.3, §7.8).
 * Candidate home: the harvest rule BUILDER — criteria belong in the rule, which is H10's shape.
 *
 * ⚠ Nothing here was changed, no endpoint was retired, and the harvest engine's own arming is
 * untouched. The file stays at this path on purpose: re-mounting it is one import.
 * Manifest: `docs/2026-08-16-ra-parked-sections.md`.
 */

/**
 * HV.2 — the criteria, as live controls, plus the policy behind them.
 *
 * ── 🔴 Two things, two labels, never one control ──────────────────────────────────────────────
 *
 *   **the filter** — the top row. Moves the grid immediately, lives in the URL, binds nothing.
 *                    A link carries it.
 *   **the policy** — the bottom line. Saved for a scope, changes the default for everyone in it.
 *                    The link carries the scope; the policy is looked up.
 *
 * A user moves the filter to explore. A user saves a policy when they have decided. Two verbs, two
 * affordances. The Save button appears only once the filter differs from the policy, because a
 * "save" that would write what is already stored is a control that changes no pixel.
 *
 * ── Why the attrition row exists ──────────────────────────────────────────────────────────────
 *
 * **A single surviving count tells you nothing about which knob to turn.** "92 → 8" is a fact;
 * "orders removes 75 · clicks removes 2 · ACoS removes 3 · exact-matched removes 4" is a decision.
 * Every step also reports how many of its removals were `new`, because the shipped defaults remove
 * this account's ONE genuinely-new candidate and a bar that quietly took the page's only real
 * finding off the screen would be worse than no bar at all.
 *
 * ── What this section must NOT own ────────────────────────────────────────────────────────────
 *
 * The negation threshold (Negative Targeting owns it, D4 — this page renders no negation control),
 * the account mode dial and any ceiling (Automations owns both, §11 C1–C3), and any write to
 * Amazon. This section changes what COUNTS as a candidate, never what is allowed to act on one.
 */

import { useEffect, useMemo, useState } from 'react'
import { Button, SegmentedControl } from '@/design-system/primitives'
import { AlertTriangle, Check, Info, RotateCcw, Save, Trash2 } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import type { HvSlotProps, HarvestCriteria, HvPolicyGrain } from './slot-contract'
import { emitAdsChange } from '../_shared/adsBus'

const GRAIN_LABEL: Record<HvPolicyGrain | 'default', string> = {
  account: 'account', market: 'market', line: 'product line', portfolio: 'portfolio',
  campaign: 'campaign', adGroup: 'ad group', default: 'shipped default',
}

const num = (n: number) => n.toLocaleString('en-IE')

/** The criteria the URL is allowed to carry, and the param each one uses. */
const PARAM: Record<keyof HarvestCriteria, string> = {
  minOrders: 'minOrders', minClicks: 'minClicks', maxAcosPct: 'maxAcos',
  windowDays: 'window', excludeExactMatched: 'matched',
}

const sameCriteria = (a: HarvestCriteria, b: HarvestCriteria) =>
  a.minOrders === b.minOrders && a.minClicks === b.minClicks && a.maxAcosPct === b.maxAcosPct
  && a.windowDays === b.windowDays && a.excludeExactMatched === b.excludeExactMatched

export function HvThresholds({ criteria, attrition, census, scope, push, reload, loading }: HvSlotProps) {
  const [saving, setSaving] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [err, setErr] = useState<string | null>(null)
  // The banner is transient; clear it as soon as the criteria move again.
  useEffect(() => { if (saving === 'saved') { const t = window.setTimeout(() => setSaving('idle'), 2600); return () => window.clearTimeout(t) } }, [saving])

  const dirty = useMemo(
    () => (criteria ? !sameCriteria(criteria.inForce, criteria.policy.criteria) : false),
    [criteria],
  )

  if (!criteria) return null
  const c = criteria.inForce
  const p = criteria.policy
  const over = new Set(criteria.overridden)

  const set = (patch: Record<string, string>) => push(patch)

  const write = async (method: 'PUT' | 'DELETE') => {
    setSaving('saving'); setErr(null)
    try {
      const url = `${getBackendUrl()}/api/advertising/harvest-policy`
      const res = method === 'PUT'
        ? await fetch(url, {
          method, headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ scopeGrain: p.saveGrain, scopeId: p.saveScopeId, ...c, maxAcosPct: c.maxAcosPct }),
        })
        : await fetch(`${url}?scopeGrain=${encodeURIComponent(p.saveGrain)}&scopeId=${encodeURIComponent(p.saveScopeId ?? '')}`, { method, credentials: 'include' })
      const j = await res.json().catch(() => ({}))
      if (!res.ok || j?.ok === false) throw new Error(j?.error ?? `HTTP ${res.status}`)
      setSaving('saved')
      // Clear the URL overrides: they have become the policy, so leaving them would show the same
      // numbers while claiming they are still a temporary filter.
      if (method === 'PUT') push({ minOrders: '', minClicks: '', maxAcos: '', window: '', matched: '' })
      reload()
      // RT.1 — a threshold change re-decides every candidate row.
      emitAdsChange('ads.keyword.changed')
    } catch (e) { setSaving('error'); setErr((e as Error).message) }
  }

  const saveTarget = p.saveGrain === 'account'
    ? 'the whole account'
    : `this ${GRAIN_LABEL[p.saveGrain]}${p.saveScopeId && p.saveGrain === 'market' ? ` (${p.saveScopeId})` : ''}`

  return (
    <div className="h10-hv-crit">
      {/* ── the filter ─────────────────────────────────────────────────────────────────────── */}
      <div className="h10-hv-critrow">
        <span className="h10-hv-lbl">Counts as a candidate</span>

        <Field label="Min orders" over={over.has('minOrders')}>
          <NumberStepper value={c.minOrders} min={1} max={20} onChange={(v) => set({ [PARAM.minOrders]: String(v) })} ariaLabel="Minimum orders" />
        </Field>

        <Field label="Min clicks" over={over.has('minClicks')} tip="A fluke guard, not a volume gate. At this account's 1.3–2.5% conversion rate, 2 orders on 1 click is an attribution artefact rather than demand.">
          <NumberStepper value={c.minClicks} min={0} max={100} onChange={(v) => set({ [PARAM.minClicks]: String(v) })} ariaLabel="Minimum clicks" />
        </Field>

        <Field label="Max ACoS" over={over.has('maxAcosPct')} tip="Defaults to 45% — this account's own blended ACoS on all search-term traffic over 60 days. No campaign carries a target ACoS, so there is nothing else to inherit. A candidate with orders but no attributed sales has no ACoS and is never excluded by this.">
          <span className="h10-hv-acos">
            <NumberStepper
              value={c.maxAcosPct ?? 0} min={0} max={500} step={5} disabled={c.maxAcosPct == null}
              onChange={(v) => set({ [PARAM.maxAcosPct]: String(v) })} ariaLabel="Maximum ACoS percent" suffix="%"
            />
            <button
              type="button" className={`h10-hv-ceil ${c.maxAcosPct == null ? 'off' : ''}`}
              /* 'none' rather than an empty param: without it, "cleared the ceiling" and "never had
                 one" would be the same URL and a link could not carry the difference. */
              onClick={() => set({ [PARAM.maxAcosPct]: c.maxAcosPct == null ? String(p.criteria.maxAcosPct ?? 45) : 'none' })}
              title={c.maxAcosPct == null ? 'Re-apply a ceiling' : 'Remove the ceiling for this view'}
            >{c.maxAcosPct == null ? 'no ceiling' : 'clear'}</button>
          </span>
        </Field>

        <Field label="Window" over={over.has('windowDays')}>
          <SegmentedControl
            ariaLabel="Window"
            size="sm"
            value={String(c.windowDays)}
            onChange={(v) => set({ [PARAM.windowDays]: v })}
            options={[30, 60, 90].map((d) => ({ value: String(d), label: `${d}d` }))}
          />
        </Field>

        <Field label="Match type" over={over.has('excludeExactMatched')} tip="A term is harvestable only where it arrived through a LOOSER match than the one we would create: auto and product expressions → phrase/exact, broad → phrase/exact, phrase → exact. A term whose every order came via an EXACT match is offering to create the very keyword that produced the traffic. Product targets are exempt.">
          <SegmentedControl
            ariaLabel="Match type"
            size="sm"
            value={c.excludeExactMatched ? 'harvestable' : 'all'}
            onChange={(v) => set({ [PARAM.excludeExactMatched]: v })}
            options={[{ value: 'harvestable', label: 'harvestable' }, { value: 'all', label: 'any match' }]}
          />
        </Field>

        {criteria.overridden.length > 0 && (
          <Button
            size="xs" className="h10-hv-clear"
            onClick={() => push({ minOrders: '', minClicks: '', maxAcos: '', window: '', matched: '' })}
            title="Go back to the criteria this scope's policy supplies"
          ><RotateCcw size={12} /> Reset to policy</Button>
        )}
      </div>

      {/* ── what each criterion removed ────────────────────────────────────────────────────── */}
      {attrition && (
        <div className="h10-hv-attr" aria-live="polite">
          <span className="base">{num(attrition.base)} {attrition.baseLabel}</span>
          {attrition.steps.map((s) => (
            <span key={s.key} className={`stp ${s.removed === 0 ? 'nil' : ''} ${s.removedNew > 0 ? 'new' : ''}`}>
              <b>{s.label}</b>
              {s.removed === 0
                ? <i>removes nothing</i>
                : <i>−{num(s.removed)}{s.removedNew > 0 && <em title={`${s.removedNew} of the rows this removed have no keyword anywhere — the only status that represents something to create`}> · {num(s.removedNew)} new</em>}</i>}
            </span>
          ))}
          <span className="out"><b>{num(census?.candidates ?? 0)}</b> candidate{(census?.candidates ?? 0) === 1 ? '' : 's'}</span>
        </div>
      )}

      {/* 🔴 The one that matters most, said in words rather than left in a chip. */}
      {attrition && attrition.steps.some((s) => s.removedNew > 0) && (
        <p className="h10-hv-critwarn">
          <AlertTriangle size={12} />
          <span>
            {attrition.steps.filter((s) => s.removedNew > 0).map((s) => `${num(s.removedNew)} behind “${s.label}”`).join(', ')} —{' '}
            <b>{num(attrition.steps.reduce((a, s) => a + s.removedNew, 0))} term{attrition.steps.reduce((a, s) => a + s.removedNew, 0) === 1 ? '' : 's'} with no keyword anywhere {attrition.steps.reduce((a, s) => a + s.removedNew, 0) === 1 ? 'is' : 'are'} hidden by these criteria.</b>{' '}
            Those are the only rows that represent something to create.
          </span>
        </p>
      )}

      {/* ── the policy ─────────────────────────────────────────────────────────────────────── */}
      <div className="h10-hv-pol">
        <span className="txt">
          <Info size={12} />
          <span>
            <b>In force here:</b> {p.criteria.minOrders}+ order{p.criteria.minOrders === 1 ? '' : 's'} · {p.criteria.minClicks}+ click{p.criteria.minClicks === 1 ? '' : 's'} ·{' '}
            {p.criteria.maxAcosPct == null ? 'no ACoS ceiling' : `ACoS ≤ ${p.criteria.maxAcosPct}%`} · {p.criteria.windowDays}-day window ·{' '}
            {p.criteria.excludeExactMatched ? 'excluding exact-matched' : 'any match type'} — from the{' '}
            <b>{GRAIN_LABEL[p.source]}{p.sourceScopeId ? ` ${p.sourceScopeId}` : ''}</b> policy.
            {p.source === 'default' && ' No policy has been saved anywhere yet.'}
            {p.source !== 'default' && !p.hasOwn && ` This ${GRAIN_LABEL[p.saveGrain]} has no policy of its own.`}
            {p.updatedBy && <> Set by {p.updatedBy}{p.updatedAt ? ` on ${new Date(p.updatedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : ''}.</>}
          </span>
        </span>

        <span className="act">
          {/* Hidden, not disabled: with nothing changed there is nothing to save, so no button. */}
          {dirty && (
            <button type="button" className="h10-hv-save" onClick={() => void write('PUT')} disabled={saving === 'saving' || loading}>
              <Save size={12} /> {saving === 'saving' ? 'Saving…' : p.hasOwn ? `Update the ${GRAIN_LABEL[p.saveGrain]} policy` : `Save for ${saveTarget}`}
            </button>
          )}
          {p.hasOwn && !dirty && (
            <button type="button" className="h10-hv-unset" onClick={() => void write('DELETE')} disabled={saving === 'saving'} title={`Remove this ${GRAIN_LABEL[p.saveGrain]} policy so the scope inherits from above`}>
              <Trash2 size={12} /> Remove this {GRAIN_LABEL[p.saveGrain]} policy
            </button>
          )}
          {saving === 'saved' && <span className="ok"><Check size={12} /> Saved</span>}
        </span>
      </div>

      {/* D4 — the full sentence a save needs: what changes, for which scope, and what it does NOT
          touch. This is the difference between a threshold control and a threshold control an
          operator can trust. */}
      {dirty && (
        <p className="h10-hv-critsay">
          Saving writes <b>{c.minOrders}+ orders · {c.minClicks}+ clicks · {c.maxAcosPct == null ? 'no ACoS ceiling' : `ACoS ≤ ${c.maxAcosPct}%`} · {c.windowDays}d · {c.excludeExactMatched ? 'excluding exact-matched' : 'any match type'}</b>{' '}
          as the default for <b>{saveTarget}</b>
          {scope.market !== 'all' && p.saveGrain === 'account' && <> — not just {scope.market}</>}.
          {' '}It changes what this page proposes, and <b>nothing else</b>: harvest rules read their
          own builder criteria, never these defaults. Reversible from here.
        </p>
      )}

      {err && <p className="h10-hv-blind"><AlertTriangle size={13} /><span>{err}</span></p>}
    </div>
  )
}

function Field({ label, tip, over, children }: { label: string; tip?: string; over: boolean; children: React.ReactNode }) {
  return (
    <span className={`h10-hv-field ${over ? 'over' : ''}`}>
      {/* An overridden criterion is marked, because "this view only" and "saved for everyone" must
          never look the same. */}
      <span className="cap" title={tip}>{label}{over && <i title="Overridden for this view only — not saved">view</i>}</span>
      {children}
    </span>
  )
}

/** A number the operator nudges. Typing is allowed; the value is clamped on the server too. */
// Renamed from `Stepper` 2026-08-25: the DS exports a `Stepper` too, and it is a WIZARD PROGRESS
// indicator — an <ol> of done/active/upcoming steps. This is a numeric input with +/- buttons.
// Both are legitimate meanings of the word; sharing the name only invites importing the wrong one.
// The DS has no numeric stepper at all, so this stays local until one is wanted.
function NumberStepper({
  value, min, max, step = 1, onChange, ariaLabel, suffix, disabled,
}: { value: number; min: number; max: number; step?: number; onChange: (v: number) => void; ariaLabel: string; suffix?: string; disabled?: boolean }) {
  const clamp = (v: number) => Math.max(min, Math.min(max, v))
  return (
    <span className={`h10-hv-step ${disabled ? 'off' : ''}`}>
      <button type="button" onClick={() => onChange(clamp(value - step))} aria-label={`${ariaLabel} down`} disabled={disabled || value <= min}>−</button>
      <input
        type="number" value={disabled ? '' : value} min={min} max={max} step={step} disabled={disabled}
        aria-label={ariaLabel}
        onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v)) onChange(clamp(v)) }}
      />
      {suffix && !disabled && <em>{suffix}</em>}
      <button type="button" onClick={() => onChange(clamp(value + step))} aria-label={`${ariaLabel} up`} disabled={disabled || value >= max}>+</button>
    </span>
  )
}
