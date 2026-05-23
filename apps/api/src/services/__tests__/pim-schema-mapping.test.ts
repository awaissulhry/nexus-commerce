/**
 * PIM A.3 — schema-mapping verifier.
 *
 * Pins the mapping shape contract + DB accessor merge semantics.
 * Prisma is mocked via vi.mock so the suite stays pure / fast.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

// ── Mock prisma BEFORE importing the service ────────────────────────
// vi.mock is hoisted above imports, so the factory can't close over
// regular `const` declarations. vi.hoisted() lifts the mock holder
// alongside the mock declaration so the factory + assertions share
// the same reference.
const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    marketplace: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}))
vi.mock('../../db.js', () => ({ default: mockPrisma }))

// Now safe to import the service.
import {
  emptyMapping,
  parseMapping,
  validateMapping,
  validateFieldRule,
  getMappingForMarketplace,
  getFieldMapping,
  upsertFieldMapping,
  removeFieldMapping,
  recordSchemaSync,
  MarketplaceNotFoundError,
  InvalidMappingError,
  type MarketplaceSchemaMapping,
  type FieldMappingRule,
} from '../pim/schema-mapping.service.js'

beforeEach(() => {
  vi.clearAllMocks()
})

// ────────────────────────────────────────────────────────────────────
// emptyMapping shape
// ────────────────────────────────────────────────────────────────────
describe('emptyMapping', () => {
  it('returns version 1 with empty fields + null sync metadata', () => {
    expect(emptyMapping()).toEqual({
      version: 1,
      fields: {},
      lastSyncedAt: null,
      schemaSnapshotVersion: null,
    })
  })

  it('returns a fresh object each call (no shared reference)', () => {
    const a = emptyMapping()
    const b = emptyMapping()
    expect(a).not.toBe(b)
    expect(a.fields).not.toBe(b.fields)
  })
})

// ────────────────────────────────────────────────────────────────────
// parseMapping — defensive parser
// ────────────────────────────────────────────────────────────────────
describe('parseMapping', () => {
  it('returns emptyMapping for null/undefined/primitives/arrays', () => {
    expect(parseMapping(null)).toEqual(emptyMapping())
    expect(parseMapping(undefined)).toEqual(emptyMapping())
    expect(parseMapping('string')).toEqual(emptyMapping())
    expect(parseMapping(42)).toEqual(emptyMapping())
    expect(parseMapping([])).toEqual(emptyMapping())
  })

  it('returns emptyMapping for invalid shape (caller should validate before this)', () => {
    expect(parseMapping({ version: 'not-a-number' })).toEqual(emptyMapping())
  })

  it('passes through a valid mapping unchanged', () => {
    const valid: MarketplaceSchemaMapping = {
      version: 1,
      fields: {
        title: { source: 'localizedContent.{locale}.title', required: true },
      },
      lastSyncedAt: '2026-05-24T00:00:00Z',
      schemaSnapshotVersion: 'abc123',
    }
    expect(parseMapping(valid)).toEqual(valid)
  })
})

// ────────────────────────────────────────────────────────────────────
// validateMapping
// ────────────────────────────────────────────────────────────────────
describe('validateMapping', () => {
  it('accepts an empty mapping', () => {
    expect(validateMapping(emptyMapping())).toEqual([])
  })

  it('rejects non-object root', () => {
    expect(validateMapping(null)[0]).toContain('object')
    expect(validateMapping([])[0]).toContain('object')
  })

  it('reports version not-a-number', () => {
    const errs = validateMapping({ ...emptyMapping(), version: 'x' })
    expect(errs.some((e) => e.includes('version'))).toBe(true)
  })

  it('reports invalid lastSyncedAt type', () => {
    const errs = validateMapping({ ...emptyMapping(), lastSyncedAt: 42 })
    expect(errs.some((e) => e.includes('lastSyncedAt'))).toBe(true)
  })

  it('reports invalid schemaSnapshotVersion type', () => {
    const errs = validateMapping({ ...emptyMapping(), schemaSnapshotVersion: {} })
    expect(errs.some((e) => e.includes('schemaSnapshotVersion'))).toBe(true)
  })

  it('reports per-field errors with field-name prefix', () => {
    const errs = validateMapping({
      ...emptyMapping(),
      fields: { title: { source: '' } },
    })
    expect(errs.some((e) => e.startsWith('fields.title'))).toBe(true)
  })
})

// ────────────────────────────────────────────────────────────────────
// validateFieldRule
// ────────────────────────────────────────────────────────────────────
describe('validateFieldRule', () => {
  it('accepts a minimal valid rule', () => {
    expect(validateFieldRule('title', { source: 'x' })).toEqual([])
  })

  it('rejects empty source', () => {
    const errs = validateFieldRule('title', { source: '' })
    expect(errs.some((e) => e.includes('source'))).toBe(true)
  })

  it('accepts a rule with all optional fields', () => {
    const rule: FieldMappingRule = {
      source: 'localizedContent.{locale}.title',
      fallback: 'name',
      transforms: [{ type: 'truncate', max: 200 }],
      required: true,
      notes: 'Amazon title cap 200 chars',
    }
    expect(validateFieldRule('title', rule)).toEqual([])
  })

  it('rejects unknown transform type', () => {
    const errs = validateFieldRule('title', {
      source: 'x',
      transforms: [{ type: 'fictionalOp' }],
    })
    expect(errs.some((e) => e.includes('transforms[0]'))).toBe(true)
  })

  it('rejects non-array transforms', () => {
    const errs = validateFieldRule('title', { source: 'x', transforms: 'truncate' })
    expect(errs.some((e) => e.includes('transforms must be an array'))).toBe(true)
  })

  it('rejects non-string fallback', () => {
    const errs = validateFieldRule('title', { source: 'x', fallback: 42 })
    expect(errs.some((e) => e.includes('fallback'))).toBe(true)
  })

  it('rejects non-boolean required', () => {
    const errs = validateFieldRule('title', { source: 'x', required: 'yes' })
    expect(errs.some((e) => e.includes('required'))).toBe(true)
  })
})

// ────────────────────────────────────────────────────────────────────
// DB accessors (mocked prisma)
// ────────────────────────────────────────────────────────────────────
describe('getMappingForMarketplace', () => {
  it('parses the column into MarketplaceSchemaMapping', async () => {
    mockPrisma.marketplace.findUnique.mockResolvedValue({
      schemaMapping: {
        version: 1,
        fields: { title: { source: 'x' } },
        lastSyncedAt: null,
        schemaSnapshotVersion: null,
      },
    })

    const result = await getMappingForMarketplace('AMAZON', 'IT')
    expect(result.fields.title.source).toBe('x')
    expect(mockPrisma.marketplace.findUnique).toHaveBeenCalledWith({
      where: { channel_code: { channel: 'AMAZON', code: 'IT' } },
      select: { schemaMapping: true },
    })
  })

  it('returns emptyMapping when column holds default {}', async () => {
    mockPrisma.marketplace.findUnique.mockResolvedValue({ schemaMapping: {} })
    const result = await getMappingForMarketplace('AMAZON', 'IT')
    expect(result).toEqual(emptyMapping())
  })

  it('throws MarketplaceNotFoundError when row missing', async () => {
    mockPrisma.marketplace.findUnique.mockResolvedValue(null)
    await expect(getMappingForMarketplace('AMAZON', 'XX')).rejects.toBeInstanceOf(
      MarketplaceNotFoundError,
    )
  })
})

describe('getFieldMapping', () => {
  it('returns the rule when present', async () => {
    mockPrisma.marketplace.findUnique.mockResolvedValue({
      schemaMapping: {
        version: 1,
        fields: { title: { source: 'x', required: true } },
        lastSyncedAt: null,
        schemaSnapshotVersion: null,
      },
    })
    const result = await getFieldMapping('AMAZON', 'IT', 'title')
    expect(result).toEqual({ source: 'x', required: true })
  })

  it('returns null when field not mapped', async () => {
    mockPrisma.marketplace.findUnique.mockResolvedValue({ schemaMapping: {} })
    const result = await getFieldMapping('AMAZON', 'IT', 'title')
    expect(result).toBeNull()
  })
})

describe('upsertFieldMapping', () => {
  it('merges new field while preserving existing ones', async () => {
    mockPrisma.marketplace.findUnique.mockResolvedValue({
      schemaMapping: {
        version: 1,
        fields: { description: { source: 'descSrc' } },
        lastSyncedAt: null,
        schemaSnapshotVersion: null,
      },
    })
    mockPrisma.marketplace.update.mockResolvedValue({})

    const result = await upsertFieldMapping('AMAZON', 'IT', 'title', {
      source: 'titleSrc',
      required: true,
    })

    expect(result.fields.title.source).toBe('titleSrc')
    expect(result.fields.description.source).toBe('descSrc')
    expect(mockPrisma.marketplace.update).toHaveBeenCalledTimes(1)
  })

  it('overwrites an existing field rule', async () => {
    mockPrisma.marketplace.findUnique.mockResolvedValue({
      schemaMapping: {
        version: 1,
        fields: { title: { source: 'oldSrc' } },
        lastSyncedAt: null,
        schemaSnapshotVersion: null,
      },
    })
    mockPrisma.marketplace.update.mockResolvedValue({})

    const result = await upsertFieldMapping('AMAZON', 'IT', 'title', {
      source: 'newSrc',
    })
    expect(result.fields.title.source).toBe('newSrc')
  })

  it('throws InvalidMappingError for a bad rule without touching prisma.update', async () => {
    await expect(
      upsertFieldMapping('AMAZON', 'IT', 'title', { source: '' } as FieldMappingRule),
    ).rejects.toBeInstanceOf(InvalidMappingError)
    expect(mockPrisma.marketplace.update).not.toHaveBeenCalled()
  })
})

describe('removeFieldMapping', () => {
  it('removes the field, preserves others', async () => {
    mockPrisma.marketplace.findUnique.mockResolvedValue({
      schemaMapping: {
        version: 1,
        fields: { title: { source: 't' }, description: { source: 'd' } },
        lastSyncedAt: null,
        schemaSnapshotVersion: null,
      },
    })
    mockPrisma.marketplace.update.mockResolvedValue({})

    const result = await removeFieldMapping('AMAZON', 'IT', 'title')
    expect(result.fields.title).toBeUndefined()
    expect(result.fields.description.source).toBe('d')
  })

  it('no-ops when field not present (no prisma.update call)', async () => {
    mockPrisma.marketplace.findUnique.mockResolvedValue({ schemaMapping: {} })
    const result = await removeFieldMapping('AMAZON', 'IT', 'nonexistent')
    expect(result).toEqual(emptyMapping())
    expect(mockPrisma.marketplace.update).not.toHaveBeenCalled()
  })
})

describe('recordSchemaSync', () => {
  it('updates lastSyncedAt + schemaSnapshotVersion, leaves fields intact', async () => {
    mockPrisma.marketplace.findUnique.mockResolvedValue({
      schemaMapping: {
        version: 1,
        fields: { title: { source: 't' } },
        lastSyncedAt: null,
        schemaSnapshotVersion: null,
      },
    })
    mockPrisma.marketplace.update.mockResolvedValue({})

    const result = await recordSchemaSync('AMAZON', 'IT', 'snap-v42')

    expect(result.schemaSnapshotVersion).toBe('snap-v42')
    expect(result.lastSyncedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/) // ISO
    expect(result.fields.title.source).toBe('t')
  })
})
