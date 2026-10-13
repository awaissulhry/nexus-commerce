/**
 * Editing correctness (group 3) — every re-read after a save on the ads screens takes a read ticket (latestRead): a read
 * that started before the save (or a date / scope change) and answers after the newer one is dropped, so it never paints
 * the old values over the saved ones. The Campaigns grid, the campaign and ad-group pages, and the Bid page's Bids view.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { latestRead } from './latestRead'

const ads = join(__dirname, '..')
const src = (file: string) => readFileSync(join(ads, file), 'utf8')

describe('the read ticket', () => {
  it('an older read that answers after a newer one is dropped (the re-read after a save wins)', async () => {
    const begin = latestRead()
    const shown: string[] = []
    const read = async (value: string, answered: Promise<void>) => {
      const current = begin()
      await answered
      if (current()) shown.push(value)
    }
    let answerOld!: () => void
    const before = read('the list from before the save', new Promise<void>((r) => { answerOld = r }))
    await read('the list after the save', Promise.resolve())
    answerOld()
    await before
    expect(shown).toEqual(['the list after the save'])
  })

  it.each([
    'campaigns/CampaignsGrid.tsx',
    'campaigns/[id]/CampaignDetail.tsx',
    'campaigns/[id]/ad-groups/[agId]/AdGroupDetail.tsx',
    'rules-automation/bid/bids/BidsView.tsx',
  ])('%s: its load takes a ticket and shows only the newest answer', (file) => {
    const s = src(file)
    expect(s).toContain('const [beginRead] = useState(latestRead)')
    expect(s).toContain('const current = beginRead()')
    expect(s).toMatch(/if \(!current\(\)\) return/)
  })

  it('the ad-group page re-reads past the API cache after a tab\'s save (as CM-34 on the campaign page)', () => {
    const s = src('campaigns/[id]/ad-groups/[agId]/AdGroupDetail.tsx')
    expect(s).toMatch(/fresh \? '&fresh=1' : ''/)
    expect(s.match(/onRefresh=\{\(\) => void load\(true\)\}/g)).toHaveLength(4)
    expect(s).not.toContain('onRefresh={() => void load()}')
  })
})
