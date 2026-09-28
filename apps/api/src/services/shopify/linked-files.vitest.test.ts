import { describe, expect, it } from 'vitest'
import { linkedFileKindsQuery, linkedFileLabel, resolveLinkedReferences, searchLinkedReferences } from './linked-products-gateway.js'

/* Lane B slice B1 (docs/shopify-metafields/PLAN-2026-09-28.md gaps G8, G11): a file field lists only the kinds it allows,
   and a file with no alt text still has a name — never an empty label, never a raw id. Made-up ids. */
const page = (nodes: unknown[]) => ({ files: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } })

describe('file search (G8)', () => {
  it('asks Shopify for the allowed kinds only, combined with the typed search', async () => {
    const calls: any[] = []
    const gql = async (_query: string, variables: any) => { calls.push(variables); return page([]) }
    await searchLinkedReferences(gql as never, { type: 'file_reference', fileTypes: 'Image' })
    await searchLinkedReferences(gql as never, { type: 'list.file_reference', fileTypes: 'Image,Video', query: 'chart' })
    await searchLinkedReferences(gql as never, { type: 'file_reference' })
    expect(calls.map(c => c.query)).toEqual(['media_type:IMAGE', '(media_type:IMAGE OR media_type:VIDEO) AND (chart)', null])
  })
  it('ignores kinds it does not know instead of guessing', () => {
    expect(linkedFileKindsQuery('Image, Model,Video')).toBe('media_type:IMAGE OR media_type:VIDEO')
    expect(linkedFileKindsQuery('Model')).toBeNull()
    expect(linkedFileKindsQuery(undefined)).toBeNull()
  })
})

describe('file names (G11)', () => {
  it('uses the alt text, else the video’s file name, else the last part of the address', () => {
    expect(linkedFileLabel({ alt: 'Size chart' })).toBe('Size chart')
    expect(linkedFileLabel({ alt: '', filename: 'fit-video.mp4' })).toBe('fit-video.mp4')
    expect(linkedFileLabel({ alt: ' ', image: { url: 'https://cdn.shopify.com/s/files/1/size%20chart.png?v=2' } })).toBe('size chart.png')
    expect(linkedFileLabel({ alt: null, url: 'https://cdn.shopify.com/s/files/1/table.pdf' })).toBe('table.pdf')
    expect(linkedFileLabel({ alt: '' })).toBe('Untitled file')
  })
  it('names files in search results and in name reads, never with an empty label', async () => {
    const found = await searchLinkedReferences((async () => page([
      { id: 'gid://shopify/MediaImage/1', __typename: 'MediaImage', alt: '', image: { url: 'https://cdn.shopify.com/s/files/1/care.png' } },
      { id: 'gid://shopify/Video/2', __typename: 'Video', alt: '', filename: 'rain.mp4', preview: null },
    ])) as never, { type: 'file_reference' })
    expect(found.items.map(i => i.label)).toEqual(['care.png', 'rain.mp4'])
    const named = await resolveLinkedReferences((async () => ({ nodes: [
      { id: 'gid://shopify/GenericFile/3', __typename: 'GenericFile', alt: '', url: 'https://cdn.shopify.com/s/files/1/table.pdf' },
    ] })) as never, ['gid://shopify/GenericFile/3'])
    expect(named[0]).toMatchObject({ label: 'table.pdf', available: true, type: 'GenericFile' })
  })
})
