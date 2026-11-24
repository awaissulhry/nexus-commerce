import { readFileSync } from 'node:fs'
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
import { aboutOf, aboutRefOf, aboutWords, bodyWithAbout, OFFICE_ONLY_ABOUT, withAbout, withoutAbout } from './model' // F-SA-265
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

  // tw- fx2 (walk G-15): without a customer the one audience chip says it ("Office note", no menu) — no extra line under the box.
  it('the reply needs a customer and email.send; without a customer the note only, said by the chip', () => {
    expect(composerModes(ORDER)).toEqual(['note', 'reply'])
    expect(composerModes({ ...ORDER, can: { ...ORDER.can, email: false } })).toEqual(['note'])
    expect(composerModes({ ...ORDER, party: null })).toEqual(['note'])
    const alone = composer({ ...ORDER, party: null }, draft())
    expect(alone).toContain('class="fw-rt-cx-chipbtn is-static"')
    expect(textOf(alone)).toContain('Office note')
    expect(textOf(alone)).not.toContain('This record has no customer: notes only.')
  })

  it('“Reply to <customer>” names only this record’s customer (W20)', () => {
    const text = textOf(composer(ORDER, draft()))
    expect(text).toContain('Office note')
    expect(text).toContain('Add note')
    // tw- W2.3: the audiences are the chip's rows (a closed menu on the server render); the reply names this record's customer.
    expect(composerModes(ORDER)).toEqual(['note', 'reply'])
    expect(composer(ORDER, draft({ mode: 'reply' }))).toContain(`aria-label="Who reads what you write: Reply to ${BRAND_ALPHA.tradeName}"`)
    const beta = textOf(composer({ ...ORDER, party: { name: BRAND_BETA.tradeName } }, draft({ mode: 'reply' })))
    expect(beta).toContain(`Send to ${BRAND_BETA.tradeName}`)
    expect(scanText(beta, BRAND_ALPHA)).toEqual([])
  })

  // tw- W2.3 (10-design §10): the audience chip takes the audience's colour and says it; Send (an arrow) names it for a screen reader.
  it('the chip takes the audience: data-mode note (yellow, lock) or reply (blue), its word, and Send names it', () => {
    expect(composer(ORDER, draft())).toContain('data-mode="note"')
    const reply = composer(ORDER, draft({ mode: 'reply', body: 'Hi' }))
    expect(reply).toContain('data-mode="reply"')
    expect(reply).toContain(`aria-label="Who reads what you write: Reply to ${BRAND_ALPHA.tradeName}"`)
    expect(reply).toContain(`aria-label="Send to ${BRAND_ALPHA.tradeName}"`)
    expect(textOf(reply)).toContain(`Send to ${BRAND_ALPHA.tradeName}`)
    expect(textOf(composer(ORDER, draft({ body: 'x' }), 'it'))).toContain("Nota d'ufficio")
    expect(composer(ORDER, draft())).not.toContain('fw-rt-cx-mark')
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
    // tw- W2.3: one line — "Closed by Bea Esempio, 12 Nov · Reopen".
    expect(closed).toContain('Closed by Bea Esempio, 12 Nov')
    expect(closed).toContain('Reopen')
    expect(closed).not.toContain('The customer cannot write here')
    expect(boxState({ ...ORDER, can: { post: false, email: false, manage: false } })).toBe('noRight')
    expect(textOf(composer({ ...ORDER, can: { post: false, email: false, manage: false } }, draft()))).toContain('You can read this thread; writing in it needs another role.')
  })

  it('“For the floor” on a work order’s note only, off by default; the line says the floor’s rules', () => {
    expect(floorOffered({ recordType: 'WorkOrder' }, 'note')).toBe(true)
    expect(floorOffered({ recordType: 'WorkOrder' }, 'reply')).toBe(false)
    expect(floorOffered({ recordType: 'SalesOrder' }, 'note')).toBe(false)
    expect(textOf(composer(ORDER, draft()))).not.toContain('For the floor')
    const wo = { ...ORDER, recordType: 'WorkOrder', recordLabel: 'WO-2026-0311', party: null }
    // tw- W2.3: "+ › For the floor" — off at rest (no sentence under the box); on, a chip whose tooltip says the tablets' rule.
    expect(textOf(composer(wo, draft()))).not.toContain('For the floor')
    expect(textOf(composer(wo, draft()))).not.toContain('only the office reads this note')
    const on = composer(wo, draft({ forFloor: true }))
    expect(on).toContain('fw-rt-cx-chip is-floor')
    expect(textOf(on)).toContain('For the floor')
    const source = readFileSync(new URL('./view/Composer.tsx', import.meta.url), 'utf8')
    expect(source).toContain("<Tooltip label={`${t('floor.on', { record: context.recordLabel, limit: FLOOR_TEXT })}")
    expect(source).toContain("{ id: 'floor', label: t('floor.label')")
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
    // tw- W2.3: the chip says "In the portal"; no sentence of the portal under the box (the chip's menu row names the customer).
    expect(text).toContain('In the portal')
    expect(text).not.toContain('their mail setting decides when they hear of it')
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
    // tw- W2.3: ONE bar above the box — the reply (the name, one line, ×; its full words for a screen reader) or the correction.
    const replying = composer({ ...ORDER, portal: true }, draft({ mode: 'portal', link: REPLY }), 'en')
    expect(replying).toContain('aria-label="Replying to Anna Alfieri, 17 Nov"')
    expect(textOf(replying)).toContain('Anna Alfieri')
    expect(replying).toContain('aria-label="Not a reply to that message any more"')
    const fix = textOf(composer(ORDER, draft({ mode: 'reply', body: 'Thursday.', link: FIX })))
    expect(fix).toContain('Correcting your email of 09:12')
    expect(textOf(composer(ORDER, draft({ mode: 'reply', body: 'x', link: FIX }), 'it'))).toContain('Correggi la tua email delle 09:12')
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
    // tw- W2.3: "For the floor" is a chip — on and locked (no × to take it off); its rule is said for a screen reader too.
    expect(textOf(html)).toContain('The note you correct is on the tablets: the correction goes there too.')
    expect(html).toContain('fw-rt-cx-chip is-floor')
    expect(html).not.toContain('fw-rt-cx-chip-x')
  })

  it('the amount field: on an office note for a price reader only; Send is held while it is not a number or with “For the floor”', () => {
    const priced = { ...ORDER, can: { ...ORDER.can, price: true } }
    // tw- W2.3: "Amount" is a row of the "+" (the composer's own rows after the files'), for a price reader on an office note only.
    const rows = (context: ComposerContext, value: ComposerDraft) => textOf(render(createElement(Composer, { context, draft: value, onDraft: () => undefined, onSend: () => undefined, plus: (more) => createElement('i', null, more.map((row) => String(row.label)).join(' | ')) })))
    expect(rows(priced, draft({ body: 'x' }))).toContain('Amount')
    expect(rows(ORDER, draft({ body: 'x' }))).not.toContain('Amount')
    expect(rows(priced, draft({ mode: 'reply', body: 'x' }))).not.toContain('Amount')
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

// ---- F-SA-282a (sales page plan R7; B-SA-073; the production notes' R-47 rule): a portal text that names another customer of ours ----
import { NAMES_NO_OTHER_CUSTOMER } from '@nexus/factory-domain/production-brand/notes'
import { REPLY_REFUSAL_WORDS } from '@nexus/factory-domain/threads/replies'
import { draftAfter, heldForNamesOther, namesNoOtherCustomerOf, namesOtherAsked, withoutNamesOther } from './model'
import { createTranslator as translatorFor, messagesFor as wordsFor } from '../../i18n/messages'

describe('F-SA-282a: the portal’s hold of a text that names another customer, and the tick “This text names no other customer”', () => {
  const PORTAL: ComposerContext = { ...ORDER, portal: true }
  const HELD = heldForNamesOther(draft({ mode: 'portal', body: 'Same trims as last season.' }))
  const words = (locale: 'en' | 'it') => translatorFor(locale, wordsFor(locale, ['record-thread-composer'])['record-thread-composer']!)

  it('the text comes back held in the portal box: Send waits with the reason until the writer ticks it, then the tick goes with it', () => {
    expect(HELD).toEqual({ mode: 'portal', body: 'Same trims as last season.', forFloor: false, namesOther: true, namesNoOtherCustomer: false })
    expect(namesOtherAsked(HELD)).toBe(true)
    expect(heldReason(HELD, PORTAL)).toEqual({ key: 'held.namesOther' })
    expect(namesNoOtherCustomerOf(HELD)).toBe(false)
    const ticked = draftAfter(HELD, { namesNoOtherCustomer: true })
    expect(heldReason(ticked, PORTAL)).toBeNull()
    expect(namesNoOtherCustomerOf(ticked)).toBe(true)
    // Offline, an empty box and the rest still come first.
    expect(heldReason(HELD, { ...PORTAL, offline: true })).toEqual({ key: 'held.offline' })
    // Nothing asked: nothing held, no tick sent (a first try never carries it).
    expect(heldReason(draft({ mode: 'portal', body: 'x' }), PORTAL)).toBeNull()
    expect(namesNoOtherCustomerOf(draft({ mode: 'portal', body: 'x', namesNoOtherCustomer: true }))).toBe(false)
  })

  it('a change of the words lets the hold and the tick go (the API checks the new words); leaving the portal or a saved reply too', () => {
    const ticked = draftAfter(HELD, { namesNoOtherCustomer: true })
    expect(draftAfter(ticked, { body: 'Same trims as before.' })).toEqual({ mode: 'portal', body: 'Same trims as before.', forFloor: false })
    expect(draftAfter(ticked, { body: ticked.body })).toEqual(ticked)
    expect(switchMode(ticked, 'note', OFFICE_PEOPLE).draft).toEqual({ mode: 'note', body: 'Same trims as last season.', forFloor: false })
    expect(switchMode(ticked, 'reply', OFFICE_PEOPLE).draft).toEqual({ mode: 'reply', body: 'Same trims as last season.', forFloor: false })
    expect(withSavedReply(ticked, { body: 'Kind regards.' })).toEqual({ mode: 'portal', body: 'Same trims as last season.\n\nKind regards.', forFloor: false })
    expect(withoutNamesOther(draft({ body: 'x' }))).toEqual(draft({ body: 'x' }))
    // Only the portal is checked this way: an office note or a mail never shows the tick.
    expect(namesOtherAsked({ ...HELD, mode: 'note' })).toBe(false)
    expect(heldReason({ ...HELD, mode: 'reply' }, PORTAL)).toBeNull()
  })

  it('the box says it in words and shows the tick, in both languages; ticked, Post may go; it never names whom', () => {
    for (const locale of ['en', 'it'] as const) {
      const t = words(locale)
      const held = textOf(composer(PORTAL, HELD, locale))
      expect(held, locale).toContain(t('held.namesOther'))
      expect(held, locale).toContain(t('namesOther.tick'))
      expect(held, locale).toContain(t('namesOther.hint'))
      expect(scanText(held, BRAND_BETA), locale).toEqual([])
      const ticked = composer(PORTAL, draftAfter(HELD, { namesNoOtherCustomer: true }), locale)
      expect(textOf(ticked), locale).not.toContain(t('held.namesOther'))
      expect(ticked, locale).toMatch(/type="checkbox"[^>]*checked=""|checked=""[^>]*type="checkbox"/)
      // Before the API held it there is no tick.
      expect(textOf(composer(PORTAL, draft({ mode: 'portal', body: 'x' }), locale)), locale).not.toContain(t('namesOther.tick'))
    }
  })

  it('one rule, one sentence: the production notes’ words (R-47) and the API’s refusal, never a new synonym', () => {
    for (const locale of ['en', 'it'] as const) {
      const t = words(locale)
      const notes = translatorFor(locale, wordsFor(locale, ['production-notes'])['production-notes']!)
      expect(t('namesOther.tick'), locale).toBe(NAMES_NO_OTHER_CUSTOMER[locale])
      expect(t('namesOther.hint'), locale).toBe(notes('check.namesOtherHint'))
      expect(t('held.namesOther'), locale).toBe(notes('held.namesOther'))
      // The API's sentence, its quotes aside.
      expect(t('held.namesOther').replace(/[“”]/g, '"'), locale).toBe(REPLY_REFUSAL_WORDS.NAMES_OTHER_CUSTOMER[locale])
    }
  })

  it('the design cases draw with no key left on screen, in both languages', () => {
    for (const [locale, id, html] of everyCase(designScreen)) if (id.startsWith('names-other')) expect(leftKeys(html, ['held', 'namesOther', 'portal', 'mark', 'send']), `${locale} ${id}`).toEqual([])
    expect(designScreen.cases.map((item) => item.id)).toEqual(expect.arrayContaining(['names-other', 'names-other-ticked']))
  })
})
// ---- end F-SA-282a

// ---- F-SA-265 (sales page plan N2, N4; picks P2, P9, R10; 10-order-page §6.4; B-SA-061): Discuss — the chip "About: …"
describe('F-SA-265: the chip "About: …" follows the audience', () => {
  const line = { ref: { kind: 'SalesOrderLine' as const, id: 'line-2' }, office: 'SO-2026-0142 · line 2', customer: 'your order · line 2' }
  const deposit = { ref: { kind: 'DepositRequest' as const, id: 'dep-1' }, office: 'SO-2026-0142 · deposit 30 %', customer: 'your order · deposit' }
  const workOrder = { ref: { kind: 'WorkOrder' as const, id: 'wo-1' }, office: 'SO-2026-0142 · WO-2026-0311', customer: 'your order · WO-2026-0311' }
  const planned = { ref: null, office: 'SO-2026-0142 · cut start planned 22 Nov', customer: 'your order · cut start', line: 'About: SO-2026-0142 · cut start planned 22 Nov' }

  it('Discuss opens on Office note with the chip; what was typed stays; the earlier chip is replaced', () => {
    const typed = { ...draft({ mode: 'reply' }), body: 'Can we check this?' }
    const opened = withAbout(typed, line, OFFICE_PEOPLE)
    expect(opened.draft.mode).toBe('note')
    expect(opened.draft.body).toBe('Can we check this?')
    expect(aboutWords(opened.draft)).toBe('SO-2026-0142 · line 2')
    expect(withAbout(opened.draft, deposit, OFFICE_PEOPLE).draft.about?.ref?.kind).toBe('DepositRequest')
    expect(withoutAbout(opened.draft).about).toBeUndefined()
  })

  it('in a reply the customer reads its own words — no office number, no price, no work-order number', () => {
    const note = withAbout(draft(), line, OFFICE_PEOPLE).draft
    const reply = switchMode(note, 'reply', OFFICE_PEOPLE)
    expect(reply.notes).toEqual([])
    expect(aboutWords(reply.draft)).toBe('your order · line 2')
    expect(aboutRefOf(reply.draft)).toEqual({ kind: 'SalesOrderLine', id: 'line-2' })
    expect(aboutWords(switchMode(note, 'portal', OFFICE_PEOPLE).draft)).toBe('your order · line 2')
  })

  it('an office-only chip (a work order; the money rows: deposit, invoice; a part with no reference) drops on Reply, said', () => {
    expect(OFFICE_ONLY_ABOUT.has('WorkOrder')).toBe(true)
    expect(OFFICE_ONLY_ABOUT.has('DepositRequest')).toBe(true)
    expect(OFFICE_ONLY_ABOUT.has('Invoice')).toBe(true)
    expect(OFFICE_ONLY_ABOUT.has('SalesOrderLine')).toBe(false)
    for (const about of [deposit, workOrder, planned]) {
      // Whatever words the row gave, the kind decides: an office-only chip has none for the customer.
      expect(aboutOf(about).customer, about.office).toBeNull()
      const note = withAbout(draft(), about, OFFICE_PEOPLE).draft
      const reply = switchMode(note, 'reply', OFFICE_PEOPLE)
      expect(reply.draft.about, about.office).toBeUndefined()
      expect(reply.notes).toContainEqual({ key: 'switch.about' })
      expect(aboutRefOf(reply.draft)).toBeNull()
    }
    // Back on the note the chip is gone (the person discusses the row again for it).
    const back = switchMode(switchMode(withAbout(draft(), workOrder, OFFICE_PEOPLE).draft, 'reply', OFFICE_PEOPLE).draft, 'note', OFFICE_PEOPLE)
    expect(back.draft.about).toBeUndefined()
  })

  it('what is sent: the reference in an office note; a part with no reference as the note\'s first line', () => {
    const note = { ...withAbout(draft(), workOrder, OFFICE_PEOPLE).draft, body: 'Hold the cut.' }
    expect(aboutRefOf(note)).toEqual({ kind: 'WorkOrder', id: 'wo-1' })
    expect(bodyWithAbout(note)).toBe('Hold the cut.')
    const words = { ...withAbout(draft(), planned, OFFICE_PEOPLE).draft, body: 'Move it a day?' }
    expect(aboutRefOf(words)).toBeNull()
    expect(bodyWithAbout(words)).toBe('About: SO-2026-0142 · cut start planned 22 Nov\nMove it a day?')
  })

  it('the box draws the chip with ×, in both languages; the switch note in words', () => {
    const en = textOf(composer(ORDER, withAbout(draft(), line, OFFICE_PEOPLE).draft))
    expect(en).toContain('About: SO-2026-0142 · line 2')
    const it = textOf(composer(ORDER, withAbout(draft(), line, OFFICE_PEOPLE).draft, 'it'))
    expect(it).toContain('Riguardo: SO-2026-0142 · line 2')
    const reply = textOf(composer(ORDER, switchMode(withAbout(draft(), line, OFFICE_PEOPLE).draft, 'reply', OFFICE_PEOPLE).draft))
    expect(reply).toContain('About: your order · line 2')
    expect(reply).not.toContain('SO-2026-0142')
    const html = composer(ORDER, withAbout(draft(), line, OFFICE_PEOPLE).draft)
    expect(html).toContain('aria-label="Remove the reference"')
    const notes = render(createElement(Composer, { context: ORDER, draft: draft({ mode: 'reply' }), notes: [{ key: 'switch.about' }], onDraft: () => undefined, onSend: () => undefined }), 'it')
    expect(textOf(notes)).toContain("Il riferimento resta nelle note d'ufficio")
  })

  it('the container sends it with the note, the portal reply and the mail (never an office-only chip to the customer)', async () => {
    const { readFileSync } = await import('node:fs')
    const hook = readFileSync(new URL('../../../areas/_shared/record-thread/use-record-thread.ts', import.meta.url), 'utf8')
    expect(hook).toContain('const about = aboutRefOf(now.draft)')
    expect(hook).toContain('const noteBody = bodyWithAbout(now.draft)')
    expect(hook).toContain('...linksOf(now.draft.link), ...(about ? { about } : {}) }')
    const api = readFileSync(new URL('../../../areas/_shared/record-thread/api.ts', import.meta.url), 'utf8')
    expect(api.match(/\.\.\.\(input\.about \? \{ about: \{ kind: input\.about\.kind, id: input\.about\.id \} \} : \{\}\), \/\/ F-SA-265/g)?.length).toBe(2)
  })
})
// ---- end F-SA-265

// ---- tw- W1.4 (D4, R4): a reply to an office note starts as an office note; going to the customer drops its quote, said ------------
import { replyWay } from '../card/model'

describe('tw- W1.4 — a reply to an office note never takes its quote to the customer (R4)', () => {
  const NOTE_REPLY = { kind: 'reply' as const, messageId: 'n-1', who: 'Carlo Prova', at: '2026-11-17T09:41:00.000Z', audience: 'note' as const, quote: { name: 'Carlo Prova', tone: 'emerald' as const, line: 'Week 50 works.' } }
  const SHARED_REPLY = { ...NOTE_REPLY, messageId: 't-1', audience: 'shared' as const }

  it('Reply on an office note starts an office note; switching it to the customer drops the quote and says so', () => {
    const note = { id: 'n-1', kind: 'note' as const, channel: 'APP' as const, author: 'Carlo Prova', authorKind: 'USER' as const, at: NOTE_REPLY.at, body: 'Week 50 works.', mentions: [], files: [] }
    expect(replyWay(note, { canReply: true, replyWays: { note: true, email: true, portal: true } })).toBe('note')
    const toMail = switchMode(draft({ body: 'Fine for us.', link: NOTE_REPLY }), 'reply', OFFICE_PEOPLE)
    expect(toMail.draft.link).toBeUndefined()
    expect(toMail.draft.body).toBe('Fine for us.')
    expect(toMail.notes).toEqual([{ key: 'switch.quote' }])
    expect(switchMode(draft({ body: 'x', link: NOTE_REPLY }), 'portal', OFFICE_PEOPLE).draft.link).toBeUndefined()
    // Back to an office note, or a quote of a shared message: the quote stays.
    expect(switchMode(draft({ mode: 'reply', body: 'x', link: NOTE_REPLY }), 'note', OFFICE_PEOPLE).draft.link).toEqual(NOTE_REPLY)
    expect(switchMode(draft({ body: 'x', link: SHARED_REPLY }), 'reply', OFFICE_PEOPLE).draft.link).toEqual(SHARED_REPLY)
    for (const locale of ['en', 'it'] as const) {
      const said = textOf(render(createElement(Composer, { context: ORDER, draft: draft({ mode: 'reply', body: 'x' }), notes: [{ key: 'switch.quote' }], onDraft: () => undefined, onSend: () => undefined }), locale))
      expect(said).toContain(locale === 'en' ? "An office note's quote never goes to the customer: taken off." : "La citazione di una nota d'ufficio non va mai al cliente: tolta.")
    }
  })
})
// ---- end tw- W1.4

// ---- tw- W2.3 (THE THREAD REBUILD; 10-design §10, S9; P0-B2, D5, Z3, P6): the composer in one row ----------------------------------
import { enterSends, withoutLink } from './model'
import { ClipMenu } from '../attachments/view/AttachmentTray'

describe('tw- W2.3 — the composer is ONE row at rest: + · the audience chip · the box · the Send arrow', () => {
  const PORTAL: ComposerContext = { ...ORDER, portal: true }
  const HELD = heldForNamesOther(draft({ mode: 'portal', body: 'Same trims as last season.' }))
  const REPLY = { kind: 'reply' as const, messageId: 'm-1', who: 'Anna Alfieri', at: '2026-11-17T09:41:00.000Z' }
  const words = (locale: 'en' | 'it') => translatorFor(locale, wordsFor(locale, ['record-thread-composer'])['record-thread-composer']!)
  it('at rest (Office note): one row, no chips row, no bar, no sentence under the box, no 3-way switch, no mark line', () => {
    const html = composer(ORDER, draft())
    expect(html.match(/class="fw-rt-cx-row"/g)?.length).toBe(1)
    for (const gone of ['fw-rt-cx-chips', 'fw-rt-cx-bar', 'nds-seg', 'radiogroup', 'fw-rt-cx-mark', 'fw-rt-cx-foot']) expect(html, gone).not.toContain(gone)
    const row = html.slice(html.indexOf('class="fw-rt-cx-row"'))
    expect(row.indexOf('fw-rt-cx-chipbtn')).toBeLessThan(row.indexOf('fw-rt-cx-box'))
    expect(row.indexOf('fw-rt-cx-box')).toBeLessThan(row.indexOf('fw-rt-cx-send'))
    expect(html).toContain('placeholder="Write a message"')
    expect(composer(ORDER, draft(), 'it')).toContain('placeholder="Scrivi un messaggio"')
  })

  it('the chip is ONE menu of radio rows with today’s words — Office note · Reply to X by email · In X’s portal', () => {
    const source = readFileSync(new URL('./view/Composer.tsx', import.meta.url), 'utf8')
    expect(source).toContain("label: mode === 'note' ? t('mode.note') : t(mode === 'portal' ? 'modeMenu.portal' : 'modeMenu.reply', { party })")
    expect(source).toContain('checked: mode === draft.mode')
    for (const locale of ['en', 'it'] as const) {
      const t = words(locale)
      expect(t('modeMenu.reply', { party: 'Brand Alpha' })).toBe(locale === 'en' ? 'Reply to Brand Alpha by email' : 'Rispondi a Brand Alpha via email')
      expect(t('modeMenu.portal', { party: 'Brand Alpha' })).toBe(locale === 'en' ? 'In Brand Alpha’s portal' : 'Nel portale di Brand Alpha')
    }
  })

  it('the "+" holds the files’ rows then Saved replies · Amount · For the floor; a row without its right says why, nothing else', () => {
    const html = render(createElement(ClipMenu, { canUpload: true, canPick: true, onFiles: () => undefined, onPick: () => undefined, more: [{ id: 'amount', label: 'Amount' }] }))
    expect(html).toContain('aria-label="Add files"')
    expect(html).toContain('lucide-plus')
    const tray = readFileSync(new URL('../attachments/view/AttachmentTray.tsx', import.meta.url), 'utf8')
    expect(tray).not.toContain("t('clip.photoHint')")
    expect(tray).not.toContain("t('clip.sheetHint')")
    expect(tray).toContain("...(more.length > 0 ? [{ id: 'more-sep', separator: true }, ...more] : [])")
  })

  it('a chips row only when a chip is on: Follow up on a message to the customer, the Amount, For the floor, About', () => {
    // tw- fx2 (G-13): in a customer mode the audience chip leads the chips row, in words; then Follow up.
    const reply = render(createElement(Composer, { context: ORDER, draft: draft({ mode: 'reply', body: 'x' }), followUp: createElement('b', null, 'FOLLOW'), onDraft: () => undefined, onSend: () => undefined }))
    const chipsRow = reply.slice(reply.indexOf('<div class="fw-rt-cx-chips">'), reply.indexOf('class="fw-rt-cx-row"'))
    expect(chipsRow).toContain('fw-rt-cx-chipbtn')
    expect(chipsRow.indexOf('fw-rt-cx-chipbtn')).toBeLessThan(chipsRow.indexOf('<b>FOLLOW</b>'))
    expect(reply.slice(reply.indexOf('class="fw-rt-cx-row"'))).not.toContain('fw-rt-cx-chipbtn')
    expect(render(createElement(Composer, { context: ORDER, draft: draft({ body: 'x' }), followUp: createElement('b', null, 'FOLLOW'), onDraft: () => undefined, onSend: () => undefined }))).not.toContain('FOLLOW')
  })

  it('D5 / Z3: Enter sends in one thread, Shift+Enter is a new line; Reply to N never sends on Enter (⌘/Ctrl+Enter there)', () => {
    expect(enterSends(ORDER)).toBe(true)
    expect(enterSends({ ...ORDER, many: true })).toBe(false)
    const source = readFileSync(new URL('./view/Composer.tsx', import.meta.url), 'utf8')
    expect(source).toContain("if (event.key === 'Enter' && !event.shiftKey && !event.altKey && (enterSends(context) || event.metaKey || event.ctrlKey)) {")
    expect(source).toContain('if (event.nativeEvent.isComposing) return')
    // The @ list takes its own Enter first (it inserts the colleague; the message does not go).
    const mention = readFileSync(new URL('../helpers/view/MentionInput.tsx', import.meta.url), 'utf8')
    expect(mention.indexOf("if ((event.key === 'Enter' || event.key === 'Tab')")).toBeLessThan(mention.indexOf('onKeyDown?.(event)'))
  })

  it('P0-B2: ONE height rule for the box, owned by composer.css — one line at rest, never 0 px, about 8 lines at most', () => {
    const css = readFileSync(new URL('./composer.css', import.meta.url), 'utf8')
    // tw- fx1: stronger than the DS's `.nds-textarea { min-height: 168px }` (the real page drew ~170 px), the wrapper the flex item.
    // tw- fx2 (walk G-19): the box as drawn — text 15 / 22, the box 40 at rest (the text 30 + its padding), about 8 lines at most.
    expect(css).toMatch(/\.fw-rt-composer \.fw-rt-cx-box textarea\.fw-rt-cx-text \{[^}]*min-height: 30px;[^}]*max-height: calc\(8 \* 22px \+ 8px\);[^}]*font-size: var\(--nds-font-size-md\);[^}]*line-height: 22px;/)
    expect(css).toMatch(/\.fw-rt-composer \.fw-rt-cx-box \{\s*min-height: 40px;/)
    expect(css).toMatch(/\.fw-rt-composer \.fw-rt-cx-row > \.fw-rt-clip \.nds-btn,\s*\.fw-rt-composer \.fw-rt-cx-row > \.fw-rt-clip-menu > \.nds-btn \{\s*width: 40px;\s*height: 40px;\s*border: 1px solid var\(--nds-border\);\s*border-radius: var\(--nds-radius-pill\);/)
    expect(css).toMatch(/\.fw-rt-composer \.fw-rt-cx-send\.nds-btn \{\s*height: 40px;\s*min-width: 40px;/)
    expect(css).toMatch(/\.fw-rt-composer \.fw-rt-cx-send\.nds-btn\[aria-disabled='true'\],\s*\.fw-rt-composer \.fw-rt-cx-send\.nds-btn:disabled \{[^}]*background: var\(--nds-surface-sunken\);[^}]*color: var\(--nds-text-muted\);/)
    expect(css).toMatch(/\.fw-rt-cx-box > \.fw-rtm \{\s*flex: 1 1 160px;\s*min-width: 0;/)
    expect(css).not.toMatch(/^\.fw-rt-cx-box \.fw-rt-cx-text \{/m)
    const source = readFileSync(new URL('./view/Composer.tsx', import.meta.url), 'utf8')
    expect(source).not.toContain('honourRows')
    expect(source).toContain('rows={1}')
    expect(source).toContain("area.style.removeProperty('height')")
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|color-mix/i)
  })

  it('ONE bar above the box: a hold before the reply, the reply before a switch note; never two', () => {
    const both = composer(PORTAL, { ...HELD, link: REPLY })
    expect(both.match(/fw-rt-cx-bar/g)?.length).toBe(1)
    expect(both).toContain('fw-rt-cx-bar is-held fw-rt-cx-tick')
    const withNotes = render(createElement(Composer, { context: ORDER, draft: draft({ mode: 'reply', link: REPLY }), notes: [{ key: 'switch.about' }], onDraft: () => undefined, onSend: () => undefined }))
    expect(withNotes.match(/class="fw-rt-cx-bar/g)?.length).toBe(1)
    expect(withNotes).toContain('fw-rt-cx-bar is-link')
  })

  it('the words: no key on screen in it and en; the gone words are gone from the catalogue', () => {
    for (const locale of ['en', 'it'] as const) {
      const t = words(locale)
      for (const key of ['mark.note', 'mark.reply', 'mark.portal', 'placeholder.note', 'portal.line', 'floor.off']) expect(t(key), `${locale} ${key}`).toBe(key)
      expect(t('placeholder')).not.toBe('placeholder')
      expect(t('mode.portal')).toBe(locale === 'en' ? 'In the portal' : 'Nel portale')
    }
  })
})
// ---- end tw- W2.3

// ---- tw- fx2 (the walk: G-12, G-13, G-14, G-24) --------------------------------------------------------------------------------------
describe('tw- fx2 — the composer after the walk', () => {
  const REPLY_LINK = { kind: 'reply' as const, messageId: 'm-1', who: 'Bea Esempio', at: '2026-11-17T09:41:00.000Z', before: 'note' as const }
  it('G-24: × on a reply bar puts the audience back to what it was before Reply; G-12: Esc drops the bar first and keeps the box', () => {
    // × after Reply on an office note that took the box to the portal: back to the office note, the bar gone.
    const back = withoutLink(draft({ mode: 'portal', body: 'Thanks', link: REPLY_LINK }), ['note', 'reply', 'portal'], OFFICE_PEOPLE)
    expect(back.draft.mode).toBe('note')
    expect(back.draft.link).toBeUndefined()
    expect(back.draft.body).toBe('Thanks')
    // The audience it had is no longer offered, or there was none: the bar goes, the audience stays, the notes too.
    expect(withoutLink(draft({ mode: 'portal', link: REPLY_LINK }), ['portal'], OFFICE_PEOPLE)).toEqual({ draft: draft({ mode: 'portal' }), notes: null })
    expect(withoutLink(draft({ mode: 'reply', link: { ...REPLY_LINK, before: 'reply' } }), ['note', 'reply'], OFFICE_PEOPLE)).toEqual({ draft: draft({ mode: 'reply' }), notes: null })
    // A correction's × keeps its audience (it was the corrected message's own).
    expect(withoutLink(draft({ mode: 'reply', link: { kind: 'correct', messageId: 'm-2', who: null, at: '2026-11-17T09:41:00.000Z', way: 'reply' } }), ['note', 'reply'], OFFICE_PEOPLE).draft.mode).toBe('reply')
    const source = readFileSync(new URL('./view/Composer.tsx', import.meta.url), 'utf8')
    expect(source).toContain('const next = withoutLink(draft, modes, context.people)')
    expect(source).toContain('if (link) dropLink()')
    const container = readFileSync(new URL('../../../areas/_shared/record-thread/use-record-thread.ts', import.meta.url), 'utf8')
    expect(container).toContain("before: workRef.current.draft.link?.kind === 'reply' ? (workRef.current.draft.link.before ?? workRef.current.draft.mode) : workRef.current.draft.mode")
    let drafted: ComposerDraft | null = null
    const html = render(createElement(Composer, { context: { ...ORDER, portal: true }, draft: draft({ mode: 'portal', link: REPLY_LINK }), onDraft: (next) => (drafted = next), onSend: () => undefined }))
    expect(html).toContain('aria-label="Not a reply to that message any more"')
    expect(drafted).toBeNull()
  })

  it('G-13: under 420 px the audience chip takes its own row in words (no icon-only chip)', () => {
    const css = readFileSync(new URL('./composer.css', import.meta.url), 'utf8')
    expect(css).toMatch(/@container fw-rtcol \(max-width: 420px\) \{\s*\.fw-rt-cx-row:has\(> \.fw-rt-cx-aud, > \.fw-rt-cx-chipbtn\) \{\s*display: grid;[^}]*grid-template-areas: 'chip chip chip' 'plus box send';/)
    // With a chip on (here the amount), the audience chip leads the chips row at every width.
    const amounted = render(createElement(Composer, { context: { ...ORDER, can: { ...ORDER.can, price: true } }, draft: draft({ mode: 'note', amount: '180.00', currency: 'EUR' }), onDraft: () => undefined, onSend: () => undefined }))
    const row = amounted.slice(amounted.indexOf('<div class="fw-rt-cx-chips">'), amounted.indexOf('class="fw-rt-cx-row"'))
    expect(row).toContain('fw-rt-cx-chipbtn')
    expect(css).not.toMatch(/\.fw-rt-cx-aud-word \{\s*display: none;/)
  })

  it('G-14: the "+" says Document · Photos · (Measurement sheet…) · From this record, then the composer’s own rows', () => {
    for (const [locale, words] of [['en', ['Document', 'Photos', 'From this record']], ['it', ['Documento', 'Foto', 'Da questo record']]] as const) {
      const attach = translatorFor(locale, wordsFor(locale, ['record-thread-attach'])['record-thread-attach']!)
      expect([attach('clip.device'), attach('clip.photo'), attach('clip.record')]).toEqual(words)
      expect(attach('clip.sheet')).toMatch(/…$/)
    }
  })
})
// ---- end tw- fx2
