import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '../../auth/permissions/catalogue'
import { PARTNER_ROLE_TEMPLATES } from '../../auth/roles/templates'
import { TECH_PACK_LAYOUTS } from '../../product/techpack/rules'
import { PORTAL_SAMPLES_PERMISSIONS, PORTAL_SAMPLES_VIEW } from './permissions'
import {
  brandRoundStatus,
  brandTechPacks,
  inDevelopment,
  isWaitingKind,
  isWaitingRecord,
  latestRoundOf,
  nextDateOf,
  outboundOf,
  safeTrackingUrl,
  styleStageOf,
  techPackToOffer,
  waitingOrder,
  type TechPackVersionFacts,
} from './rules'

const BRAND = '0190f0e2-1950-7000-8000-000000000001'
const OTHER = '0190f0e2-1950-7000-8000-000000000002'
const COMPANY = '0190f0e2-1950-7000-8000-000000000010'
const id = (n: number) => `0190f0e2-1950-7000-8000-${String(n).padStart(12, '0')}`

describe('who sees the samples page', () => {
  it('declares one partner permission, for the customer Buyer, Quality, Designer, Viewer and Admin; never Finance or a supplier', () => {
    for (const name of PORTAL_SAMPLES_PERMISSIONS) expect(FACTORY_PERMISSIONS.get(name)?.partner).toBe(true)
    const holders = PARTNER_ROLE_TEMPLATES.filter((template) => template.permissions.includes(PORTAL_SAMPLES_VIEW))
      .map((template) => template.key)
      .sort()
    expect(holders).toEqual(['customer-admin', 'customer-buyer', 'customer-designer', 'customer-quality', 'customer-viewer'])
  })
})

describe('what waits for the brand', () => {
  it('answers the product kinds on rounds, swatches and styles, not an order’s revised order, a concession or a proof', () => {
    expect(['SAMPLE', 'COLOUR', 'LEATHER', 'ARTWORK'].every(isWaitingKind)).toBe(true)
    expect(['REVISED_ORDER', 'CONCESSION', 'PROOF', 'SIGNATURE'].some(isWaitingKind)).toBe(false)
    expect(['SampleRound', 'SampleSwatch', 'Style'].every(isWaitingRecord)).toBe(true)
    expect(isWaitingRecord('SalesOrder')).toBe(false)
  })

  it('puts overdue first, then the earliest due, then the oldest asked', () => {
    const now = new Date('2026-11-10T10:00:00Z')
    const rows = [
      { requestId: 'b', dueAt: '2026-11-20T17:00:00Z', askedAt: '2026-11-01T09:00:00Z' },
      { requestId: 'a', dueAt: '2026-11-12T17:00:00Z', askedAt: '2026-11-02T09:00:00Z' },
      { requestId: 'c', dueAt: '2026-11-09T17:00:00Z', askedAt: '2026-11-03T09:00:00Z' },
    ]
    expect(waitingOrder(rows, now).map((row) => row.requestId)).toEqual(['c', 'a', 'b'])
  })
})

describe('a round in the brand’s words', () => {
  it('says the decision, a request waiting, or the stage', () => {
    expect(brandRoundStatus({ stage: 'REQUESTED', decision: null, waiting: false })).toBe('BEING_MADE')
    expect(brandRoundStatus({ stage: 'IN_MAKING', decision: null, waiting: false })).toBe('BEING_MADE')
    expect(brandRoundStatus({ stage: 'SENT', decision: null, waiting: false })).toBe('SENT')
    expect(brandRoundStatus({ stage: 'SENT', decision: null, waiting: true })).toBe('WAITING')
    expect(brandRoundStatus({ stage: 'UNDER_REVIEW', decision: null, waiting: false })).toBe('RECEIVED')
    expect(brandRoundStatus({ stage: 'UNDER_REVIEW', decision: null, waiting: true })).toBe('WAITING')
    expect(brandRoundStatus({ stage: 'DECIDED', decision: 'REJECTED', waiting: false })).toBe('REJECTED')
    expect(brandRoundStatus({ stage: 'DECIDED', decision: 'APPROVED_WITH_COMMENTS', waiting: false })).toBe('APPROVED_WITH_COMMENTS')
    expect(brandRoundStatus({ stage: 'CANCELLED', decision: null, waiting: true })).toBe('CANCELLED')
  })

  it('follows the newest sent outbound shipment (a return is ours) and opens only an https tracking page', () => {
    const ships = [
      { id: '1', direction: 'OUTBOUND', sentAt: '2026-11-01T10:00:00Z', createdAt: '2026-11-01T09:00:00Z' },
      { id: '2', direction: 'RETURN', sentAt: '2026-11-05T10:00:00Z', createdAt: '2026-11-05T09:00:00Z' },
      { id: '3', direction: 'OUTBOUND', sentAt: null, createdAt: '2026-11-06T09:00:00Z' },
    ]
    expect(outboundOf(ships)?.id).toBe('1')
    expect(outboundOf(ships.filter((ship) => ship.id === '3'))?.id).toBe('3')
    expect(outboundOf(ships.filter((ship) => ship.id === '2'))).toBeNull()
    expect(safeTrackingUrl('https://track.example/AB12')).toBe('https://track.example/AB12')
    expect(safeTrackingUrl('javascript:alert(1)')).toBeNull()
    expect(safeTrackingUrl('http://track.example/AB12')).toBeNull()
  })
})

describe('a style’s stage', () => {
  const round = (n: number, kind: 'PROTO' | 'FIT' | 'SALESMAN', stage: 'REQUESTED' | 'DECIDED' | 'CANCELLED', day: number) => ({ id: id(n), kind, stage, createdAt: `2026-10-${String(day).padStart(2, '0')}T09:00:00Z` })

  it('is the open round’s kind, else approved for production, else the newest round’s kind, else in development', () => {
    expect(styleStageOf({ lifecycle: 'SAMPLING' }, [round(1, 'PROTO', 'DECIDED', 1), round(2, 'FIT', 'REQUESTED', 5)])).toBe('FIT')
    expect(styleStageOf({ lifecycle: 'IN_PRODUCTION' }, [round(1, 'SALESMAN', 'REQUESTED', 1)])).toBe('SALESMAN')
    expect(styleStageOf({ lifecycle: 'APPROVED' }, [round(1, 'FIT', 'DECIDED', 1)])).toBe('APPROVED')
    expect(styleStageOf({ lifecycle: 'SAMPLING' }, [round(1, 'PROTO', 'DECIDED', 1), round(2, 'FIT', 'CANCELLED', 5)])).toBe('PROTO')
    expect(styleStageOf({ lifecycle: 'CONCEPT' }, [])).toBe('IN_DEVELOPMENT')
    expect(latestRoundOf([round(1, 'PROTO', 'DECIDED', 1), round(2, 'FIT', 'CANCELLED', 5)])?.id).toBe(id(1))
  })

  it('is in development before production, or while a round is open; never archived', () => {
    expect(inDevelopment({ lifecycle: 'CONCEPT', status: 'DRAFT' }, [])).toBe(true)
    expect(inDevelopment({ lifecycle: 'IN_PRODUCTION', status: 'ACTIVE' }, [])).toBe(false)
    expect(inDevelopment({ lifecycle: 'IN_PRODUCTION', status: 'ACTIVE' }, [round(1, 'SALESMAN', 'REQUESTED', 1)])).toBe(true)
    expect(inDevelopment({ lifecycle: 'SAMPLING', status: 'ARCHIVED' }, [round(1, 'SALESMAN', 'REQUESTED', 1)])).toBe(false)
    expect(nextDateOf([null, '2026-11-20T17:00:00.000Z', '2026-11-14'])).toBe('2026-11-14')
    expect(nextDateOf([null])).toBeNull()
  })
})

describe('the tech pack the brand may open', () => {
  const revisions = [
    { id: id(101), revision: 1, status: 'RELEASED' as const },
    { id: id(102), revision: 2, status: 'DRAFT' as const },
  ]
  const version = (n: number, revisionId: string, v: number, layout: string, language = 'en', companyId = COMPANY, fingerprint = `f${n}`): TechPackVersionFacts => ({ id: id(n), revisionId, version: v, layout, language, fingerprint, createdAt: `2026-11-0${v}T09:00:00Z`, companyId })
  const versions = [
    version(1, id(101), 1, TECH_PACK_LAYOUTS.BRAND),
    version(2, id(101), 2, TECH_PACK_LAYOUTS.INTERNAL),
    version(3, id(101), 3, TECH_PACK_LAYOUTS.SUBCONTRACTOR, 'it'),
    version(4, id(101), 4, TECH_PACK_LAYOUTS.BRAND),
    version(5, id(101), 5, TECH_PACK_LAYOUTS.BRAND, 'it', id(999)),
  ]

  it('offers only BRAND versions of the brand’s own style made in the portal’s company, each with its verdict', () => {
    const packs = brandTechPacks({ brandPartyId: BRAND }, BRAND, COMPANY, versions, revisions)
    expect(packs.map((pack) => pack.version)).toEqual([4, 1])
    expect(packs.map((pack) => pack.state)).toEqual(['CURRENT', 'NEWER_VERSION'])
    expect(packs[0]!.printed).toMatch(/^TP [0-9A-Z]{5}-[0-9A-Z]{5}$/)
    expect(techPackToOffer(packs, 'it')?.version).toBe(4)
  })

  it('offers nothing of another brand’s or of a tenant-wide style', () => {
    expect(brandTechPacks({ brandPartyId: OTHER }, BRAND, COMPANY, versions, revisions)).toEqual([])
    expect(brandTechPacks({ brandPartyId: null }, BRAND, COMPANY, versions, revisions)).toEqual([])
  })

  it('says a newer revision when another revision is in force', () => {
    const later = [{ id: id(101), revision: 1, status: 'OBSOLETE' as const }, { id: id(102), revision: 2, status: 'RELEASED' as const }]
    const packs = brandTechPacks({ brandPartyId: BRAND }, BRAND, COMPANY, [version(1, id(101), 1, TECH_PACK_LAYOUTS.BRAND), version(6, id(102), 2, TECH_PACK_LAYOUTS.BRAND, 'it')], later)
    expect(packs.map((pack) => [pack.revision, pack.state])).toEqual([
      [2, 'CURRENT'],
      [1, 'NEWER_REVISION'],
    ])
    expect(techPackToOffer(packs, 'en')?.revision).toBe(2)
  })
})
