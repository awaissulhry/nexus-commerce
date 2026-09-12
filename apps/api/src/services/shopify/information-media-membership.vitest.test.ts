import { describe, expect, it } from 'vitest'
import { applyMediaMembership, verifyMediaMembership } from './information-media-membership.js'
import type { MediaOrderEdit } from '@nexus/shared/shopify-information'
const pid = 'gid://shopify/Product/1', image = (n: number) => `gid://shopify/MediaImage/${n}`
function setup() {
  let media = [1, 2].map(n => ({ id: image(n), alt: `View ${n}`, mediaContentType: 'IMAGE', status: 'READY', image: { url: `https://example.test/${n}.jpg` } }))
  let interrupt = false, foreignVariant = false
  const writes: any[] = [], page = (nodes: unknown[]) => ({ nodes, pageInfo: { hasNextPage: false } })
  const gql = async (query: string, vars: any) => {
    if (query.includes('NexusInformationMedia(')) return { product: { media: page(media) } }
    if (query.includes('NexusInformationMediaVariants')) return { product: { variants: page(foreignVariant ? [{ id: 'gid://shopify/ProductVariant/9', title: 'New association', media: page([{ id: image(2) }]) }] : []) } }
    if (query.includes('NexusInformationAddedFiles')) return { nodes: vars.ids.map((id: string) => ({ id, fileStatus: 'READY', __typename: 'MediaImage' })) }
    if (query.includes('NexusInformationFileReferences')) {
      writes.push(vars)
      for (const file of vars.files) { if (file.referencesToRemove) media = media.filter(m => m.id !== file.id); if (file.referencesToAdd && !media.some(m => m.id === file.id)) media.push({ id: file.id, alt: 'View 3', mediaContentType: 'IMAGE', status: 'READY', image: { url: 'https://example.test/3.jpg' } }) }
      if (interrupt) { interrupt = false; throw new Error('Response lost') }
      return { fileUpdate: { userErrors: [] } }
    }
    if (query.includes('NexusInformationFileAlt')) { writes.push(vars); vars.files.forEach((f: any) => { media.find(m => m.id === f.id)!.alt = f.alt }); return { fileUpdate: { userErrors: [] } } }
    throw new Error(query)
  }
  const edit: MediaOrderEdit = { productId: pid, ownerLabel: 'Product', value: [image(1), image(2)], nextValue: [image(1), image(3)], membershipChanged: true, added: [{ id: image(3), type: 'IMAGE', alt: 'View 3', status: 'READY', preview: null }], affectedVariants: [] }
  return { gql: gql as any, edit, writes, interrupt: () => { interrupt = true }, addVariant: () => { foreignVariant = true } }
}
describe('Reviewed media associations and partial failures', () => {
  it('adds and removes only references to the reviewed product, never deleting a file', async () => {
    const s = setup(); const result = await applyMediaMembership(s.gql, s.edit)
    expect(result.map(m => m.id)).toEqual(s.edit.nextValue)
    expect(s.writes).toEqual([{ files: [{ id: image(3), referencesToAdd: [pid] }, { id: image(2), referencesToRemove: [pid] }] }])
  })
  it('reconciles an applied association batch after an interrupted response', async () => {
    const s = setup(); s.interrupt(); await expect(applyMediaMembership(s.gql, s.edit)).rejects.toThrow('Response lost')
    await applyMediaMembership(s.gql, s.edit); expect(s.writes).toHaveLength(1)
  })
  it('refuses an unreviewed variant image removal before any mutation', async () => {
    const s = setup(); s.addVariant(); await expect(applyMediaMembership(s.gql, s.edit)).rejects.toThrow('another variant'); expect(s.writes).toEqual([])
  })
  it('checks added-file capability and batches shared-alt updates', async () => {
    const s = setup(); const plan = await verifyMediaMembership(s.gql, { ...s.edit, sharedAltConfirmed: true, altEdits: [{ id: image(1), value: 'View 1', nextValue: '' }, { id: image(3), value: 'View 3', nextValue: 'New alt' }] })
    const result = await applyMediaMembership(s.gql, plan); expect(result.map(m => m.alt)).toEqual(['', 'New alt']); expect(s.writes).toHaveLength(2)
  })
})
