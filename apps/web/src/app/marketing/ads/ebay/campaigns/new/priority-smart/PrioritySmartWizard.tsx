'use client'

/**
 * ER2 — the Priority-Smart (CPC) wizard: Setup → Listings (scope) →
 * Budget & Max CPC (with eBay's suggestMaxCpc) → Review & Launch. Smart has
 * no keyword management — eBay targets under your cap.
 */
import { useMemo } from 'react'
import '../../../ebay.css'
import { WizardShell, type WizardStep } from '../_wizard/WizardShell'
import { useWizard } from '../_wizard/useWizard'
import { SetupStep } from '../_wizard/steps/SetupStep'
import { ListingsStep } from '../_wizard/steps/ListingsStep'
import { BudgetStep } from '../_wizard/steps/BudgetStep'
import { ReviewStep } from '../_wizard/steps/ReviewStep'

const STEPS: WizardStep[] = [
  { key: 'setup', label: 'Setup' },
  { key: 'listings', label: 'Listings' },
  { key: 'budget', label: 'Budget & Max CPC' },
  { key: 'review', label: 'Review & Launch' },
]

export function PrioritySmartWizard() {
  const w = useWizard('priority-smart', { strategy: 'CPC' })
  const blockers: string[] = useMemo(() => {
    if (w.step === 'setup') return w.plan.name.trim() ? [] : ['Name the campaign']
    if (w.step === 'budget') {
      const out: string[] = []
      if (!(Number(w.plan.budgetEur) >= 1)) out.push('Daily budget must be ≥ €1.00')
      if (!(Number(w.plan.maxCpcEur) >= 0.02)) out.push('Max CPC must be ≥ €0.02')
      return out
    }
    return []
  }, [w.step, w.plan])
  const idx = STEPS.findIndex((s) => s.key === w.step)
  return (
    <WizardShell title="Priority — Smart (CPC)" steps={STEPS} active={w.step} visited={w.visited} onStep={w.go}
      blockers={blockers} onNext={() => idx < STEPS.length - 1 && w.go(STEPS[idx + 1]!.key)} onBack={() => idx > 0 && w.go(STEPS[idx - 1]!.key)}
      nextLabel={w.step === 'review' ? 'Review above' : 'Next'}>
      {w.resume && (
        <div className="eb-sandbox" style={{ marginBottom: 12 }}>
          <b>Draft resumed</b> — saved {w.resume.savedAt ? new Date(w.resume.savedAt).toLocaleString('en-GB') : 'earlier'}. <button type="button" className="h10-am-link" onClick={w.dismissResume}>ok</button>
        </div>
      )}
      {w.dataErr && <div className="h10-cd-error">Couldn&apos;t load listings — {w.dataErr}.</div>}
      {w.step === 'setup' && <SetupStep plan={w.plan} set={w.set} suggestedName={w.data?.suggestedName ?? null} onMarketChange={w.changeMarket} />}
      {w.step === 'listings' && (
        <>
          <p className="eb-be-hint" style={{ marginBottom: 10 }}>Staged listings scope the budget sizing. eBay attaches listings to Priority campaigns in Seller Hub for now (write-layer extension recorded).</p>
          <ListingsStep plan={w.plan} set={w.set} listings={w.listings} isPriority />
        </>
      )}
      {w.step === 'budget' && <BudgetStep plan={w.plan} set={w.set} showMaxCpc />}
      {w.step === 'review' && <ReviewStep plan={w.plan} set={w.set} listings={w.listings} activeCampaigns={w.data?.activeCampaigns ?? 0} packOptions={[]} goTo={w.go} />}
    </WizardShell>
  )
}
