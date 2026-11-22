import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { LOCALES } from '../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import { render, textOf } from '../../../../lib/record-thread/parts/testing'
import { askPhotoHeld, floorAskCards, outcomeOf, type FloorAsk } from './model'
import { FilesAskedView } from './view/FilesAskedView'

/**
 * F-OF-204 (order FILES tab W2; 10-design §8; 13-backend B-OF-034) — "Files asked" on the tablet: a card per ask (the step, the work order,
 * the customer's floor code, due and late, the office's words, asked again, asked for an update), "Photo for this ask", offline the camera
 * waits (L8); no worker's name, no "seen". Made-up data only (WO-0041, the customer code SC-01).
 */

const ask = (id: string, over: Partial<FloorAsk> = {}): FloorAsk => ({ askId: id, words: 'Photos of the collar seam, front and back, before pressing', dueOn: '2026-11-20', lateDays: 0, workOrder: { id: 'wo-41', number: 'WO-0041' }, step: { id: 'op-3', seq: 3, name: 'Sewing' }, customer: 'SC-01', askedAgain: null, chasedAt: null, ...over })

describe('F-OF-204: the floor\'s asks — order, holds, outcomes', () => {
  it('the most late first, then the nearest due day; offline the camera waits; a closed ask still posts the photo as a note', () => {
    expect(floorAskCards([ask('a', { dueOn: '2026-11-28' }), ask('b', { lateDays: 2 }), ask('c', { dueOn: '2026-11-24' })]).map((one) => one.askId)).toEqual(['b', 'c', 'a'])
    expect(askPhotoHeld({ online: false, busy: false })).toBe('asked.offline')
    expect(askPhotoHeld({ online: true, busy: true })).toBe('asked.sending')
    expect(askPhotoHeld({ online: true, busy: false })).toBeNull()
    expect([outcomeOf({ ok: true, answered: true }), outcomeOf({ ok: true, answered: false }), outcomeOf({ ok: false })]).toEqual(['sent', 'closed', 'failed'])
  })

  it('the cards in both languages: the step, the work order, the code, late, the office\'s words, asked again, an update asked; no "seen"', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['floor-mywork'])['floor-mywork']!)
      const text = textOf(render(createElement(FilesAskedView, { model: { asks: [ask('a', { lateDays: 2, askedAgain: 'Front only, please', chasedAt: '2026-11-21T08:30:00Z' })], online: true, capture: null, busy: false, outcome: null } }), locale))
      for (const words of [t('asked.title', { count: 1 }), t('asked.forStep', { seq: 3, name: 'Sewing' }), 'WO-0041', t('asked.customer', { code: 'SC-01' }), t('asked.late', { count: 2 }), t('asked.again', { reason: 'Front only, please' }), t('asked.photo')]) expect(text, `${locale}: ${words}`).toContain(words)
      expect(text.toLowerCase()).not.toMatch(/\bseen\b|\bvisto\b/)
      expect(text).not.toMatch(/\basked\.[a-zA-Z]/)
    }
  })

  it('offline: "Photos need the network — the camera waits while offline."; nothing to show (none asked, or the read not there yet): no section', () => {
    const offline = textOf(render(createElement(FilesAskedView, { model: { asks: [ask('a')], online: false, capture: null, busy: false, outcome: null } })))
    expect(offline).toContain('Photos need the network — the camera waits while offline.')
    expect(render(createElement(FilesAskedView, { model: { asks: null, online: true, capture: null, busy: false, outcome: null } }))).toBe('')
    expect(render(createElement(FilesAskedView, { model: { asks: [], online: true, capture: null, busy: false, outcome: null } }))).toBe('')
  })

  it('the code: the photo goes up first, then the note with the ask and the tile ASKED_FILE; My work draws the section on its list; the note tiles know the new tile', () => {
    const api = readFileSync(new URL('./api.ts', import.meta.url), 'utf8')
    expect(api).toContain("body: { clientEventId, tileCode: 'ASKED_FILE', fileIds: [file.value.fileId], askId: ask.askId")
    expect(api).toContain("'/production/floor-notes/asks'")
    const work = readFileSync(new URL('../MyWork.tsx', import.meta.url), 'utf8')
    expect(work).toContain('asked={<FilesAsked /> /* F-OF-204')
    const view = readFileSync(new URL('../view/MyWorkView.tsx', import.meta.url), 'utf8')
    expect(view).toContain("{step.kind === 'list' ? asked /* F-OF-204")
    const note = readFileSync(new URL('../../scans/view/NoteView.tsx', import.meta.url), 'utf8')
    expect(note).toContain("ASKED_FILE: { icon: <Camera />, tone: 'info' },")
    expect(note).toContain('...(TILE_LOOK[tile.code] ?? PLAIN_LOOK)')
  })
})

// ---- T.1 (order FILES tab): the tablet's "Files asked" gallery screen (SCR-089-asked) ----
describe('T.1 — the tablet’s Files asked cases (made up)', () => {
  it('every case draws in both languages: no key, no "seen", no worker’s name; each outcome said', async () => {
    const { designScreen } = await import('./fixtures')
    expect(designScreen.cases.map((item) => item.id)).toEqual(['asked', 'asked-offline', 'asked-sent', 'asked-closed', 'asked-failed'])
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['floor-mywork'])['floor-mywork']!)
      for (const item of designScreen.cases) {
        const text = textOf(render(createElement(FilesAskedView, { model: item.model }), locale))
        expect(text, `${item.id} ${locale}`).not.toMatch(/\basked\.[a-zA-Z]/)
        expect(text.toLowerCase(), item.id).not.toMatch(/\bseen\b|\bvisto\b/)
      }
      const of = (id: string) => textOf(render(createElement(FilesAskedView, { model: designScreen.cases.find((item) => item.id === id)!.model }), locale))
      expect(of('asked')).toContain(t('asked.title', { count: 2 }))
      expect(of('asked-offline')).toContain(t('asked.offline'))
      for (const outcome of ['sent', 'closed', 'failed'] as const) expect(of(`asked-${outcome}`)).toContain(t(`asked.${outcome}`))
    }
  })
})
