import { describe, it, expect } from 'vitest'
import { extractBrowseNodes, browseNodeIdFromRow, resolveBrowseNodeId } from './browse-nodes.js'

// Representative slice of an Amazon PTD schema for IT motorcycle apparel.
// Mirrors the live shape: recommended_browse_nodes → array → items.properties.value
// carries enum (node ids) + enumNames (localized browse paths).
const IT_COAT_SCHEMA = {
  properties: {
    recommended_browse_nodes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          value: {
            type: 'string',
            maxLength: 15,
            enum: ['2420941031', '2420945031'],
            enumNames: [
              'Auto e Moto > Moto, accessori e componenti > Abbigliamento protettivo > Giacche',
              'Auto e Moto > Moto, accessori e componenti > Abbigliamento protettivo > Tute',
            ],
          },
        },
      },
    },
  },
} as Record<string, unknown>

describe('extractBrowseNodes', () => {
  it('pairs enum ids with enumNames paths', () => {
    const nodes = extractBrowseNodes(IT_COAT_SCHEMA, 'APJ6JRA9NG5V4')
    expect(nodes).toEqual([
      { id: '2420941031', path: 'Auto e Moto > Moto, accessori e componenti > Abbigliamento protettivo > Giacche' },
      { id: '2420945031', path: 'Auto e Moto > Moto, accessori e componenti > Abbigliamento protettivo > Tute' },
    ])
  })

  it('returns [] when the attribute/enum is absent (e.g. US item_type_keyword path)', () => {
    expect(extractBrowseNodes({ properties: {} }, 'ATVPDKIKX0DER')).toEqual([])
    expect(extractBrowseNodes({}, 'ATVPDKIKX0DER')).toEqual([])
  })

  it('falls back to id-as-path when enumNames is missing or length-mismatched', () => {
    const s = { properties: { recommended_browse_nodes: { items: { properties: { value: { enum: ['111', '222'] } } } } } } as Record<string, unknown>
    expect(extractBrowseNodes(s, 'APJ6JRA9NG5V4')).toEqual([
      { id: '111', path: '111' },
      { id: '222', path: '222' },
    ])
  })

  it('skips blocks pinned to a different marketplace_id', () => {
    const s = {
      properties: {
        recommended_browse_nodes: {
          anyOf: [
            { marketplace_id: { const: 'ATVPDKIKX0DER' }, properties: { value: { enum: ['US_NODE'] } } },
            { marketplace_id: { const: 'APJ6JRA9NG5V4' }, properties: { value: { enum: ['IT_NODE'], enumNames: ['Italian Path'] } } },
          ],
        },
      },
    } as Record<string, unknown>
    expect(extractBrowseNodes(s, 'APJ6JRA9NG5V4')).toEqual([{ id: 'IT_NODE', path: 'Italian Path' }])
    expect(extractBrowseNodes(s, 'ATVPDKIKX0DER')).toEqual([{ id: 'US_NODE', path: 'US_NODE' }])
  })
})

describe('browseNodeIdFromRow', () => {
  it('reads the col.id node value', () => {
    expect(browseNodeIdFromRow({ recommended_browse_nodes: '2420941031' })).toBe('2420941031')
  })
  it('null when unset/empty', () => {
    expect(browseNodeIdFromRow({})).toBeNull()
    expect(browseNodeIdFromRow({ recommended_browse_nodes: '' })).toBeNull()
  })
})

describe('resolveBrowseNodeId', () => {
  it('returns the row node id when present (ignores existing)', () => {
    expect(
      resolveBrowseNodeId(
        { recommended_browse_nodes: '2420941031' },
        { browseNodeId: '9999999999' },
      ),
    ).toBe('2420941031')
  })

  it('returns the existing browseNodeId when row has none', () => {
    expect(
      resolveBrowseNodeId(
        {},
        { browseNodeId: '9999999999' },
      ),
    ).toBe('9999999999')
  })

  it('returns null when both row and existing are empty/absent', () => {
    expect(resolveBrowseNodeId({}, null)).toBeNull()
    expect(resolveBrowseNodeId({}, undefined)).toBeNull()
    expect(resolveBrowseNodeId({}, {})).toBeNull()
    expect(resolveBrowseNodeId({}, { browseNodeId: '' })).toBeNull()
  })
})
