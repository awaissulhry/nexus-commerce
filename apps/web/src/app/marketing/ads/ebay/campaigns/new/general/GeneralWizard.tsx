'use client'

/**
 * ER2 — the General (CPS) wizard: Setup → Targeting (key vs rules) →
 * [key: Listings → Rates] → Review & Launch. Rules-based skips the listing
 * steps (the criterion preview IS the listing set — SPEC §5②).
 */
import { useMemo } from 'react'
import '../../../ebay.css'
import { WizardShell, type WizardStep } from '../_wizard/WizardShell'
import { useWizard } from '../_wizard/useWizard'
import { SetupStep } from '../_wizard/steps/SetupStep'
import { TargetingStepGen } from '../_wizard/steps/TargetingStepGen'
import { ListingsStep } from '../_wizard/steps/ListingsStep'
import { RatesStep } from '../_wizard/steps/RatesStep'
import { ReviewStep } from '../_wizard/steps/ReviewStep'
import { includedListings, effRate } from '../_wizard/plan'

const CPS_PACKS = ['Fee % creep-down (CPS)', 'Click bleeder — remove ad (CPS)', 'Rate above break-even — repair (CPS)', 'Restock re-promote (CPS)']

export function GeneralWizard() {
  const w = useWizard('general', { strategy: 'CPS', goalFactor: 0.7, fallbackRatePct: 5 })
  const isRules = w.plan.targetingMode === 'rules'

  const steps: WizardStep[] = useMemo(() => [
    { key: 'setup', label: 'Setup' },
    { key: 'targeting', label: 'Targeting' },
    ...(!isRules ? [{ key: 'listings', label: 'Listings' }, { key: 'rates', label: 'Rates' }] : []),
    { key: 'review', label: 'Review & Launch' },
  ], [isRules])

  const blockers: string[] = useMemo(() => {
    if (w.step === 'setup') return w.plan.name.trim() ? [] : ['Name the campaign (the suggestion chip is one click)']
    if (w.step === 'targeting' && isRules) {
      const out: string[] = []
      if (w.plan.criterion.rules.length === 0) out.push('Add at least one selection rule')
      if (!(Number(w.plan.campaignRatePct) >= 2 && Number(w.plan.campaignRatePct) <= 100)) out.push('Set the campaign rate (2–100%)')
      return out
    }
    if (w.step === 'listings') return includedListings(w.plan, w.listings).length ? [] : ['Stage at least one listing']
    if (w.step === 'rates') {
      const bad = includedListings(w.plan, w.listings).filter((l) => { const r = effRate(w.plan, l); return r == null || r < 2 || r > 100 })
      return bad.length ? [`${bad.length} listing(s) need a valid rate (2–100%)`] : []
    }
    return []
  }, [w.step, w.plan, w.listings, isRules])

  const idx = steps.findIndex((s) => s.key === w.step)
  const next = () => { if (idx < steps.length - 1) w.go(steps[idx + 1]!.key) }
  const back = () => { if (idx > 0) w.go(steps[idx - 1]!.key) }

  return (
    <WizardShell title="General (CPS)" steps={steps} active={w.step} visited={w.visited} onStep={w.go}
      blockers={blockers} onNext={next} onBack={back}
      nextLabel={w.step === 'review' ? 'Review above' : 'Next'}>
      {w.resume && (
        <div className="eb-sandbox" style={{ marginBottom: 12 }}>
          <b>Draft resumed</b> — you left this wizard {w.resume.savedAt ? `at ${new Date(w.resume.savedAt).toLocaleString('en-GB')}` : 'earlier'}. <button type="button" className="h10-am-link" onClick={w.dismissResume}>ok</button>
        </div>
      )}
      {w.dataErr && <div className="h10-cd-error">Couldn&apos;t load listings — {w.dataErr}.</div>}
      {w.step === 'setup' && <SetupStep plan={w.plan} set={w.set} suggestedName={w.data?.suggestedName ?? null} onMarketChange={w.changeMarket} />}
      {w.step === 'targeting' && <TargetingStepGen plan={w.plan} set={w.set} />}
      {w.step === 'listings' && <ListingsStep plan={w.plan} set={w.set} listings={w.listings} loading={w.data == null && !w.dataErr} isPriority={false} />}
      {w.step === 'rates' && <RatesStep plan={w.plan} set={w.set} listings={w.listings} />}
      {w.step === 'review' && <ReviewStep plan={w.plan} set={w.set} listings={w.listings} activeCampaigns={w.data?.activeCampaigns ?? 0} packOptions={CPS_PACKS} goTo={w.go} />}
    </WizardShell>
  )
}
