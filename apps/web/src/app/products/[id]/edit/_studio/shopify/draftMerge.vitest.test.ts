import { describe, expect, it } from 'vitest'
import { emptyShopifyLinkedDraft } from '@nexus/shared/shopify-linked-products'
import { mergeInformationDraft } from './draftMerge'
const edit = (key: string, nextValue: string | null) => ({ ownerId: 'gid://shopify/Product/1', ownerLabel: 'Product', namespace: 'custom', key, type: 'single_line_text_field', value: 'Shopify baseline', compareDigest: 'digest', nextValue })
describe('Concurrent Nexus Information drafts', () => {
  it('combines edits to different fields while retaining Shopify compare digests', () => {
    const base = emptyShopifyLinkedDraft(), local = { ...base, edits: [edit('one', 'Mine')] }, saved = { ...base, edits: [edit('two', 'Theirs')] }
    const result = mergeInformationDraft(base, local, saved)
    expect(result.conflicts).toEqual([]); expect(result.merged.edits).toEqual([edit('one', 'Mine'), edit('two', 'Theirs')])
  })
  it('requires a decision for concurrent changes to the same field, including a clear', () => {
    const base = emptyShopifyLinkedDraft(), local = { ...base, edits: [edit('one', null)] }, saved = { ...base, edits: [edit('one', 'Theirs')] }
    const result = mergeInformationDraft(base, local, saved)
    expect(result.conflicts).toHaveLength(1)
    expect(mergeInformationDraft(base, local, saved, { [result.conflicts[0].key]: 'local' }).merged.edits[0].nextValue).toBeNull()
    expect(mergeInformationDraft(base, local, saved, { [result.conflicts[0].key]: 'saved' }).merged.edits[0].nextValue).toBe('Theirs')
  })
  it('preserves an intentional command removal and unrelated newly saved commands', () => {
    const base = { ...emptyShopifyLinkedDraft(), edits: [edit('one', 'Old')] }
    expect(mergeInformationDraft(base, { ...base, edits: [] }, { ...base, edits: [...base.edits, edit('two', 'New')] }).merged.edits).toEqual([edit('two', 'New')])
  })
})
