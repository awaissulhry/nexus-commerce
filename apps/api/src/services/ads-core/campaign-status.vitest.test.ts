import { describe, it, expect } from 'vitest'
import {
  AMAZON_CAMPAIGN_STATUS_MAP,
  EBAY_CAMPAIGN_STATUS_MAP,
  normalizeCampaignStatus,
  canTransitionCampaignStatus,
  isTerminalCampaignStatus,
} from './campaign-status.js'

describe('normalizeCampaignStatus', () => {
  it('maps eBay natives exactly as the adapter always did', () => {
    expect(normalizeCampaignStatus(EBAY_CAMPAIGN_STATUS_MAP, 'RUNNING')).toBe('ACTIVE')
    expect(normalizeCampaignStatus(EBAY_CAMPAIGN_STATUS_MAP, 'PAUSED')).toBe('PAUSED')
    expect(normalizeCampaignStatus(EBAY_CAMPAIGN_STATUS_MAP, 'ENDED')).toBe('ENDED')
    expect(normalizeCampaignStatus(EBAY_CAMPAIGN_STATUS_MAP, 'SUSPENDED')).toBe('SUSPENDED')
    expect(normalizeCampaignStatus(EBAY_CAMPAIGN_STATUS_MAP, 'DRAFT')).toBe('DRAFT')
  })
  it('maps Amazon natives exactly as the adapter always did', () => {
    expect(normalizeCampaignStatus(AMAZON_CAMPAIGN_STATUS_MAP, 'ENABLED')).toBe('ACTIVE')
    expect(normalizeCampaignStatus(AMAZON_CAMPAIGN_STATUS_MAP, 'PAUSED')).toBe('PAUSED')
    expect(normalizeCampaignStatus(AMAZON_CAMPAIGN_STATUS_MAP, 'ARCHIVED')).toBe('ENDED')
    expect(normalizeCampaignStatus(AMAZON_CAMPAIGN_STATUS_MAP, 'DRAFT')).toBe('DRAFT')
  })
  it('falls back to DRAFT for unknown/missing natives (adapter behavior)', () => {
    expect(normalizeCampaignStatus(EBAY_CAMPAIGN_STATUS_MAP, 'SCHEDULED')).toBe('DRAFT')
    expect(normalizeCampaignStatus(EBAY_CAMPAIGN_STATUS_MAP, null)).toBe('DRAFT')
    expect(normalizeCampaignStatus(AMAZON_CAMPAIGN_STATUS_MAP, undefined)).toBe('DRAFT')
  })
  it('honors an explicit fallback', () => {
    expect(normalizeCampaignStatus(EBAY_CAMPAIGN_STATUS_MAP, 'WEIRD', 'SUSPENDED')).toBe('SUSPENDED')
  })
})

describe('canTransitionCampaignStatus', () => {
  it('allows the operational basics', () => {
    expect(canTransitionCampaignStatus('ACTIVE', 'PAUSED')).toBe(true)
    expect(canTransitionCampaignStatus('PAUSED', 'ACTIVE')).toBe(true)
    expect(canTransitionCampaignStatus('ACTIVE', 'ENDED')).toBe(true)
    expect(canTransitionCampaignStatus('DRAFT', 'ACTIVE')).toBe(true)
    expect(canTransitionCampaignStatus('SCHEDULED', 'ACTIVE')).toBe(true)
    expect(canTransitionCampaignStatus('SUSPENDED', 'ACTIVE')).toBe(true)
  })
  it('blocks resurrecting terminal campaigns (clone, not resume)', () => {
    expect(canTransitionCampaignStatus('ENDED', 'ACTIVE')).toBe(false)
    expect(canTransitionCampaignStatus('ENDED', 'PAUSED')).toBe(false)
    expect(canTransitionCampaignStatus('DELETED', 'ACTIVE')).toBe(false)
  })
  it('blocks no-op self transitions and nonsense', () => {
    expect(canTransitionCampaignStatus('ACTIVE', 'ACTIVE')).toBe(false)
    expect(canTransitionCampaignStatus('DRAFT', 'PAUSED')).toBe(false)
    expect(canTransitionCampaignStatus('DRAFT', 'SUSPENDED')).toBe(false)
  })
})

describe('isTerminalCampaignStatus', () => {
  it('ENDED and DELETED are terminal; the rest are not', () => {
    expect(isTerminalCampaignStatus('ENDED')).toBe(true)
    expect(isTerminalCampaignStatus('DELETED')).toBe(true)
    expect(isTerminalCampaignStatus('ACTIVE')).toBe(false)
    expect(isTerminalCampaignStatus('PAUSED')).toBe(false)
    expect(isTerminalCampaignStatus('DRAFT')).toBe(false)
    expect(isTerminalCampaignStatus('SCHEDULED')).toBe(false)
    expect(isTerminalCampaignStatus('SUSPENDED')).toBe(false)
  })
})
