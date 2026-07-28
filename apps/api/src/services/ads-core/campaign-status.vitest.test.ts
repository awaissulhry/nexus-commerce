import { describe, it, expect } from 'vitest'
import { AMAZON_CAMPAIGN_STATUS_MAP, EBAY_CAMPAIGN_STATUS_MAP, normalizeCampaignStatus, canTransitionCampaignStatus, isTerminalCampaignStatus, EBAY_MANAGED_STATUSES, EBAY_SERVING_STATUSES } from './campaign-status.js'

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

// ── D1 — eBay SYSTEM_PAUSED ────────────────────────────────────────────────
// Live evidence when this was found: 11 of 11 non-ended eBay campaigns were
// SYSTEM_PAUSED, the literal { in: ['RUNNING','PAUSED'] } filter matched ZERO,
// and 24 ads were invisible to coverage, the products rollup, the builder's
// conflict preflight and every automation rule — silently.
describe('D1 — SYSTEM_PAUSED', () => {
  it('is mapped, and is PAUSED rather than the DRAFT fallback', () => {
    // The subtle half: an unmapped status does not throw, it silently becomes
    // DRAFT. So "absent from the map" meant "mislabelled as a draft".
    expect(EBAY_CAMPAIGN_STATUS_MAP.SYSTEM_PAUSED).toBe('PAUSED')
    expect(normalizeCampaignStatus(EBAY_CAMPAIGN_STATUS_MAP, 'SYSTEM_PAUSED')).toBe('PAUSED')
    expect(normalizeCampaignStatus(EBAY_CAMPAIGN_STATUS_MAP, 'SYSTEM_PAUSED')).not.toBe('DRAFT')
  })

  it('MANAGED includes retailer-paused campaigns; SERVING does not', () => {
    expect([...EBAY_MANAGED_STATUSES]).toContain('SYSTEM_PAUSED')
    expect([...EBAY_MANAGED_STATUSES]).toContain('RUNNING')
    expect([...EBAY_MANAGED_STATUSES]).toContain('PAUSED')
    expect([...EBAY_SERVING_STATUSES]).toEqual(['RUNNING'])
    expect([...EBAY_SERVING_STATUSES]).not.toContain('SYSTEM_PAUSED')
  })

  it('MANAGED excludes dead campaigns', () => {
    for (const dead of ['ENDED', 'DELETED', 'ARCHIVED']) {
      expect([...EBAY_MANAGED_STATUSES]).not.toContain(dead)
    }
  })

  it('an unknown future eBay status still falls back rather than throwing', () => {
    expect(normalizeCampaignStatus(EBAY_CAMPAIGN_STATUS_MAP, 'SOME_NEW_STATE')).toBe('DRAFT')
  })
})

// The ratchet. Fixing the 14 sites is worthless if the 15th reintroduces it.
describe('D1 ratchet — no raw campaign-status literals in eBay ads queries', () => {
  it('no eBay ads file filters on a hardcoded RUNNING/PAUSED status', async () => {
    const { readFileSync, readdirSync, statSync } = await import('node:fs')
    const { join, dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

    const files: string[] = []
    const walk = (d: string): void => {
      for (const e of readdirSync(d)) {
        if (e === 'node_modules' || e === 'dist') continue
        const p = join(d, e)
        if (statSync(p).isDirectory()) walk(p)
        else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && /ebay-ads/.test(p)) files.push(p)
      }
    }
    walk(root)
    expect(files.length).toBeGreaterThan(0) // the walk must actually find them

    const offenders: string[] = []
    for (const f of files) {
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        // Anchor on RUNNING only. eBay campaign statuses are
        // RUNNING/PAUSED/SYSTEM_PAUSED, but KEYWORD statuses are ACTIVE/PAUSED
        // — so a bare status:'PAUSED' is usually a keyword write, not a
        // campaign filter, and flagging it makes the ratchet cry wolf. RUNNING
        // is campaign-only, and any D1-shaped filter necessarily mentions it.
        if (/status:\s*(\{\s*in:\s*\[\s*)?'RUNNING'/.test(line)) {
          offenders.push(`${f.replace(root, 'src')}:${i + 1}`)
        }
      })
    }
    expect(offenders, `use EBAY_MANAGED_STATUSES / EBAY_SERVING_STATUSES:\n${offenders.join('\n')}`).toEqual([])
  })
})
