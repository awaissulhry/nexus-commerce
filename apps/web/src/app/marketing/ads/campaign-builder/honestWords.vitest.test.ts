/**
 * W2-C part 2 — the creator screens say what is true (node has no DOM, so the words are read from the source).
 *   CC-8   the video / Amazon Business / audience boosts, Amazon Business sites and Sponsored Videos are kept but say
 *          "not sent to Amazon yet" — nothing sends them.
 *   CC-9   no "Suggested" bid or budget with an invented ±27 % range: a starting value says where it comes from.
 *   CC-32  the chooser's cards: Single is Sponsored Products only; AI Goal proposes, it does not "manage … no manual work".
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = (rel: string) => readFileSync(join(here, rel), 'utf8')

describe('CC-8 — controls that send nothing say so', () => {
  it('every boost and the audience picker carry the "not sent" line', () => {
    const s = src('_shared/PlacementBidMultiplier.tsx')
    expect(s).toContain("const NOT_SENT = 'Not sent to Amazon yet.'")
    expect(s.match(/\{NOT_SENT\}/g)?.length).toBe(3)
  })
  it('Single: Amazon Business sites, the boosts recap and Sponsored Videos say so too', () => {
    const s = src('campaign-builder/single/SingleCampaignBuilder.tsx')
    expect(s).toMatch(/Amazon Business\. Not sent to Amazon yet/)
    expect(s).toContain('Bid Boosts (not sent to Amazon yet)')
    expect(s).toContain('with Sponsored Videos (not sent to Amazon yet)')
    expect(src('campaign-builder/sp-super-wizard/ProductSelection.tsx')).toContain('Sponsored Videos <span className="newtag">Not sent yet</span>')
  })
})

describe('CC-9 — no invented "Suggested" bids or budgets', () => {
  for (const rel of ['campaign-builder/sp-super-wizard/CampaignSetup.tsx', 'campaign-builder/quick/QuickBuilder.tsx', 'campaign-builder/guided/GuidedBuilder.tsx', 'campaign-builder/single/SingleCampaignBuilder.tsx', 'campaign-builder/sp-super-wizard/TargetingModal.tsx']) {
    it(`${rel.split('/').pop()}: no "Suggested:" money label and no ±27 % range`, () => {
      const s = src(rel)
      expect(s).not.toMatch(/Suggested: (<b>|€|\{currency\})/)
      expect(s).not.toMatch(/SUG_LOW|SUG_HIGH|\* 0\.73|\* 1\.27/)
    })
  }
})

describe('CC-32 — the chooser says what each builder does', () => {
  const s = src('campaign-builder/CampaignBuilder.tsx')
  it('Single is Sponsored Products only', () => {
    expect(s).not.toContain('Sponsored Product, Sponsored Brand or Sponsored Display campaign')
    expect(s).toContain('Set up a single Sponsored Products campaign')
  })
  it('AI Goal proposes for approval; it does not promise "no manual work"', () => {
    expect(s).not.toMatch(/no manual work|automatically manage/)
    expect(s).toContain('proposes bid, budget, keyword and negative changes for your approval')
  })
})
