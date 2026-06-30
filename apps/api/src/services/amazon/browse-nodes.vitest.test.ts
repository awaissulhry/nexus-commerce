import { describe, it, expect } from 'vitest'
import { extractBrowseNodes } from './browse-nodes.js'

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
})
