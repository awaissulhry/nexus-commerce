'use client'

/**
 * Shared SP "Bid Strategy" model + card selector (Helium 10 match). The Helium 10 bid
 * algorithm choice — Max Impressions / Target ACoS / Max Orders / Custom / None — is the
 * change-prone, reusable piece, so it lives here as ONE source of truth shared by the SP
 * Super Wizard (LaunchStep, which re-exports the types for back-compat) and the Single
 * Campaign builder. Change a strategy's copy / icon / add a new algorithm once → every
 * builder updates. The conditional Target-ACoS / Min-Max config stays surface-local (the
 * two builders group + gate those fields differently). Reuses the `.h10-spw-bidcard` styles.
 */
import { Package, Megaphone, Target, ShoppingCart, SlidersHorizontal } from 'lucide-react'
import { RadioCard } from '@/design-system/primitives'

export type BidStrategy = 'maxImpressions' | 'targetAcos' | 'maxOrders' | 'custom' | 'none'
export type BidConfig = { strategy: BidStrategy; targetAcos: string; minBid: string; maxBid: string }
export const defaultBidConfig = (): BidConfig => ({ strategy: 'targetAcos', targetAcos: '30', minBid: '', maxBid: '' })

export const BID_STRATEGIES: Array<{ key: Exclude<BidStrategy, 'none'>; label: string; desc: string; stage: string; recommended?: boolean; Icon: typeof Target }> = [
  { key: 'maxImpressions', label: 'Max Impressions', desc: 'A bid algorithm for products in a launch stage that need to get as many impressions as possible.', stage: 'Launch', Icon: Megaphone },
  { key: 'targetAcos', label: 'Target ACoS', desc: 'A bid algorithm for products in a performance stage that should target an ACoS for scalable advertising.', stage: 'Scale', recommended: true, Icon: Target },
  { key: 'maxOrders', label: 'Max Orders', desc: 'A bid algorithm for products in a liquidate stage that should bid for maximum orders to clear out inventory.', stage: 'Liquidate', Icon: ShoppingCart },
  { key: 'custom', label: 'Custom', desc: 'Create a custom rule that adjusts a target’s bid based on your set performance criteria.', stage: 'Custom', Icon: SlidersHorizontal },
]

/** The 4 algorithm RadioCards + the full-width "None" card. Caller supplies the heading/card chrome. */
export function BidStrategyCardGrid({ value, onChange }: { value: BidConfig; onChange: (patch: Partial<BidConfig>) => void }) {
  return (
    <>
      <div className="h10-spw-bidstrat">
        {BID_STRATEGIES.map((s) => (
          <RadioCard key={s.key} className="h10-spw-bidcard" name="spw-bidstrat" selected={value.strategy === s.key} checked={value.strategy === s.key} onChange={() => onChange({ strategy: s.key })}
            title={<span className="h10-spw-bc-t">{s.recommended && <span className="rec">Recommended</span>}<span className="ic"><s.Icon size={16} /></span><span className="lbl">{s.label}</span></span>}
            description={s.desc} />
        ))}
      </div>
      <RadioCard className="h10-spw-bidcard none" name="spw-bidstrat" title={<span className="h10-spw-bc-t"><span className="ic none"><Package size={15} /></span><span className="lbl">None</span></span>} description="Don't apply a bid algorithm — manage bids yourself." selected={value.strategy === 'none'} checked={value.strategy === 'none'} onChange={() => onChange({ strategy: 'none' })} />
    </>
  )
}
