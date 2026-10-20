/**
 * CC-13 — the one campaign-name check every builder uses: empty, longer than 128, and the middle dot Amazon refuses.
 */
import { describe, expect, it } from 'vitest'
import { CAMPAIGN_NAME_MAX, amazonSafeName, campaignNameKey, campaignNameProblem, safeCampaignName } from './ads-campaign-name.js'

describe('campaignNameProblem', () => {
  it('takes an ordinary name, hyphens and accents included', () => {
    expect(campaignNameProblem('Giacca pelle - SP - Exact')).toBeNull()
    expect(campaignNameProblem('Protezioni città - Auto')).toBeNull()
    expect(campaignNameProblem('x'.repeat(CAMPAIGN_NAME_MAX))).toBeNull()
  })

  it('refuses an empty name', () => {
    expect(campaignNameProblem('')).toBe('Every campaign needs a name.')
    expect(campaignNameProblem('   ')).toBe('Every campaign needs a name.')
    expect(campaignNameProblem(null)).toBe('Every campaign needs a name.')
  })

  it('refuses a name over 128 characters, and says how long it is', () => {
    const p = campaignNameProblem('y'.repeat(129))
    expect(p).toMatch(/is 129 characters long; Amazon takes at most 128\./)
  })

  it('refuses the middle dot Amazon drops into its error array, and names the replacement', () => {
    expect(campaignNameProblem('[AI] Goal · Auto')).toBe('"[AI] Goal · Auto" contains "·", which Amazon refuses in names; use "-" instead.')
  })

  it('refuses the em dash Amazon refused in an SD ad group name, and the en dash with it', () => {
    expect(campaignNameProblem('Display — ad group')).toBe('"Display — ad group" contains "—", which Amazon refuses in names; use "-" instead.')
    expect(campaignNameProblem('Protezioni – Auto')).toBe('"Protezioni – Auto" contains "–", which Amazon refuses in names; use "-" instead.')
  })
})

describe('campaignNameKey', () => {
  it('ignores case and outer spaces, like Replicate\'s collision gate', () => {
    expect(campaignNameKey('  Gale EXACT ')).toBe(campaignNameKey('gale exact'))
    expect(campaignNameKey('Gale Exact')).not.toBe(campaignNameKey('Gale  Exact2'))
  })
})

describe('safeCampaignName', () => {
  it('turns " · " into " - " and keeps every other hyphen as it is', () => {
    expect(safeCampaignName('[AI] T-shirt · B0TEST0001 · Auto')).toBe('[AI] T-shirt - B0TEST0001 - Auto')
    expect(safeCampaignName('[AI] Goal·Auto')).toBe('[AI] Goal - Auto')
    expect(campaignNameProblem(safeCampaignName('[AI] Goal · Auto'))).toBeNull()
  })

  it('cuts to 128 characters', () => {
    expect(safeCampaignName(`${'z'.repeat(140)} · Auto`).length).toBe(CAMPAIGN_NAME_MAX)
  })

  it('turns an em or en dash a name was composed with into " - " too', () => {
    expect(safeCampaignName('Gloves — Auto')).toBe('Gloves - Auto')
    expect(safeCampaignName('Gloves–Exact')).toBe('Gloves - Exact')
  })
})

describe('amazonSafeName', () => {
  it('swaps each refused character for a hyphen and changes nothing else', () => {
    expect(amazonSafeName('Display IT — ad group')).toBe('Display IT - ad group')
    expect(amazonSafeName('Casco – Exact · Brand')).toBe('Casco - Exact - Brand')
    expect(amazonSafeName('a—b')).toBe('a-b')
    // spacing, case, length and every other character stay as typed
    expect(amazonSafeName('  Città  Jacket (IT) ')).toBe('  Città  Jacket (IT) ')
    expect(amazonSafeName('x'.repeat(200))).toHaveLength(200)
  })

  it('leaves a name Amazon takes exactly as it was, and what it returns passes the name check', () => {
    expect(amazonSafeName('Giacca pelle - SP - Exact')).toBe('Giacca pelle - SP - Exact')
    expect(campaignNameProblem(amazonSafeName('Display — ad group · IT – Auto'))).toBeNull()
  })
})
