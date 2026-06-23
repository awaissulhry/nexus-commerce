'use client'

/**
 * CBU — AI Goal "Control preview". Reuses the shared (generalized) AutopilotCanvas to show how
 * Product Goal AI will run this set: Products/Performance/Inventory → AI Target → AI-managed levers
 * (bid · budget · keyword harvest · negative · product targeting) → Budget guardrail → Campaigns.
 * Read-only: AI Goal delegates every lever to the AI (configured via the sections above), so there's
 * nothing to toggle here — it's a live reflection of the goal for verifying before launch.
 */
import { AutopilotCanvas, type CanvasSpec } from '../../autopilot/AutopilotCanvas'

const eur = (n: number) => `€${n.toLocaleString('en-IE', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`

export function AiGoalPreview({ targetLabel, budgetMode, productCount, totalBudget, seedCount, excludeCount, productTargetCount }: {
  targetLabel: string
  budgetMode: 'strict' | 'shared'
  productCount: number
  totalBudget: number
  seedCount: number
  excludeCount: number
  productTargetCount: number
}) {
  const spec: CanvasSpec = {
    signals: [
      { id: 'g-prod', label: 'Products', sub: productCount ? `${productCount} selected` : 'none selected' },
      { id: 'g-perf', label: 'Performance', sub: 'spend · sales · ACoS' },
      { id: 'g-inv', label: 'Inventory', sub: 'days of supply' },
    ],
    goalEyebrow: 'AI Target',
    goalLabel: targetLabel || '—',
    modules: [
      { key: 'bid', label: 'Bid', sub: 'AI-optimized', on: true },
      { key: 'budget', label: 'Budget', sub: budgetMode === 'shared' ? 'shared pool' : 'per-product', on: true },
      { key: 'harvest', label: 'Keyword Harvest', sub: seedCount ? `${seedCount} seeds` : 'auto', on: true },
      { key: 'negate', label: 'Negative Targeting', sub: excludeCount ? `${excludeCount} excluded` : 'auto', on: true },
      { key: 'product', label: 'Product Targeting', sub: productTargetCount ? `${productTargetCount} targets` : 'auto', on: true },
    ],
    guardrailLabel: 'Budget',
    guardrailSub: `${budgetMode === 'shared' ? 'Shared' : 'Strict'} · ${eur(totalBudget)}/day`,
    outputLabel: 'Campaigns',
    outputSub: 'SP Auto · KW · PAT · AI-managed',
  }
  return (
    <section className="h10-aig-sec">
      <h2>Control preview</h2>
      <div className="h10-aig-card">
        <p>How Product Goal AI will run this set: Products → AI Target → managed levers → Budget → Campaigns. Review it before you launch.</p>
        <AutopilotCanvas spec={spec} readOnly compact />
      </div>
    </section>
  )
}
