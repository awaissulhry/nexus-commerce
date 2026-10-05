import { describe, expect, it } from 'vitest'
import {
  NEW_CHOICE_DEFAULT, NEW_CHOICE_DELETED, NEW_CHOICE_MAIN, NEW_CHOICE_UNLINKED, RELIST_MARK, SELLING_ROW_MARK_CLASS, SELLING_STATE_TONE, SELLING_STATE_WORD, STATUS_NOW_NOTE, STATUS_TARGET_TONE,
  STATUS_TARGET_WORD, newListingEditorOptions, rowCarriesInactiveMark, sellingStatusModel, statusEditorOptions, waitingSetPhrase, waitingWhen,
  type SellingState, type SellingStatusValue,
} from './sellingStatus'

const now = new Date(2026, 9, 4, 15, 0).getTime()
const today = new Date(2026, 9, 4, 10, 42).toISOString()
const earlier = new Date(2026, 9, 1, 9, 5).toISOString()
const waitingInactive: SellingStatusValue = { state: 'active', waiting: { target: 'inactive', setAt: today, setByName: 'Awais' } }

describe('the live state', () => {
  it('Active = success, Inactive and Mixed = warning, the rest neutral — each with its word and a dot', () => {
    const expected: Record<SellingState, [string, string]> = {
      active: ['Active', 'success'], paused: ['Inactive', 'warning'], mixed: ['Mixed', 'warning'], ended: ['Ended', 'neutral'],
      draft: ['Not listed', 'neutral'], not_listed: ['Not listed', 'neutral'], unknown: ['Unknown', 'neutral'],
    }
    for (const [state, [word, tone]] of Object.entries(expected) as Array<[SellingState, [string, string]]>) {
      expect(SELLING_STATE_WORD[state]).toBe(word)
      expect(SELLING_STATE_TONE[state]).toBe(tone)
      const model = sellingStatusModel({ state }, now)
      expect(model.pill).toEqual({ label: word, tone, glyph: 'dot' })
    }
  })

  it('says the state in one sentence, with the listing\'s own reason when there is one', () => {
    expect(sellingStatusModel({ state: 'active' }, now).ariaLabel).toBe('Status: Active.')
    const amazon = sellingStatusModel({ state: 'active', reason: 'Amazon reports it not buyable now' }, now)
    expect(amazon.ariaLabel).toBe('Status: Active. Amazon reports it not buyable now.')
    expect(amazon.tooltip).toBe('Amazon reports it not buyable now.')
    expect(sellingStatusModel({ state: 'paused' }, now).tooltip).toContain('Buyers cannot buy it here')
  })

  it('loading is a state of its own, never a guessed one', () => {
    const model = sellingStatusModel(undefined, now)
    expect(model.kind).toBe('loading')
    expect(model.ariaLabel).toBe('Status: loading.')
    expect(model.editable).toBe(false)
  })
})

describe('a change waiting for Publish', () => {
  it('shows the target as a clock pill in its tone, the live state beside it, and says who and when', () => {
    const model = sellingStatusModel(waitingInactive, now)
    expect(model.kind).toBe('waiting')
    expect(model.pill).toEqual({ label: 'Inactive', tone: 'warning', glyph: 'clock' })
    expect(model.aside).toBe('now Active')
    expect(model.ariaLabel).toBe('Status: Active. Inactive is waiting for Publish, set by Awais today 10:42.')
    expect(model.tooltip).toBe('Inactive is waiting for Publish. Now Active on the channel. Set by Awais today 10:42.')
    expect(model.editable).toBe(true)
  })

  it('a waiting Ended is danger, a waiting Active is info', () => {
    expect(sellingStatusModel({ state: 'active', waiting: { target: 'ended', setAt: today, setByName: 'Awais' } }, now).pill.tone).toBe('danger')
    expect(sellingStatusModel({ state: 'paused', waiting: { target: 'active', setAt: today, setByName: 'Awais' } }, now).pill.tone).toBe('info')
  })

  it('an older value says the day; an unknown author or time is left out, never invented', () => {
    expect(sellingStatusModel({ state: 'active', waiting: { target: 'ended', setAt: earlier, setByName: 'Awais' } }, now).ariaLabel)
      .toBe('Status: Active. Ended is waiting for Publish, set by Awais on 1 Oct, 09:05.')
    expect(sellingStatusModel({ state: 'active', waiting: { target: 'inactive', setAt: null, setByName: null } }, now).ariaLabel)
      .toBe('Status: Active. Inactive is waiting for Publish.')
    expect(waitingSetPhrase({ setAt: today, setByName: null }, now)).toBe('set today 10:42')
    expect(waitingSetPhrase({ setAt: 'not a date', setByName: 'Awais' }, now)).toBe('set by Awais')
    expect(waitingWhen(null, now)).toBe('')
  })

  it('a target the listing already reached says "No longer applies" and shows the live state', () => {
    const model = sellingStatusModel({ state: 'paused', waiting: { target: 'inactive', setAt: today, setByName: 'Awais' } }, now)
    expect(model.kind).toBe('outgrown')
    expect(model.pill).toEqual({ label: 'Inactive', tone: 'warning', glyph: 'dot' })
    expect(model.aside).toBe('No longer applies')
    expect(model.ariaLabel).toBe('Status: Inactive. The waiting change to Inactive no longer applies: the listing is already Inactive.')
  })
})

describe('read-only cells', () => {
  it('a draft and Not listed (without `create`) cannot change here, and say why', () => {
    const draft = sellingStatusModel({ state: 'draft', reason: 'In Nexus only. Publish creates it on the channel.' }, now)
    expect(draft).toMatchObject({ kind: 'locked', editable: false, locked: true, aside: 'Publish creates it' })
    expect(draft.ariaLabel).toBe('Status: Not listed. In Nexus only. Publish creates it on the channel.')
    const absent = sellingStatusModel({ state: 'not_listed' }, now)
    expect(absent).toMatchObject({ kind: 'locked', editable: false, aside: null })
    expect(absent.tooltip).toBe('Not on the channel yet. Publish creates it.')
  })

  it('a caller lock wins over a waiting value, with its own reason', () => {
    const model = sellingStatusModel({ ...waitingInactive, lockedReason: 'Shopify colour products change in Shopify for now' }, now)
    expect(model).toMatchObject({ kind: 'locked', editable: false, pill: { label: 'Active', glyph: 'dot' } })
    expect(model.ariaLabel).toBe('Status: Active. Shopify colour products change in Shopify for now.')
  })
})

describe('the row-start mark', () => {
  it('marks a row when any market is live Inactive or Mixed — never for a waiting Inactive', () => {
    expect(SELLING_ROW_MARK_CLASS).toBe('nds-row-inactive')
    expect(rowCarriesInactiveMark(['active', 'paused'])).toBe(true)
    expect(rowCarriesInactiveMark([{ state: 'mixed' }])).toBe(true)
    expect(rowCarriesInactiveMark([waitingInactive, undefined, null, 'ended', 'draft', 'unknown'])).toBe(false)
    expect(rowCarriesInactiveMark([{ state: 'paused', waiting: { target: 'active', setAt: today, setByName: 'Awais' } }])).toBe(true)
    expect(sellingStatusModel({ state: 'paused' }, now).rowMark).toBe(true)
    expect(sellingStatusModel(waitingInactive, now).rowMark).toBe(false)
  })
})

describe('the Status editor options', () => {
  const choices = [
    { target: 'active' as const, offered: true, reason: null, warning: null },
    { target: 'inactive' as const, offered: true, reason: null, warning: 'Amazon runs this offer (FBA).' },
    { target: 'ended' as const, offered: false, reason: 'Amazon has no End.', warning: null },
  ]

  it('keeps a refused target in the list, HELD with its reason, and shows the reason under it', () => {
    const options = statusEditorOptions(choices, 'active', null, now)
    expect(options.map(o => o.value)).toEqual(['active', 'inactive', 'ended'])
    expect(options[2]).toEqual({ value: 'ended', label: 'Ended', heldReason: 'Amazon has no End.', note: 'Amazon has no End.' })
    expect(options[0]).toMatchObject({ label: 'Active', note: STATUS_NOW_NOTE })
    expect(options[0].heldReason).toBeUndefined()
    expect(options[1]).toMatchObject({ label: 'Inactive', note: 'Amazon runs this offer (FBA).' })
  })

  it('says who set the waiting value and when, under that option', () => {
    const options = statusEditorOptions(choices, 'active', { target: 'inactive', setAt: today, setByName: 'Awais' }, now)
    expect(options[1].note).toBe('Waiting for Publish, set by Awais today 10:42.')
  })
})

describe('a new row (not on the channel yet)', () => {
  const sells = 'Publish creates it and it sells.'
  it('Not listed is a Status word with a neutral tone', () => {
    expect(STATUS_TARGET_WORD.not_listed).toBe('Not listed')
    expect(STATUS_TARGET_TONE.not_listed).toBe('neutral')
  })

  it('is editable, never locked by its state: the default choice without a glyph, a small "new" mark, what Publish does', () => {
    const model = sellingStatusModel({ state: 'not_listed', create: { target: 'active', source: 'default', sentence: sells } }, now)
    expect(model).toMatchObject({ kind: 'new', editable: true, locked: false, rowMark: false, aside: 'new' })
    expect(model.pill).toEqual({ label: 'Active', tone: 'info', glyph: 'none' })
    expect(model.tooltip).toBe('Publish creates it and it sells. The default for a new listing here.')
    expect(model.ariaLabel).toBe('Status: New listing: Active. Publish creates it and it sells. The default for a new listing here.')
  })

  it('a choice made on this row waits with a clock, and says who and when', () => {
    const model = sellingStatusModel({ state: 'draft', waiting: { target: 'inactive', setAt: today, setByName: 'Awais' },
      create: { target: 'inactive', source: 'own', sentence: 'Publish creates it, but buyers cannot buy it yet.' } }, now)
    expect(model.pill).toEqual({ label: 'Inactive', tone: 'warning', glyph: 'clock' })
    expect(model.aside).toBe('new')
    expect(model.tooltip).toBe('Publish creates it, but buyers cannot buy it yet. Set by Awais today 10:42.')
  })

  it('a variation that follows its main product says so; Not listed is no new listing (no "new" mark)', () => {
    const main = sellingStatusModel({ state: 'draft', create: { target: 'active', source: 'main', sentence: `${sells} (It follows the main product's choice; set this row to choose for it.)` } }, now)
    expect(main.aside).toBe('new · as main')
    expect(main.tooltip).toBe(`${sells} (It follows the main product's choice; set this row to choose for it.)`)
    const out = sellingStatusModel({ state: 'not_listed', create: { target: 'not_listed', source: 'own', sentence: 'Publish leaves it out. It stays in Nexus only.' } }, now)
    expect(out.pill).toEqual({ label: 'Not listed', tone: 'neutral', glyph: 'clock' })
    expect(out.aside).toBeNull()
    expect(out.ariaLabel).toBe('Status: Not listed. Publish leaves it out. It stays in Nexus only. Chosen on this row.')
  })

  it('the eBay check rides the tooltip; a caller lock still locks it, with the reason first', () => {
    const value: SellingStatusValue = { state: 'not_listed', create: { target: 'inactive', source: 'default', sentence: 'Creates it inactive.', note: 'Nexus checks the out-of-stock option again when Publish sends.' } }
    expect(sellingStatusModel(value, now).tooltip).toBe('Creates it inactive. Nexus checks the out-of-stock option again when Publish sends. The default for a new listing here.')
    const locked = sellingStatusModel({ ...value, lockedReason: 'Your role cannot publish listings' }, now)
    expect(locked).toMatchObject({ kind: 'locked', editable: false, locked: true })
    expect(locked.tooltip.startsWith('Your role cannot publish listings.')).toBe(true)
  })

  it('a row Nexus deleted (simplify): Not listed with "deleted 4 Oct", the delete\'s words alone; Active reads "lists again"', () => {
    const words = 'Deleted on Amazon · IT on 4 Oct. To list it again, set Status to Active and Publish.'
    const off = sellingStatusModel({ state: 'not_listed', create: { target: 'not_listed', source: 'default', sentence: words, deleted: { on: '4 Oct' } } }, now)
    expect(off).toMatchObject({ kind: 'new', editable: true, locked: false, aside: 'deleted 4 Oct' })
    expect(off.pill).toEqual({ label: 'Not listed', tone: 'neutral', glyph: 'none' })
    expect(off.tooltip).toBe(words)
    expect(off.ariaLabel).toBe(`Status: Not listed. ${words}`)
    const again = sellingStatusModel({ state: 'not_listed', waiting: { target: 'active', setAt: today, setByName: 'Awais' },
      create: { target: 'active', source: 'own', sentence: 'Publish lists it again, whole, and it sells.', deleted: { on: '4 Oct' } } }, now)
    expect(again).toMatchObject({ aside: RELIST_MARK, pill: { label: 'Active', tone: 'info', glyph: 'clock' } })
    expect(again.ariaLabel).toBe('Status: Lists again: Active. Publish lists it again, whole, and it sells. Set by Awais today 10:42.')
    const editor = newListingEditorOptions([{ target: 'not_listed' as const, offered: true, reason: null, sentence: 'Publish leaves it out: it stays deleted on the channel.' }],
      { target: 'not_listed', source: 'default', deleted: { on: '4 Oct' } }, null, now)
    expect(editor[0].note).toBe(`Publish leaves it out: it stays deleted on the channel. ${NEW_CHOICE_DELETED}`)
  })

  it('a row Nexus UNLINKED (Item ID control): "unlinked 5 Oct", the unlink\'s words alone, never "lists again" (Publish leaves it out)', () => {
    const words = 'Unlinked from eBay · IT on 5 Oct: the item may still be live there, and Nexus no longer updates it. Link its Item ID again on the main row; listing it as new makes a second item.'
    const off = sellingStatusModel({ state: 'not_listed', create: { target: 'not_listed', source: 'default', sentence: words, deleted: { on: '5 Oct', unlinked: true } } }, now)
    expect(off).toMatchObject({ kind: 'new', editable: true, aside: 'unlinked 5 Oct' })
    expect(off.tooltip).toBe(words)
    expect(off.ariaLabel).toBe(`Status: Not listed. ${words}`)
    // An older own choice the row still holds: no "Lists again", no "lists again" mark.
    const stale = sellingStatusModel({ state: 'not_listed', waiting: { target: 'active', setAt: today, setByName: 'Awais' },
      create: { target: 'active', source: 'own', sentence: 'Publish leaves it out.', deleted: { on: '5 Oct', unlinked: true } } }, now)
    expect(stale.aside).toBe('unlinked 5 Oct')
    expect(stale.ariaLabel.startsWith('Status: Active. Publish leaves it out.')).toBe(true)
    const editor = newListingEditorOptions([
      { target: 'active' as const, offered: false, reason: words },
      { target: 'not_listed' as const, offered: true, reason: null, sentence: 'Publish leaves it out. Nexus no longer updates it on the channel.' }],
    { target: 'not_listed', source: 'default', deleted: { on: '5 Oct', unlinked: true } }, null, now)
    expect(editor[0]).toMatchObject({ value: 'active', heldReason: words })
    expect(editor[1].note).toBe(`Publish leaves it out. Nexus no longer updates it on the channel. ${NEW_CHOICE_UNLINKED}`)
  })

  it('its editor: Active · Inactive · Not listed with what each does, a held one with its reason, and where the current choice comes from', () => {
    const choices = [
      { target: 'active' as const, offered: true, reason: null, sentence: sells },
      { target: 'inactive' as const, offered: false, reason: 'The out-of-stock option is off.', sentence: 'Creates it inactive.' },
      { target: 'not_listed' as const, offered: true, reason: null, sentence: 'Publish leaves it out.', warning: 'Publish leaves the whole family out here.' },
    ]
    const byDefault = newListingEditorOptions(choices, { target: 'active', source: 'default' }, null, now)
    expect(byDefault.map(o => o.label)).toEqual(['Active', 'Inactive', 'Not listed'])
    expect(byDefault[0].note).toBe(`${sells} ${NEW_CHOICE_DEFAULT}`)
    expect(byDefault[1]).toMatchObject({ heldReason: 'The out-of-stock option is off.', note: 'The out-of-stock option is off.' })
    expect(byDefault[2].note).toBe('Publish leaves it out. Publish leaves the whole family out here.')
    expect(newListingEditorOptions(choices, { target: 'active', source: 'main' }, null, now)[0].note).toBe(`${sells} ${NEW_CHOICE_MAIN}`)
    const own = newListingEditorOptions(choices, { target: 'not_listed', source: 'own' }, { setAt: today, setByName: 'Awais' }, now)
    expect(own[2].note).toBe('Publish leaves it out. Publish leaves the whole family out here. Waiting for Publish, set by Awais today 10:42.')
    expect(own[0].note).toBe(sells)
  })
})
