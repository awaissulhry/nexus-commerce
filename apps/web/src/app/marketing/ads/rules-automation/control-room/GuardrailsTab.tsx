'use client'

/**
 * ACR.1.3 — Guardrails: the bounds that bind every engine and rule.
 *
 * These numbers already existed and were scattered — two in a DB row, one in an env var, one
 * implied by a column's default-deny, one only countable by query. Setting the breaker
 * threshold required running a script, which is a strange property for the control that stops
 * the account to have.
 *
 * Two ideas from the competitor teardowns are load-bearing here:
 *   · Bounds belong on the ENTITY, not inside a rule (Quartile's portfolio grid, Rithum's
 *     per-SKU price floors). A column binds every engine automatically, including ones
 *     written next year. What this tab shows is coverage of those columns, not a rule list.
 *   · The boundary of authority should be COUNTED and visible (Quartile's
 *     "all (5) · managed (4) · not managed (1)"). An operator who can see exactly what
 *     automation owns is far more willing to let it own more.
 *
 * A null threshold is NOT "no limit" — it is the code's default. Showing a blank field would
 * read as unbounded, so both the effective and the explicitly-set value are rendered.
 */

import { useCallback, useEffect, useState } from 'react'
import { Save, AlertTriangle, Lock } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { Button, Input } from '@/design-system/primitives'
import { SummaryTable } from '@/design-system/components'
import { GuardrailGrid } from './GuardrailGrid'
import { ProtectedTermsPanel } from '../ProtectedTermsPanel'

interface Guardrails {
  actionsPerHour: { effective: number; set: number | null; default: number }
  spendPerHourCents: { effective: number; set: number | null; default: number }
  maxWriteValueCents: number
  campaigns: { total: number; managed: number; unmanaged: number }
  bounds: { withMinBid: number; withMaxBid: number }
  protectedTerms: number
  adsMode: string
  envKill: boolean
}

/** 1g — one engine's limits from GET /automation/state (ads-engine-actors.ts). Only the hourly one binds today. */
interface EngineLimit { key: string; label: string; perTick: number | null; perDay: number | null; breakerPerHour: number }

const eur = (cents: number) => `€${(cents / 100).toLocaleString('en-GB', { maximumFractionDigits: 0 })}`

export function GuardrailsTab() {
  const [g, setG] = useState<Guardrails | null>(null)
  const [actions, setActions] = useState('')
  const [spend, setSpend] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [limits, setLimits] = useState<EngineLimit[] | null>(null)
  const [limitsErr, setLimitsErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    // Each engine's hourly limit, from the same endpoint the brakes write to. A failure here leaves the rest of the tab.
    void fetch(`${getBackendUrl()}/api/advertising/automation/state`, { cache: 'no-store' })
      .then(async (r) => {
        if (!r.ok) throw new Error(`state: ${r.status}`)
        const j = (await r.json()) as { engineLimits?: EngineLimit[] }
        if (!Array.isArray(j.engineLimits)) throw new Error('the API sent no engine limits')
        setLimits(j.engineLimits); setLimitsErr(null)
      })
      .catch((e: unknown) => setLimitsErr((e as Error).message))
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/control-room/guardrails`, { cache: 'no-store' })
      if (!r.ok) throw new Error(`guardrails: ${r.status}`)
      const j = (await r.json()) as Guardrails
      setG(j)
      // Seed the inputs with what is SET, not what is effective — otherwise saving would
      // silently promote a default into an explicit value the operator never chose.
      setActions(j.actionsPerHour.set == null ? '' : String(j.actionsPerHour.set))
      setSpend(j.spendPerHourCents.set == null ? '' : String(Math.round(j.spendPerHourCents.set / 100)))
      setErr(null)
    } catch (e) { setErr((e as Error).message) }
  }, [])
  useEffect(() => { void load() }, [load])

  const save = async () => {
    if (busy) return
    setBusy(true); setErr(null); setSaved(false)
    try {
      const body = {
        maxActionsPerHour: actions.trim() === '' ? null : Number(actions),
        maxHourlySpendCentsEur: spend.trim() === '' ? null : Math.round(Number(spend) * 100),
      }
      // The API refuses the same (1g); asking here first keeps the sentence in the screen's own units.
      if (body.maxActionsPerHour != null && !(Number.isInteger(body.maxActionsPerHour) && body.maxActionsPerHour >= 1)) {
        throw new Error('Rule actions per hour must be a whole number of at least 1, or empty for the default.')
      }
      if (body.maxHourlySpendCentsEur != null && !(Number.isFinite(body.maxHourlySpendCentsEur) && body.maxHourlySpendCentsEur >= 1)) {
        throw new Error('Spend per hour must be more than €0, or empty for the default.')
      }
      const r = await fetch(`${getBackendUrl()}/api/advertising/automation/thresholds`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
      if (!r.ok) throw new Error(((await r.json().catch(() => null)) as { error?: string } | null)?.error ?? `Could not save (${r.status})`)
      await load()
      setSaved(true)
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }

  if (!g) return <div className="acr-empty">{err ?? 'Loading…'}</div>

  const pctManaged = g.campaigns.total ? Math.round((g.campaigns.managed / g.campaigns.total) * 100) : 0

  return (
    <div className="acr-guard">
      {err && <div className="acr-banner err" role="alert"><AlertTriangle size={15} /> {err}</div>}

      <div className="acr-sec-head"><h2>Circuit breaker</h2>
        <span className="acr-sec-count">Stops all automation when any limit below is passed in an hour</span>
      </div>
      <div className="acr-card">
        <div className="acr-fields">
          <label>
            <span className="acr-lbl">Rule actions per hour</span>
            <Input
              fieldClassName="acr-field"
              type="number" min={1} inputMode="numeric" value={actions}
              placeholder={`${g.actionsPerHour.default} (default)`}
              onChange={(e) => { setActions(e.target.value); setSaved(false) }}
            />
            <span className="acr-hint">
              In force: <strong>{g.actionsPerHour.effective}</strong>
              {g.actionsPerHour.set == null ? ' — the code default, not a choice anyone made' : ''}
            </span>
          </label>
          <label>
            <span className="acr-lbl">Spend per hour (€)</span>
            <Input
              fieldClassName="acr-field"
              type="number" min={1} inputMode="numeric" value={spend}
              placeholder={`${g.spendPerHourCents.default / 100} (default)`}
              onChange={(e) => { setSpend(e.target.value); setSaved(false) }}
            />
            <span className="acr-hint">
              In force: <strong>{eur(g.spendPerHourCents.effective)}</strong>
              {g.spendPerHourCents.set == null ? ' — the code default' : ''}
            </span>
          </label>
          <Button variant="success" size="sm" disabled={busy} onClick={() => void save()}>
            <Save size={14} /> {busy ? 'Saving…' : saved ? 'Saved' : 'Save'}
          </Button>
        </div>
        <p className="acr-note">
          Leave a field empty to fall back to the default. Rule actions counts the runs of
          automation rules only. Each engine&apos;s changes have their own hourly limit, below.
        </p>
      </div>

      {/* 1g — the limits the breaker holds each engine to (it counts the last 60 minutes of each one's changes). */}
      <div className="acr-sec-head"><h2>Each engine&apos;s changes per hour</h2>
        <span className="acr-sec-count">Set on the server — a change needs a deploy</span>
      </div>
      <div className="acr-card">
        {limits
          ? <SummaryTable
            label="Each engine's changes per hour"
            columns={['Engine', 'Changes per hour']}
            rows={limits.map((l) => ({ id: l.key, cells: [l.label, l.breakerPerHour.toLocaleString('en-GB')] }))}
          />
          : <p className="acr-note">{limitsErr ? `The engine limits could not be read (${limitsErr}).` : 'Loading…'}</p>}
        <p className="acr-note">
          When one engine makes more changes than its limit in the last 60 minutes, the breaker
          stops all automation, as it does for the limits above. The limits come
          from <code>NEXUS_ADS_ENGINE_CAPS</code> on the server, or the code&apos;s defaults.
        </p>
      </div>

      <div className="acr-sec-head"><h2>What automation may touch</h2>
        <span className="acr-sec-count">Default-deny — a campaign is off-limits until allowlisted</span>
      </div>
      <div className="acr-card">
        <div className="acr-counts">
          <div><span className="n">{g.campaigns.total}</span><span className="k">all campaigns</span></div>
          <div className="on"><span className="n">{g.campaigns.managed}</span><span className="k">managed</span></div>
          <div><span className="n">{g.campaigns.unmanaged}</span><span className="k">not managed</span></div>
        </div>
        <div className="acr-bar" role="img" aria-label={`${pctManaged}% of campaigns are managed by automation`}>
          <div className="acr-bar-fill" style={{ width: `${pctManaged}%` }} />
        </div>
        <p className="acr-note">
          {pctManaged}% of campaigns are reachable by automation. Re-enabling a paused campaign
          does <strong>not</strong> re-allowlist it — its writes will be refused until it is
          added back.
        </p>
      </div>

      <div className="acr-sec-head"><h2>Bounds and protections</h2>
        <span className="acr-sec-count">Stored on the entity, so every engine inherits them</span>
      </div>
      <div className="acr-card">
        <dl className="acr-facts wide">
          <div><dt>Campaigns with a min bid</dt><dd>{g.bounds.withMinBid} of {g.campaigns.total}</dd></div>
          <div><dt>Campaigns with a max bid</dt><dd>{g.bounds.withMaxBid} of {g.campaigns.total}</dd></div>
          <div><dt>Protected terms</dt><dd className={g.protectedTerms === 0 ? 'bad' : undefined}>{g.protectedTerms}</dd></div>
          <div><dt>Per-write ceiling</dt><dd>{eur(g.maxWriteValueCents)} <Lock size={11} /></dd></div>
        </dl>
        <p className="acr-note">
          Bid bounds and per-dimension pins are editable in the grid below, and on the Ad Manager
          grid one campaign at a time. The per-write ceiling and the live-mode flag
          (<code>{g.adsMode}</code>{g.envKill ? ', kill switch SET' : ''}) come from the environment
          and need a deploy to change — shown here so the full set is in one place.
        </p>
      </div>

      {/* ACR.1.3b — the rows behind the counts above. A coverage number with no way to move it
          is a report, not a control. */}
      <GuardrailGrid />

      {/*
        ACR.1.3f — the protected-terms panel, SECOND MOUNT.

        The card above counts protected terms and stops there, which is the same defect the
        grid was built to remove: a number describing work with nowhere to do it. Protection
        belongs on this tab because it is a bound of exactly the kind this tab is about — it
        is enforced at `ads-write-gate`, beside the allowlist, the bid bounds and the pins,
        and refuses the write outright (`keyword_protected`).

        The SAME component the Negative Targeting tab mounts, with no props and no copy of
        its markup — the doc's "one implementation, two mounts". Its `h10-pt-*` styles come
        from `rules-automation.css`, which the parent layout loads for this route; verified
        in the deployed CSSOM before mounting rather than assumed, since borrowed classes
        that turn out not to cascade are what shipped the Coverage page unstyled.
      */}
      {/*
        No `acr-sec-head` above it, unlike every other section on this tab: the panel titles
        and explains itself, so adding one rendered "PROTECTED TERMS" immediately above the
        panel's own "Protected terms" — two headings, one subject. Reusing a component means
        letting it own its presentation; the alternative is a second place to keep in sync,
        which is the whole reason this is a second MOUNT and not a second copy.
      */}
      <div className="acr-pt-mount">
        <ProtectedTermsPanel />
      </div>
    </div>
  )
}
