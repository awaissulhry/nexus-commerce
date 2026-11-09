import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import { DECLINE_REASONS, JOB_CHIPS, JOB_STATES, jobActsOf, NEXT_STEPS, SCRAP_REASONS, type JobFacts } from '@nexus/factory-domain/purchasing/portal-jobs/jobs'
import { ApiError } from '../../../lib/api/errors'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { CATALOGUE, createTranslator, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { designScreen as linkScreen } from '../../../links/job/fixtures'
import { answerHeld, answerOf, endOf, jobClosed, LINK_DRAFT } from '../../../links/job/model'
import type { Job } from './api'
import { backJob, jobOf, kitJob, newJob, ROWS, TODAY } from './design-data'
import { designScreen as listScreen } from './fixtures'
import {
  acceptBody,
  acceptHeld,
  cardStepOf,
  declineHeld,
  dueOf,
  endWords,
  jobHeld,
  jobsCsv,
  kitDraftOf,
  kitHeld,
  kitLinesAct,
  KNOWN_SCRAP,
  KNOWN_UOM,
  personHeld,
  progressAct,
  progressDraftOf,
  progressHeld,
  returnAct,
  returnDraftOf,
  returnHeld,
  tabFor,
  writeProblem,
  type PersonFacts,
} from './model'
import { designScreen as recordScreen } from './record/fixtures'

const t = (locale: 'it' | 'en') => createTranslator(locale, CATALOGUE[locale]['portal-jobs'] ?? {})
const has = (locale: 'it' | 'en', key: string) => {
  const words = CATALOGUE[locale]['portal-jobs'] ?? {}
  return key in words || `${key}_other` in words
}

describe('the words come from codes, in both languages', () => {
  it('every chip, state, next step, decline reason, scrap reason and unit the domain knows has our words', () => {
    for (const locale of ['it', 'en'] as const) {
      for (const chip of JOB_CHIPS) expect(has(locale, `chip.${chip}`), chip).toBe(true)
      for (const state of JOB_STATES) expect(has(locale, `state.${state}`), state).toBe(true)
      for (const step of NEXT_STEPS) expect(has(locale, `next.${step}`), step).toBe(true)
      for (const reason of DECLINE_REASONS) expect(has(locale, `decline.reasons.${reason}`), reason).toBe(true)
      for (const code of KNOWN_SCRAP) expect(has(locale, `scrap.${code}`), code).toBe(true)
      for (const uom of KNOWN_UOM) expect(has(locale, `uom.${uom}`), uom).toBe(true)
    }
    expect([...KNOWN_SCRAP].sort()).toEqual(SCRAP_REASONS.map((reason) => reason.code).sort())
    expect([...KNOWN_UOM]).toEqual([...UOMS])
  })
})

// The domain's own sentence for each hold, and the key the page says it with.
const HELD_KEYS: Record<string, string> = {
  'This job has ended.': 'held.ended',
  'You declined this job.': 'held.declined',
  'You accepted this job already.': 'held.answered',
  'Some of the work came back already: write to us in the messages.': 'held.declinePartly',
  'This job was not sent to you yet.': 'held.notSent',
  'Accept the job first.': 'held.acceptFirst',
  'No kit to confirm.': 'held.kitNone',
  'The kit has not left yet: nothing to send back.': 'held.noKitYet',
  'Everything you hold is announced or back already.': 'held.nothingToAnnounce',
}

describe('why an act is held mirrors the domain (jobActsOf)', () => {
  const STATUSES = ['ISSUED', 'AT_WORKSHOP', 'PARTLY_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED'] as const
  it('for every status × answer × kit × what is with the workshop, the page says the domain’s reason in its own words', () => {
    for (const status of STATUSES)
      for (const answer of ['none', 'accepted', 'declined'] as const)
        for (const kitWaits of [false, true])
          for (const announceable of [0, 5]) {
            const facts: JobFacts = {
              status,
              accepted: answer === 'accepted',
              declined: answer === 'declined',
              kitLines: [{ status: 'SENT', checked: !kitWaits }],
              operations: [{ pieces: 10, piecesSent: announceable, piecesBackGood: 0, piecesBackDefective: 0, piecesScrapped: 0, finished: 0, announced: 0 }],
            }
            const acts = jobActsOf(facts)
            const state = status === 'CANCELLED' ? 'CANCELLED' : status === 'CLOSED' ? 'CLOSED' : answer === 'declined' ? 'DECLINED' : status === 'RECEIVED' ? 'BACK' : answer === 'none' ? 'TO_ANSWER' : 'IN_WORK'
            const job = {
              state,
              status,
              answer: { ...jobOf().answer, acceptedAt: answer === 'accepted' ? TODAY : null, declinedAt: answer === 'declined' ? TODAY : null },
              acts: { accept: acts.accept !== null, decline: acts.decline !== null, kit: acts.kit !== null, progress: acts.progress !== null, sendBack: acts.sendBack !== null },
              kit: jobOf().kit,
              operations: jobOf().operations,
            } as Pick<Job, 'state' | 'status' | 'answer' | 'acts' | 'kit' | 'operations'>
            for (const act of ['accept', 'decline', 'kit', 'progress', 'sendBack'] as const) {
              const domain = acts[act]
              const ours = jobHeld(job, act)
              const where = `${status} ${answer} kit:${kitWaits} with:${announceable} ${act}`
              if (domain === null) expect(ours, where).toBeNull()
              else expect(ours?.key, where).toBe(HELD_KEYS[domain.en])
            }
          }
  })

  it('the person comes first: a preview, a missing capability, no connection, busy', () => {
    const facts: PersonFacts = { preview: false, offline: false, busy: false, mayAct: { approve: true, comment: true, upload: true } }
    expect(personHeld(facts, 'accept')).toBeNull()
    expect(personHeld({ ...facts, preview: true }, 'progress')?.key).toBe('held.preview')
    expect(personHeld({ ...facts, mayAct: { ...facts.mayAct, approve: false } }, 'kit')?.key).toBe('held.may.approve')
    expect(personHeld({ ...facts, mayAct: { ...facts.mayAct, comment: false } }, 'sendBack')?.key).toBe('held.may.comment')
    expect(personHeld({ ...facts, mayAct: { ...facts.mayAct, upload: false } }, 'photo')?.key).toBe('held.may.upload')
    expect(personHeld({ ...facts, offline: true }, 'progress')?.key).toBe('held.offline')
  })
})

describe('the cards', () => {
  it('one button per card, to the tab where the next step is done', () => {
    expect(cardStepOf({ id: 'j', nextStep: 'ACCEPT' }, '/p/X')).toEqual({ kind: 'accept' })
    expect(cardStepOf({ id: 'j', nextStep: 'CONFIRM_KIT' }, '/p/X')).toEqual({ kind: 'open', href: '/p/X/jobs/j?tab=kit' })
    expect(cardStepOf({ id: 'j', nextStep: 'SEND_BACK' }, '/p/X')).toEqual({ kind: 'open', href: '/p/X/jobs/j?tab=sendback' })
    expect(cardStepOf({ id: 'j', nextStep: 'WAIT_KIT' }, '/p/X')).toBeNull()
    expect(tabFor('REPORT')).toBe('progress')
  })

  it('the due-back line: late, today, in N days', () => {
    expect(dueOf({ dueBack: '2026-11-10', late: false, state: 'IN_WORK' }, '2026-11-08')).toEqual({ key: 'due.in', days: 2, tone: 'warning' })
    expect(dueOf({ dueBack: '2026-11-08', late: false, state: 'IN_WORK' }, '2026-11-08').key).toBe('due.today')
    expect(dueOf({ dueBack: '2026-11-05', late: true, state: 'IN_WORK' }, '2026-11-08')).toEqual({ key: 'due.late', days: 3, tone: 'danger' })
    expect(dueOf({ dueBack: '2026-11-05', late: false, state: 'BACK' }, '2026-11-08').key).toBe('due.ended')
  })

  it('the CSV of a view: our header, no price', () => {
    const csv = jobsCsv(ROWS.slice(0, 2), t('en'))
    expect(csv.split('\n')[0]).toBe('Job;Work;Style;Work order;Pieces;Finished;Kit sent on;Due back on;Status')
    expect(csv).not.toMatch(/€|price|amount/i)
  })
})

describe('the acts: what waits and what is sent', () => {
  it('accept as asked, or another day with why', () => {
    const job = newJob()
    expect(acceptHeld({ mode: 'asked', proposedDate: '', reason: '' }, job, TODAY)).toBeNull()
    expect(acceptHeld({ mode: 'move', proposedDate: '', reason: '' }, job, TODAY)?.key).toBe('accept.held.date')
    expect(acceptHeld({ mode: 'move', proposedDate: '2000-01-01', reason: 'x' }, job, TODAY)?.key).toBe('accept.held.past')
    expect(acceptHeld({ mode: 'move', proposedDate: job.expectedBackDate!, reason: 'x' }, job, TODAY)?.key).toBe('accept.held.same')
    expect(acceptHeld({ mode: 'move', proposedDate: '2099-01-01', reason: ' ' }, job, TODAY)?.key).toBe('accept.held.reason')
    expect(acceptBody({ mode: 'move', proposedDate: '2099-01-01', reason: ' two machines down ' })).toEqual({ proposedDate: '2099-01-01', reason: 'two machines down' })
    expect(acceptBody({ mode: 'asked', proposedDate: '2099-01-01', reason: 'x' })).toEqual({})
    expect(declineHeld({ reason: '', note: '' })?.key).toBe('decline.held.reason')
    expect(declineHeld({ reason: 'OTHER', note: '' })?.key).toBe('decline.held.note')
    expect(declineHeld({ reason: 'DATES', note: '' })).toBeNull()
  })

  it('the kit: every line counted, at most what we sent, a shortfall with words', () => {
    const job = kitJob()
    const draft = kitDraftOf(job)
    expect(kitHeld(draft, job)).toBeNull()
    const zip = job.kit.lines[1]!
    expect(kitHeld({ lines: { ...draft.lines, [zip.id]: { quantity: '118', note: '' } } }, job)).toEqual({ key: 'kit.held.note', params: { line: 20 } })
    expect(kitHeld({ lines: { ...draft.lines, [zip.id]: { quantity: '121', note: '' } } }, job)).toEqual({ key: 'kit.held.more', params: { line: 20, sent: '120' } })
    const act = kitLinesAct({ lines: { ...draft.lines, [zip.id]: { quantity: '118,5', note: ' two broken ' } } }, job)
    expect(act).toEqual({ act: 'kit', body: { lines: [{ kitLineId: job.kit.lines[0]!.id, quantity: '84' }, { kitLineId: zip.id, quantity: '118.5', note: 'two broken' }, { kitLineId: job.kit.lines[2]!.id, quantity: '12' }] } })
    expect(kitHeld(draft, jobOf())?.key).toBe('held.kitNone')
  })

  it('progress: per size cell, never past what is left, at least one piece', () => {
    const job = jobOf()
    const op = job.operations[0]!
    const draft = progressDraftOf(job)
    expect(progressHeld(draft, job)?.key).toBe('progress.held.nothing')
    expect(progressHeld({ ...draft, grids: { [op.id]: { Nero: { L: 11 } } } }, job)).toEqual({ key: 'progress.held.cell', params: { line: 10, size: 'Nero L', left: 10 } })
    const ok = { ...draft, grids: { [op.id]: { Nero: { L: 6, XL: 4 } } }, note: ' ok ' }
    expect(progressHeld(ok, job)).toBeNull()
    const cell = (colourway: string, size: string) => op.sizes.find((entry) => entry.colourway === colourway && entry.size === size)!.workOrderSizeId
    expect(progressAct(ok, job)).toEqual({ act: 'progress', body: { entries: [{ operationId: op.id, workOrderSizeId: cell('Nero', 'L'), finished: 6 }, { operationId: op.id, workOrderSizeId: cell('Nero', 'XL'), finished: 4 }], finishBy: job.finishBy, note: 'ok' } })
  })

  it('send back: at most what is with the workshop, scrap with a reason, the DDT dated on or before the day', () => {
    const job = backJob()
    const op = job.operations[0]!
    const draft = returnDraftOf(job, TODAY)
    expect(draft.rows[op.id]).toEqual({ finished: '58', scrapped: '0', reasonCode: '' })
    expect(returnHeld(draft, job, TODAY)).toBeNull()
    expect(returnHeld({ ...draft, rows: { [op.id]: { finished: '58', scrapped: '2', reasonCode: '' } } }, job, TODAY)?.key).toBe('returns.held.reason')
    expect(returnHeld({ ...draft, rows: { [op.id]: { finished: '60', scrapped: '2', reasonCode: 'STAIN' } } }, job, TODAY)).toEqual({ key: 'returns.held.more', params: { line: 10, left: 60 } })
    expect(returnHeld({ ...draft, ddtDate: TODAY }, job, TODAY)?.key).toBe('returns.held.ddtNumber')
    expect(returnHeld({ ...draft, expectedDate: '2000-01-01' }, job, TODAY)?.key).toBe('returns.held.day')
    const body = returnAct({ ...draft, rows: { [op.id]: { finished: '56', scrapped: '2', reasonCode: 'STAIN' } }, ddtNumber: ' LP-122 ', ddtDate: TODAY, parcels: '2', material: { [job.kit.lines[0]!.id]: '3,5' } })
    expect(body).toEqual({ act: 'returns', body: { quantities: [{ operationId: op.id, finished: 56, scrapped: 2, reasonCode: 'STAIN' }], materialBack: [{ kitLineId: job.kit.lines[0]!.id, quantity: '3.5' }], parcels: 2, expectedDate: TODAY, weCollect: false, ddt: { number: 'LP-122', date: TODAY } } })
  })

  it('a refusal in our words: the field first, then its kind', () => {
    expect(writeProblem(new ApiError('invalid', 400, 'invalid', 'x', null, [{ path: 'body/quantities/0/finished', message: 'x' }])).key).toBe('refused.returns')
    expect(writeProblem(new ApiError('conflict', 409, 'stale_version', 'changed')).key).toBe('problem.changed')
    expect(writeProblem(new ApiError('forbidden', 403, 'forbidden', 'no')).key).toBe('problem.forbidden')
    expect(writeProblem(new Error('boom')).key).toBe('problem.write')
  })

  it('the end of each act, in both languages, with no key left', () => {
    for (const locale of ['it', 'en'] as const) {
      const say = t(locale)
      for (const end of [
        { kind: 'accepted', proposedDate: null, kitDay: TODAY },
        { kind: 'accepted', proposedDate: TODAY, kitDay: null },
        { kind: 'declined' },
        { kind: 'kit', lines: 3, short: 1 },
        { kind: 'progress', pieces: 1 },
        { kind: 'returns', pieces: 58, day: TODAY },
        { kind: 'photo', name: 'x.jpg' },
        { kind: 'problem' },
      ] as const) {
        const words = endWords(end)
        expect(say(words.key, words.params)).not.toMatch(/^end\./)
      }
    }
  })
})

describe('the job link (SCR-196)', () => {
  const job = (linkScreen.cases[0]!.model.page!).job
  it('answers: accept as asked, another day with why, decline with a reason', () => {
    expect(answerHeld(LINK_DRAFT, job, TODAY)).toBeNull()
    expect(answerHeld({ ...LINK_DRAFT, mode: 'move' }, job, TODAY)?.key).toBe('accept.held.date')
    expect(answerHeld({ ...LINK_DRAFT, mode: 'decline' }, job, TODAY)?.key).toBe('decline.held.reason')
    expect(answerHeld({ ...LINK_DRAFT, mode: 'decline', declineReason: 'OTHER' }, job, TODAY)?.key).toBe('decline.held.note')
    expect(answerOf({ ...LINK_DRAFT, typedName: ' Rosa ' })).toEqual({ kind: 'accept', typedName: 'Rosa' })
    expect(answerOf({ ...LINK_DRAFT, mode: 'move', proposedDate: '2099-01-01', reason: ' why ' })).toEqual({ kind: 'move', typedName: null, proposedDate: '2099-01-01', reason: 'why' })
    expect(answerOf({ ...LINK_DRAFT, mode: 'decline', declineReason: 'DATES' })).toEqual({ kind: 'decline', typedName: null, reason: 'DATES', note: null })
    expect(endOf({ kind: 'accept', typedName: null }, { job: { ...job, kit: { ...job.kit, sentOn: [TODAY] } } }).body).toEqual({ key: 'end.acceptedKit', params: { date: TODAY } })
  })

  it('a job answered already takes no answer and says why', () => {
    const answered = { ...job, answer: { ...job.answer, acceptedAt: TODAY }, acts: { accept: true, decline: true, moveDate: true } }
    expect(jobClosed(answered)?.key).toBe('link.closed.accepted')
    expect(answerHeld(LINK_DRAFT, answered, TODAY)?.key).toBe('link.closed.accepted')
  })
})

const KEY = /\b(?:list|row|bulk|held|accept|decline|record|tabs|answer|problem|refused|end|docs|kit|progress|returns|sheet|unsaved|band|keys|chips?|col|due|state|next|uom|scrap|facts|grid|card|link|offline|notice|dialog|bulkAccept|csv)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/
const MONEY = /€|\bEUR\b|unitPrice|netAmount|pricePerPiece|\bfee\b/i

describe('SCR-192 / SCR-193 / SCR-196 design cases', () => {
  for (const screen of [listScreen, recordScreen, linkScreen] as unknown as DesignScreen<unknown>[]) {
    it(`${screen.screen}: every case draws in Italian and English with no raw key and no money`, () => {
      for (const locale of ['it', 'en'] as const) {
        for (const entry of screen.cases) {
          const html = renderToStaticMarkup(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'portal']) }, createElement(screen.view, { model: entry.model })))
          expect(html, `${screen.screen}/${entry.id} (${locale})`).toContain('main-content')
          expect(html.replace(/<[^>]+>/g, ' ').match(KEY)?.[0] ?? null, `${screen.screen}/${entry.id} (${locale})`).toBeNull()
          expect(html.replace(/<[^>]+>/g, ' '), `${screen.screen}/${entry.id} (${locale}): money on a workshop page`).not.toMatch(MONEY)
        }
      }
    })
  }
})
