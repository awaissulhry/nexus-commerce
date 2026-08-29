/**
 * MS.5 — the publish preview's verdicts.
 *
 * These are the sheet's promises about an outward-facing, hard-to-reverse action. The failure that
 * matters most is a row called sendable that the channel then refuses — the operator stops reading
 * the preview after the first time it lies. The mapping is exercised through a stubbed row page so
 * the readiness fixtures are exact.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const getSheetRows = vi.fn()
vi.mock('../pim/sheet-rows.service.js', async (orig) => {
  const actual = await orig<typeof import('../pim/sheet-rows.service.js')>()
  return { ...actual, getSheetRows: (...a: unknown[]) => getSheetRows(...a) }
})
vi.mock('../amazon-publish-gate.service.js', () => ({ getAmazonPublishMode: () => 'dry-run' }))
vi.mock('../ebay-publish-gate.service.js', () => ({ getEbayPublishMode: () => 'live' }))

const { previewPublish } = await import('../pim/sheet-publish.service.js')

const AMAZON_IT = { channel: 'AMAZON', marketplace: 'IT', label: 'Amazon · IT', inMarket: true }
const EBAY_IT = { channel: 'EBAY', marketplace: 'IT', label: 'eBay · IT', inMarket: true }

const err = (key: string) => ({ key, label: key, message: `${key} is required by Amazon · IT`, severity: 'error' as const })
const warn = (key: string) => ({ key, label: key, message: `${key} is not in the list`, severity: 'warn' as const })

const row = (sku: string, readiness: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
  id: `id-${sku}`, sku, name: sku, isParent: false, readiness, ...over,
})

const page = (rows: unknown[], coordinates = [AMAZON_IT, EBAY_IT]) => ({ rows, coordinates })

beforeEach(() => getSheetRows.mockReset())

describe('previewPublish', () => {
  it('blocks a row whose readiness has an error, and names the fields', async () => {
    getSheetRows.mockResolvedValue(page([
      row('A', { 'AMAZON:IT': { state: 'errors', issues: [err('brand'), err('item_name')] } }),
    ]))
    const p = await previewPublish({ ids: ['id-A'], channel: 'AMAZON', marketplace: 'IT' })
    expect(p.rows[0].verdict).toBe('blocked')
    expect(p.rows[0].issues.map((i) => i.key)).toEqual(['brand', 'item_name'])
    expect(p.summary).toMatchObject({ total: 1, blocked: 1, sendable: 0 })
  })

  it('calls a listed row with no issues ready', async () => {
    getSheetRows.mockResolvedValue(page([
      row('A', { 'AMAZON:IT': { state: 'live', issues: [], ref: 'B0123' } }),
    ]))
    const p = await previewPublish({ ids: ['id-A'], channel: 'AMAZON', marketplace: 'IT' })
    expect(p.rows[0].verdict).toBe('ready')
    expect(p.rows[0].ref).toBe('B0123')
    expect(p.summary.sendable).toBe(1)
  })

  it('separates a row that is not on the channel yet — a create, not an update', async () => {
    getSheetRows.mockResolvedValue(page([
      row('A', { 'AMAZON:IT': { state: 'unlisted', issues: [] } }),
    ]))
    const p = await previewPublish({ ids: ['id-A'], channel: 'AMAZON', marketplace: 'IT' })
    expect(p.rows[0].verdict).toBe('unlisted')
    // Still sendable: that is how a listing is born.
    expect(p.summary).toMatchObject({ sendable: 1, unlisted: 1, blocked: 0 })
  })

  it('a warning does not block — it is sendable and flagged', async () => {
    getSheetRows.mockResolvedValue(page([
      row('A', { 'AMAZON:IT': { state: 'live', issues: [warn('gender')], ref: 'B1' } }),
    ]))
    const p = await previewPublish({ ids: ['id-A'], channel: 'AMAZON', marketplace: 'IT' })
    expect(p.rows[0].verdict).toBe('warned')
    expect(p.summary).toMatchObject({ sendable: 1, warned: 1, blocked: 0 })
  })

  it('an error beats a warning on the same row', async () => {
    getSheetRows.mockResolvedValue(page([
      row('A', { 'AMAZON:IT': { state: 'errors', issues: [warn('gender'), err('brand')] } }),
    ]))
    expect((await previewPublish({ ids: ['id-A'], channel: 'AMAZON', marketplace: 'IT' })).rows[0].verdict).toBe('blocked')
  })

  it('judges only the coordinate asked for', async () => {
    // The defect: a row green on Amazon and broken on eBay reported as blocked for an Amazon send.
    getSheetRows.mockResolvedValue(page([
      row('A', {
        'AMAZON:IT': { state: 'live', issues: [], ref: 'B1' },
        'EBAY:IT': { state: 'errors', issues: [err('ean')] },
      }),
    ]))
    expect((await previewPublish({ ids: ['id-A'], channel: 'AMAZON', marketplace: 'IT' })).rows[0].verdict).toBe('ready')
    expect((await previewPublish({ ids: ['id-A'], channel: 'EBAY', marketplace: 'IT' })).rows[0].verdict).toBe('blocked')
  })

  it('reports the platform mode from the real gate, so a dry run is never mistaken for a send', async () => {
    getSheetRows.mockResolvedValue(page([row('A', { 'AMAZON:IT': { state: 'live', issues: [] } })]))
    const p = await previewPublish({ ids: ['id-A'], channel: 'AMAZON', marketplace: 'IT' })
    expect(p.publishMode).toBe('dry-run')
  })

  it('says plainly that eBay cannot be sent from the sheet', async () => {
    getSheetRows.mockResolvedValue(page([row('A', { 'EBAY:IT': { state: 'live', issues: [] } })]))
    const p = await previewPublish({ ids: ['id-A'], channel: 'EBAY', marketplace: 'IT' })
    expect(p.notSendable).toMatch(/no dry run/i)
    // …and does not silently pretend otherwise by leaving the mode blank.
    expect(p.publishMode).toBe('live')
  })

  it('leaves Amazon sendable', async () => {
    getSheetRows.mockResolvedValue(page([row('A', { 'AMAZON:IT': { state: 'live', issues: [] } })]))
    expect((await previewPublish({ ids: ['id-A'], channel: 'AMAZON', marketplace: 'IT' })).notSendable).toBeUndefined()
  })

  it('refuses a coordinate this market does not have', async () => {
    getSheetRows.mockResolvedValue(page([row('A', {})], [AMAZON_IT]))
    await expect(previewPublish({ ids: ['id-A'], channel: 'EBAY', marketplace: 'IT' })).rejects.toThrow(/EBAY:IT/)
  })

  it('refuses an empty selection rather than previewing nothing', async () => {
    await expect(previewPublish({ ids: [], channel: 'AMAZON', marketplace: 'IT' })).rejects.toThrow(/ids/)
    expect(getSheetRows).not.toHaveBeenCalled()
  })

  it('de-duplicates ids so a row is judged once', async () => {
    getSheetRows.mockResolvedValue(page([row('A', { 'AMAZON:IT': { state: 'live', issues: [] } })]))
    await previewPublish({ ids: ['id-A', 'id-A', 'id-A'], channel: 'AMAZON', marketplace: 'IT' })
    expect(getSheetRows.mock.calls[0][0].ids).toEqual(['id-A'])
  })

  it('asks for the exact rows, never a family page', async () => {
    // Family expansion would judge rows the operator never selected and offer to publish them.
    getSheetRows.mockResolvedValue(page([row('A', { 'AMAZON:IT': { state: 'live', issues: [] } })]))
    await previewPublish({ ids: ['id-A', 'id-B'], channel: 'AMAZON', marketplace: 'IT' })
    const arg = getSheetRows.mock.calls[0][0]
    expect(arg.ids).toEqual(['id-A', 'id-B'])
    expect(arg.parentIds).toBeUndefined()
  })

  it('counts a mixed selection the way the operator must act on it', async () => {
    getSheetRows.mockResolvedValue(page([
      row('A', { 'AMAZON:IT': { state: 'live', issues: [] } }),
      row('B', { 'AMAZON:IT': { state: 'errors', issues: [err('brand')] } }),
      row('C', { 'AMAZON:IT': { state: 'unlisted', issues: [] } }),
      row('D', { 'AMAZON:IT': { state: 'live', issues: [warn('gender')] } }),
    ]))
    const p = await previewPublish({ ids: ['a', 'b', 'c', 'd'], channel: 'AMAZON', marketplace: 'IT' })
    expect(p.summary).toEqual({ total: 4, sendable: 3, blocked: 1, unlisted: 1, warned: 1 })
  })
})
