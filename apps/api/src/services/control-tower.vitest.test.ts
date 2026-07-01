/**
 * P6.1 — Tests for the pure control-tower status roll-up shaper.
 * Written BEFORE implementation (TDD).
 *
 * Precedence (worst-wins): DEAD > FAILED > CLAMPED > PENDING > IN_SYNC > UNKNOWN
 */
import { describe, it, expect } from 'vitest'
import {
  buildControlTowerRows,
  type ControlTowerSkuInput,
  type ControlTowerRow,
} from './control-tower.service.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

const sku = (
  id: string,
  overrides: Partial<ControlTowerSkuInput> = {},
): ControlTowerSkuInput => ({
  sku: id,
  productId: `prod-${id}`,
  listings: [],
  queueRows: [],
  clampedChannels: [],
  negativeAvailable: false,
  ...overrides,
})

const listing = (
  channel: string,
  marketplace: string | null,
  lastSyncStatus: string | null,
  lastSyncedAt: Date | null = null,
  quantity: number | null = 10,
  channelListingId: string = 'cl-default',
) => ({ channelListingId, channel, marketplace, lastSyncStatus, lastSyncedAt, quantity })

const queueRow = (
  channel: string,
  marketplace: string | null,
  syncStatus: string,
  isDead = false,
) => ({ channel, marketplace, syncStatus, isDead })

// ─── Status derivation — single channel ───────────────────────────────────────

describe('DEAD wins over everything', () => {
  it('isDead queue row + SUCCESS listing → DEAD', () => {
    const rows = buildControlTowerRows([
      sku('A', {
        listings: [listing('amazon', 'IT', 'SUCCESS')],
        queueRows: [queueRow('amazon', 'IT', 'FAILED', true)],
      }),
    ])
    expect(rows[0].channels[0].status).toBe('DEAD')
  })

  it('isDead queue row + CLAMPED channel → DEAD (DEAD > CLAMPED)', () => {
    const rows = buildControlTowerRows([
      sku('A', {
        listings: [listing('amazon', 'IT', 'SUCCESS')],
        queueRows: [queueRow('amazon', 'IT', 'SUCCESS', true)],
        clampedChannels: ['amazon'],
      }),
    ])
    expect(rows[0].channels[0].status).toBe('DEAD')
  })
})

describe('FAILED wins over CLAMPED, PENDING, IN_SYNC', () => {
  it('FAILED queue row beats a clamped flag → FAILED', () => {
    const rows = buildControlTowerRows([
      sku('A', {
        listings: [listing('amazon', 'IT', 'SUCCESS')],
        queueRows: [queueRow('amazon', 'IT', 'FAILED', false)],
        clampedChannels: ['amazon'],
      }),
    ])
    expect(rows[0].channels[0].status).toBe('FAILED')
  })

  it('FAILED queue row beats IN_SYNC listing → FAILED', () => {
    const rows = buildControlTowerRows([
      sku('A', {
        listings: [listing('ebay', null, 'SUCCESS')],
        queueRows: [queueRow('ebay', null, 'FAILED', false)],
      }),
    ])
    expect(rows[0].channels[0].status).toBe('FAILED')
  })

  it('FAILED listing status (no queue rows) → FAILED', () => {
    const rows = buildControlTowerRows([
      sku('A', {
        listings: [listing('shopify', null, 'FAILED')],
      }),
    ])
    expect(rows[0].channels[0].status).toBe('FAILED')
  })
})

describe('CLAMPED beats PENDING and IN_SYNC', () => {
  it('clamped flag + IN_SYNC listing → CLAMPED', () => {
    const rows = buildControlTowerRows([
      sku('A', {
        listings: [listing('amazon', 'DE', 'SUCCESS')],
        clampedChannels: ['amazon'],
      }),
    ])
    expect(rows[0].channels[0].status).toBe('CLAMPED')
  })

  it('clamped flag + PENDING listing → CLAMPED', () => {
    const rows = buildControlTowerRows([
      sku('A', {
        listings: [listing('amazon', 'FR', 'PENDING')],
        clampedChannels: ['amazon'],
      }),
    ])
    expect(rows[0].channels[0].status).toBe('CLAMPED')
  })
})

describe('PENDING beats IN_SYNC and UNKNOWN', () => {
  it('PENDING queue row (IN_PROGRESS) + SUCCESS listing → PENDING', () => {
    const rows = buildControlTowerRows([
      sku('A', {
        listings: [listing('amazon', 'ES', 'SUCCESS')],
        queueRows: [queueRow('amazon', 'ES', 'IN_PROGRESS', false)],
      }),
    ])
    expect(rows[0].channels[0].status).toBe('PENDING')
  })

  it('PENDING queue row (PENDING) contributes PENDING', () => {
    const rows = buildControlTowerRows([
      sku('A', {
        listings: [listing('amazon', 'IT', 'SUCCESS')],
        queueRows: [queueRow('amazon', 'IT', 'PENDING', false)],
      }),
    ])
    expect(rows[0].channels[0].status).toBe('PENDING')
  })

  it('listing lastSyncStatus PENDING → PENDING', () => {
    const rows = buildControlTowerRows([
      sku('A', {
        listings: [listing('shopify', null, 'PENDING')],
      }),
    ])
    expect(rows[0].channels[0].status).toBe('PENDING')
  })
})

describe('listing lastSyncStatus mapping', () => {
  it('SUCCESS → IN_SYNC', () => {
    const rows = buildControlTowerRows([
      sku('A', { listings: [listing('shopify', null, 'SUCCESS')] }),
    ])
    expect(rows[0].channels[0].status).toBe('IN_SYNC')
  })

  it('PENDING → PENDING', () => {
    const rows = buildControlTowerRows([
      sku('A', { listings: [listing('ebay', null, 'PENDING')] }),
    ])
    expect(rows[0].channels[0].status).toBe('PENDING')
  })

  it('FAILED → FAILED', () => {
    const rows = buildControlTowerRows([
      sku('A', { listings: [listing('ebay', null, 'FAILED')] }),
    ])
    expect(rows[0].channels[0].status).toBe('FAILED')
  })

  it('null → UNKNOWN', () => {
    const rows = buildControlTowerRows([
      sku('A', { listings: [listing('amazon', 'IT', null)] }),
    ])
    expect(rows[0].channels[0].status).toBe('UNKNOWN')
  })

  it('unrecognised string → UNKNOWN', () => {
    const rows = buildControlTowerRows([
      sku('A', { listings: [listing('amazon', 'IT', 'GIBBERISH')] }),
    ])
    expect(rows[0].channels[0].status).toBe('UNKNOWN')
  })
})

describe('queue SUCCESS / CANCELLED rows contribute nothing', () => {
  it('SUCCESS queue row alone does not degrade an IN_SYNC listing', () => {
    const rows = buildControlTowerRows([
      sku('A', {
        listings: [listing('amazon', 'IT', 'SUCCESS')],
        queueRows: [queueRow('amazon', 'IT', 'SUCCESS', false)],
      }),
    ])
    expect(rows[0].channels[0].status).toBe('IN_SYNC')
  })

  it('CANCELLED queue row alone does not affect listing status', () => {
    const rows = buildControlTowerRows([
      sku('A', {
        listings: [listing('amazon', 'IT', 'SUCCESS')],
        queueRows: [queueRow('amazon', 'IT', 'CANCELLED', false)],
      }),
    ])
    expect(rows[0].channels[0].status).toBe('IN_SYNC')
  })
})

// ─── marketplace null-matching ─────────────────────────────────────────────────

describe('marketplace null matching', () => {
  it('queue row with null marketplace matches listing with null marketplace', () => {
    const rows = buildControlTowerRows([
      sku('A', {
        listings: [listing('ebay', null, 'SUCCESS')],
        queueRows: [queueRow('ebay', null, 'FAILED', false)],
      }),
    ])
    expect(rows[0].channels[0].status).toBe('FAILED')
  })

  it('queue row for amazon/IT does NOT affect amazon/DE listing', () => {
    const rows = buildControlTowerRows([
      sku('A', {
        listings: [listing('amazon', 'DE', 'SUCCESS')],
        queueRows: [queueRow('amazon', 'IT', 'FAILED', false)],
      }),
    ])
    // DE cell has no queue rows → just IN_SYNC from listing
    expect(rows[0].channels[0].status).toBe('IN_SYNC')
  })
})

// ─── worstStatus across channels ──────────────────────────────────────────────

describe('worstStatus across multiple channels', () => {
  it('picks the worst across all cells', () => {
    const rows = buildControlTowerRows([
      sku('A', {
        listings: [
          listing('amazon', 'IT', 'SUCCESS'),
          listing('ebay', null, 'FAILED'),
          listing('shopify', null, 'SUCCESS'),
        ],
      }),
    ])
    expect(rows[0].worstStatus).toBe('FAILED')
  })

  it('DEAD in one cell → worstStatus DEAD', () => {
    const rows = buildControlTowerRows([
      sku('A', {
        listings: [
          listing('amazon', 'IT', 'SUCCESS'),
          listing('ebay', null, 'SUCCESS'),
        ],
        queueRows: [queueRow('amazon', 'IT', 'FAILED', true)],
      }),
    ])
    expect(rows[0].worstStatus).toBe('DEAD')
  })

  it('all IN_SYNC → worstStatus IN_SYNC', () => {
    const rows = buildControlTowerRows([
      sku('A', {
        listings: [
          listing('amazon', 'IT', 'SUCCESS'),
          listing('shopify', null, 'SUCCESS'),
        ],
      }),
    ])
    expect(rows[0].worstStatus).toBe('IN_SYNC')
  })
})

describe('empty channels', () => {
  it('no listings → worstStatus UNKNOWN + empty channels array', () => {
    const rows = buildControlTowerRows([sku('A')])
    expect(rows[0].worstStatus).toBe('UNKNOWN')
    expect(rows[0].channels).toHaveLength(0)
  })
})

// ─── negativeAvailable pass-through ───────────────────────────────────────────

describe('negativeAvailable', () => {
  it('passes through true', () => {
    const rows = buildControlTowerRows([sku('A', { negativeAvailable: true })])
    expect(rows[0].negativeAvailable).toBe(true)
  })

  it('defaults to false when omitted', () => {
    const rows = buildControlTowerRows([
      sku('A', { negativeAvailable: undefined as unknown as boolean }),
    ])
    expect(rows[0].negativeAvailable).toBe(false)
  })
})

// ─── multiple SKUs are independent ────────────────────────────────────────────

describe('multiple SKUs', () => {
  it('returns one row per SKU in order', () => {
    const rows = buildControlTowerRows([sku('A'), sku('B'), sku('C')])
    expect(rows.map((r) => r.sku)).toEqual(['A', 'B', 'C'])
  })

  it('clamped channel on SKU A does not affect SKU B', () => {
    const rows = buildControlTowerRows([
      sku('A', {
        listings: [listing('amazon', 'IT', 'SUCCESS')],
        clampedChannels: ['amazon'],
      }),
      sku('B', {
        listings: [listing('amazon', 'IT', 'SUCCESS')],
        clampedChannels: [],
      }),
    ])
    expect(rows[0].channels[0].status).toBe('CLAMPED')
    expect(rows[1].channels[0].status).toBe('IN_SYNC')
  })
})

// ─── cell data pass-through ───────────────────────────────────────────────────

describe('cell data pass-through', () => {
  it('lastSyncedAt and quantity are passed through from the listing', () => {
    const ts = new Date('2026-06-30T10:00:00Z')
    const rows = buildControlTowerRows([
      sku('A', {
        listings: [listing('amazon', 'IT', 'SUCCESS', ts, 42)],
      }),
    ])
    const cell = rows[0].channels[0]
    expect(cell.lastSyncedAt).toBe(ts)
    expect(cell.quantity).toBe(42)
    expect(cell.channel).toBe('amazon')
    expect(cell.marketplace).toBe('IT')
  })

  it('channelListingId is passed through from the listing', () => {
    const rows = buildControlTowerRows([
      sku('A', {
        listings: [listing('amazon', 'IT', 'SUCCESS', null, 5, 'cl-abc123')],
      }),
    ])
    const cell = rows[0].channels[0]
    expect(cell.channelListingId).toBe('cl-abc123')
  })
})
