import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { encodePooledSheetCells, encodeSheetCells, POOLED_SHEET_CELL_ENCODING } from '@nexus/shared/sheet-cell-wire'
import { channelSheetResponse, compactSheetUrl } from './channel/useChannelSheet'

/**
 * P2 (2026-09-30) — the sheet reads ask for the compact wire form (each column's shared cell once, each cell as its
 * difference) and restore today's shape in ONE place per read, so nothing past the read changes. The encoding is
 * proven in packages/shared/sheet-cell-wire.vitest.test.ts. Since 2026-10-01 they also ask for pooled patches
 * (`patches=pooled`); an older API answers the compact form, which reads the same.
 */
const cell = (value: string | null, pinned: boolean) => ({
  value, pinned, layer: 'channel', writeField: 'attr_colore', writeVerb: 'channel', writeTarget: 'channelListing',
  mapped: { value, status: 'mapped', provenance: 'override', warnings: [], errors: [] },
  contentAddress: { tier: 'pin', language: 'it', coordinate: { channel: 'EBAY', market: 'IT', accountId: 'account-1' } },
})
const page = () => ({
  scope: { channel: 'EBAY', marketplace: 'IT' }, columns: [{ key: 'colore' }], aliases: [],
  meta: { schemaMissing: [], schemaAge: [] },
  rows: [{ id: 'p0', values: { colore: cell('Rosso', true) } }, { id: 'p1', values: { colore: cell(null, false) } }, { id: 'p2', values: { colore: cell('Blu', true) } }],
})

describe('the channel sheet read', () => {
  it('restores a compact answer to the sheet it encodes', () => {
    const compact = JSON.parse(JSON.stringify(encodeSheetCells(page())))
    expect(compact.rows[0].values.colore.contentAddress).toBeUndefined()
    expect(channelSheetResponse(compact)).toEqual(page())
  })

  it('passes an answer that was not encoded through as it is (an older API)', () => {
    const plain = page()
    expect(channelSheetResponse(plain)).toBe(plain)
  })

  it('restores a pooled answer to the sheet it encodes', () => {
    // Enough rows that the same cell patch repeats: the pooled form is then the smallest and is what the API sends.
    const many = { ...page(), rows: Array.from({ length: 12 }, (_, r) => ({ id: `p${r}`, values: { colore: cell(r % 3 ? 'Rosso' : `Blu ${r}`, r % 2 === 0) } })) }
    const pooled = JSON.parse(JSON.stringify(encodePooledSheetCells(many)))
    expect(pooled.meta.cellEncoding).toBe(POOLED_SHEET_CELL_ENCODING)
    expect(pooled.patchPool.length).toBeGreaterThan(0)
    expect(channelSheetResponse(pooled)).toEqual(many)
  })

  it('refuses a pooled answer whose references do not resolve, instead of showing patches as cells', () => {
    const many = { ...page(), rows: Array.from({ length: 12 }, (_, r) => ({ id: `p${r}`, values: { colore: cell(r % 3 ? 'Rosso' : `Blu ${r}`, r % 2 === 0) } })) }
    const pooled = JSON.parse(JSON.stringify(encodePooledSheetCells(many)))
    pooled.rows[1].values.colore = pooled.patchPool.length
    expect(() => channelSheetResponse(pooled)).toThrow(/could not be read/)
  })

  it('asks for the compact form with pooled patches without changing the read\'s identity', () => {
    const url = 'https://api.test/api/products/p/studio/sheet?scope=channel&channel=EBAY&market=IT'
    expect(compactSheetUrl(url)).toBe(`${url}&cells=compact&patches=pooled`)
    expect(compactSheetUrl('https://api.test/sheet')).toBe('https://api.test/sheet?cells=compact&patches=pooled')
  })
})

describe('both sheet reads use it', () => {
  const source = (file: string) => readFileSync(join(__dirname, file), 'utf8')

  it('the channel read and its refresh fetch the compact form and parse through channelSheetResponse', () => {
    const text = source('channel/useChannelSheet.ts')
    expect(text.match(/compactSheetUrl\(url\)/g)).toHaveLength(2)
    expect(text).toMatch(/const page = decodeSheetCells\(body\)/)
  })

  it('the master read fetches the compact form and decodes it before anything reads it', () => {
    const text = source('master/useMasterSheet.ts')
    expect(text).toMatch(/fetchStudioRead\(compactSheetUrl\(studioUrl\), signal\)/)
    expect(text).toMatch(/const body = decodeSheetCells\(\(await studio\.json\(\)\) as StudioSheet\)/)
  })
})
