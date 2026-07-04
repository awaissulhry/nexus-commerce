'use client'

/**
 * ER2 — the Priority-Manual (CPC) wizard: Setup → Listings (scope for seed
 * mining + budget sizing) → Keywords & Bids (ad-group structure lives here —
 * spec deviation: the Structure step merged in, single-group dominant case)
 * → Budget → Review & Launch. Listing ATTACH to Priority campaigns is a
 * recorded write-layer gap (Findings) — keywords are the targeting.
 */
import { useMemo } from 'react'
import '../../../ebay.css'
import { WizardShell, type WizardStep } from '../_wizard/WizardShell'
import { useWizard } from '../_wizard/useWizard'
import { SetupStep } from '../_wizard/steps/SetupStep'
import { ListingsStep } from '../_wizard/steps/ListingsStep'
import { KeywordsStep } from '../_wizard/steps/KeywordsStep'
import { BudgetStep } from '../_wizard/steps/BudgetStep'
import { ReviewStep } from '../_wizard/steps/ReviewStep'

const CPC_PACKS = ['Keyword bleeder — pause (CPC)', 'Keyword bid-down on thin CTR (CPC)']

const STEPS: WizardStep[] = [
  { key: 'setup', label: 'Setup' },
  { key: 'listings', label: 'Listings' },
  { key: 'keywords', label: 'Keywords & Bids' },
  { key: 'budget', label: 'Budget' },
  { key: 'review', label: 'Review & Launch' },
]

export function PriorityManualWizard() {
  const w = useWizard('priority-manual', { strategy: 'CPC' })

  const blockers: string[] = useMemo(() => {
    if (w.step === 'setup') return w.plan.name.trim() ? [] : ['Name the campaign']
    if (w.step === 'keywords') {
      const selected = w.plan.adGroups.flatMap((g) => g.seeds.filter((s) => s.on))
      const out: string[] = []
      if (!selected.length) out.push('Select at least one keyword — manual Priority targets nothing without keywords')
      const badBids = selected.filter((s) => !(Number(s.bidEur) >= 0.05))
      if (badBids.length) out.push(`${badBids.length} keyword(s) need a bid ≥ €0.05`)
      return out
    }
    if (w.step === 'budget') return Number(w.plan.budgetEur) >= 1 ? [] : ['Daily budget must be ≥ €1.00']
    return []
  }, [w.step, w.plan])

  const idx = STEPS.findIndex((s) => s.key === w.step)
  return (
    <WizardShell title="Priority — Manual (CPC)" steps={STEPS} active={w.step} visited={w.visited} onStep={w.go}
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
          <p className="eb-be-hint" style={{ marginBottom: 10 }}>Staged listings scope the keyword mining and budget sizing. eBay attaches listings to Priority campaigns in Seller Hub for now (write-layer extension recorded) — <b>keywords are the targeting</b>.</p>
          <ListingsStep plan={w.plan} set={w.set} listings={w.listings} loading={w.data == null && !w.dataErr} isPriority />
        </>
      )}
      {w.step === 'keywords' && <KeywordsStep plan={w.plan} set={w.set} />}
      {w.step === 'budget' && <BudgetStep plan={w.plan} set={w.set} showMaxCpc={false} />}
      {w.step === 'review' && <ReviewStep plan={w.plan} set={w.set} listings={w.listings} activeCampaigns={w.data?.activeCampaigns ?? 0} packOptions={CPC_PACKS} goTo={w.go} />}
    </WizardShell>
  )
}
