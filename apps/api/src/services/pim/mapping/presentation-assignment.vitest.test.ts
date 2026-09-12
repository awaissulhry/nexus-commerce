import { beforeEach, describe, expect, it, vi } from 'vitest'
const { db, read, token, preview, mapping } = vi.hoisted(() => ({ db: { bulkOperation: { findFirst: vi.fn() } }, read: vi.fn(), token: vi.fn(), preview: vi.fn(), mapping: vi.fn() }))
vi.mock('../../../db.js', () => ({ default: db }))
vi.mock('./impact.service.js', () => ({ readMappingImpact: read }))
vi.mock('./review-inputs.js', () => ({ mappingInputToken: token }))
vi.mock('../catalog-transfer.service.js', () => ({ previewCatalogTransfer: preview }))
vi.mock('../schema-mapping.service.js', () => ({ getMappingForMarketplace: mapping }))
import { mappingToken } from './revision-token.js'
import { previewPresentationAssignment } from './presentation-assignment.service.js'
const row = (patch = {}) => ({ sku: 'sku', accountId: 'account-b', listingId: 'listing-b', aliasKey: 'alias-b', language: 'it', field: 'descriptionThemeId', before: null, after: 'theme', changed: true, preserved: false, matchesDraft: true, errors: [], ...patch })
let review: any
beforeEach(() => {
  vi.resetAllMocks()
  mapping.mockResolvedValue({})
  review = { channel: 'EBAY', market: 'IT', token: mappingToken({}), state: 'MAPPING_REVIEW', pages: 1, presentationChange: { rule: { themeId: 'theme' } }, rows: [row()] }
  read.mockImplementation(async (_id, _user, page = 0) => ({ ...review, rows: page === 0 ? review.rows : [row({ sku: `page-${page}` })] }))
  db.bulkOperation.findFirst.mockResolvedValue({ changes: { inputToken: 'v1' }, expiresAt: new Date(Date.now() + 60_000) })
  token.mockResolvedValue('v1'); preview.mockResolvedValue({ jobId: 'transfer-review' })
})
describe('one-time presentation assignments use the canonical transfer review', () => {
  it('pages every destination, preserves exceptions and excludes invalid, unlisted, unattributed and former matches', async () => {
    review.pages = 2
    review.rows.push(row({ preserved: true }), row({ errors: ['invalid'] }), row({ listingId: null }), row({ accountId: null }), row({ changed: false }), row({ matchesDraft: false }), row({ after: 'competing-rule-theme' }))
    const result = await previewPresentationAssignment('review', 'operator')
    expect(result).toEqual({ jobId: 'transfer-review', href: '/products/catalog-transfer?job=transfer-review', preserved: 1, excluded: 6, assignments: 2 })
    expect(preview).toHaveBeenCalledWith(expect.objectContaining({ userId: 'operator', mode: 'update', rows: [
      expect.objectContaining({ sku: 'sku', accountId: 'account-b', marketplace: 'IT', locale: 'it', aliasKey: 'alias-b', entity: 'Listings', field: 'descriptionThemeId', action: 'SET', value: 'theme' }),
      expect.objectContaining({ sku: 'page-1', accountId: 'account-b', aliasKey: 'alias-b' }),
    ] }))
  })
  it('rejects stale input before preparing any writes', async () => {
    token.mockResolvedValue('v2')
    await expect(previewPresentationAssignment('review', 'operator')).rejects.toThrow(/Inputs changed/)
    expect(preview).not.toHaveBeenCalled()
  })
  it('rejects a changed standing mapping even when product inputs are unchanged', async () => {
    mapping.mockResolvedValue({ version: 2 })
    await expect(previewPresentationAssignment('review', 'operator')).rejects.toThrow(/Rules changed/)
    expect(preview).not.toHaveBeenCalled()
  })
  it('refuses order drafts and another operator’s missing review', async () => {
    review.presentationChange.rule.order = { axes: [], values: {} }
    await expect(previewPresentationAssignment('review', 'operator')).rejects.toThrow(/supports a description theme/)
    read.mockResolvedValue(null)
    await expect(previewPresentationAssignment('review', 'other')).resolves.toBeNull()
    expect(preview).not.toHaveBeenCalled()
  })
  it('bounds the staged transfer to 5,000 assignments without publishing or executing it', async () => {
    review.rows = Array.from({ length: 5001 }, (_, i) => row({ sku: `sku-${i}` }))
    await expect(previewPresentationAssignment('review', 'operator')).rejects.toThrow(/5,000/)
    expect(preview).not.toHaveBeenCalled()
  })
})
