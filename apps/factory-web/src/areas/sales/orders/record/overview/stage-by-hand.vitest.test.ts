import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { READY_UNRELEASED_WORDS, STAGE_SET_REFUSAL_WORDS, floorStageWords, sameStageWords } from '@nexus/factory-domain/production-brand/stage-set'
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
import { HAND_AT, HAND_BACK_READ, HAND_BY, HAND_FREE_READ, HAND_READ, HEADLINE, ready } from './fixtures'
import { NOTICE_WAIT_MINUTES, clearLinesOf, clearNoticeOf, readyWarningOf, setNoticeOf, stageByHandBodyOf, stageByHandHeld, stageByHandStartOf, stageChoicesOf, stageDialogLinesOf, stageRefusalOf, versionOf } from './stage-by-hand'

// The DS Modal draws only after it mounts in a browser — here a plain section, so the dialog's words are read on the server too (as the
// credit dialogs' tests do in where.vitest). Only an open dialog draws.
vi.mock('@nexus/ui/components', async (original) => {
  const actual = await original<typeof import('@nexus/ui/components')>()
  const Modal = ({ open, title, children, footer }: { open: boolean; title?: unknown; children?: unknown; footer?: unknown }) => (open ? createElement('section', { role: 'dialog', 'data-modal': '' }, createElement('h2', null, title as never), children as never, footer as never) : null)
  return { ...actual, Modal }
})

/**
 * F-MS-103 (set the stage by hand, 04 §3; review R3b, R8, R9, R18, R20; Owner D4) — the ONE dialog's rules (the stages it offers, why
 * Go waits, the request it sends, the lines it says), Clear…'s lines, the refusals and notices in words, the hook's two writes through
 * the page's one write (a fake API), and the dialog drawn in both languages.
 * F-SC-W1 (stage control B, the Owner's pick 2026-11-21; 40-stage-plan §1, §3): any stage, forward or back, also below the floor and
 * Ready to ship by hand (warned); a move back told as a correction; Clear… told by the same rule.
 */

type HandStage = NonNullable<Headline['stage']>['byHand']
const at = (code: BrandStage, byHand: HandStage = null, version: number | null | undefined = 3): Headline => ({ ...HEADLINE, stage: { ...HEADLINE.stage!, code, byHand, version } })
const choices = (floor: BrandStage, shown: BrandStage, hand: BrandStage | null) => stageChoicesOf({ floor, shown, hand }).map((row) => `${row.stage}:${row.choice}${row.disabled ? '×' : ''}`)
const M = (key: string) => `where.manual.${key}`

describe('F-SC-W1: the stages the dialog offers — the domain\'s handStageChoicesOf, in the dialog\'s words', () => {
  it('nothing set: only the stage the customer reads is never picked; every other one ahead or back — below the floor and Ready to ship too', () => {
    expect(choices('PREPARING', 'PREPARING', null)).toEqual(['PREPARING:NOW×', 'CUTTING:AHEAD', 'SEWING:AHEAD', 'QUALITY:AHEAD', 'READY:AHEAD'])
    expect(choices('SEWING', 'SEWING', null)).toEqual(['PREPARING:BACK', 'CUTTING:BACK', 'SEWING:NOW×', 'QUALITY:AHEAD', 'READY:AHEAD'])
    expect(choices('QUALITY', 'QUALITY', null)).toEqual(['PREPARING:BACK', 'CUTTING:BACK', 'SEWING:BACK', 'QUALITY:NOW×', 'READY:AHEAD'])
    expect(choices('READY', 'READY', null)).toEqual(['PREPARING:BACK', 'CUTTING:BACK', 'SEWING:BACK', 'QUALITY:BACK', 'READY:NOW×'])
    const rows = stageChoicesOf({ floor: 'SEWING', shown: 'SEWING', hand: null })
    expect(rows.map((row) => row.note)).toEqual([{ key: M('rowBack') }, { key: M('rowBack') }, { key: M('rowNow') }, null, READY_UNRELEASED_WORDS])
    // Ready to ship ahead of a floor that is not Ready: quality has not released every piece (the domain's warning on its row).
    expect(rows.map((row) => row.readyUnreleased)).toEqual([false, false, false, false, true])
    expect(stageChoicesOf({ floor: 'READY', shown: 'READY', hand: null }).every((row) => !row.readyUnreleased)).toBe(true)
  })

  it('with a hand stage standing: the stage shown and the floor\'s own never picked (Clear… goes back to the floor); the rest ahead or back of the stage shown', () => {
    // Sewing set ahead of the floor's Preparing.
    expect(choices('PREPARING', 'SEWING', 'SEWING')).toEqual(['PREPARING:FLOOR×', 'CUTTING:BACK', 'SEWING:NOW×', 'QUALITY:AHEAD', 'READY:AHEAD'])
    // Cutting set back below the floor's Quality check (a wrong scan).
    expect(choices('QUALITY', 'CUTTING', 'CUTTING')).toEqual(['PREPARING:BACK', 'CUTTING:NOW×', 'SEWING:AHEAD', 'QUALITY:FLOOR×', 'READY:AHEAD'])
    expect(stageChoicesOf({ floor: 'QUALITY', shown: 'CUTTING', hand: 'CUTTING' })[3]!.note).toEqual({ key: M('rowFloor') })
    expect(stageChoicesOf({ floor: 'QUALITY', shown: 'CUTTING', hand: 'CUTTING' })[1]!.note).toEqual({ key: M('rowNow') })
  })

  it('what it opens on: the step picked (when it may be picked); Change… — the reason and note set, nothing pre-picked; a hand stage gone meanwhile — a Set', () => {
    expect(stageByHandStartOf('set', HAND_FREE_READ.headline)).toMatchObject({ changing: false, floor: 'SEWING', shown: 'SEWING', hand: null, pick: null, reasonCode: '', note: '' })
    // A step of the stages picked opens the dialog on it — ahead, back below the floor, or Ready to ship; never the stage shown.
    for (const pick of ['PREPARING', 'CUTTING', 'QUALITY', 'READY'] as const) expect(stageByHandStartOf('set', HAND_FREE_READ.headline, pick).pick, pick).toBe(pick)
    expect(stageByHandStartOf('set', HAND_FREE_READ.headline, 'SEWING').pick).toBeNull()
    expect(stageByHandStartOf('change', HAND_READ.headline)).toMatchObject({ changing: true, floor: 'PREPARING', shown: 'SEWING', hand: 'SEWING', pick: null, reasonCode: 'OUTAGE', note: HAND_BY.note })
    expect(stageByHandStartOf('change', HAND_READ.headline, 'CUTTING').pick).toBe('CUTTING')
    // The floor's own step is Clear…'s, never the dialog's.
    expect(stageByHandStartOf('change', HAND_READ.headline, 'PREPARING').pick).toBeNull()
    expect(stageByHandStartOf('change', HAND_FREE_READ.headline)).toMatchObject({ changing: false, hand: null, pick: null })
    // The floor of a standing hand stage is the API's live one (byHand.floor), never the shown stage; not known: Preparing (the API judges).
    expect(stageByHandStartOf('set', at('SEWING', { ...HAND_BY, floor: null })).floor).toBe('PREPARING')
    expect(stageByHandStartOf('change', HAND_BACK_READ.headline)).toMatchObject({ floor: 'QUALITY', shown: 'CUTTING', hand: 'CUTTING', reasonCode: 'OTHER' })
    // An unknown reason code is not pre-filled (the person picks one of the four).
    expect(stageByHandStartOf('change', at('SEWING', { ...HAND_BY, reasonCode: 'NOT_A_CODE' })).reasonCode).toBe('')
  })
})

describe('F-MS-103: why Go waits, and the request it sends', () => {
  const rows = stageChoicesOf({ floor: 'PREPARING', shown: 'PREPARING', hand: null })
  const ask = (over: Partial<{ stage: BrandStage | null; reasonCode: string; note: string; busy: boolean; rows: ReturnType<typeof stageChoicesOf> }> = {}) => stageByHandHeld({ rows, stage: 'SEWING', reasonCode: 'OUTAGE', note: '', busy: false, ...over })

  it('held: a write running, no stage, the stage shown or the floor\'s own, no reason, "Something else" without a note, two lines, 201 characters', () => {
    expect(ask({ busy: true })).toEqual({ key: 'held.busy' })
    expect(ask({ stage: null })).toEqual({ key: M('held.stage') })
    expect(ask({ stage: 'PREPARING' })).toEqual({ key: M('held.stage') })
    // F-SC-W1: Ready to ship may go by hand (the warning is the dialog's, never a hold).
    expect(ask({ stage: 'READY' })).toBeNull()
    const standing = stageChoicesOf({ floor: 'PREPARING', shown: 'SEWING', hand: 'SEWING' })
    expect(ask({ rows: standing, stage: 'SEWING' })).toEqual({ key: M('held.stage') })
    expect(ask({ rows: standing, stage: 'PREPARING' })).toEqual({ key: M('held.stage') })
    expect(ask({ rows: standing, stage: 'CUTTING' })).toBeNull()
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

  it('the body: any of the five stages, the reason, the note only when typed (trimmed), the headline\'s production version — null only without a row', () => {
    expect(stageByHandBodyOf({ stage: 'SEWING', reasonCode: 'OUTAGE', note: '' }, HAND_FREE_READ.headline)).toEqual({ stage: 'SEWING', reasonCode: 'OUTAGE', version: 3 })
    expect(stageByHandBodyOf({ stage: 'READY', reasonCode: 'OUTAGE', note: '' }, HAND_FREE_READ.headline)).toEqual({ stage: 'READY', reasonCode: 'OUTAGE', version: 3 })
    expect(stageByHandBodyOf({ stage: 'PREPARING', reasonCode: 'OTHER', note: '  Scansione sbagliata.  ' }, HAND_READ.headline)).toEqual({ stage: 'PREPARING', reasonCode: 'OTHER', note: 'Scansione sbagliata.', version: 4 })
    // No row yet (SEED-SO-W39-02): null, a key always sent; an older answer without the field: null too.
    expect(stageByHandBodyOf({ stage: 'CUTTING', reasonCode: 'FEW_PEOPLE', note: '' }, at('PREPARING', null, null))).toEqual({ stage: 'CUTTING', reasonCode: 'FEW_PEOPLE', version: null })
    expect(versionOf(HEADLINE)).toBeNull()
    expect(versionOf(null)).toBeNull()
    expect('version' in stageByHandBodyOf({ stage: 'CUTTING', reasonCode: 'FEW_PEOPLE', note: '' }, null)).toBe(true)
  })
})

describe('F-SC-W1: the lines the dialogs say — R3b and R18 always, never an urgent line (R8); a move back told as a correction; Clear… by the same rule', () => {
  it('always: the customer reads a plain stage, the 10-minute window, the customer\'s changes on the floor\'s records; then when it clears by itself', () => {
    const keys = (floor: BrandStage, shown: BrandStage, pick: BrandStage | null) => stageDialogLinesOf({ floor, shown, pick }).map((line) => line.key)
    expect(keys('SEWING', 'SEWING', null)).toEqual([M('customer'), M('told'), M('cuts')])
    // Ahead of the floor: clears once the floor reaches it.
    expect(keys('SEWING', 'SEWING', 'QUALITY')).toEqual([M('customer'), M('told'), M('cuts'), M('clears')])
    // Back below the floor (a wrong scan): told as a correction; clears once the floor comes back to it or passes where it is now.
    expect(keys('SEWING', 'SEWING', 'CUTTING')).toEqual([M('customer'), M('told'), M('back'), M('cuts'), M('clearsBack')])
    // A hand stage ahead changed down, still ahead of the floor: told as a correction; clears once the floor reaches it.
    expect(keys('PREPARING', 'SEWING', 'CUTTING')).toEqual([M('customer'), M('told'), M('back'), M('cuts'), M('clears')])
    // A hand stage back changed up, still below the floor: a move forward; clears once the floor comes back or passes.
    expect(keys('QUALITY', 'CUTTING', 'SEWING')).toEqual([M('customer'), M('told'), M('cuts'), M('clearsBack')])
    expect(stageDialogLinesOf({ floor: 'SEWING', shown: 'SEWING', pick: null })[1]).toEqual({ key: M('told'), minutes: NOTICE_WAIT_MINUTES })
    expect(NOTICE_WAIT_MINUTES).toBe(10)
    // What the customer reads is named in the customer's own words (the portal's: Taglio), a stage of the office in the office's.
    expect(stageDialogLinesOf({ floor: 'SEWING', shown: 'SEWING', pick: 'CUTTING' }).find((line) => line.key === M('back'))).toEqual({ key: M('back'), customer: { it: 'Taglio', en: 'Cutting' }, minutes: 10 })
    expect(stageDialogLinesOf({ floor: 'SEWING', shown: 'SEWING', pick: 'CUTTING' }).at(-1)).toEqual({ key: M('clearsBack'), stage: 'CUTTING', past: 'SEWING' })
    expect(stageDialogLinesOf({ floor: 'SEWING', shown: 'SEWING', pick: 'READY' }).at(-1)).toEqual({ key: M('clears'), stage: 'READY' })
    // No line about Mark urgent, in any case (R8: the customer's own urgent mark keeps reading the real cuts).
    for (const floor of ['PREPARING', 'SEWING', 'QUALITY'] as const) for (const pick of [null, 'PREPARING', 'CUTTING', 'SEWING', 'QUALITY', 'READY'] as const) expect(JSON.stringify(stageDialogLinesOf({ floor, shown: floor, pick }))).not.toMatch(/urgent/i)
  })

  it('Ready to ship picked while quality has not released every piece: the domain\'s warning (never a hold); none at a floor already Ready', () => {
    const rows = stageChoicesOf({ floor: 'QUALITY', shown: 'QUALITY', hand: null })
    expect(readyWarningOf(rows, 'READY')).toEqual(READY_UNRELEASED_WORDS)
    expect(readyWarningOf(rows, 'SEWING')).toBeNull()
    expect(readyWarningOf(rows, null)).toBeNull()
    expect(readyWarningOf(stageChoicesOf({ floor: 'READY', shown: 'SEWING', hand: 'SEWING' }), 'READY')).toBeNull()
  })

  it('Clear… down to the floor: inside the window not told yet and never now; after it told the correction; up to the floor: the usual notice', () => {
    const set = Date.parse(HAND_AT)
    expect(clearLinesOf(HAND_READ.headline, set + 9 * 60_000)).toEqual([
      { key: M('clearUntold'), customer: { it: 'Cucitura', en: 'Sewing' }, minutes: 10 },
      { key: M('clearFloor'), customer: { it: 'In preparazione', en: 'Preparing' } },
    ])
    expect(clearLinesOf(HAND_READ.headline, set + 10 * 60_000)).toEqual([{ key: M('clearCorrection'), customer: { it: 'Cucitura', en: 'Sewing' }, minutes: 10 }])
    // Cutting set back below the floor's Quality check, cleared: the customer reads Quality check again and gets the usual notice.
    expect(clearLinesOf(HAND_BACK_READ.headline, set + 60 * 60_000)).toEqual([{ key: M('clearForward'), customer: { it: 'Controllo qualità', en: 'Quality check' } }])
    // The floor not known: no line (never a guess); nothing set: no lines at all.
    expect(clearLinesOf(at('SEWING', { ...HAND_BY, floor: null }), set + 60 * 60_000)).toEqual([])
    expect(clearLinesOf(HAND_FREE_READ.headline, set)).toBeNull()
  })

  it('every word in both languages (office "tu", "la fase" feminine); the hint says never name a person on the floor; no key hint text; the old keys gone', () => {
    const keys = ['title', 'changeTitle', 'body', 'pick', 'rowNow', 'rowFloor', 'rowBack', 'reason', 'noteHint', 'customer', 'told', 'back', 'cuts', 'clears', 'clearsBack', 'go', 'changeGo', 'refused', 'notice', 'cleared', 'clearedPlain', 'clearTitle', 'clearCorrection', 'clearForward', 'clearUntold', 'clearNever' /* B-MS-008 (ms-fx1) */, 'clearFloor', 'clearGo', 'clearGoPlain', 'held.stage', 'stepAria']
    const params = { number: 'SO-1', max: 200, minutes: 10, customer: 'x', stage: 'x', floor: 'x', past: 'x' }
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      for (const key of keys) expect(t(M(key), params), `${locale} ${key}`).not.toBe(M(key))
      for (const key of keys) expect(t(M(key), params), `${locale} ${key}`).not.toMatch(/\{\w+\}/)
      // F-SC-W1: the rows and lines of the old rules are gone (nothing unused stays).
      for (const key of ['rowDone', 'rowSet', 'same', 'clearTold']) expect(t(M(key)), `${locale} ${key}`).toBe(M(key))
      expect(t(M('noteHint'), { max: 200 })).toBe(locale === 'en' ? 'One line, at most 200 characters. Never name a person on the floor.' : 'Una riga, al massimo 200 caratteri. Non nominare chi lavora in reparto.')
      for (const key of keys) expect(t(M(key), params), `${locale} ${key}`).not.toMatch(/⌘|Ctrl|\bEsc\b|urgent|urgente/i)
    }
    const it = createTranslator('it', messagesFor('it', ['orders']).orders!)
    expect(it(M('told'), { minutes: 10 })).toBe("Quando la fase va avanti, il cliente riceve l'avviso dopo 10 minuti: se la togli prima, non lo riceve. Dopo, un ritorno indietro gli arriva come correzione.")
    expect(it(M('cuts'))).toBe('Le modifiche del cliente si valutano sui dati del reparto: registra i tagli appena il reparto può.')
    expect(it(M('body'))).toBe('Imposta dove si trova davvero il lavoro. Cambia solo la fase: ordini di lavoro, conteggi, qualità e spedizioni restano come registrati.')
    const en = createTranslator('en', messagesFor('en', ['orders']).orders!)
    expect(en(M('told'), { minutes: 10 })).toBe('When the stage moves forward, the customer is told after 10 minutes: clear it before then and it is not told. After that, a move back is told as a correction.')
    expect(en(M('back'), { customer: 'Cutting', minutes: 10 })).toBe('Going back: the customer reads Cutting, told as a correction after 10 minutes (only if it was told the stage it leaves).')
    expect(en(M('clearsBack'), { stage: 'Cutting', past: 'Quality check' })).toBe("It clears by itself when the floor's counts come back to Cutting or pass Quality check.")
    expect(en(M('clearCorrection'), { customer: 'Sewing', minutes: 10 })).toBe('The customer was told Sewing: it is told the correction after 10 minutes.')
    expect(en(M('clearForward'), { customer: 'Quality check' })).toBe('The customer reads Quality check and gets the usual notice.')
    expect(en(M('body'))).toBe('Set where the work really is. Only the stage changes: work orders, counts, quality and shipments stay as recorded.')
    expect(en(M('cuts'))).toBe("The customer's changes are judged on the floor's records: key the cuts in as soon as the floor can.")
  })
})

describe('F-MS-103: refusals and notices in the page\'s words', () => {
  const refusal = (kind: 'conflict' | 'invalid' | 'forbidden' | 'not_found', message: string, path = 'body/stage') => new ApiError(kind, kind === 'conflict' ? 409 : kind === 'invalid' ? 400 : kind === 'forbidden' ? 403 : 404, kind, message, null, [{ path, message }])

  it('the domain\'s own words when the API answers them; the stage already read, the floor\'s own; any other conflict: changed meanwhile; the right; not found', () => {
    expect(stageRefusalOf(refusal('conflict', STAGE_SET_REFUSAL_WORDS.PAUSED.en))).toEqual(STAGE_SET_REFUSAL_WORDS.PAUSED)
    expect(stageRefusalOf(refusal('conflict', STAGE_SET_REFUSAL_WORDS.NOT_STARTED.en))).toEqual(STAGE_SET_REFUSAL_WORDS.NOT_STARTED)
    expect(stageRefusalOf(refusal('conflict', STAGE_SET_REFUSAL_WORDS.ALREADY_READY.en))).toEqual(STAGE_SET_REFUSAL_WORDS.ALREADY_READY)
    expect(stageRefusalOf(refusal('invalid', STAGE_SET_REFUSAL_WORDS.NOTE_NEEDED.en, 'body/note'))).toEqual(STAGE_SET_REFUSAL_WORDS.NOTE_NEEDED)
    // F-SC-W1: "The customer already reads Sewing." / "Preparing is the floor's own stage: clear the stage set by hand to go back to it."
    for (const stage of ['PREPARING', 'SEWING', 'READY'] as const) {
      expect(stageRefusalOf(refusal('conflict', sameStageWords(stage).en)), stage).toEqual(sameStageWords(stage))
      expect(stageRefusalOf(refusal('conflict', floorStageWords(stage).en)), stage).toEqual(floorStageWords(stage))
    }
    expect(stageRefusalOf(refusal('conflict', 'Changed by someone else.', 'version'))).toEqual({ key: M('refused') })
    expect(stageRefusalOf(refusal('conflict', 'No stage set by hand to clear.'))).toEqual({ key: M('refused') })
    expect(stageRefusalOf(refusal('forbidden', 'Forbidden.'))).toEqual({ key: 'wo.heldHold' })
    // Another customer's order reads as an unknown one (the API's wall): the page's own words, never a hint.
    expect(stageRefusalOf(refusal('not_found', 'Sales order not found.'))).toEqual({ key: 'problem.write.not_found' })
    expect(stageRefusalOf(new Error('boom'))).toEqual({ key: 'problem.write.internal' })
  })

  it('the notices: the office\'s word of the stage and the customer\'s own; back to the floor\'s stage', () => {
    expect(setNoticeOf('SEWING', 'en')).toEqual({ key: M('notice'), params: { stage: 'Sewing', customer: 'Sewing' } })
    expect(setNoticeOf('SEWING', 'it')).toEqual({ key: M('notice'), params: { stage: 'Confezione', customer: 'Cucitura' } })
    expect(setNoticeOf('READY', 'en')).toEqual({ key: M('notice'), params: { stage: 'Ready to ship', customer: 'Ready to ship' } })
    expect(clearNoticeOf('PREPARING', 'it')).toEqual({ key: M('cleared'), params: { floor: 'In preparazione' } })
    expect(clearNoticeOf(null, 'en')).toEqual({ key: M('clearedPlain') })
    const it = createTranslator('it', messagesFor('it', ['orders']).orders!)
    expect(it(M('notice'), setNoticeOf('SEWING', 'it').params)).toBe('Fase Confezione impostata a mano: il cliente legge Cucitura.')
    const en = createTranslator('en', messagesFor('en', ['orders']).orders!)
    expect(en(M('cleared'), clearNoticeOf('PREPARING', 'en').params)).toBe("Back to the floor's stage: Preparing.")
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
    expect(clearLinesOf(HAND_READ.headline, set + HAND_STAGE_NOTICE_DELAY_MS)![0]!.key).toBe('where.manual.clearCorrection') // F-SC-W1
    // No copy of the number in the model: it reads the domain's.
    const source = readFileSync(new URL('./stage-by-hand.ts', import.meta.url), 'utf8')
    expect(source).toContain("import { HAND_STAGE_NOTICE_DELAY_MS } from '@nexus/factory-domain/production-brand/stage-set'")
    expect(source).not.toMatch(/NOTICE_WAIT_MINUTES = \d/)
  })
})
// ── end B-MS-008 ──

// ── B-MS-008 (ms-fx1; Z01 note 2): Clear… never says something false — what it says the customer was told is the API's notice ──
describe('B-MS-008 (ms-fx1): Clear… reads what the customer was told from the notice (the keeper\'s markers), never the set\'s time', () => {
  const set = Date.parse(HAND_AT)
  const withNotice = (notice: { told: boolean; waitsUntil: string | null } | null) => at('SEWING', { ...HAND_BY, notice })

  it('Z01 note 2: a Change 2 minutes ago (a new set time) after the notice went — told (so Clear… tells the correction), never "not told yet"', () => {
    // The set time is now 2 minutes old, but its notice went long ago: the markers say told.
    const changed = at('SEWING', { ...HAND_BY, at: new Date(set + 30 * 60_000).toISOString(), notice: { told: true, waitsUntil: null } })
    expect(clearLinesOf(changed, set + 32 * 60_000)![0]).toEqual({ key: 'where.manual.clearCorrection', customer: { it: 'Cucitura', en: 'Sewing' }, minutes: 10 })
    // A set of a stage told before (a re-set inside 10 minutes): told too.
    expect(clearLinesOf(withNotice({ told: true, waitsUntil: null }), set + 60_000)![0]!.key).toBe('where.manual.clearCorrection')
  })

  it('a notice still waiting: not told yet, until the time it goes (the API says when), then told; never told: says so', () => {
    const goes = new Date(set + 6 * 60_000).toISOString() // a Change to the same stage 4 minutes after the set keeps the set's notice
    expect(clearLinesOf(withNotice({ told: false, waitsUntil: goes }), set + 5 * 60_000)![0]).toEqual({ key: 'where.manual.clearUntold', customer: { it: 'Cucitura', en: 'Sewing' }, minutes: 10 })
    expect(clearLinesOf(withNotice({ told: false, waitsUntil: goes }), set + 6 * 60_000)![0]!.key).toBe('where.manual.clearCorrection')
    // A notice dropped (never told): "has not been told Cutting, and is not told it now" — at any time; no correction of what it never read.
    const down = at('CUTTING', { ...HAND_BY, stage: 'CUTTING', notice: { told: false, waitsUntil: null } })
    for (const now of [set + 60_000, set + 60 * 60_000]) expect(clearLinesOf(down, now)).toEqual([{ key: 'where.manual.clearNever', customer: { it: 'Taglio', en: 'Cutting' } }, { key: 'where.manual.clearFloor', customer: { it: 'In preparazione', en: 'Preparing' } }])
  })

  it('no notice read (an older answer): no line at all — whether a correction goes is never guessed', () => {
    expect(clearLinesOf(withNotice(null), set + 60_000)).toEqual([])
  })

  it('the words: never told (en + it); going back and the floor\'s stage never claim the customer read it before ("again")', () => {
    const en = createTranslator('en', messagesFor('en', ['orders']).orders!)
    const it_ = createTranslator('it', messagesFor('it', ['orders']).orders!)
    expect(en('where.manual.clearNever', { customer: 'Cutting' })).toBe('The customer has not been told Cutting, and is not told it now.')
    expect(it_('where.manual.clearNever', { customer: 'Taglio' })).toBe("Il cliente non ha ricevuto l'avviso di Taglio, e ora non lo riceve.")
    for (const key of ['back', 'clearFloor']) {
      expect(en(`where.manual.${key}`, { customer: 'Cutting' }), key).not.toMatch(/\bagain\b/)
      expect(it_(`where.manual.${key}`, { customer: 'Taglio' }), key).not.toMatch(/di nuovo/)
    }
  })
})
// ── end B-MS-008 (ms-fx1) ──
