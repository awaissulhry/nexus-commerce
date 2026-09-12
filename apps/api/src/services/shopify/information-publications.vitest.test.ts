import { describe, expect, it } from 'vitest'
import { applyInformationPublications } from './information-publications.js'
const id = 'gid://shopify/Product/1', a = 'gid://shopify/Publication/1', b = 'gid://shopify/Publication/2'
type Entry = { publicationId: string; publishDate: string | null }
function fixture(initial: Entry[]) {
  let entries = structuredClone(initial), interrupt = false
  const writes: { kind: string; input: Entry[] }[] = []
  const gql = async (query: string, variables: any) => {
    if (query.startsWith('query')) return { product: { resourcePublicationsV2: { nodes: entries.map(e => ({ publication: { id: e.publicationId }, isPublished: !e.publishDate, publishDate: e.publishDate })), pageInfo: { hasNextPage: false } } } }
    const kind = query.includes('Unpublish') ? 'publishableUnpublish' : 'publishablePublish'
    writes.push({ kind, input: variables.input })
    for (const e of variables.input) { entries = entries.filter(v => v.publicationId !== e.publicationId); if (kind === 'publishablePublish') entries.push({ ...e, publishDate: e.publishDate ?? null }) }
    if (interrupt) { interrupt = false; throw new Error('Lost response') }
    return { [kind]: { userErrors: [] } }
  }
  return { gql: gql as any, writes, interrupt: () => { interrupt = true } }
}
const edit = (before: Entry[], after: Entry[]) => ({ ownerId: id, productId: id, ownerLabel: 'Product', field: 'salesChannels' as const, value: JSON.stringify(before), nextValue: JSON.stringify(after) })
describe('Exact Shopify publication commands', () => {
  it('schedules one destination while retaining another published channel', async () => {
    const before = [{ publicationId: a, publishDate: null }], after = [...before, { publicationId: b, publishDate: '2030-01-01T10:00:00.000Z' }], s = fixture(before)
    await applyInformationPublications(s.gql, edit(before, after))
    expect(s.writes).toEqual([{ kind: 'publishablePublish', input: [after[1]] }])
  })
  it('reconciles a partial removal before adding another channel after interruption', async () => {
    const before = [{ publicationId: a, publishDate: null }], after = [{ publicationId: b, publishDate: null }], s = fixture(before)
    s.interrupt(); await expect(applyInformationPublications(s.gql, edit(before, after))).rejects.toThrow('Lost response')
    await applyInformationPublications(s.gql, edit(before, after))
    expect(s.writes.map(w => w.kind)).toEqual(['publishableUnpublish', 'publishablePublish'])
  })
  it('rejects a concurrent visibility change before any mutation', async () => {
    const s = fixture([{ publicationId: b, publishDate: null }])
    await expect(applyInformationPublications(s.gql, edit([{ publicationId: a, publishDate: null }], []))).rejects.toThrow('publication changed')
    expect(s.writes).toEqual([])
  })
})
