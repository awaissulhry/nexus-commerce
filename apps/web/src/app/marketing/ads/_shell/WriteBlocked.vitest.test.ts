/**
 * Ads wave 4c — every write control that reaches Amazon on the bid, negatives, harvest and keyword-action pages (and
 * campaign detail and portfolios) is off on a market Nexus only reads, with the same keyboard-reachable reason: the
 * DS InfoTip beside it (`WriteBlockedTip`). A source check, because the tests run without a browser: a control that
 * loses its block, or a new write control added without one, fails here. The write gate stays the backstop.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ads = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = (rel: string) => readFileSync(join(ads, rel), 'utf8')

const CONTROLS: Array<{ file: string; button: RegExp }> = [
  { file: 'rules-automation/bid/BidEditing.tsx', button: /onClick=\{\(\) => setMode\(m\)\} disabled=\{!!blocked\}/ },
  { file: 'rules-automation/negative-targeting/NegRemoval.tsx', button: /disabled=\{busy \|\| writeCount === 0 \|\| !!blocked\}/ },
  { file: 'rules-automation/negative-targeting/NegWastefulWords.tsx', button: /disabled=\{busy \|\| !!targetBlocked\}/ },
  { file: 'rules-automation/keyword-harvest/HvPromote.tsx', button: /disabled=\{busy \|\| plan\.promotable === 0 \|\| !!blocked\}/ },
  { file: 'rules-automation/keyword-tracker/BidAction.tsx', button: /disabled=\{loading \|\| !!blocked\}/ },
  { file: 'rules-automation/keyword-tracker/BidAction.tsx', button: /disabled=\{!p\.canPropose \|\| loading \|\| !!blocked\}/ },
  { file: 'campaigns/[id]/tabs/DetailsTab.tsx', button: /\|\| !!writeBlock\}/ },
  { file: 'portfolios/PortfoliosClient.tsx', button: /\|\| !!rowWriteBlock\(r\)\}/ },
]

describe('🔴 4c — write controls on a reading-only market are off, with a focusable reason', () => {
  for (const c of CONTROLS) {
    it(`${c.file}: disabled by the market's write block, reason in WriteBlockedTip`, () => {
      const s = src(c.file)
      expect(s).toMatch(c.button)
      expect(s).toMatch(/<WriteBlockedTip reason=\{/)
    })
  }

  it('the harvest selection bar is off too, from the page\'s market', () => {
    expect(src('rules-automation/keyword-harvest/KeywordHarvestClient.tsx')).toMatch(/\}, promoteBlocked\)\}/)
    expect(src('rules-automation/keyword-harvest/HvPromote.tsx')).toMatch(/className="h10-hv-promote" disabled=\{!!blocked\}/)
  })
})
