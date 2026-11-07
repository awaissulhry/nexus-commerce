import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ApiError } from '../../../../../lib/api/errors'
import type { DesignScreen } from '../../../../../lib/design/design-screen'
import { LOCALES } from '../../../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../../lib/i18n/provider'
import { canFor, LOCATIONS, order, STOCK, TODAY } from '../../demo/fixtures'
import { ready, receiveBody, receiveDraftOf } from '../record-model'
import { designScreen } from './fixtures'
import {
  actHeld,
  answerAct,
  cellKey,
  dateHeld,
  dialogHeld,
  kitAct,
  linkBody,
  linkHeld,
  progressAct,
  reachOf,
  receiveDraftFrom,
  receiveHeld,
  returnsAct,
  writeProblem,
  type WorkshopDialog,
} from './model'
import type { WorkshopAnswer } from './api'

type Case = (typeof designScreen.cases)[number]
const answerOf = (id: string): WorkshopAnswer => {
  const item = designScreen.cases.find((entry) => entry.id === id) as Case
  // The panel's model sits in the record's slot: read it back from the element's props.
  const element = item.model.record.workshop as { props: { model: { answer: { status: string; value?: WorkshopAnswer } } } }
  return element.props.model.answer.value!
}
const dialogOf = (id: string): WorkshopDialog => {
  const item = designScreen.cases.find((entry) => entry.id === id) as Case
  return (item.model.record.workshop as { props: { model: { dialog: WorkshopDialog } } }).props.model.dialog
}
const invalid = (path: string) => new ApiError('invalid', 400, 'validation_failed', 'x', null, [{ path }])

describe('why an act is held, in our words', () => {
  it('the permission first, then the job’s facts', () => {
    expect(actHeld(answerOf('read-only'), 'progress')?.key).toBe('held.manage')
    expect(receiveHeld(answerOf('read-only'))?.key).toBe('held.receive')
    expect(actHeld(answerOf('waiting'), 'accept')).toBeNull()
    expect(actHeld(answerOf('waiting'), 'progress')?.key).toBe('held.acceptFirst')
    expect(actHeld(answerOf('declined'), 'kit')?.key).toBe('held.declined')
    expect(actHeld(answerOf('proposed'), 'accept')?.key).toBe('held.answered')
    expect(actHeld(answerOf('waiting-kit'), 'sendBack')?.key).toBe('held.noKitYet')
    expect(linkHeld(answerOf('waiting'))).toBeNull()
    expect(linkHeld(answerOf('proposed'))?.key).toBe('held.link.accepted')
    expect(dateHeld(answerOf('proposed'))).toBeNull()
    expect(dateHeld(answerOf('date-accepted'))?.key).toBe('held.date.answered')
    expect(reachOf(answerOf('no-email'))).toBe('none')
    expect(reachOf(answerOf('waiting'))).toBe('mail')
  })
})

describe('the dialogs: held with why, and what they send', () => {
  it('the job link: to a contact, a typed address, or handed out once', () => {
    expect(linkBody({ kind: 'link', mode: 'mail', contactId: 'c1', email: '', language: '' })).toEqual({ send: true, contactId: 'c1' })
    expect(linkBody({ kind: 'link', mode: 'mail', contactId: '', email: ' a@b.example ', language: 'en' })).toEqual({ send: true, email: 'a@b.example', language: 'en' })
    expect(linkBody({ kind: 'link', mode: 'hand', contactId: 'c1', email: '', language: '' })).toEqual({ send: false })
    expect(dialogHeld({ kind: 'link', mode: 'mail', contactId: '', email: 'nope', language: '' }, answerOf('waiting'), TODAY)?.key).toBe('link.held.address')
  })

  it('the answer: another day needs why; Other needs words', () => {
    expect(dialogHeld(dialogOf('answer-move'), answerOf('no-email'), TODAY)).toBeNull()
    expect(answerAct(dialogOf('answer-move') as Extract<WorkshopDialog, { kind: 'answer' }>)).toEqual({ act: 'accept', body: { proposedDate: '2026-11-24', reason: 'Due macchine in manutenzione.', name: 'Gino al telefono' } })
    expect(dialogHeld(dialogOf('answer-decline'), answerOf('no-email'), TODAY)?.key).toBe('answer.held.note')
    expect(dialogHeld({ ...(dialogOf('answer-move') as Extract<WorkshopDialog, { kind: 'answer' }>), proposedDate: '2026-11-20' }, answerOf('no-email'), TODAY)?.key).toBe('answer.held.same')
  })

  it('the kit: a shortfall needs words; all as listed sends all', () => {
    expect(dialogHeld(dialogOf('kit-dialog-held'), answerOf('kit-dialog-held'), TODAY)?.key).toBe('kit.held.note')
    expect(dialogHeld(dialogOf('kit-dialog'), answerOf('kit-dialog'), TODAY)).toBeNull()
    expect(kitAct(dialogOf('kit-dialog') as Extract<WorkshopDialog, { kind: 'kit' }>).body).toEqual({ lines: [expect.objectContaining({ quantity: '40', note: 'Rotolo bagnato.' }), expect.objectContaining({ quantity: '60' })] })
    expect(kitAct({ kind: 'kit', all: true, lines: {} })).toEqual({ act: 'kit', body: { all: true } })
  })

  it('progress: never past a size’s pieces; the rows it sends', () => {
    expect(dialogHeld(dialogOf('progress-held'), answerOf('progress-held'), TODAY)?.key).toBe('progress.held.cell')
    const act = progressAct(dialogOf('progress-dialog') as Extract<WorkshopDialog, { kind: 'progress' }>)
    expect(act.body).toMatchObject({ entries: [expect.objectContaining({ finished: 2, workOrderSizeId: expect.any(String) }), expect.objectContaining({ finished: 10 })], finishBy: '2026-11-19', name: 'Gino al telefono' })
    expect((act.body as { entries: { workOrderSizeId?: string }[] }).entries[1]!.workOrderSizeId).toBeUndefined()
    expect(cellKey('op', null)).toBe('op|')
  })

  it('a send-back: scrap needs why; what it sends', () => {
    expect(dialogHeld(dialogOf('returns-held'), answerOf('returns-held'), TODAY)?.key).toBe('returns.held.reason')
    expect(dialogHeld(dialogOf('returns-dialog'), answerOf('returns-dialog'), TODAY)).toBeNull()
    expect(returnsAct(dialogOf('returns-dialog') as Extract<WorkshopDialog, { kind: 'returns' }>).body).toMatchObject({
      quantities: [{ finished: 6, scrapped: 1, reasonCode: 'STAIN' }],
      materialBack: [{ quantity: '1.5' }],
      parcels: 1,
      ddt: { number: 'LCD-97/26', date: TODAY },
    })
  })

  it('a refusal in words by its field, never the API’s sentence', () => {
    expect(writeProblem(invalid('body/proposedDate')).key).toBe('refused.proposedDate')
    expect(writeProblem(invalid('body/quantities/0/reasonCode')).key).toBe('refused.scrapReason')
    expect(writeProblem(new ApiError('conflict', 409, 'stale_version', 'changed')).key).toBe('problem.changed')
    expect(writeProblem(new ApiError('conflict', 409, 'invalid_state', 'The workshop accepted already.')).key).toBe('problem.state')
  })
})

describe('Receive back prefilled from the workshop’s send-back', () => {
  it('the lines, its DDT, the material back keyed as the dialog keeps it, and the notice it answers', () => {
    const answer = answerOf('returns')
    const value = order('PARTLY_RECEIVED')
    const draft = receiveDraftFrom(receiveDraftOf(value, TODAY, canFor('warehouse')), answer.prefills[0]!)
    expect(draft).toMatchObject({ ddtNumber: 'LCD-95/26', ddtDate: TODAY, returnNoticeId: answer.prefills[0]!.returnNoticeId, note: 'Il resto la settimana prossima.' })
    expect(draft.lines.map((line) => [line.good, line.scrapped, line.reason])).toEqual([
      ['5', '1', 'STAIN'],
      ['1', '0', ''],
    ])
    expect(Object.values(draft.returns)).toEqual([{ quantity: '2.5', toLocationId: '' }])
    const stocked = { ...draft, stock: ready(STOCK.rows.filter((row) => row.location.id === LOCATIONS.sewing.id)), returns: Object.fromEntries(Object.entries(draft.returns).map(([key, entry]) => [key, { ...entry, toLocationId: 'demo-store-01' }])) }
    const body = receiveBody(stocked, value, `${TODAY}T10:00:00.000Z`)
    expect(body.returnNoticeId).toBe(answer.prefills[0]!.returnNoticeId)
    expect(body.returns).toEqual([expect.objectContaining({ quantity: '2.5', toLocationId: 'demo-store-01' })])
    expect(body.supplierDdt).toEqual({ number: 'LCD-95/26', date: TODAY })
    // Material the workshop's stock does not hold is not sent (the dialog does not list it).
    expect(receiveBody({ ...stocked, stock: ready([]) }, value, `${TODAY}T10:00:00.000Z`).returns).toEqual([])
  })
})

const NAMESPACES = ['shell', 'subcontracting', 'subcontract-order', 'subcontract-workshop', 'lists', 'records']
const groups = [...new Set(['subcontract-workshop'].flatMap((namespace) => Object.keys(CATALOGUE.en[namespace] ?? {}).map((key) => key.split('.')[0]!)))].join('|')
const LEFT_KEY = new RegExp(`\\b(?:${groups})\\.[a-zA-Z_]+(?:\\.[a-zA-Z_]+)*\\b`)

function render(model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = designScreen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, NAMESPACES) }, createElement(View, { model })))
}

describe('every design case draws in both languages with no key left on screen and no price', () => {
  it(`${designScreen.screen}: ${designScreen.cases.length} cases × it, en`, () => {
    for (const item of (designScreen as unknown as DesignScreen<unknown>).cases) {
      for (const locale of LOCALES) {
        const html = render(item.model, locale)
        const panel = html.slice(html.indexOf('fw-ws'))
        expect(html.indexOf('fw-ws') > 0 || item.id === 'loading' || item.id === 'slow' || item.id === 'error', `${item.id} (${locale}): the panel draws`).toBe(true)
        expect(panel.match(LEFT_KEY)?.[0] ?? null, `${item.id} (${locale})`).toBeNull()
        expect(panel, item.id).not.toMatch(/€|Fee per piece|Prezzo|Compenso/)
      }
    }
  })
})
