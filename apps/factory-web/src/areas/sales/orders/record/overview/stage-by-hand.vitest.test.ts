import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { STAGE_SET_REFUSAL_WORDS, floorAlreadyWords } from '@nexus/factory-domain/production-brand/stage-set'
import { HAND_STAGE_NOTICE_DELAY_MS } from '@nexus/factory-domain/production-brand/stage-set' // B-MS-008
import { ApiError } from '../../../../../lib/api/errors'
import type { ApiClient } from '../../../../../lib/api/client'
import { LOCALES } from '../../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../../lib/i18n/messages'
import { render, textOf } from '../../../../../lib/record-thread/parts/testing'
import { order } from '../../_demo/fixtures'
import type { Order } from '../../api'
import { designScreen } from '../fixtures'
import type { OrderRecordModel, RecordActsBase, RecordDialog } from '../record-model'
import { useOverviewActs } from '../use-overview-acts'
import { StageHandDialogs } from '../view/overview/StageByHandDialog'
import type { BrandStage, Headline } from './api'
import { HAND_AT, HAND_BY, HAND_FREE_READ, HAND_READ, HEADLINE, ready } from './fixtures'
import { NOTICE_WAIT_MINUTES, clearLinesOf, clearNoticeOf, setNoticeOf, stageByHandBodyOf, stageByHandHeld, stageByHandStartOf, stageChoicesOf, stageDialogLinesOf, stageRefusalOf, versionOf } from './stage-by-hand'

// The DS Modal draws only after it mounts in a browser — here a plain section, so the dialog's words are read on the server too (as the
// credit dialogs' tests do in where.vitest). Only an open dialog draws.
vi.mock('@nexus/ui/components', async (original) => {
  const actual = await original<typeof import('@nexus/ui/components')>()
  const Modal = ({ open, title, children, footer }: { open: boolean; title?: unknown; children?: unknown; footer?: unknown }) => (open ? createElement('section', { role: 'dialog', 'data-modal': '' }, createElement('h2', null, title as never), children as never, footer as never) : null)
  return { ...actual, Modal }
})

/**
 * F-MS-103 (set the stage by hand, 04 §3; review R3b, R8, R9, R18, R20; Owner D4, D9) — the ONE dialog's rules (the stages it offers, why
 * Go waits, the request it sends, the lines it says), Clear…'s lines, the refusals and notices in words, the hook's two writes through
 * the page's one write (a fake API), and the dialog drawn in both languages.
 */

type HandStage = NonNullable<Headline['stage']>['byHand']
const at = (code: BrandStage, byHand: HandStage = null, version: number | null | undefined = 3): Headline => ({ ...HEADLINE, stage: { ...HEADLINE.stage!, code, byHand, version } })
const choices = (floor: BrandStage, hand: BrandStage | null) => stageChoicesOf(floor, hand).map((row) => `${row.stage}:${row.choice}${row.disabled ? '×' : ''}`)

describe('F-MS-103: the stages the dialog offers — the domain\'s handStageChoicesOf, in the dialog\'s words', () => {
  it('for each floor stage, nothing set: Done and Now from the floor\'s counts (never picked), the stages ahead open, Ready never', () => {
    expect(choices('PREPARING', null)).toEqual(['PREPARING:NOW×', 'CUTTING:OPEN', 'SEWING:OPEN', 'QUALITY:OPEN', 'READY:READY_HELD×'])
    expect(choices('CUTTING', null)).toEqual(['PREPARING:DONE×', 'CUTTING:NOW×', 'SEWING:OPEN', 'QUALITY:OPEN', 'READY:READY_HELD×'])
    expect(choices('SEWING', null)).toEqual(['PREPARING:DONE×', 'CUTTING:DONE×', 'SEWING:NOW×', 'QUALITY:OPEN', 'READY:READY_HELD×'])
    expect(choices('QUALITY', null)).toEqual(['PREPARING:DONE×', 'CUTTING:DONE×', 'SEWING:DONE×', 'QUALITY:NOW×', 'READY:READY_HELD×'])
    const rows = stageChoicesOf('CUTTING', null)
    expect(rows.map((row) => row.note)).toEqual([{ key: 'where.manual.rowDone' }, { key: 'where.manual.rowNow' }, null, null, STAGE_SET_REFUSAL_WORDS.NEVER_READY])
  })

  it('with a hand stage standing: the stage set (pickable), a lower one still above the floor open (D9); the floor\'s own rows held', () => {
    expect(choices('PREPARING', 'SEWING')).toEqual(['PREPARING:NOW×', 'CUTTING:OPEN', 'SEWING:SET', 'QUALITY:OPEN', 'READY:READY_HELD×'])
    expect(choices('CUTTING', 'QUALITY')).toEqual(['PREPARING:DONE×', 'CUTTING:NOW×', 'SEWING:OPEN', 'QUALITY:SET', 'READY:READY_HELD×'])
    expect(stageChoicesOf('PREPARING', 'SEWING')[2]!.note).toEqual({ key: 'where.manual.rowSet' })
  })

  it('what it opens on: Set — nothing picked, no reason; Change… — the stage, reason and note set; a hand stage gone meanwhile — a Set', () => {
    expect(stageByHandStartOf('set', HAND_FREE_READ.headline)).toMatchObject({ changing: false, floor: 'SEWING', hand: null, pick: null, reasonCode: '', note: '' })
    expect(stageByHandStartOf('change', HAND_READ.headline)).toMatchObject({ changing: true, floor: 'PREPARING', hand: 'SEWING', pick: 'SEWING', reasonCode: 'OUTAGE', note: HAND_BY.note })
    expect(stageByHandStartOf('change', HAND_FREE_READ.headline)).toMatchObject({ changing: false, hand: null, pick: null })
    // The floor of a standing hand stage is the API's live one (byHand.floor), never the shown stage; not known: Preparing (the API judges).
    expect(stageByHandStartOf('set', at('SEWING', { ...HAND_BY, floor: null })).floor).toBe('PREPARING')
    // An unknown reason code is not pre-filled (the person picks one of the four).
    expect(stageByHandStartOf('change', at('SEWING', { ...HAND_BY, reasonCode: 'NOT_A_CODE' })).reasonCode).toBe('')
  })
})

describe('F-MS-103: why Go waits, and the request it sends', () => {
  const rows = stageChoicesOf('PREPARING', null)
  const ask = (over: Partial<{ stage: 'CUTTING' | 'SEWING' | 'QUALITY' | 'PREPARING' | 'READY' | null; reasonCode: string; note: string; busy: boolean }> = {}) => stageByHandHeld({ rows, stage: 'SEWING', reasonCode: 'OUTAGE', note: '', busy: false, ...over })

  it('held: a write running, no stage, a stage the floor did or Ready, no reason, "Something else" without a note, two lines, 201 characters', () => {
    expect(ask({ busy: true })).toEqual({ key: 'held.busy' })
    expect(ask({ stage: null })).toEqual({ key: 'where.manual.held.stage' })
    expect(ask({ stage: 'PREPARING' })).toEqual({ key: 'where.manual.held.stage' })
    expect(ask({ stage: 'READY' })).toEqual({ key: 'where.manual.held.stage' })
    expect(ask({ reasonCode: '' })).toEqual({ key: 'raise.held.pick', ns: 'production' })
    expect(ask({ reasonCode: 'NOT_A_CODE' })).toEqual({ key: 'raise.held.pick', ns: 'production' })
    expect(ask({ reasonCode: 'OTHER' })).toEqual(STAGE_SET_REFUSAL_WORDS.NOTE_NEEDED)
    expect(ask({ reasonCode: 'OTHER', note: '   ' })).toEqual(STAGE_SET_REFUSAL_WORDS.NOTE_NEEDED)
    expect(ask({ note: 'one\ntwo' })).toEqual(STAGE_SET_REFUSAL_WORDS.NOTE_TOO_LONG)
    expect(ask({ note: 'x'.repeat(201) })).toEqual(STAGE_SET_REFUSAL_WORDS.NOTE_TOO_LONG)
    // It may go: any of the four reasons, the note optional except "Something else"; 200 characters with spaces around it.
    for (const reasonCode of ['OUTAGE', 'FEW_PEOPLE', 'OUTSIDE']) expect(ask({ reasonCode }), reasonCode).toBeNull()
    expect(ask({ reasonCode: 'OTHER', note: 'Lavoro registrato su carta.' })).toBeNull()
    expect(ask({ note: `  ${'x'.repeat(200)}  ` })).toBeNull()
    // Busy speaks first, whatever was typed.
    expect(ask({ busy: true, stage: null, reasonCode: '' })).toEqual({ key: 'held.busy' })
  })

  it('the body: the stage, the reason, the note only when typed (trimmed), the headline\'s production version — null only without a row', () => {
    expect(stageByHandBodyOf({ stage: 'SEWING', reasonCode: 'OUTAGE', note: '' }, HAND_FREE_READ.headline)).toEqual({ stage: 'SEWING', reasonCode: 'OUTAGE', version: 3 })
    expect(stageByHandBodyOf({ stage: 'CUTTING', reasonCode: 'OTHER', note: '  Lavoro registrato su carta.  ' }, HAND_READ.headline)).toEqual({ stage: 'CUTTING', reasonCode: 'OTHER', note: 'Lavoro registrato su carta.', version: 4 })
    // No row yet (SEED-SO-W39-02): null, a key always sent; an older answer without the field: null too.
    expect(stageByHandBodyOf({ stage: 'CUTTING', reasonCode: 'FEW_PEOPLE', note: '' }, at('PREPARING', null, null))).toEqual({ stage: 'CUTTING', reasonCode: 'FEW_PEOPLE', version: null })
    expect(versionOf(HEADLINE)).toBeNull()
    expect(versionOf(null)).toBeNull()
    expect('version' in stageByHandBodyOf({ stage: 'CUTTING', reasonCode: 'FEW_PEOPLE', note: '' }, null)).toBe(true)
  })
})

describe('F-MS-103: the lines the dialogs say — R3b and R18 always, never an urgent line (R8); Clear… inside and after the window', () => {
  it('always: the customer reads a plain stage, the 10-minute window (R3b), the customer\'s changes on the floor\'s records (R18)', () => {
    const keys = (hand: BrandStage | null, pick: BrandStage | null) => stageDialogLinesOf({ hand, pick }).map((line) => line.key)
    expect(keys(null, null)).toEqual(['where.manual.customer', 'where.manual.told', 'where.manual.cuts'])
    expect(keys(null, 'SEWING')).toEqual(['where.manual.customer', 'where.manual.told', 'where.manual.cuts', 'where.manual.clears'])
    // A Change: lower (still above the floor) — going back, not told (D9); the same stage — not told again; higher — told.
    expect(keys('SEWING', 'CUTTING')).toEqual(['where.manual.customer', 'where.manual.told', 'where.manual.back', 'where.manual.cuts', 'where.manual.clears'])
    expect(keys('SEWING', 'SEWING')).toEqual(['where.manual.customer', 'where.manual.told', 'where.manual.same', 'where.manual.cuts', 'where.manual.clears'])
    expect(keys('SEWING', 'QUALITY')).toEqual(['where.manual.customer', 'where.manual.told', 'where.manual.cuts', 'where.manual.clears'])
    expect(stageDialogLinesOf({ hand: null, pick: null })[1]).toEqual({ key: 'where.manual.told', minutes: NOTICE_WAIT_MINUTES })
    expect(NOTICE_WAIT_MINUTES).toBe(10)
    // What the customer reads is named in the customer's own words (the portal's: Cucitura), a stage of the office in the office's.
    expect(stageDialogLinesOf({ hand: 'SEWING', pick: 'CUTTING' }).find((line) => line.key === 'where.manual.back')).toEqual({ key: 'where.manual.back', customer: { it: 'Taglio', en: 'Cutting' } })
    expect(stageDialogLinesOf({ hand: null, pick: 'SEWING' }).at(-1)).toEqual({ key: 'where.manual.clears', stage: 'SEWING' })
    // No line about Mark urgent, in any case (R8: the customer's own urgent mark keeps reading the real cuts).
    for (const hand of [null, 'CUTTING', 'SEWING'] as const) for (const pick of [null, 'CUTTING', 'SEWING', 'QUALITY'] as const) expect(JSON.stringify(stageDialogLinesOf({ hand, pick }))).not.toMatch(/urgent/i)
  })

  it('Clear…: inside the 10-minute window not told yet and never now; after it told and not told again; then the floor\'s stage, with no notice', () => {
    const set = Date.parse(HAND_AT)
    expect(clearLinesOf(HAND_READ.headline, set + 9 * 60_000)).toEqual([
      { key: 'where.manual.clearUntold', customer: { it: 'Cucitura', en: 'Sewing' }, minutes: 10 },
      { key: 'where.manual.clearFloor', customer: { it: 'In preparazione', en: 'Preparing' } },
    ])
    expect(clearLinesOf(HAND_READ.headline, set + 10 * 60_000)).toEqual([
      { key: 'where.manual.clearTold', customer: { it: 'Cucitura', en: 'Sewing' } },
      { key: 'where.manual.clearFloor', customer: { it: 'In preparazione', en: 'Preparing' } },
    ])
    expect(clearLinesOf(at('SEWING', { ...HAND_BY, floor: null }), set + 60 * 60_000)).toEqual([{ key: 'where.manual.clearTold', customer: { it: 'Cucitura', en: 'Sewing' } }])
    expect(clearLinesOf(HAND_FREE_READ.headline, set)).toBeNull()
  })

  it('every word in both languages (office "tu", "la fase" feminine); the hint says never name a person on the floor; no key hint text', () => {
    const keys = ['title', 'changeTitle', 'body', 'pick', 'rowDone', 'rowNow', 'rowSet', 'reason', 'noteHint', 'customer', 'told', 'back', 'same', 'cuts', 'clears', 'go', 'changeGo', 'refused', 'notice', 'cleared', 'clearedPlain', 'clearTitle', 'clearTold', 'clearUntold', 'clearFloor', 'clearGo', 'clearGoPlain', 'held.stage']
    const params = { number: 'SO-1', max: 200, minutes: 10, customer: 'x', stage: 'x', floor: 'x' }
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      for (const key of keys) expect(t(`where.manual.${key}`, params), `${locale} ${key}`).not.toBe(`where.manual.${key}`)
      expect(t('where.manual.noteHint', { max: 200 })).toBe(locale === 'en' ? 'One line, at most 200 characters. Never name a person on the floor.' : 'Una riga, al massimo 200 caratteri. Non nominare chi lavora in reparto.')
      for (const key of keys) expect(t(`where.manual.${key}`, params), `${locale} ${key}`).not.toMatch(/⌘|Ctrl|\bEsc\b|urgent|urgente/i)
    }
    const it = createTranslator('it', messagesFor('it', ['orders']).orders!)
    expect(it('where.manual.told', { minutes: 10 })).toBe("Quando la fase va avanti, il cliente riceve l'avviso dopo 10 minuti: se la togli prima, non lo riceve. Dopo, togliendola non riprendi ciò che il cliente ha letto.")
    expect(it('where.manual.cuts')).toBe('Le modifiche del cliente si valutano sui dati del reparto: registra i tagli appena il reparto può.')
    const en = createTranslator('en', messagesFor('en', ['orders']).orders!)
    expect(en('where.manual.told', { minutes: 10 })).toBe('When the stage moves forward, the customer is told after 10 minutes: clear it before then and it is not told. After that, clearing it does not take back what the customer read.')
    expect(en('where.manual.cuts')).toBe("The customer's changes are judged on the floor's records: key the cuts in as soon as the floor can.")
  })
})

describe('F-MS-103: refusals and notices in the page\'s words', () => {
  const refusal = (kind: 'conflict' | 'invalid' | 'forbidden' | 'not_found', message: string, path = 'body/stage') => new ApiError(kind, kind === 'conflict' ? 409 : kind === 'invalid' ? 400 : kind === 'forbidden' ? 403 : 404, kind, message, null, [{ path, message }])

  it('the domain\'s own words when the API answers them; the floor already there; any other conflict: changed meanwhile; the right; not found', () => {
    expect(stageRefusalOf(refusal('conflict', STAGE_SET_REFUSAL_WORDS.PAUSED.en))).toEqual(STAGE_SET_REFUSAL_WORDS.PAUSED)
    expect(stageRefusalOf(refusal('conflict', STAGE_SET_REFUSAL_WORDS.NOT_STARTED.en))).toEqual(STAGE_SET_REFUSAL_WORDS.NOT_STARTED)
    expect(stageRefusalOf(refusal('invalid', STAGE_SET_REFUSAL_WORDS.NOTE_NEEDED.en, 'body/note'))).toEqual(STAGE_SET_REFUSAL_WORDS.NOTE_NEEDED)
    expect(stageRefusalOf(refusal('conflict', floorAlreadyWords('SEWING').en))).toEqual(floorAlreadyWords('SEWING'))
    expect(stageRefusalOf(refusal('conflict', 'Changed by someone else.', 'version'))).toEqual({ key: 'where.manual.refused' })
    expect(stageRefusalOf(refusal('conflict', 'No stage set by hand to clear.'))).toEqual({ key: 'where.manual.refused' })
    expect(stageRefusalOf(refusal('forbidden', 'Forbidden.'))).toEqual({ key: 'wo.heldHold' })
    // Another customer's order reads as an unknown one (the API's wall): the page's own words, never a hint.
    expect(stageRefusalOf(refusal('not_found', 'Sales order not found.'))).toEqual({ key: 'problem.write.not_found' })
    expect(stageRefusalOf(new Error('boom'))).toEqual({ key: 'problem.write.internal' })
  })

  it('the notices: the office\'s word of the stage and the customer\'s own; back to the floor\'s stage', () => {
    expect(setNoticeOf('SEWING', 'en')).toEqual({ key: 'where.manual.notice', params: { stage: 'Sewing', customer: 'Sewing' } })
    expect(setNoticeOf('SEWING', 'it')).toEqual({ key: 'where.manual.notice', params: { stage: 'Confezione', customer: 'Cucitura' } })
    expect(clearNoticeOf('PREPARING', 'it')).toEqual({ key: 'where.manual.cleared', params: { floor: 'In preparazione' } })
    expect(clearNoticeOf(null, 'en')).toEqual({ key: 'where.manual.clearedPlain' })
    const it = createTranslator('it', messagesFor('it', ['orders']).orders!)
    expect(it('where.manual.notice', setNoticeOf('SEWING', 'it').params)).toBe('Fase Confezione impostata a mano: il cliente legge Cucitura.')
    const en = createTranslator('en', messagesFor('en', ['orders']).orders!)
    expect(en('where.manual.cleared', clearNoticeOf('PREPARING', 'en').params)).toBe("Back to the floor's stage: Preparing.")
  })
})

describe('F-MS-103: the hook — Set, Change and Clear through the page\'s one write (a fake API)', () => {
  const value: Order = order('IN_PRODUCTION')
  const run = async (headline: Headline, act: (acts: NonNullable<ReturnType<typeof useOverviewActs>['actions']['stageHand']>) => void, answer: () => Promise<unknown>, permissions: readonly string[] = ['production.brand.manage']) => {
    const calls: { method: string; path: string; body?: unknown; query?: unknown; key?: unknown }[] = []
    const dialogs: (RecordDialog | null)[] = []
    const notices: unknown[] = []
    const writes: { success: unknown; keep: unknown }[] = []
    const rereads: string[] = []
    const api = {
      request: (method: string, path: string, options: { body?: unknown; query?: unknown; idempotencyKey?: unknown }) => (calls.push({ method, path, body: options.body, query: options.query, key: options.idempotencyKey }), answer()),
    } as unknown as ApiClient
    const base = {
      api,
      orderId: value.id,
      current: { current: value },
      version: () => value.version,
      setNotice: (notice: unknown) => notices.push(notice),
      load: async () => undefined,
      loadParts: () => undefined,
      write: async (task: () => Promise<Order | null>, success: string | null, keep?: boolean) => {
        writes.push({ success, keep })
        await task()
      },
    } as unknown as RecordActsBase
    let acts: ReturnType<typeof useOverviewActs>['actions']['stageHand']
    let model: OrderRecordModel['stageHand']
    function Harness() {
      const result = useOverviewActs({ setDialog: (dialog) => dialogs.push(dialog), base, stage: { permissions, production: ready({ ...HAND_FREE_READ, headline }), reread: () => rereads.push('headline') } })
      acts = result.actions.stageHand
      model = result.model.stageHand
      return null
    }
    render(createElement(Harness), 'en')
    act(acts!)
    await new Promise((resolve) => setTimeout(resolve, 0))
    return { calls, dialogs, notices, writes, rereads, model }
  }
  const answered = async () => ({ orderId: value.id, floor: 'PREPARING', stage: 'SEWING', byHand: { stage: 'SEWING', reasonCode: 'OUTAGE', note: null, setAt: HAND_AT, setBy: { id: 'u-1', name: 'Bea Esempio' } }, version: 5 })

  it('Set: PUT …/stage with the stage, reason, the note only when typed, the version as read, a fresh key; the dialog closes, the notice says it', async () => {
    const out = await run(HAND_FREE_READ.headline!, (acts) => acts.onSet?.({ mode: 'set', stage: 'SEWING', reasonCode: 'OUTAGE', note: '  ' }), answered)
    expect(out.calls).toEqual([{ method: 'PUT', path: `/production/brand-orders/${value.id}/stage`, body: { stage: 'SEWING', reasonCode: 'OUTAGE', version: 3 }, query: undefined, key: expect.any(String) }])
    expect(out.writes).toEqual([{ success: null, keep: true }])
    expect(out.dialogs).toEqual([{ kind: 'stageByHand', mode: 'set' }, null])
    expect(out.notices).toEqual([{ tone: 'success', words: { key: 'where.manual.notice', params: { stage: 'Sewing', customer: 'Sewing' } } }])
    expect(out.rereads).toEqual(['headline'])
    expect(out.model).toEqual({ can: true })
  })

  it('no row yet (as SEED-SO-W39-02): version null is sent, never left out; a typed note goes trimmed', async () => {
    const out = await run(at('PREPARING', null, null), (acts) => acts.onSet?.({ mode: 'set', stage: 'CUTTING', reasonCode: 'OTHER', note: ' Registrato su carta. ' }), answered)
    expect(out.calls[0]!.body).toEqual({ stage: 'CUTTING', reasonCode: 'OTHER', note: 'Registrato su carta.', version: null })
  })

  it('a 409: the dialog stays with "The stage changed meanwhile" (what was typed is the dialog\'s own), the headline is read again', async () => {
    const out = await run(HAND_READ.headline!, (acts) => acts.onSet?.({ mode: 'change', stage: 'CUTTING', reasonCode: 'OUTAGE', note: '' }), () => Promise.reject(new ApiError('conflict', 409, 'conflict', 'Changed by someone else.', null, [{ path: 'version', message: 'Changed by someone else.' }])))
    expect(out.calls[0]!.body).toEqual({ stage: 'CUTTING', reasonCode: 'OUTAGE', version: 4 })
    expect(out.dialogs).toEqual([{ kind: 'stageByHand', mode: 'change' }, { kind: 'stageByHand', mode: 'change', refused: { key: 'where.manual.refused' } }])
    expect(out.notices).toEqual([])
    expect(out.rereads).toEqual(['headline'])
  })

  it('Clear: DELETE …/stage?version=, the notice names the floor\'s stage the API answers; without the right the door is held (model)', async () => {
    const out = await run(HAND_READ.headline!, (acts) => acts.onClear?.(), async () => ({ orderId: value.id, floor: 'PREPARING', stage: 'PREPARING', byHand: null, version: 5 }))
    expect(out.calls).toEqual([{ method: 'DELETE', path: `/production/brand-orders/${value.id}/stage`, body: undefined, query: { version: 4 }, key: expect.any(String) }])
    expect(out.dialogs).toEqual([{ kind: 'stageClear' }, null])
    expect(out.notices).toEqual([{ tone: 'success', words: { key: 'where.manual.cleared', params: { floor: 'Preparing' } } }])
    const sales = await run(HAND_READ.headline!, () => undefined, answered, ['orders.view', 'orders.manage'])
    expect(sales.model).toEqual({ can: false })
    expect(sales.calls).toEqual([])
  })
})

describe('F-MS-103: the dialog drawn — the stages held with their words, Change… pre-picked, the lines, Go held in words', () => {
  const recordOf = (id: string): OrderRecordModel => (designScreen.cases.find((item) => item.id === id)!.model as { record: OrderRecordModel }).record
  const draw = (id: string, locale: 'en' | 'it' = 'en') => {
    const model = recordOf(id)
    return render(createElement(StageHandDialogs, { order: model.order.status === 'ready' ? model.order.value : order('IN_PRODUCTION'), model }), locale)
  }

  it('Set: the floor\'s Sewing and what it did never picked ("from the floor\'s counts"), Ready never; the reason, the note; R3b and R18; Go held', () => {
    const html = draw('f-ms-dialog-set')
    const text = textOf(html)
    for (const words of ['Set the stage of SO-2026-0088 by hand', 'Where the work really is', "Done, from the floor's counts", "Now, from the floor's counts", "Only quality's release of every piece makes it Ready to ship.", 'Reason (office only)', 'Note (office only)', 'One line, at most 200 characters. Never name a person on the floor.', 'The customer reads it as a plain stage', 'the customer is told after 10 minutes', "The customer's changes are judged on the floor's records: key the cuts in as soon as the floor can."]) expect(text, words).toContain(words)
    expect(text).not.toMatch(/urgent/i)
    // Preparing, Cutting (done), Sewing (now) and Ready disabled; Quality check open; nothing picked.
    expect(html.match(/<input type="radio"[^>]*disabled=""/g)?.length).toBe(4)
    expect(html).not.toMatch(/<input type="radio"[^>]*checked=""/)
    // Go waits for a stage, in words; ⌘↵ / Ctrl↵ through its aria-keyshortcuts, never a key hint on screen.
    expect(html).toMatch(/aria-keyshortcuts="Meta\+Enter Control\+Enter"[^>]*aria-disabled="true"[^>]*aria-description="Pick a stage first\."|aria-disabled="true"[^>]*aria-description="Pick a stage first\."[^>]*aria-keyshortcuts="Meta\+Enter Control\+Enter"/)
    expect(text).not.toMatch(/⌘|Ctrl|\bEsc\b/)
    const it = textOf(draw('f-ms-dialog-set', 'it'))
    for (const words of ['Imposta a mano la fase di SO-2026-0088', 'Dove si trova davvero il lavoro', 'Fatta, dai conteggi del reparto', 'Ora, dai conteggi del reparto', 'Motivo (solo ufficio)', 'Nota (solo ufficio)', 'Non nominare chi lavora in reparto.']) expect(it, words).toContain(words)
  })

  it('Change…: the stage set pre-picked with its reason and note; "Something else" without a note holds Go; a refusal is said in the dialog', () => {
    const html = draw('f-ms-dialog-change')
    expect(textOf(html)).toContain('Change the stage set by hand on SO-2026-0088')
    expect(html).toMatch(/<input type="radio"[^>]*value="SEWING"[^>]*checked=""|<input type="radio"[^>]*checked=""[^>]*value="SEWING"/)
    expect(html).toContain('<option value="OUTAGE" selected="">System or scanners down</option>')
    expect(textOf(html)).toContain('Set by hand now')
    expect(textOf(html)).toContain('The customer keeps reading Sewing: it is not told again.')
    expect(draw('f-ms-dialog-other')).toMatch(/aria-disabled="true"[^>]*aria-description="Something else needs a note\."[^>]*>Change the stage</)
    expect(textOf(draw('f-ms-dialog-refused'))).toContain('The stage changed meanwhile: it was read again.')
  })

  it('source: the view fetches nothing (the page\'s one write); the dialog is the page\'s Frame; Clear… the DS ActionConfirm', () => {
    const view = readFileSync(new URL('../view/overview/StageByHandDialog.tsx', import.meta.url), 'utf8')
    expect(view).not.toMatch(/lib\/api\/|fetch\(|use-overview-acts/)
    expect(view).toContain("import { Frame } from '../Dialogs'")
    expect(view).toContain('<ActionConfirm')
    expect(view).toContain('variant="row"')
    const card = readFileSync(new URL('../view/overview/WhereCard.tsx', import.meta.url), 'utf8')
    expect(card).toContain('<StageHandDialogs order={order} model={model} actions={actions} />')
  })
})

// ── B-MS-008 (Owner D4: the 10-minute undo window) ──
describe('B-MS-008: the dialog\'s window is the one the API\'s notice waits — the domain\'s constant, the words unchanged', () => {
  it('10 minutes from HAND_STAGE_NOTICE_DELAY_MS; Clear… reads "not told yet" up to the last millisecond of it', () => {
    expect(NOTICE_WAIT_MINUTES * 60_000).toBe(HAND_STAGE_NOTICE_DELAY_MS)
    const set = Date.parse(HAND_AT)
    expect(clearLinesOf(HAND_READ.headline, set + HAND_STAGE_NOTICE_DELAY_MS - 1)![0]!.key).toBe('where.manual.clearUntold')
    expect(clearLinesOf(HAND_READ.headline, set + HAND_STAGE_NOTICE_DELAY_MS)![0]!.key).toBe('where.manual.clearTold')
    // No copy of the number in the model: it reads the domain's.
    const source = readFileSync(new URL('./stage-by-hand.ts', import.meta.url), 'utf8')
    expect(source).toContain("import { HAND_STAGE_NOTICE_DELAY_MS } from '@nexus/factory-domain/production-brand/stage-set'")
    expect(source).not.toMatch(/NOTICE_WAIT_MINUTES = \d/)
  })
})
// ── end B-MS-008 ──
