/**
 * CM-26 (second half) — Sponsored Brands / Display rows do not offer an Amazon change the server always refuses.
 *
 * The server refuses status, budget, strategy and placement changes to any campaign that is not Sponsored Products
 * (6a). Wave 1 showed the reason after the click; the row now shows those cells read-only with the reason beside them,
 * reachable by keyboard (the DS InfoTip is a focusable icon). Fake names only.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { adProductRefusal } from '@nexus/shared/ads-ad-product'
import { amazonEditHold } from './amazonEditHold'

describe('amazonEditHold — the same classification the server refuses on', () => {
  it('Sponsored Brands and Display rows are held, with the reason in words', () => {
    expect(amazonEditHold({ adProduct: 'SPONSORED_BRANDS' })).toMatch(/^This is a Sponsored Brands campaign\. Nexus changes Sponsored Products campaigns only/)
    expect(amazonEditHold({ adProduct: null, type: 'SD' })).toMatch(/Sponsored Display campaign/)
    expect(amazonEditHold({ type: 'SB' })).toMatch(/Amazon's advertising console/)
  })

  it('Sponsored Products rows, and rows whose ad product is not stated, keep their controls', () => {
    expect(amazonEditHold({ adProduct: 'SPONSORED_PRODUCTS' })).toBeNull()
    expect(amazonEditHold({ adProduct: null, type: 'SP' })).toBeNull()
    expect(amazonEditHold({})).toBeNull()
  })

  it('holds exactly the rows the server refuses (the shared 6a rule, unknown allowed)', () => {
    const rows = [
      { adProduct: 'SPONSORED_PRODUCTS' }, { adProduct: 'SPONSORED_BRANDS' }, { adProduct: 'SPONSORED_DISPLAY' },
      { type: 'SP' }, { type: 'SB' }, { type: 'SD' }, { type: 'DSP' }, {},
    ]
    for (const r of rows) expect(amazonEditHold(r) != null).toBe(adProductRefusal(r, { unknown: 'allow' }) != null)
  })
})

const SRC = readFileSync(fileURLToPath(new URL('../CampaignsGrid.tsx', import.meta.url)), 'utf8')

describe('CampaignsGrid — the four Amazon-bound cells read the hold', () => {
  it('status, bidding strategy, bid multiplier and daily budget each branch on it', () => {
    expect(SRC).toContain("case 'status': return hold ? held(<StatusCell status={c.status} name={c.name} />, hold)")
    expect(SRC).toContain("case 'biddingStrategy': return hold ? held(<BiddingStrategyCell strategy={effStrat(c)} />, hold)")
    expect(SRC).toMatch(/\{hold\s*\n\s*\? <InfoTip tip=\{hold\} \/>\s*\n\s*: <button type="button" className="h10-gearbtn"/)
    expect(SRC).toContain("if (hold) return held(")
  })
})
