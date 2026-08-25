'use client'

/**
 * AX3.3 — where the copies land, and what their numbers are.
 *
 * The bid policy exists because copying is not neutral: a bid that matured on a
 * product with months of history is not the right opening bid for one with none,
 * and the source structure this feature was built from sits at the 2¢ floor
 * because it is deliberately suppressed. Copying that verbatim would replicate
 * the suppression. So "copy verbatim" is a choice here, not the only behaviour.
 */
import { Input, SegmentedControl } from '@/design-system/primitives'
import { Field } from '@/design-system/components'
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/primitives.css'
import '@/design-system/styles/components.css'
import '../builder-ds.css'
import { PortfolioPicker } from '../sp-super-wizard/PortfolioPicker'
import type { PolicyMode, ValuePolicy } from './replicate-types'

const MARKETS = ['IT', 'DE', 'FR', 'ES']

function PolicyControl({ label, hint, unit, policy, setPolicy }: {
  label: string; hint: string; unit: string; policy: ValuePolicy; setPolicy: (p: ValuePolicy) => void
}) {
  const modes: Array<{ k: PolicyMode; l: string }> = [
    { k: 'copy', l: 'Copy from source' },
    { k: 'scale', l: 'Scale by %' },
    { k: 'fixed', l: 'Set a flat value' },
  ]
  return (
    <div className="h10-rep-policy">
      <span className="lbl">{label}</span>
      <SegmentedControl
        className="rep-modes"
        size="sm"
        ariaLabel={label}
        value={policy.mode}
        onChange={(k) => setPolicy({ mode: k as PolicyMode, value: k === 'scale' ? (policy.value || '100') : k === 'fixed' ? policy.value : '' })}
        options={modes.map((m) => ({ value: m.k, label: m.l }))}
      />
      {policy.mode !== 'copy' && (
        <Input
          fieldClassName="rep-policyval"
          inputMode="decimal"
          value={policy.value}
          onChange={(e) => setPolicy({ ...policy, value: e.target.value })}
          placeholder={policy.mode === 'scale' ? '100' : '0.00'}
          aria-label={`${label} value`}
          suffix={policy.mode === 'scale' ? '%' : unit}
        />
      )}
      <span className="hint">{hint}</span>
    </div>
  )
}

export function DestinationPanel({
  market, setMarket, portfolioId, setPortfolioId, cap, setCap, bidPolicy, setBidPolicy, budgetPolicy, setBudgetPolicy, plannedTotal,
}: {
  market: string; setMarket: (v: string) => void
  portfolioId: string; setPortfolioId: (v: string) => void
  cap: string; setCap: (v: string) => void
  bidPolicy: ValuePolicy; setBidPolicy: (p: ValuePolicy) => void
  budgetPolicy: ValuePolicy; setBudgetPolicy: (p: ValuePolicy) => void
  plannedTotal: number | null
}) {
  const capNum = Number(cap)
  const over = plannedTotal != null && cap.trim() !== '' && Number.isFinite(capNum) && plannedTotal > capNum
  return (
    <div className="h10-spw-card h10-rep-dest">
      <div className="h10-rep-destrow">
        <div className="h10-rep-policy">
          <span className="lbl">Create in</span>
          <SegmentedControl
            className="rep-modes"
            size="sm"
            ariaLabel="Destination marketplace"
            value={market}
            onChange={setMarket}
            options={MARKETS.map((m) => ({ value: m, label: m }))}
          />
          <span className="hint">The self-competition check runs against the campaigns already live in this market.</span>
        </div>
        <div className="h10-rep-policy">
          <span className="lbl">Portfolio</span>
          <PortfolioPicker value={portfolioId} onChange={setPortfolioId} market={market} />
          <span className="hint">The copies join this portfolio, so they show up in its budget and spend rollups.</span>
        </div>
      </div>

      <div className="h10-rep-destrow">
        <PolicyControl label="Bids" unit="€" policy={bidPolicy} setPolicy={setBidPolicy}
          hint="Applies to every keyword and ad-group default. Never goes below Amazon’s €0.02 floor." />
        <PolicyControl label="Daily budgets" unit="€" policy={budgetPolicy} setPolicy={setBudgetPolicy}
          hint="Applies to every campaign in the copy." />
      </div>

      <Field
        className="spw-field sm"
        label="Refuse above"
        hint={<>
          A hard stop, checked before anything is created.
          {plannedTotal != null && (
            <> This plan commits <b className={over ? 'over' : ''}>€{plannedTotal.toFixed(2)}/day</b>.</>
          )}
        </>}
      >
        <Input inputMode="decimal" prefix="€" suffix="/ day" value={cap} onChange={(e) => setCap(e.target.value)} placeholder="150" fieldClassName="spw-cap-field" />
      </Field>
    </div>
  )
}
