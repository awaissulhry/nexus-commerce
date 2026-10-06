/**
 * CM-27 — the same edit reaches Amazon with the same timing from every campaign-manager screen.
 *
 * The Campaigns grid and the campaign Details tab send a person's edit now (`applyImmediately: true`; the ads drain
 * picks it up within a minute). The Ad Groups, Targets, Negatives and Ads tabs, and their bulk buttons, sent theirs
 * with `applyImmediately: false`: a 5-minute grace window that no tray on those pages could cancel. So a status or bid
 * change took a minute from one page and five from the next. Every screen now uses `SEND_NOW`.
 *
 * Node, no DOM: the screens are read as source, the way the other campaign-manager guards here do.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SEND_NOW } from '../../_shared/adsWrite'

const ADS = join(__dirname, '..', '..')
const SCREENS = [join(ADS, 'campaigns'), join(ADS, '_shared')]

function sources(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...sources(p))
    else if (/\.tsx?$/.test(name) && !name.includes('.vitest.test.')) out.push(p)
  }
  return out
}

describe('CM-27 — one timing for a person\'s edit', () => {
  it('SEND_NOW sends the change now', () => {
    expect(SEND_NOW).toEqual({ applyImmediately: true })
  })

  it('no campaign-manager screen holds an edit in the 5-minute grace window', () => {
    const held = SCREENS.flatMap(sources).filter((p) => /applyImmediately:\s*false/.test(readFileSync(p, 'utf8')))
    expect(held.map((p) => p.slice(ADS.length + 1))).toEqual([])
  })

  it('the bulk buttons (Enable / Pause / Archive / Adjust Bid) send now', () => {
    const src = readFileSync(join(ADS, 'campaigns', '_grid', 'bulkActions.tsx'), 'utf8')
    expect(src).toMatch(/adsWriteEach\(base, ids, \{ \.\.\.body, \.\.\.SEND_NOW \}\)/)
  })

  it('every inline edit on the detail and ad-group tabs sends now', () => {
    const tabs = [
      'campaigns/[id]/tabs/AdGroupsTab.tsx', 'campaigns/[id]/tabs/AdsTab.tsx', 'campaigns/[id]/tabs/NegativeTargetsTab.tsx',
      'campaigns/[id]/ad-groups/[agId]/tabs/TargetsTab.tsx', 'campaigns/[id]/ad-groups/[agId]/tabs/AgAdsTab.tsx',
      'campaigns/[id]/ad-groups/[agId]/tabs/AgNegativesTab.tsx',
    ]
    for (const t of tabs) expect(readFileSync(join(ADS, t), 'utf8'), t).toContain('...SEND_NOW')
  })
})
