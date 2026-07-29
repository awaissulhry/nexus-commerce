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
      <div className="modes" role="group" aria-label={label}>
        {modes.map((m) => (
          <button key={m.k} type="button" className={policy.mode === m.k ? 'on' : ''} aria-pressed={policy.mode === m.k}
            onClick={() => setPolicy({ mode: m.k, value: m.k === 'scale' ? (policy.value || '100') : m.k === 'fixed' ? policy.value : '' })}>
            {m.l}
          </button>
        ))}
      </div>
      {policy.mode !== 'copy' && (
        <label className="val">
          <input inputMode="decimal" value={policy.value} onChange={(e) => setPolicy({ ...policy, value: e.target.value })}
            placeholder={policy.mode === 'scale' ? '100' : '0.00'} aria-label={`${label} value`} />
          <span className="u">{policy.mode === 'scale' ? '%' : unit}</span>
        </label>
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
          <div className="modes" role="group" aria-label="Destination marketplace">
            {MARKETS.map((m) => (
              <button key={m} type="button" className={market === m ? 'on' : ''} aria-pressed={market === m} onClick={() => setMarket(m)}>{m}</button>
            ))}
          </div>
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

      <label className="h10-spw-field sm">
        <span className="lbl">Refuse above</span>
        <div className="h10-rep-cap">
          <span className="pf">€</span>
          <input inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} placeholder="150" aria-label="Daily budget cap" />
          <span className="sf">/ day</span>
        </div>
        <span className="hint">
          A hard stop, checked before anything is created.
          {plannedTotal != null && (
            <> This plan commits <b className={over ? 'over' : ''}>€{plannedTotal.toFixed(2)}/day</b>.</>
          )}
        </span>
      </label>
    </div>
  )
}
