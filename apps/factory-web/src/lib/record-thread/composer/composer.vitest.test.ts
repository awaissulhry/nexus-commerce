import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { BRAND_ALPHA, BRAND_BETA } from '../../testing/two-brands'
import { scanText } from '../../testing/brand-scan'
import { OFFICE_PEOPLE } from '../demo-data'
import { everyCase, leftKeys, render, textOf } from '../parts/testing'
import { designScreen } from './fixtures'
import { boxState, composerModes, floorOffered, floorTooLong, heldReason, keyMode, mentionsOf, startDraft, switchMode, type ComposerContext, type ComposerDraft } from './model'
// B-TH-236 / B-TH-237
import { floorLocked, sendKey, toCustomer } from './model'
import { replyAudienceOf, swapNumbers, withSavedReply } from './model' // th-backend-g step 1
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

// ---- B-TH-237 (B-TH-044): reply in the portal without e-mail; B-TH-236: Reply / Correct links, the amount, the floor's price check.
describe('B-TH-237: “In the portal only” — offered by the customer’s portal, the default stays Office note', () => {
  const PORTAL: ComposerContext = { ...ORDER, portal: true }

  it('the third audience needs a customer, threads.post and the portal offered; every visit still starts on Office note', () => {
    expect(composerModes(PORTAL)).toEqual(['note', 'reply', 'portal'])
    expect(composerModes(ORDER)).toEqual(['note', 'reply'])
    expect(composerModes({ ...PORTAL, party: null })).toEqual(['note'])
    expect(composerModes({ ...PORTAL, can: { ...PORTAL.can, email: false } })).toEqual(['note', 'portal'])
    expect(composerModes({ ...PORTAL, can: { ...PORTAL.can, post: false } })).toEqual(['reply'])
    expect(startDraft(PORTAL).mode).toBe('note')
    expect(toCustomer('portal')).toBe(true)
    expect(toCustomer('note')).toBe(false)
  })

  it('the portal box: blue, no To or Cc, its line names the customer’s mail setting, Send names the customer (W08, W20)', () => {
    const html = composer(PORTAL, draft({ mode: 'portal', body: 'Yes, both sizes.' }))
    expect(html).toContain('data-mode="portal"')
    const text = textOf(html)
    expect(text).toContain('In the portal only')
    expect(text).toContain(`In ${BRAND_ALPHA.tradeName}’s portal · no e-mail`)
    expect(text).toContain('their mail setting decides when they hear of it')
    expect(text).toContain(`Post to ${BRAND_ALPHA.tradeName}`)
    expect(sendKey('portal')).toBe('send.portal')
    expect(textOf(composer(PORTAL, draft({ mode: 'portal', body: 'x' }), 'it'))).toContain(`Pubblica per ${BRAND_ALPHA.tradeName}`)
    const beta = textOf(composer({ ...PORTAL, party: { name: BRAND_BETA.tradeName } }, draft({ mode: 'portal', body: 'x' })))
    expect(scanText(beta, BRAND_ALPHA)).toEqual([])
  })

  it('switching to the portal keeps the text, takes mentions and the amount out (said), drops the floor tick', () => {
    const after = switchMode(draft({ body: '@Bea Esempio the price is set.', amount: '10', forFloor: true }), 'portal', OFFICE_PEOPLE)
    expect(after.draft).toEqual({ mode: 'portal', body: 'the price is set.', forFloor: false })
    expect(after.notes.map((note) => note.key)).toEqual(['switch.mentions', 'switch.amount'])
    expect(heldReason(draft({ mode: 'portal', body: 'x' }), { party: null, prospect: { name: 'Nova' } })).toEqual({ key: 'held.prospect' })
  })
})

describe('B-TH-236: what the message answers or corrects, the amount, the floor’s price check', () => {
  const REPLY = { kind: 'reply' as const, messageId: 'm-1', who: 'Anna Alfieri', at: '2026-11-17T09:41:00.000Z' }
  const FIX = { kind: 'correct' as const, messageId: 'm-2', who: null, at: '2026-11-17T08:12:00.000Z', way: 'reply' as const }

  it('the box names the message: “Replying to Anna Alfieri, 17 Nov” or “Correcting your mail of 09:12”, with ×', () => {
    expect(textOf(composer({ ...ORDER, portal: true }, draft({ mode: 'portal', link: REPLY }), 'en'))).toContain('Replying to Anna Alfieri, 17 Nov')
    const fix = textOf(composer(ORDER, draft({ mode: 'reply', body: 'Thursday.', link: FIX })))
    expect(fix).toContain('Correcting your mail of 09:12: whoever got it gets the correction')
    expect(textOf(composer(ORDER, draft({ mode: 'reply', body: 'x', link: FIX }), 'it'))).toContain('Correggi la tua mail delle 09:12')
  })

  it('a reply link survives a switch; a correction keeps its way — leaving it lets the correction go (said)', () => {
    expect(switchMode(draft({ mode: 'reply', body: 'x', link: REPLY }), 'note', OFFICE_PEOPLE).draft.link).toEqual(REPLY)
    expect(switchMode(draft({ mode: 'note', body: 'x', link: REPLY }), 'portal', OFFICE_PEOPLE).draft.link).toEqual(REPLY)
    const left = switchMode(draft({ mode: 'reply', body: 'x', link: FIX }), 'note', OFFICE_PEOPLE)
    expect(left.draft.link).toBeUndefined()
    expect(left.notes).toEqual([{ key: 'switch.correction' }])
  })

  it('the floor tick of a correction of a floor note is on and stays on', () => {
    const wo = { ...ORDER, recordType: 'WorkOrder', recordLabel: 'WO-2026-0311', party: null }
    const fixFloor = draft({ body: 'Black mesh.', forFloor: true, link: { kind: 'correct', messageId: 'm-3', who: null, at: '2026-11-17T08:30:00.000Z', way: 'note', forFloor: true } })
    expect(floorLocked(fixFloor)).toBe(true)
    expect(floorLocked(draft())).toBe(false)
    const html = composer(wo, fixFloor)
    expect(textOf(html)).toContain('The note you correct is on the tablets: the correction goes there too.')
    expect(html).toMatch(/type="checkbox"[^>]*checked=""[^>]*disabled=""|type="checkbox"[^>]*disabled=""[^>]*checked=""|disabled=""[^>]*type="checkbox"[^>]*checked=""|checked=""[^>]*disabled=""[^>]*type="checkbox"/)
  })

  it('the amount field: on an office note for a price reader only; Send is held while it is not a number or with “For the floor”', () => {
    const priced = { ...ORDER, can: { ...ORDER.can, price: true } }
    expect(textOf(composer(priced, draft({ body: 'x' })))).toContain('Amount')
    expect(textOf(composer(ORDER, draft({ body: 'x' })))).not.toContain('Amount')
    expect(textOf(composer(priced, draft({ mode: 'reply', body: 'x' })))).not.toContain('Amount')
    expect(heldReason(draft({ body: 'x', amount: '12,50' }), ORDER)).toBeNull()
    expect(heldReason(draft({ body: 'x', amount: 'twelve' }), ORDER)).toEqual({ key: 'held.amount' })
    expect(heldReason(draft({ body: 'x', amount: '12', forFloor: true }), ORDER)).toEqual({ key: 'held.amountFloor' })
    expect(heldReason(draft({ body: 'x', amount: '' }), ORDER)).toBeNull()
  })

  it('W08/W34: a floor note whose words look like a price is held, naming what looked like one; an office note may say prices', () => {
    expect(heldReason(draft({ body: 'Lining at € 4,50 a metre.', forFloor: true }), ORDER)).toEqual({ key: 'held.floorPrice', params: { found: '€ 4,50' } })
    expect(heldReason(draft({ body: 'prezzo 12 al metro', forFloor: true }), ORDER)?.key).toBe('held.floorPrice')
    expect(heldReason(draft({ body: 'Lining at € 4,50 a metre.' }), ORDER)).toBeNull()
    expect(heldReason(draft({ body: 'Cut 40 pieces, total 120.', forFloor: true }), ORDER)).toBeNull()
    const wo = { ...ORDER, recordType: 'WorkOrder', recordLabel: 'WO-2026-0311', party: null }
    expect(textOf(composer(wo, draft({ body: 'Lining at € 4,50 a metre.', forFloor: true })))).toContain('Held: “€ 4,50” looks like a price, and the floor never sees money.')
  })

  it('the new cases draw with no key left on screen, in both languages', () => {
    for (const [locale, id, html] of everyCase(designScreen)) expect(leftKeys(html, ['mode', 'mark', 'placeholder', 'send', 'live', 'held', 'portal', 'link', 'switch', 'floor', 'drop', 'amount']), `${locale} ${id}`).toEqual([])
    expect(designScreen.cases.map((item) => item.id)).toEqual(expect.arrayContaining(['portal', 'replying', 'correcting', 'amount', 'floor-price', 'correct-floor']))
  })
})
// ---- end B-TH-236 / B-TH-237

// ---- B-TH-287 (B-TH-092; T5-F10, T8-F07; wall W08): the composer's draft on the server — what a save sends, what a read restores ----
import { draftFromServer, draftToSave, newerCopy, savedKey, worthKeeping, type ServerDraftIn } from './server-draft'
import type { DraftFile } from '../attachments/model'
import { CATALOGUE } from '../../i18n/messages'

describe('B-TH-287 — the draft on the server', () => {
  const done = (id: string, audience: 'OFFICE' | 'PARTY'): DraftFile => ({ key: `k-${id}`, name: `${id}.pdf`, sizeBytes: 10, contentType: 'application/pdf', source: 'device', phase: 'done', fileId: id, audience })
  const parts = (over: Partial<Parameters<typeof draftToSave>[0]> = {}) => ({ draft: { mode: 'note' as const, body: 'Check the collar', forFloor: false }, to: [], cc: [], subject: '', files: [], ...over })
  const server = (over: Partial<ServerDraftIn> = {}): ServerDraftIn => ({ audience: 'OFFICE', body: 'Kept words', fields: { mode: 'note' }, attachments: [], savedAt: '2026-11-17T09:42:00.000Z', version: 3, ...over })

  it('an office note saves as OFFICE with its words; nothing names a person or a party (the API takes the person from the session)', () => {
    const save = draftToSave(parts())!
    expect(save).toMatchObject({ audience: 'OFFICE', body: 'Check the collar', attachments: [] })
    expect(JSON.stringify(save)).not.toMatch(/userId|partyId|personId/)
  })

  it('a reply saves as PARTNER with its subject, To and Cc; files that went up keep their audience; a file on its way is not kept', () => {
    const save = draftToSave(
      parts({
        draft: { mode: 'reply', body: 'Hello', forFloor: false },
        to: [{ address: 'buyer@example.com', name: null, kind: 'PARTY', organisation: null }],
        cc: [{ address: 'cc@example.com', name: null, kind: null, organisation: null }],
        subject: 'SO-2026-0142',
        files: [done('f-1', 'PARTY'), { ...done('f-2', 'OFFICE'), phase: 'uploading' }],
      }),
    )!
    expect(save.audience).toBe('PARTNER')
    expect(save.fields).toMatchObject({ mode: 'reply', subject: 'SO-2026-0142', to: ['buyer@example.com'], cc: ['cc@example.com'], fileAudiences: { 'f-1': 'PARTY' } })
    expect(save.attachments).toEqual(['f-1'])
  })

  it('an empty box keeps nothing (the server’s draft is discarded); files alone are worth keeping', () => {
    expect(draftToSave(parts({ draft: { mode: 'note', body: '   ', forFloor: false } }))).toBeNull()
    expect(worthKeeping(parts({ draft: { mode: 'note', body: '', forFloor: false }, files: [done('f-1', 'OFFICE')] }))).toBe(true)
  })

  it('a read restores the box safely: a portal message comes back as an office note, a reply only to who may still send it', () => {
    expect(draftFromServer(server(), { reply: true }).draft).toEqual({ mode: 'note', body: 'Kept words', forFloor: false })
    const reply = server({ audience: 'PARTNER', fields: { mode: 'reply', subject: 'S', to: ['Buyer@Example.com'], cc: [] } })
    expect(draftFromServer(reply, { reply: true })).toMatchObject({ mode: 'reply', subject: 'S', to: [{ address: 'buyer@example.com' }] })
    // No right to mail (or no customer any more): the words stay, as an office note, with no recipients.
    expect(draftFromServer(reply, { reply: false })).toMatchObject({ mode: 'note', to: [], subject: '' })
    expect(draftFromServer(server({ audience: 'PARTNER', fields: { mode: 'portal' } }), { reply: true }).mode).toBe('note')
  })

  it('restores the files the person may still open with their audience; a locked sheet or a file gone stays out', () => {
    const read = draftFromServer(
      server({
        fields: { mode: 'note', fileAudiences: { a: 'PARTY' } },
        attachments: [
          { id: 'a', originalName: 'a.pdf', contentType: 'application/pdf', sizeBytes: 1, status: 'AVAILABLE' },
          { id: 'b', originalName: '', contentType: 'application/pdf', sizeBytes: 1, status: 'AVAILABLE', locked: 'MEASUREMENTS' },
          { id: 'c', originalName: 'c.pdf', contentType: 'application/pdf', sizeBytes: 1, status: 'DELETED' },
        ],
      }),
      { reply: true },
    )
    expect(read.files.map((file) => [file.fileId, file.audience, file.phase])).toEqual([['a', 'PARTY', 'done']])
  })

  it('a correction keeps its way; one that went another way is let go', () => {
    const link = { kind: 'correct', messageId: 'm-1', who: null, at: '2026-11-16T09:00:00.000Z', way: 'reply' }
    expect(draftFromServer(server({ audience: 'PARTNER', fields: { mode: 'reply', link } }), { reply: true }).draft.link).toMatchObject({ kind: 'correct', messageId: 'm-1' })
    expect(draftFromServer(server({ audience: 'PARTNER', fields: { mode: 'reply', link } }), { reply: false }).draft.link).toBeUndefined()
  })

  it('keeps the office numbers a saved reply put in a note, so a switch to the customer still swaps them (§0.5)', () => {
    const numbers = [{ office: 'INQ-2026-0042', customer: '#7' }]
    const save = draftToSave(parts({ draft: { mode: 'note', body: 'About INQ-2026-0042', forFloor: false, numbers } }))!
    expect(save.fields.numbers).toEqual(numbers)
    const read = draftFromServer(server({ body: 'About INQ-2026-0042', fields: { mode: 'note', numbers: [...numbers, { office: '', customer: null }, 'junk'] } }), { reply: true })
    expect(read.draft.numbers).toEqual(numbers)
    expect(switchMode(read.draft, 'reply', []).draft.body).toBe('About #7')
  })

  it('on arrival the newer of the device copy and the server’s goes in the box', () => {
    expect(newerCopy(null, null)).toBeNull()
    expect(newerCopy({ savedAt: 1 }, null)).toBe('local')
    expect(newerCopy(null, { savedAt: '2026-11-17T09:42:00.000Z' })).toBe('server')
    expect(newerCopy({ savedAt: Date.parse('2026-11-17T09:43:00.000Z') }, { savedAt: '2026-11-17T09:42:00.000Z' })).toBe('local')
    expect(newerCopy({ savedAt: Date.parse('2026-11-17T09:41:00.000Z') }, { savedAt: '2026-11-17T09:42:00.000Z' })).toBe('server')
  })

  it('the line’s words are keys of record-thread-helpers `draft.*` in it and en', () => {
    for (const saved of [{ state: 'saved', at: 'x' }, { state: 'replaced', at: 'x' }, { state: 'saving' }, { state: 'failed' }, { state: 'offline' }] as const) {
      const key = savedKey(saved)
      for (const locale of ['en', 'it'] as const) expect(CATALOGUE[locale]['record-thread-helpers']?.[key], `${locale} ${key}`).toBeTruthy()
    }
  })
})
// ---- end B-TH-287

// ---- th-backend-g step 1 (threads plan §0.5, counts do not leak; lead's decision) ------------------------------------------------
describe('th-backend-g step 1: a saved reply names the office’s numbers in a note, the customer’s own once it goes to the customer', () => {
  it('fills for who reads it: the office in a note, the customer in a reply or the portal', () => {
    expect(replyAudienceOf('note')).toBe('OFFICE')
    expect(replyAudienceOf('reply')).toBe('CUSTOMER')
    expect(replyAudienceOf('portal')).toBe('CUSTOMER')
  })

  it('a reply filled for a note keeps its numbers; filled for the customer it keeps none (nothing to swap)', () => {
    const numbers = [{ placeholder: 'inquiry.number', office: 'INQ-2026-0042', customer: '#7' }]
    const note = withSavedReply(draft({ body: 'Typed first' }), { body: 'Thank you for INQ-2026-0042.', audience: 'OFFICE', numbers })
    expect(note).toEqual({ mode: 'note', body: 'Typed first\n\nThank you for INQ-2026-0042.', forFloor: false, numbers: [{ office: 'INQ-2026-0042', customer: '#7' }] })
    expect(withSavedReply(draft({ mode: 'reply' }), { body: 'Thank you for #7.', audience: 'CUSTOMER', numbers }).numbers).toBeUndefined()
    // A prospect's number is the same in both forms: nothing to keep.
    expect(withSavedReply(draft(), { body: 'INQ-2026-0043', audience: 'OFFICE', numbers: [{ office: 'INQ-2026-0043', customer: 'INQ-2026-0043' }] }).numbers).toBeUndefined()
  })

  it('switching the note to the customer swaps the office’s numbers for its own and says so; a number it has none for goes', () => {
    const filled = draft({ body: 'Order SO-2026-0101 and request INQ-2026-0042 (not XSO-2026-01011).', numbers: [{ office: 'SO-2026-0101', customer: '#12' }, { office: 'INQ-2026-0042', customer: null }] })
    const { draft: reply, notes } = switchMode(filled, 'reply', OFFICE_PEOPLE)
    expect(reply.body).toBe('Order #12 and request  (not XSO-2026-01011).')
    expect(reply.numbers).toBeUndefined()
    expect(notes).toEqual([{ key: 'switch.numbers', params: { numbers: 'SO-2026-0101 → #12, INQ-2026-0042' } }])
    expect(JSON.stringify(reply)).not.toMatch(/INQ-2026-0042|(?<![A-Z])SO-2026-0101(?!\d)/)
    // Back to a note: nothing is swapped back (the office reads every number).
    expect(switchMode(reply, 'note', OFFICE_PEOPLE).draft.body).toBe(reply.body)
    expect(swapNumbers('No numbers here', [{ office: 'SO-1', customer: '#1' }])).toEqual({ body: 'No numbers here', swapped: [] })
  })
})
// ---- end th-backend-g step 1
