import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { BRAND_ALPHA, BRAND_BETA } from '../../testing/two-brands'
import { scanText } from '../../testing/brand-scan'
import { OFFICE_PEOPLE } from '../demo-data'
import { everyCase, leftKeys, render, textOf } from '../parts/testing'
import { designScreen } from './fixtures'
import { boxState, composerModes, floorOffered, floorTooLong, heldReason, keyMode, mentionsOf, startDraft, switchMode, type ComposerContext, type ComposerDraft } from './model'
import { Composer } from './view/Composer'

/** B-TH-205 — the composer's audience switch (T5): starts on Office note, the switch keeps the text, the floor tick, every state. */

const ORDER: ComposerContext = { recordType: 'SalesOrder', recordLabel: 'SO-2026-0101', party: { name: BRAND_ALPHA.tradeName }, can: { post: true, email: true, manage: false }, people: OFFICE_PEOPLE }
const draft = (more: Partial<ComposerDraft> = {}): ComposerDraft => ({ mode: 'note', body: '', forFloor: false, ...more })
const composer = (context: ComposerContext, value: ComposerDraft, locale: 'en' | 'it' = 'en') => render(createElement(Composer, { context, draft: value, onDraft: () => undefined, onSend: () => undefined }), locale)

describe('starts on Office note, safe by default (P3)', () => {
  it('every visit starts on the note; one who may only send mail starts on the reply', () => {
    expect(startDraft(ORDER)).toEqual({ mode: 'note', body: '', forFloor: false })
    expect(startDraft({ ...ORDER, can: { post: false, email: true, manage: false } }).mode).toBe('reply')
  })

  it('the reply needs a customer and email.send; without a customer the note only, said in words', () => {
    expect(composerModes(ORDER)).toEqual(['note', 'reply'])
    expect(composerModes({ ...ORDER, can: { ...ORDER.can, email: false } })).toEqual(['note'])
    expect(composerModes({ ...ORDER, party: null })).toEqual(['note'])
    expect(textOf(composer({ ...ORDER, party: null }, draft()))).toContain('This record has no customer: notes only.')
  })

  it('“Reply to <customer>” names only this record’s customer (W20)', () => {
    const text = textOf(composer(ORDER, draft()))
    expect(text).toContain('Office note')
    expect(text).toContain(`Reply to ${BRAND_ALPHA.tradeName}`)
    expect(text).toContain('Add note')
    const beta = textOf(composer({ ...ORDER, party: { name: BRAND_BETA.tradeName } }, draft({ mode: 'reply' })))
    expect(beta).toContain(`Send to ${BRAND_BETA.tradeName}`)
    expect(scanText(beta, BRAND_ALPHA)).toEqual([])
  })

  it('the whole box takes the audience: data-mode note (yellow, lock) or reply (blue), and Send names it', () => {
    expect(composer(ORDER, draft())).toContain('data-mode="note"')
    const reply = composer(ORDER, draft({ mode: 'reply', body: 'Hi' }))
    expect(reply).toContain('data-mode="reply"')
    expect(textOf(reply)).toContain(`Email to ${BRAND_ALPHA.tradeName} · the people in To and Cc read it`)
    expect(textOf(reply)).toContain(`Send to ${BRAND_ALPHA.tradeName}`)
    expect(textOf(composer(ORDER, draft({ body: 'x' }), 'it'))).toContain("Nota d'ufficio · la leggono solo i tuoi colleghi")
  })
})

describe('the text survives a switch', () => {
  it('keeps the text; leaving the note takes each @mention out of the mail and names it; the floor tick goes', () => {
    const before = draft({ body: 'Cutting on Thursday. @Bea Esempio please tell the warehouse.', forFloor: true })
    const after = switchMode(before, 'reply', OFFICE_PEOPLE)
    expect(after.draft).toEqual({ mode: 'reply', body: 'Cutting on Thursday. please tell the warehouse.', forFloor: false })
    expect(after.notes).toEqual([{ key: 'switch.mentions', params: { names: '@Bea Esempio' } }])
    expect(switchMode(after.draft, 'note', OFFICE_PEOPLE)).toEqual({ draft: { ...after.draft, mode: 'note' }, notes: [] })
    expect(switchMode(draft({ body: 'Hello' }), 'reply', OFFICE_PEOPLE).draft.body).toBe('Hello')
  })

  it('a mention is a colleague’s whole name after @, not an address or part of a word', () => {
    expect(mentionsOf('@alex demo, ok', OFFICE_PEOPLE).map((person) => person.name)).toEqual(['Alex Demo'])
    expect(mentionsOf('mail alex@Alex Demonstration', OFFICE_PEOPLE)).toEqual([])
  })
})

describe('Send waits with its reason', () => {
  it('offline first (the text stays), then sending, a prospect, an empty message, too long; files alone may go', () => {
    expect(heldReason(draft({ body: 'x' }), { ...ORDER, offline: true })).toEqual({ key: 'held.offline' })
    expect(heldReason(draft({ body: 'x' }), ORDER, { sending: true })).toEqual({ key: 'held.sending' })
    expect(heldReason(draft({ mode: 'reply', body: 'x' }), { party: null, prospect: { name: 'Nova' } })).toEqual({ key: 'held.prospect' })
    expect(heldReason(draft(), ORDER)).toEqual({ key: 'held.empty' })
    expect(heldReason(draft(), ORDER, { hasFiles: true })).toBeNull()
    expect(heldReason(draft({ body: 'x'.repeat(20_003) }), ORDER)).toEqual({ key: 'held.tooLong', params: { count: 3 } })
    expect(textOf(composer({ ...ORDER, offline: true }, draft({ body: 'x' })))).toContain('You are offline · your text stays on this device')
  })
})

describe('held box states and the floor', () => {
  it('closed replaces the box (Reopen for who manages threads); no right says why', () => {
    expect(boxState({ ...ORDER, closed: { by: 'Bea Esempio', at: '2026-11-12T15:00:00Z' } })).toBe('closed')
    const closed = textOf(render(createElement(Composer, { context: { ...ORDER, can: { ...ORDER.can, manage: true }, closed: { by: 'Bea Esempio', at: '2026-11-12T15:00:00Z' } }, draft: draft(), now: '2026-11-17T10:00:00Z', onDraft: () => undefined, onSend: () => undefined, onReopen: () => undefined })))
    expect(closed).toContain('Closed by Bea Esempio, 12 Nov. The customer cannot write here. Reopen')
    expect(boxState({ ...ORDER, can: { post: false, email: false, manage: false } })).toBe('noRight')
    expect(textOf(composer({ ...ORDER, can: { post: false, email: false, manage: false } }, draft()))).toContain('You can read this thread; writing in it needs another role.')
  })

  it('“For the floor” on a work order’s note only, off by default; the line says the floor’s rules', () => {
    expect(floorOffered({ recordType: 'WorkOrder' }, 'note')).toBe(true)
    expect(floorOffered({ recordType: 'WorkOrder' }, 'reply')).toBe(false)
    expect(floorOffered({ recordType: 'SalesOrder' }, 'note')).toBe(false)
    expect(textOf(composer(ORDER, draft()))).not.toContain('For the floor')
    const wo = { ...ORDER, recordType: 'WorkOrder', recordLabel: 'WO-2026-0311', party: null }
    expect(textOf(composer(wo, draft()))).toContain('For the floor Off: only the office reads this note.')
    expect(textOf(composer(wo, draft({ forFloor: true })))).toContain('The tablets of WO-2026-0311 show it: no prices, the first 1000 characters, for 14 days, no file, no name.')
    expect(floorTooLong(draft({ forFloor: true, body: 'x'.repeat(1001) }))).toBe(true)
  })

  it('R and N switch from outside the box; inside a field they type', () => {
    expect(keyMode('r', ['note', 'reply'], false)).toBe('reply')
    expect(keyMode('N', ['note', 'reply'], false)).toBe('note')
    expect(keyMode('r', ['note'], false)).toBeNull()
    expect(keyMode('r', ['note', 'reply'], true)).toBeNull()
  })
})

describe('SCR-006-composer in both languages', () => {
  it('every case draws, with no message key left on screen', () => {
    for (const [locale, id, html] of everyCase(designScreen)) expect(leftKeys(html, ['mode', 'mark', 'placeholder', 'send', 'live', 'held', 'box', 'prospect', 'switch', 'floor', 'drop', 'leave']), `${locale} ${id}`).toEqual([])
  })

  it('the brand wall: Brand Beta’s copy names only Brand Beta (B-TH-203)', () => {
    for (const [, id, html] of everyCase(designScreen)) if (id === 'brand-beta') expect(scanText(textOf(html), BRAND_ALPHA)).toEqual([])
  })
})
