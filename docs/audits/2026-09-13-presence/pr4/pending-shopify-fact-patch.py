from pathlib import Path
import re
import sys

root = Path('/Users/awais/nexus-commerce')
source = root / 'apps/api/src/services/shopify/content-sync.service.ts'
test = root / 'apps/api/src/services/shopify/content-sync-status.vitest.test.ts'

def once(text, old, new):
    assert text.count(old) == 1, (old, text.count(old))
    return text.replace(old, new, 1)

text = source.read_text()
text = once(text, "import { readLinkedStoreSchema } from './linked-products-gateway.js'", "import { readLinkedStoreSchema } from './linked-products-gateway.js'\nimport { readInformationPublications } from './information-publications.js'")
anchor = "    const listingStatus = isPublished ? 'ACTIVE' : 'INACTIVE'\n"
facts = '''    // SHOP-P2: a verified ACTIVE status alone does not prove a published offer.
    // Publication reads retain future schedules, whose non-null publishDate is not selling now.
    let channelFact = 'UNKNOWN'
    let channelFactDetail: Prisma.InputJsonValue = { shopifyStatus: verifiedProduct.status, publications: null }
    try {
      const publications = await readInformationPublications(graphql, result.productId)
      const schema = await readLinkedStoreSchema(graphql)
      channelFact = ['DRAFT', 'ARCHIVED'].includes(verifiedProduct.status) ? 'NOT_SELLING'
        : verifiedProduct.status === 'ACTIVE' ? (publications.some(p => p.publishDate === null) ? 'SELLING' : 'NOT_SELLING') : 'UNKNOWN'
      channelFactDetail = { shopifyStatus: verifiedProduct.status, publications: publications.map(p => ({
        id: p.publicationId, name: schema.publications?.find(n => n.id === p.publicationId)?.name ?? null, publishDate: p.publishDate,
      })), ...(verifiedProduct.status === 'ACTIVE' && channelFact === 'NOT_SELLING' ? { reason: 'withdrawn from every sales channel' } : {}) }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      channelFact = /HTTP (401|403)|access denied|access scope|reauth|unauthorized|forbidden/i.test(message) ? 'REFUSED' : 'UNKNOWN'
      // Failed reads are neither an empty publication set nor evidence of a successful takedown.
      channelFactDetail = { shopifyStatus: verifiedProduct.status, publications: null, error: message }
    }
    const channelFacts = { channelFact, channelFactAt: new Date(), channelFactVia: 'write-ack', channelFactDetail }
'''
text = once(text, anchor, anchor + facts)
text = once(text, "isPublished, listingStatus }\n        if (existing)", "isPublished, listingStatus, ...channelFacts }\n        if (existing)")
text = once(text, "isPublished, listingStatus, platformAttributes: { ...object(parent.platformAttributes)", "isPublished, listingStatus, ...channelFacts, platformAttributes: { ...object(parent.platformAttributes)")

t = test.read_text()
t = once(t, "status: 'DRAFT', category: false", "status: 'DRAFT', publications: [{ publicationId: 'publication', publishDate: null }] as { publicationId: string; publishDate: string | null }[], publicationError: null as Error | null, category: false")
t = once(t, "vi.mock('./linked-state-guard.js'", "vi.mock('./information-publications.js', () => ({ readInformationPublications: async () => { if (s.publicationError) throw s.publicationError; return s.publications } }))\nvi.mock('./linked-state-guard.js'")
t = once(t, "s.remote = null; s.category = false;", "s.remote = null; s.publicationError = null; s.publications = [{ publicationId: 'publication', publishDate: null }]; s.category = false;")
t = once(t, "expect(s.row.isPublished).toBe(status === 'ACTIVE')", "expect(s.row.isPublished).toBe(status === 'ACTIVE')\n    expect(s.row.channelFact).toBe(status === 'ACTIVE' ? 'SELLING' : 'NOT_SELLING')\n    expect(s.row.channelFactAt).toBeInstanceOf(Date)\n    expect(s.row.channelFactVia).toBe('write-ack')\n    expect(s.row.channelFactDetail.shopifyStatus).toBe(status)\n    expect(s.childWrites[0].channelFact).toBe(s.row.channelFact)")
t += '''
 it.each([
  { publications: [], error: null, fact: 'NOT_SELLING' },
  { publications: [{ publicationId: 'publication', publishDate: '2030-01-01T00:00:00Z' }], error: null, fact: 'NOT_SELLING' },
  { publications: [], error: new Error('Shopify request failed (HTTP 403).'), fact: 'REFUSED' },
  { publications: [], error: new Error('socket timed out'), fact: 'UNKNOWN' },
])('persists $fact without inventing selling from ACTIVE or failed publication reads', async ({ publications, error, fact }) => {
  s.status = 'ACTIVE'; s.publications = publications; s.publicationError = error
  const scope = { accountId: 'store-b', market: 'GLOBAL' }
  const preview = await previewContentSync('family', scope, true)
  await synchronizeContent('family', scope, { expectedRevision: preview.revision, expectedRemoteRevision: preview.remoteRevision, locationId: 'location', confirmActive: true })
  expect(s.row.listingStatus).toBe('ACTIVE')
  expect(s.row.channelFact).toBe(fact)
  expect(s.childWrites[0].channelFact).toBe(fact)
  expect(s.row.channelFactDetail.publications).toEqual(error ? null : publications.map(p => ({ id: p.publicationId, name: null, publishDate: p.publishDate })))
})
'''
Path('/private/tmp/nexus-pr4-presence/content-sync.wave2.ts').write_text(text)
Path('/private/tmp/nexus-pr4-presence/content-sync-status.wave2.test.ts').write_text(t)
if '--apply' in sys.argv:
    assert re.search(r'^PR-GATE W2-SCHEMA-APPLIED(?: DONE)? — local=', (root / 'docs/pes-claims.md').read_text(), re.M), 'W2-SCHEMA-APPLIED missing; no app source saved'
    # Caller also checks the live browser hold and producer ownership before applying.
    source.write_text(text)
    test.write_text(t)
    print('Applied paired post-schema writer and tests')
else:
    print('Scratch only: anchored writer and tests staged; no app source saved')
