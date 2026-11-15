import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ApiError } from '../../../../lib/api/errors'
import { LOCALES } from '../../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { designScreen as carrierScreen } from '../booking/fixtures'
import { allProblems, arrangeBody, arrangeProblem, checkProblemWords, mayHeld, reasonProblem, reprintHeld, statusProblem } from '../booking/model'
import { newestReprintable } from '../booking/view/ReprintView'
import { designScreen as cartonsScreen } from '../cartons/fixtures'
import { cartonName, contentsBySize, marksState, removeHeld, stepOf, weighHeld } from '../cartons/model'
import { designScreen as holdsScreen } from '../holds/fixtures'
import { bulkProblem, placeHeld, placeProblem, reasonChoices, releaseHeld, releaseProblem } from '../holds/model'
import { ShipmentsListView } from '../list/view/ShipmentsListView'
import { designScreen as noticeScreen } from '../notice/fixtures'
import { automaticWords, sendHeld, sentWords } from '../notice/model'
import { designScreen as papersScreen } from '../papers/fixtures'
import { packHeld, partWords, proformaBlockers, proformaHeld } from '../papers/model'
import { designScreen as podScreen } from '../pod/fixtures'
import { openParts, podProblem, recordHeld, resolveHeld } from '../pod/model'
import { designScreen as searchScreen } from '../search/fixtures'
import { atRiskSchema, problemsSchema, searchSchema, shipTodaySchema } from './api'
import { designScreen as queueScreen } from './fixtures'
import { gridOf, isDepthView, queueCsv, searchStatusOf, todayRows } from './model'
import { refusalOf, writeWords } from './shared/depth'
import { designScreen as splitScreen } from './split/fixtures'
import { handBody, handTotals, splitHeld } from './split/model'

/** B-W2b-410 — shipments in depth on screen: the parts' rules, the fixtures as API answers, every case in it and en. */

const ready = <T,>(read: { state: string; value?: T }): T => {
  if (read.state !== 'ready' || read.value === undefined) throw new Error('not ready')
  return read.value
}
const caseOf = <M,>(screen: { cases: readonly { id: string; model: M }[] }, id: string): M => screen.cases.find((entry) => entry.id === id)!.model
const conflict = (code: string) => new ApiError('conflict', 409, 'conflict', 'refused', null, [{ path: `refusal/${code}`, message: 'x' }])

describe('the list: which grid, the search state, the CSV (SCR-590 / SCR-591)', () => {
  it('a search term wins over a view; the views of this step draw their own grid', () => {
    expect(gridOf('today', '')).toBe('today')
    expect(gridOf('atRisk', '')).toBe('atRisk')
    expect(gridOf('exceptions', ' ')).toBe('exceptions')
    expect(gridOf('SHIPPED', '')).toBeNull()
    expect(gridOf('open', 'S')).toBeNull()
    expect(gridOf('open', 'SO')).toBe('search')
    expect(isDepthView('open')).toBe(false)
    expect(searchStatusOf('SHIPPED')).toBe('SHIPPED')
    expect(searchStatusOf('today')).toBeNull()
  })

  it('the fixtures are answers the queue may give', () => {
    const model = caseOf(queueScreen, 'today').list.depth!
    expect(() => shipTodaySchema.parse(ready(model.today))).not.toThrow()
    expect(() => atRiskSchema.parse(ready(model.atRisk))).not.toThrow()
    expect(() => problemsSchema.parse(ready(model.exceptions))).not.toThrow()
    expect(() => searchSchema.parse(ready(caseOf(searchScreen, 'serial').list.depth!.search!))).not.toThrow()
  })

  it('a pressed carrier card keeps its rows only; the CSV names each row', () => {
    const today = ready(caseOf(queueScreen, 'today').list.depth!.today)
    expect(todayRows(today, 'SENDER').map((row) => row.transportBy)).toEqual(['SENDER'])
    const csv = queueCsv(today.shipments.slice(1, 2), { header: (column) => column, status: (status) => status, risk: (risk) => risk, hold: (reason) => reason })
    expect(csv.split('\n')[0]).toBe('number,status,risk,order,customerPo,customer,carrier,shipBy,parcels,garments,holds')
    expect(csv.split('\n')[1]).toContain('HELD')
    expect(csv.split('\n')[1]).toContain('BALANCE_UNPAID')
  })
})

describe('holds (SCR-592)', () => {
  const held = caseOf(holdsScreen, 'held-warehouse').panel!
  const holds = ready(held.holds)
  it('says who may release: the system\'s balance needs finance; the warehouse releases a customer request', () => {
    const system = holds.holds.find((hold) => hold.bySystem)!
    const person = holds.holds.find((hold) => hold.reason === 'CUSTOMER_REQUEST')!
    expect(releaseHeld(system, held.can, false)?.key).toBe('holds.held.financeOnly')
    expect(releaseHeld(person, held.can, false)).toBeNull()
    expect(releaseHeld(person, held.can, true)?.key).toBe('holds.held.busy')
    expect(releaseHeld(holds.holds.find((hold) => !hold.inForce)!, held.can, false)?.key).toBe('holds.held.notInForce')
  })

  it('offers only the reasons not in force; Other needs words; a release needs why', () => {
    expect(reasonChoices(holds).map((choice) => choice.reason)).not.toContain('CUSTOMER_REQUEST')
    expect(placeProblem({ kind: 'place', reason: 'OTHER', text: ' ' }, reasonChoices(holds))?.key).toBe('holds.form.wordsNeeded')
    expect(placeProblem({ kind: 'place', reason: 'QUALITY', text: '' }, reasonChoices(holds))).toBeNull()
    expect(placeProblem({ kind: 'place', reason: null, text: '' }, reasonChoices(holds))?.key).toBe('holds.form.pickReason')
    expect(releaseProblem({ kind: 'release', holdId: 'x', text: '' })?.key).toBe('holds.form.whyNeeded')
  })

  it('places only on an open shipment, with the right', () => {
    expect(placeHeld(holds, held.can, false)).toBeNull()
    expect(placeHeld({ ...holds, status: 'SHIPPED' }, held.can, false)?.key).toBe('holds.held.notOpen')
    expect(placeHeld(holds, { holdsManage: false, holdsRelease: false }, false)?.key).toBe('holds.held.noManage')
  })

  it('the list\'s Hold leaves out what has left, and needs a reason', () => {
    const bulk = caseOf(holdsScreen, 'bulk').bulk!
    expect(bulkProblem(bulk)?.key).toBe('holds.form.pickReason')
    expect(bulkProblem({ ...bulk, reason: 'QUALITY' })).toBeNull()
    expect(bulkProblem({ ...bulk, reason: 'QUALITY', picked: bulk.picked.filter((row) => row.status === 'SHIPPED') })?.key).toBe('holds.bulk.noneOpen')
  })
})

describe('split (SCR-593)', () => {
  const model = caseOf(splitScreen, 'hand-ready')
  const preview = ready(model.preview)
  it('moves only what may move, something stays, a reason is asked', () => {
    expect(handTotals(preview, model.quantities)).toEqual({ moving: 3, staying: 7 })
    expect(splitHeld(model, preview)).toBeNull()
    expect(splitHeld({ ...model, quantities: {} }, preview)?.key).toBe('split.held.pickGarments')
    expect(splitHeld({ ...model, reason: null }, preview)?.key).toBe('split.held.pickReason')
    expect(splitHeld(caseOf(splitScreen, 'hand-all'), ready(caseOf(splitScreen, 'hand-all').preview))?.key).toBe('split.refusal.NOTHING_STAYS')
    expect(splitHeld(caseOf(splitScreen, 'rule-one-day'), ready(caseOf(splitScreen, 'rule-one-day').preview))?.key).toBe('split.refusal.ONE_DAY')
  })

  it('sends the lines that move and the new carrier when it is the reason', () => {
    expect(handBody(model, preview)).toEqual({ version: 3, reason: 'PART_READY', lines: [{ lineId: preview.lines[1]!.id, quantity: 3 }] })
    const carrier = caseOf(splitScreen, 'hand-carrier')
    expect(handBody(carrier, preview)).toMatchObject({ reason: 'CARRIER', transportBy: 'CARRIER', carrierCode: 'demo-express' })
  })
})

describe('cartons (SCR-594)', () => {
  const model = caseOf(cartonsScreen, 'packed')
  const bench = ready(model.bench)
  it('names a closed carton n of N, an open one by its place; groups the contents by size', () => {
    expect(cartonName(bench.cartons[1]!)).toEqual({ key: 'cartons.nOfN', params: { n: 2, count: 3 } })
    const draft = ready(caseOf(cartonsScreen, 'draft').bench)
    expect(cartonName(draft.cartons[1]!)).toEqual({ key: 'cartons.open', params: { n: 2 } })
    expect(contentsBySize(bench.cartons[1]!.contents)).toEqual([
      { key: 'DEMO-JKT|BLK', style: 'DEMO-JKT · Black', sizes: '52×1, 54×1', serials: 2 },
      { key: 'DEMO-PNT|BLK', style: 'DEMO-PNT · Black', sizes: '50×2', serials: 0 },
    ])
    expect(marksState(draft.cartons[1]!)).toBe('open')
    expect(marksState({ closed: true, marksCurrent: false, marksPrintedAt: '2026-11-14T10:00:00.000Z' })).toBe('stale')
  })

  it('holds weighing a labelled carton and removing a full one', () => {
    const labelled = caseOf(cartonsScreen, 'labelled')
    expect(weighHeld(labelled.context, bench.cartons[0]!)?.key).toBe('cartons.held.labelled')
    const draft = caseOf(cartonsScreen, 'draft')
    const draftBench = ready(draft.bench)
    expect(removeHeld(draft.context, draftBench.cartons[0]!)?.key).toBe('cartons.held.notEmpty')
    expect(removeHeld(draft.context, draftBench.cartons[2]!)).toBeNull()
    expect(stepOf(bench, bench.cartons[0]!.id, 1)).toBe(bench.cartons[1]!.id)
    expect(stepOf(bench, bench.cartons[2]!.id, 1)).toBeNull()
  })
})

describe('carrier & label (SCR-595)', () => {
  it('says each check problem in words, the address field by name', () => {
    const check = ready(caseOf(carrierScreen, 'check-problems').transport!.check!)
    const words = allProblems(check).map((problem) => checkProblemWords(problem, check.carrier.name).key)
    expect(words).toEqual(['check.POSTAL_CODE', 'check.PHONE_NEEDED_eu', 'check.TOO_HEAVY'])
    expect(checkProblemWords({ code: 'SENDER_INCOMPLETE', parcelSeq: null, path: 'sender/postalCode', params: {} }, 'X').key).toBe('check.incomplete.sender.postalCode')
  })

  it('our van sends no carrier; a carrier by hand needs its name; a typed time is not in the future', () => {
    expect(arrangeBody({ kind: 'arrange', mode: 'OWN_VAN', carrierName: 'x', trackingNumber: 'y' }, 4)).toEqual({ version: 4, mode: 'OWN_VAN' })
    expect(arrangeBody({ kind: 'arrange', mode: 'MANUAL_CARRIER', carrierName: ' Demo ', trackingNumber: '' }, 4)).toEqual({ version: 4, mode: 'MANUAL_CARRIER', carrierName: 'Demo', trackingNumber: null })
    expect(arrangeProblem({ kind: 'arrange', mode: 'MANUAL_CARRIER', carrierName: '', trackingNumber: '' })?.key).toBe('transport.form.carrierNeeded')
    const ownVan = ready(caseOf(carrierScreen, 'own-van').transport!.transport)
    expect(statusProblem({ kind: 'status', status: 'DELIVERED', occurredAt: '2099-01-01T10:00:00.000Z', description: '', location: '' }, ownVan)?.key).toBe('transport.form.future')
    expect(statusProblem({ kind: 'status', status: 'DELIVERED', occurredAt: '2026-11-15T06:00:00.000Z', description: '', location: '' }, ownVan, new Date('2026-11-16T00:00:00.000Z'))?.key).toBe('transport.form.beforeLeft')
    expect(mayHeld(ownVan.may.arrange, true)?.key).toBe('transport.refusal.LEFT')
  })

  it('a reprint asks 3 to 200 characters on one line, only reprintable jobs, newest per parcel and kind', () => {
    expect(reasonProblem('ok')?.key).toBe('reprint.form.reasonShort')
    expect(reasonProblem('Torn label')).toBeNull()
    expect(reasonProblem('a\nb c')?.key).toBe('reprint.form.oneLine')
    const model = caseOf(carrierScreen, 'reprint').reprint!
    const jobs = ready(model.jobs)
    expect(newestReprintable(jobs)).toHaveLength(3)
    const marks = jobs.parcels[1]!.jobs[0]!
    expect(reprintHeld({ ...model, picked: [marks.jobId] })?.key).toBe('reprint.held.notReprintable')
    expect(reprintHeld({ ...model, picked: [] })?.key).toBe('reprint.held.pickOne')
  })
})

describe('papers, delivery, notice (SCR-596 … SCR-598)', () => {
  it('names the pack\'s parts and holds Make and print without a printer', () => {
    const model = caseOf(papersScreen, 'all')
    const pack = ready(model.pack!)
    expect(partWords(pack.parts[2]!)).toEqual({ key: 'pack.ready.numbered', params: { number: '153/2026', count: 1 } })
    expect(packHeld(model, pack, true)).toBeNull()
    expect(packHeld(model, { ...pack, printer: null }, true)?.key).toBe('pack.held.noPrinter')
    expect(proformaBlockers(['DEMO-JKT BLK 52: no order line prices it.', 'SH-1 is cancelled: it has no proforma.'])).toEqual([{ key: 'proforma.problem.noPrice' }, { key: 'proforma.problem.cancelled' }])
    expect(proformaHeld({ can: { ...model.can, price: false }, busy: false }, ready(model.proformas!))?.key).toBe('proforma.held.noRight')
  })

  it('records only the parts still open of a delivered shipment', () => {
    const typed = caseOf(podScreen, 'typed')
    const pod = ready(typed.pod)
    expect(openParts(pod)).toEqual({ signer: true, time: true, image: true })
    expect(recordHeld(pod, typed.can, false)).toBeNull()
    expect(recordHeld(ready(caseOf(podScreen, 'kept').pod), typed.can, false)?.key).toBe('pod.held.kept')
    expect(podProblem({ kind: 'pod', signedBy: '', signedAt: null, file: null }, pod, typed.can)?.key).toBe('pod.form.nothing')
    expect(podProblem({ kind: 'pod', signedBy: '', signedAt: null, file: { name: 'a.gif', type: 'image/gif', size: 10 } }, pod, typed.can)?.key).toBe('pod.form.type')
    const problems = ready(caseOf(podScreen, 'travelling').problems)
    expect(resolveHeld(problems.problems[2]!, typed.can, false)?.key).toBe('problems.held.resolved')
  })

  it('holds Send again with the API\'s code; says the outcome', () => {
    expect(sendHeld(ready(caseOf(noticeScreen, 'not-left').notice), false)?.key).toBe('notice.why.NOT_LEFT')
    expect(sendHeld(ready(caseOf(noticeScreen, 'read-only').notice), false)?.key).toBe('notice.held.noManage')
    expect(automaticWords(ready(caseOf(noticeScreen, 'off').notice)).key).toBe('notice.auto.off')
    expect(sentWords({ sent: 1, failed: 1, skipped: [], notice: ready(caseOf(noticeScreen, 'sent').notice) }).key).toBe('notice.outcome.failed')
  })
})

describe('refusals in this step\'s words', () => {
  it('reads refusal/<CODE>, a moved version, a missing right', () => {
    expect(refusalOf(conflict('ALREADY_HELD'))).toBe('ALREADY_HELD')
    expect(writeWords(conflict('ALREADY_HELD'), 'holds.refusal', ['ALREADY_HELD']).key).toBe('holds.refusal.ALREADY_HELD')
    expect(writeWords(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'version', message: 'x' }]), 'holds.refusal', []).key).toBe('problem.write.moved')
    expect(writeWords(new ApiError('forbidden', 403, 'forbidden', 'x'), 'holds.refusal', []).key).toBe('problem.write.forbidden')
    expect(writeWords(new Error('offline'), 'holds.refusal', []).key).toBe('problem.write.internal')
  })
})

// ---- every design case in it and en: no key left on screen -----------------------------------------------------------------

const TOP = [...new Set(Object.keys(CATALOGUE.en['warehouse-shipments-depth'] ?? {}).map((key) => key.split('.')[0]!))]
const LEFT_KEY = new RegExp(`(?:^|[\\s>"(])(?:${TOP.join('|')})\\.[a-zA-Z]+(?:\\.[a-zA-Z_]+)*`)
const NAMESPACES = ['shipments', 'lists', 'records', 'shell', 'ds-words']

describe('SCR-590 … SCR-598 draw every case in both languages', () => {
  const parts = [holdsScreen, splitScreen, cartonsScreen, carrierScreen, papersScreen, podScreen, noticeScreen] as const
  for (const locale of LOCALES) {
    it(`every case in ${locale}: no key left`, () => {
      const draw = (element: ReturnType<typeof createElement>) => renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, NAMESPACES) }, element))
      for (const screen of parts) {
        for (const item of screen.cases) {
          const html = draw(createElement(screen.view as never, { model: item.model }))
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen} ${item.id} (${locale})`).toBeNull()
        }
      }
      for (const screen of [queueScreen, searchScreen]) {
        for (const item of screen.cases) {
          const html = draw(createElement(ShipmentsListView, { model: item.model.list }))
          expect(html.length, item.id).toBeGreaterThan(200)
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen} ${item.id} (${locale})`).toBeNull()
        }
      }
    })
  }
})
