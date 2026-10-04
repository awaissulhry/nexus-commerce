import { describe, expect, it } from 'vitest'
import { DELETED_ROW_LEFT_OUT_HINT, NEW_ROW_FULL_NOTE, NEW_ROW_LEFT_OUT_HINT, NEW_ROW_SENT_WHOLE, SEND_MODE_DEFAULT_NOTE, SEND_MODE_WORD, publishActionModel, sendModeEditorOptions } from './publishAction'

const now = new Date(2026, 9, 4, 15, 0).getTime()
const today = new Date(2026, 9, 4, 10, 42).toISOString()

describe('the Action cell', () => {
  it('draws the default, Partial update, QUIET: no pill, and says what Publish sends', () => {
    const model = publishActionModel({ mode: 'partial' }, now)
    expect(model).toMatchObject({ kind: 'default', label: 'Partial update', pill: null, editable: true })
    expect(model.ariaLabel).toBe('Action: Partial update. Publish sends only the fields you changed.')
  })

  it('a waiting Full update is an info clock pill, a waiting Delete a danger one; who and when in tooltip and sentence', () => {
    const full = publishActionModel({ mode: 'full', setAt: today, setByName: 'Awais' }, now)
    expect(full.pill).toEqual({ label: 'Full update', tone: 'info', glyph: 'clock' })
    expect(full.ariaLabel).toMatch(/^Action: Full update is waiting for Publish, set by Awais today 10:42\. Publish sends every field/)
    const del = publishActionModel({ mode: 'delete', setAt: today, setByName: 'Awais' }, now)
    expect(del.pill).toEqual({ label: 'Delete', tone: 'danger', glyph: 'clock' })
    expect(del.tooltip).toBe('Delete is waiting for Publish. Publish removes this listing from the channel and Nexus forgets its channel number. It cannot be undone. Set by Awais today 10:42.')
  })

  it('a locked cell is quiet, never shows a waiting pill, and says why', () => {
    const model = publishActionModel({ mode: 'delete', lockedReason: 'Publishing to Etsy from the product sheet is not available yet.' }, now)
    expect(model).toMatchObject({ kind: 'locked', label: 'Partial update', pill: null, editable: false, locked: true })
    expect(model.ariaLabel).toBe('Action: Partial update. Publishing to Etsy from the product sheet is not available yet.')
  })

  it('loading is a skeleton state, and an unknown stored mode reads as the default', () => {
    expect(publishActionModel(undefined, now)).toMatchObject({ kind: 'loading', ariaLabel: 'Action: loading.', editable: false })
    expect(publishActionModel({ mode: 'bogus' as never }, now).kind).toBe('default')
  })
})

describe('the Action editor options', () => {
  const choices = [
    { mode: 'partial' as const, offered: true, reason: null, warning: null },
    { mode: 'full' as const, offered: true, reason: null, warning: 'Every field Nexus manages is sent again.' },
    { mode: 'delete' as const, offered: false, reason: 'eBay changes a whole listing. Choose Delete on the main row.', warning: null },
  ]

  it('groups Send · Remove, holds a refused value with its reason, and notes the default and the warning', () => {
    const options = sendModeEditorOptions(choices, null, now)
    expect(options.map(o => [o.value, o.label, o.group])).toEqual([['partial', SEND_MODE_WORD.partial, 'Send'], ['full', 'Full update', 'Send'], ['delete', 'Delete', 'Remove']])
    expect(options[0].note).toBe(SEND_MODE_DEFAULT_NOTE)
    expect(options[1].note).toBe('Every field Nexus manages is sent again.')
    expect(options[2]).toMatchObject({ heldReason: 'eBay changes a whole listing. Choose Delete on the main row.', note: 'eBay changes a whole listing. Choose Delete on the main row.' })
  })

  it('the waiting value says who set it and when', () => {
    const options = sendModeEditorOptions(choices.map(c => ({ ...c, offered: true, reason: null })), { mode: 'delete', setAt: today, setByName: 'Awais' }, now)
    expect(options[2].note).toBe('Waiting for Publish, set by Awais today 10:42.')
    expect(options[2].heldReason).toBeUndefined()
  })
})

/** Simplify (Owner 2026-10-04): a row not on the channel — new, or deleted by Nexus — reads Full update, sent whole. */
describe('a row not on the channel: Full update, sent whole', () => {
  it('reads Full update as an info pill without a glyph (no waiting clock), editable, and says it is sent whole', () => {
    const model = publishActionModel({ mode: 'full', newRow: true }, now)
    expect(model).toMatchObject({ kind: 'new', label: 'Full update', editable: true, locked: false })
    expect(model.pill).toEqual({ label: 'Full update', tone: 'info', glyph: 'none' })
    expect(model.tooltip).toBe(`Full update: ${NEW_ROW_SENT_WHOLE}`)
    expect(NEW_ROW_SENT_WHOLE).toBe('A new listing is always sent whole.')
    // Whatever mode the caller hands a new row (an older stored value), it reads Full update.
    expect(publishActionModel({ mode: 'partial', newRow: true }, now).label).toBe('Full update')
  })

  it('is quiet when its Status leaves it out; a deleted row says it stays deleted; a locked one still reads Full update', () => {
    const out = publishActionModel({ mode: 'full', newRow: true, leftOut: true }, now)
    expect(out.pill).toBeNull()
    expect(out.tooltip).toBe(`Full update: ${NEW_ROW_SENT_WHOLE} ${NEW_ROW_LEFT_OUT_HINT}`)
    const gone = publishActionModel({ mode: 'full', newRow: true, leftOut: true, deleted: true }, now)
    expect(gone.tooltip).toBe(`Full update: ${NEW_ROW_SENT_WHOLE} ${DELETED_ROW_LEFT_OUT_HINT}`)
    expect(gone.ariaLabel).toMatch(/stays deleted\. Set Status to Active to list it again\.$/)
    expect(publishActionModel({ mode: 'full', newRow: true, lockedReason: 'Your role cannot publish listings' }, now)).toMatchObject({ kind: 'locked', label: 'Full update', pill: null })
  })

  it('there are only three Action words: no Create, Deleted or Keep deleted', () => {
    expect(SEND_MODE_WORD).toEqual({ partial: 'Partial update', full: 'Full update', delete: 'Delete' })
  })

  it('its editor: Full update is the value it holds ("Now"), Partial update and Delete held — never "waiting"', () => {
    const options = sendModeEditorOptions([
      { mode: 'partial', offered: false, reason: 'A new listing is always sent whole.' },
      { mode: 'full', offered: true, reason: null, warning: 'A new listing is always sent whole.' },
      { mode: 'delete', offered: false, reason: 'Already deleted on Amazon · IT. To keep it off, leave its Status Not listed.' },
    ], { mode: 'full', setAt: today, setByName: 'Awais' }, now, true)
    expect(options.map(o => [o.value, o.group, Boolean(o.heldReason)])).toEqual([['partial', 'Send', true], ['full', 'Send', false], ['delete', 'Remove', true]])
    expect(options[1].note).toBe(NEW_ROW_FULL_NOTE)
    expect(options[2].note).toBe('Already deleted on Amazon · IT. To keep it off, leave its Status Not listed.')
  })
})
