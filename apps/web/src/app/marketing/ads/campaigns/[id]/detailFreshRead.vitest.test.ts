/**
 * CM-34 — after a save on the campaign page, the page re-reads with `fresh=1`, so the server skips its cached copy
 * (which can be the one from before the save) and the form shows what was saved instead of snapping back.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const src = readFileSync(join(__dirname, 'CampaignDetail.tsx'), 'utf8')

describe('CM-34 — the campaign page reads fresh after its own writes', () => {
  it('asks the server for a fresh read when told to', () => {
    expect(src).toMatch(/fresh \? '&fresh=1' : ''/)
  })
  it('Details Save, the Ad Groups tab\'s writes and "Refresh data" read fresh', () => {
    expect(src).toContain("onSaved={() => void load(true)}")
    expect(src).toContain("onRefresh={() => void load(true)}")
    expect(src).toContain("{ label: 'Refresh data', onClick: () => void load(true) }")
  })
})
