'use client'

/**
 * ER1 — Details (Settings v2), modeled on the Amazon DetailsTab contract
 * (§PL-5): sticky scroll-spy subnav + .h10-cd-sec section cards +
 * always-editable fields + whole-form snapshot diff + ALWAYS-rendered sticky
 * footer (Discard/Save disabled unless dirty). Save fans out one guarded
 * write per dirty field group, then reloads (never optimistic). Fixes
 * critique D-1 (read-only settings) and D-2 (raw-JSON criterion/prefs).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { money } from '../../../../campaigns/_grid/format'
import { postEbayAds, type CampaignDetailPayload } from '../../../_lib'
import type { Strategy } from '../tabs'
import { CriterionCard } from './CriterionCard'

interface FormState { name: string; endDate: string; budgetEur: string; capPct: string }

const buildInitial = (d: CampaignDetailPayload): FormState => ({
  name: d.campaign.name,
  endDate: d.campaign.endDate ? d.campaign.endDate.slice(0, 10) : '',
  budgetEur: d.campaign.dailyBudgetCents != null ? (d.campaign.dailyBudgetCents / 100).toFixed(2) : '',
  capPct: (() => {
    const prefs = d.campaign.dynamicAdRatePrefs
    const p = Array.isArray(prefs) ? prefs[0] : prefs
    const v = (p as { adRateCapPercent?: string } | null)?.adRateCapPercent
    return v != null ? String(v) : ''
  })(),
})

export function DetailsTab({ data, campaignId, strategy, onSaved, say }: {
  data: CampaignDetailPayload; campaignId: string; strategy: Strategy
  onSaved: () => void; say: (m: string) => void
}) {
  const c = data.campaign
  const currency = data.currency
  const baseline = useMemo(() => buildInitial(data), [data])
  const [form, setForm] = useState<FormState>(baseline)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  useEffect(() => { setForm(baseline) }, [baseline])
  const set = (k: keyof FormState, v: string) => setForm((f) => ({ ...f, [k]: v }))
  const dirty = JSON.stringify(form) !== JSON.stringify(baseline)
  const ended = c.status === 'ENDED'

  // scroll-spy subnav (§PL-5 idiom)
  const SECTIONS = useMemo(() => {
    const s: Array<{ id: string; label: string }> = [{ id: 'campaign', label: 'Campaign' }, { id: 'schedule', label: 'Schedule' }]
    if (strategy === 'PRI_MANUAL' || strategy === 'PRI_SMART' || strategy === 'OFF') s.push({ id: 'budget', label: 'Budget' })
    if (strategy === 'GEN' || strategy === 'PRI_MANUAL') s.push({ id: 'bidding', label: strategy === 'GEN' ? 'Rate strategy' : 'Bidding' })
    if (c.isRulesBased) s.push({ id: 'targeting', label: 'Targeting' })
    s.push({ id: 'danger', label: 'Danger zone' })
    return s
  }, [strategy, c.isRulesBased])
  const [active, setActive] = useState('campaign')
  const refs = useRef<Record<string, HTMLElement | null>>({})
  useEffect(() => {
    const obs = new IntersectionObserver((entries) => {
      const vis = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
      if (vis[0]?.target.id) setActive(vis[0].target.id)
    }, { rootMargin: '-90px 0px -55% 0px' })
    Object.values(refs.current).forEach((el) => el && obs.observe(el))
    return () => obs.disconnect()
  }, [SECTIONS])

  const save = async () => {
    setSaving(true); setMsg(null)
    const done: string[] = []
    const failed: string[] = []
    try {
      if (form.name !== baseline.name || form.endDate !== baseline.endDate) {
        try {
          await postEbayAds(`/campaigns/${campaignId}/identification`, {
            ...(form.name !== baseline.name ? { name: form.name } : {}),
            ...(form.endDate !== baseline.endDate ? { endDate: form.endDate === '' ? null : form.endDate } : {}),
          }, 'PATCH')
          done.push('identification')
        } catch (e) { failed.push(`name/schedule: ${(e as Error).message}`) }
      }
      if (form.budgetEur !== baseline.budgetEur && form.budgetEur !== '') {
        try {
          await postEbayAds(`/campaigns/${campaignId}/budget`, { dailyBudgetCents: Math.round(Number(form.budgetEur) * 100) })
          done.push('budget')
        } catch (e) { failed.push(`budget: ${(e as Error).message}`) }
      }
      if (form.capPct !== baseline.capPct && c.adRateStrategy === 'DYNAMIC' && form.capPct !== '') {
        try {
          await postEbayAds(`/campaigns/${campaignId}/rate-strategy`, { adRateStrategy: 'DYNAMIC', capPct: Number(form.capPct) })
          done.push('rate cap')
        } catch (e) { failed.push(`rate cap: ${(e as Error).message}`) }
      }
      if (failed.length) setMsg(failed.join(' · '))
      else if (done.length) { setMsg('Campaign saved'); say('Campaign saved'); onSaved() }
      setTimeout(() => setMsg(null), 3200)
    } finally { setSaving(false) }
  }

  return (
    <div className="h10-cd-details">
      <div className="h10-cd-cols">
        <nav className="h10-cd-subnav" aria-label="Settings sections">
          {SECTIONS.map((s) => (
            <button key={s.id} type="button" className={active === s.id ? 'on' : ''} onClick={() => refs.current[s.id]?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>{s.label}</button>
          ))}
        </nav>
        <div className="h10-cd-form">
          <section id="campaign" ref={(el) => { refs.current.campaign = el }} className="h10-cd-sec">
            <h2>Campaign</h2>
            <div className="h10-cd-card pad">
              <div className="h10-cd-field">
                <label>Campaign name</label>
                <input value={form.name} maxLength={80} onChange={(e) => set('name', e.target.value)} disabled={ended} />
              </div>
              <p className="eb-be-hint" style={{ marginTop: 10 }}>
                {strategy === 'GEN' && !c.isRulesBased && <>General (CPS) — <b>the ad rate lives on each ad</b>; the campaign default applied at creation only. Change rates on the Ads tab.</>}
                {strategy === 'GEN' && c.isRulesBased && <>General (CPS), rules-based — listings are selected by the rules below; the campaign-level rate strategy applies to all of them.</>}
                {strategy === 'PRI_MANUAL' && <>Priority (CPC), manual targeting — keywords and bids live under ad groups. This strategy is the only one eligible for the first ad slot in search.</>}
                {strategy === 'PRI_SMART' && <>Priority (CPC), smart targeting — eBay picks targets under your max CPC. No keyword management exists on smart campaigns.</>}
                {strategy === 'OFF' && <>Promoted Offsite — eBay manages placement and CPC on external networks. Budget is the only lever.</>}
              </p>
              <div className="eb-headstats" style={{ marginTop: 14 }}>
                <div><span className="k">Marketplace</span><span className="v" style={{ fontSize: 13 }}>{c.marketplace}</span></div>
                <div><span className="k">Campaign ID</span><span className="v" style={{ fontSize: 13 }}><a className="h10-am-link" href={`https://www.ebay.it/sh/mkt/marketing/campaigns`} target="_blank" rel="noreferrer" title="Open Seller Hub advertising">{c.externalCampaignId}</a></span></div>
                <div><span className="k">Managed by</span><span className="v" style={{ fontSize: 13 }}>{c.nexusManaged ? 'Nexus' : 'Seller Hub'}</span></div>
                <div><span className="k">Status</span><span className="v" style={{ fontSize: 13 }}>{c.status}</span></div>
              </div>
            </div>
          </section>

          <section id="schedule" ref={(el) => { refs.current.schedule = el }} className="h10-cd-sec">
            <h2>Schedule</h2>
            <div className="h10-cd-card pad">
              <div className="eb-form-row">
                <div className="h10-cd-field s">
                  <label>Start date</label>
                  <input value={c.startDate.slice(0, 10)} disabled title="Start date is immutable once a campaign has launched" />
                </div>
                <div className="h10-cd-field s">
                  <label>End date — blank = never expires</label>
                  <input type="date" value={form.endDate} min={new Date().toISOString().slice(0, 10)} onChange={(e) => set('endDate', e.target.value)} disabled={ended} />
                </div>
              </div>
              {ended && <p className="eb-be-hint" style={{ marginTop: 10 }}>This campaign has <b>ended</b> — ENDED is terminal on eBay. Use <b>Clone campaign</b> (Action ▾) to relaunch it.</p>}
            </div>
          </section>

          {(strategy === 'PRI_MANUAL' || strategy === 'PRI_SMART' || strategy === 'OFF') && (
            <section id="budget" ref={(el) => { refs.current.budget = el }} className="h10-cd-sec">
              <h2>Budget</h2>
              <div className="h10-cd-card pad">
                <div className="eb-form-row" style={{ alignItems: 'center' }}>
                  <div className="h10-cd-field s">
                    <label>Daily budget ({currency})</label>
                    <input type="number" min={1} step={0.5} value={form.budgetEur} onChange={(e) => set('budgetEur', e.target.value)} disabled={ended} />
                  </div>
                  <span className={`h10-pill ${c.budgetUpdatesToday >= 12 ? 'warn' : 'arch'}`} title="eBay hard limit: 15 budget updates per campaign per day — shown before you try, not as an error after.">
                    {c.budgetUpdatesToday} / 15 edits today
                  </span>
                </div>
                <p className="eb-be-hint" style={{ marginTop: 10 }}>Current: <b>{money(c.dailyBudgetCents, currency)}</b>/day · eBay may spend up to 2× the daily budget on a single day (monthly cap = 30.4× daily). Budget decreases after overspend apply the next day.</p>
              </div>
            </section>
          )}

          {strategy === 'GEN' && (
            <section id="bidding" ref={(el) => { refs.current.bidding = el }} className="h10-cd-sec">
              <h2>Rate strategy</h2>
              <div className="h10-cd-card pad">
                <div className="eb-headstats">
                  <div><span className="k">Strategy</span><span className="v" style={{ fontSize: 13 }}>{c.adRateStrategy ?? 'FIXED'}</span></div>
                  {c.adRateStrategy !== 'DYNAMIC' && <div><span className="k">Rates</span><span className="v" style={{ fontSize: 13 }}>{c.isRulesBased ? (c.bidPercentage != null ? `${c.bidPercentage}% (campaign-level)` : '—') : 'per ad (Ads tab)'}</span></div>}
                </div>
                {c.adRateStrategy === 'DYNAMIC' && (
                  <div className="eb-form-row" style={{ marginTop: 12 }}>
                    <div className="h10-cd-field s">
                      <label>Dynamic rate cap (%)</label>
                      <input type="number" min={2} max={100} step={0.1} value={form.capPct} onChange={(e) => set('capPct', e.target.value)} disabled={ended} />
                    </div>
                  </div>
                )}
                <p className="eb-be-hint" style={{ marginTop: 10 }}>
                  {c.adRateStrategy === 'DYNAMIC'
                    ? <>DYNAMIC follows eBay&apos;s daily suggestion <b>up to your cap</b>. Floor Watch alerts if eBay drifts ads above it.</>
                    : <>FIXED — rates never change unless you change them. The margin guardrail blocks any rate above a listing&apos;s break-even without a named reason.</>}
                </p>
              </div>
            </section>
          )}

          {strategy === 'PRI_MANUAL' && (
            <section id="bidding" ref={(el) => { refs.current.bidding = el }} className="h10-cd-sec">
              <h2>Bidding</h2>
              <div className="h10-cd-card pad">
                <p className="eb-be-hint">Keyword bids live on each keyword (Keywords tab / ad-group pages). eBay locks manual bid edits while a campaign uses DYNAMIC bidding — switch to FIXED in Seller Hub to hand-edit, or let the daily suggestion run.</p>
              </div>
            </section>
          )}

          {c.isRulesBased && (
            <section id="targeting" ref={(el) => { refs.current.targeting = el }} className="h10-cd-sec">
              <h2>Targeting — selection rules</h2>
              <CriterionCard criterion={c.campaignCriterion} marketplace={c.marketplace} onClone={() => say('Use Action ▾ → Clone campaign — selection rules are immutable on eBay; a clone carries editable rules.')} />
            </section>
          )}

          <section id="danger" ref={(el) => { refs.current.danger = el }} className="h10-cd-sec">
            <h2>Danger zone</h2>
            <div className="h10-cd-card pad" style={{ borderColor: '#f0c8c8' }}>
              <p className="eb-be-hint">Ending a campaign stops all its ads permanently — <b>ENDED is terminal on eBay</b> (history and Activity are retained; clone to relaunch). Use <b>Action ▾ → End campaign</b>; it confirms the consequences first.</p>
            </div>
          </section>
        </div>
      </div>

      <div className="h10-cd-footer">
        <button type="button" className="h10-am-btn" disabled={!dirty || saving} onClick={() => setForm(baseline)}>Discard Changes</button>
        {msg && <span className="msg">{msg}</span>}
        <button type="button" className="h10-am-btn primary" disabled={!dirty || saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save Campaign'}</button>
      </div>
    </div>
  )
}
