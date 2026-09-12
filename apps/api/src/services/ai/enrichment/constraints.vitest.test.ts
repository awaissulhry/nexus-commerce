/**
 * The default draftable set — the list that decides what a run with no explicit `columns` will
 * touch. Every assertion here is a bug that shipped or nearly did.
 */
import { describe, expect, it } from 'vitest'

import { draftableConstraints, isDefaultDraftKey, isNeverDraft } from './constraints.js'
import type { SheetColumn } from '../../pim/sheet-columns.service.js'

const col = (over: Partial<SheetColumn>): SheetColumn =>
  ({
    key: 'x', writeField: 'x', label: 'X', group: 'Content', kind: 'text',
    storage: 'column', scope: 'global', requiredBy: [], editable: true, defaultVisible: true,
    ...over,
  }) as SheetColumn

describe('the default draftable set', () => {
  it('INCLUDES the channel content fields', () => {
    // 🔴 Their absence made every channel-scope run return "No draftable columns in this scope",
    // for any channel and any market, from the day this lane was built. The master scope worked,
    // so nothing looked broken. Found through BE.1's #298 question.
    for (const f of ['amazon_title', 'amazon_description', 'ebay_title', 'ebay_description']) {
      expect(isDefaultDraftKey(f)).toBe(true)
    }
  })

  it('EXCLUDES variation theme — listing structure is not copy', () => {
    expect(isDefaultDraftKey('amazon_variationTheme')).toBe(false)
    expect(isDefaultDraftKey('ebay_variationTheme')).toBe(false)
  })

  it('yields channel columns for a channel scope with no explicit selection', () => {
    // The end-to-end shape of the same bug: a default run over a channel's columns must not be empty.
    const columns = [
      col({ key: 'amazon_title', writeField: 'amazon_title', kind: 'longtext', maxLength: 200 }),
      col({ key: 'amazon_description', writeField: 'amazon_description', kind: 'longtext' }),
      col({ key: 'amazon_variationTheme', writeField: 'amazon_variationTheme' }),
    ]
    const out = draftableConstraints(columns).map((c) => c.writeField)
    expect(out).toContain('amazon_title')
    expect(out).toContain('amazon_description')
    expect(out).not.toContain('amazon_variationTheme')
  })

  it('still refuses claims of record even though channel fields are now in the set', () => {
    expect(isNeverDraft('product_tax_code')).toBe(true)
    expect(isNeverDraft('merchant_suggested_asin')).toBe(true)
    expect(isNeverDraft('country_of_origin')).toBe(true)
    expect(isNeverDraft('recommended_browse_nodes')).toBe(true)
  })
})
