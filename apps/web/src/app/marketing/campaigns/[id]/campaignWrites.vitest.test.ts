/**
 * Google Ads step 1a, W3 (D1) — the legacy campaign page offers no write for a read-only channel, and shows "—" (not
 * €0.00) for such a campaign that Nexus never read.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { READ_ONLY_CHANNELS, campaignMoney, campaignWrites, isReadOnlyChannel } from './campaignWrites'

const money = { spendCents: 0, salesCents: 0, acos: null, roas: null }

describe('campaignWrites', () => {
  it.each(READ_ONLY_CHANNELS)('%s: no pause/resume, no budget edit, no launch, and a note where changes are made', (channel) => {
    const w = campaignWrites({ channel, status: 'ACTIVE' })
    expect(w).toMatchObject({ canPauseResume: false, canEditBudget: false, canLaunch: false })
    expect(w.readOnlyNote).toMatch(/^Changes are made in /)
  })

  it('Google says Google Ads', () => {
    expect(campaignWrites({ channel: 'GOOGLE', status: 'PAUSED' }).readOnlyNote).toBe('Changes are made in Google Ads. Nexus does not change this campaign.')
  })

  it('other channels keep their controls as before', () => {
    expect(campaignWrites({ channel: 'AMAZON', status: 'ACTIVE' })).toEqual({ canPauseResume: true, canEditBudget: true, canLaunch: false, readOnlyNote: null })
    expect(campaignWrites({ channel: 'EBAY', status: 'DRAFT' }).canPauseResume).toBe(false)
    expect(campaignWrites({ channel: 'INTERNAL', status: 'DRAFT' }).canLaunch).toBe(true)
    expect(isReadOnlyChannel('SHOPIFY')).toBe(false)
  })
})

describe('campaignMoney', () => {
  it('a read-only channel’s campaign never read shows no amount (—), not 0', () => {
    expect(campaignMoney({ channel: 'GOOGLE', ...money }, 0)).toEqual({ spendCents: null, salesCents: null, acos: null, roas: null })
  })

  it('once read, or on another channel, the amounts are shown as they are', () => {
    expect(campaignMoney({ channel: 'GOOGLE', ...money, spendCents: 500 }, 3).spendCents).toBe(500)
    expect(campaignMoney({ channel: 'AMAZON', ...money }, 0).spendCents).toBe(0)
  })
})

describe('the page uses them', () => {
  const src = readFileSync(fileURLToPath(new URL('./CampaignDetailClient.tsx', import.meta.url)), 'utf8')
  it('gates Pause/Resume, Launch and the budget edit on campaignWrites', () => {
    expect(src).toContain('{writes.canPauseResume && (')
    expect(src).toContain('{writes.canLaunch && <button')
    expect(src).toContain("label === 'Budget' && writes.canEditBudget && setEditing(true)")
    expect(src).toContain('eur(money.spendCents, c.currency)')
  })
})
