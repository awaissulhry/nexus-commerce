import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DECISION_REFUSALS } from '@nexus/factory-domain/sales/sample-decisions/rules'
import { BOARD_LANES as DOMAIN_LANES, ROUND_TILES, SAMPLE_DECISIONS, SAMPLE_KINDS, SAMPLE_REFUSALS, SAMPLE_STAGES } from '@nexus/factory-domain/sales/samples/rules'
import { ApiError } from '../../../lib/api/errors'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { listAddress, recordAddress } from '../../../lib/records/record-links'
import { permissionCheck } from '../../../lib/session/session'
import { OFFICE_PAGES, officeNavFor } from '../../../shell/nav/office-nav'
import { FIT, JACKET_DETAIL, ROLE_PERMISSIONS, ROUND, ROWS, WO_OPTIONS, WO_OPTIONS_NONE } from './demo/fixtures'
import { designScreen as listScreen } from './fixtures'
import {
  addressOf,
  addressText,
  ANY_COLOUR,
  approvalHeld,
  BOARD_LANES,
  boardMoveHeld,
  boardRowsOf,
  cellsOfGrid,
  chargeEditText,
  decideDraftHeld,
  decideHeldOfRow,
  dueOf,
  emptyNewDraft,
  fitCellEditable,
  fitHeld,
  fitRowsOf,
  gridOfCells,
  HOME_ADDRESS,
  KNOWN_REFUSALS,
  KNOWN_RIGHTS,
  newBodyOf,
  newDraftHeld,
  parseCharge,
  requestChanges,
  requestDraftOf,
  samplesCan,
  shipmentCellHeld,
  shipmentValueProblem,
  writeProblem,
} from './model'
import { designScreen as recordScreen } from './record/fixtures'
import { workOrderFacts } from './record/view/RecordDialogs'

const owner = samplesCan(ROLE_PERMISSIONS.owner)

describe('who may do what, by the role templates', () => {
  it('sales asks, decides and ships but makes no work order; production makes and measures; the planner reads; the warehouse has no page', () => {
    const sales = samplesCan(ROLE_PERMISSIONS.sales)
    expect([sales.view, sales.manage, sales.decide, sales.measure, sales.workOrders]).toEqual([true, true, true, false, false])
    const production = samplesCan(ROLE_PERMISSIONS.production)
    expect([production.view, production.manage, production.decide, production.measure, production.workOrders]).toEqual([true, true, true, true, true])
    const planner = samplesCan(ROLE_PERMISSIONS.planner)
    expect([planner.view, planner.manage, planner.decide]).toEqual([true, false, false])
    expect(samplesCan(ROLE_PERMISSIONS.warehouse).view).toBe(false)
  })
})

describe('the address: the same filters for the board, the list and the calendar', () => {
  it('reads and writes every term; the board is the page with no term; nonsense is dropped', () => {
    const id = ROWS[0]!.style.id
    const address = addressOf(new URLSearchParams(`tile=LATE&kind=FIT&internal=1&style=${id}&revision=${ROWS[0]!.revision.id}&q=jacket&mode=calendar&new=1`))
    expect(address).toEqual({ tile: 'LATE', kind: 'FIT', party: null, internal: true, style: id, revision: ROWS[0]!.revision.id, q: 'jacket', mode: 'calendar', isNew: true })
    expect(addressOf(new URLSearchParams(addressText(address)))).toEqual(address)
    expect(addressOf(new URLSearchParams('tile=NOPE&kind=x&style=not-an-id&mode=cards'))).toEqual(HOME_ADDRESS)
    expect(addressText(HOME_ADDRESS)).toBe('')
    expect(addressText({ ...HOME_ADDRESS, mode: 'table' })).toBe('?mode=table')
  })

  it('the tiles and lanes are the API’s own', () => {
    expect([...BOARD_LANES]).toEqual([...DOMAIN_LANES])
    expect(ROUND_TILES).toContain('WAITING_DECISION')
  })
})

describe('the board', () => {
  it('a cancelled round is off the board; Decided is reached only by the decision; closed rounds do not move', () => {
    expect(boardRowsOf(ROWS).some((row) => row.stage === 'CANCELLED')).toBe(false)
    expect(boardMoveHeld(ROWS[0]!, 'IN_MAKING', owner, false)).toBeNull()
    expect(boardMoveHeld(ROWS[0]!, 'DECIDED', owner, false)?.key).toBe('held.decideNotDrag')
    expect(boardMoveHeld(ROWS[5]!, 'SENT', owner, false)?.key).toBe('held.decided')
    expect(boardMoveHeld(ROWS[0]!, 'SENT', samplesCan(ROLE_PERMISSIONS.planner), false)?.key).toBe('held.noManage')
    expect(boardMoveHeld(ROWS[0]!, 'SENT', owner, true)?.key).toBe('held.offline')
  })

  it('Decide… waits until something is made, and needs the right', () => {
    expect(decideHeldOfRow(ROWS[0]!, owner, false)?.key).toBe('refusal.NOTHING_MADE')
    expect(decideHeldOfRow(ROWS[2]!, owner, false)).toBeNull()
    expect(decideHeldOfRow(ROWS[2]!, samplesCan(ROLE_PERMISSIONS.planner), false)?.key).toBe('held.noDecide')
  })

  it('due words: late in the danger tone, today, within a week, else the day', () => {
    expect(dueOf(ROWS[1]!, '2026-11-10')).toEqual({ key: 'due.late', params: { count: 3 }, tone: 'danger' })
    expect(dueOf({ dueDate: '2026-11-10', daysLate: null, stage: 'SENT' }, '2026-11-10')?.key).toBe('due.today')
    expect(dueOf({ dueDate: '2026-11-13', daysLate: null, stage: 'SENT' }, '2026-11-10')).toEqual({ key: 'due.in', params: { count: 3 }, tone: 'neutral' })
    expect(dueOf({ dueDate: '2026-12-13', daysLate: null, stage: 'SENT' }, '2026-11-10')?.key).toBe('due.on')
    expect(dueOf({ dueDate: null, daysLate: null, stage: 'SENT' }, '2026-11-10')).toBeNull()
  })
})

describe('New sample request', () => {
  it('cells: a grid of colourways × sizes (with "any colourway") and back', () => {
    const grid = gridOfCells(ROUND.cells)
    expect(cellsOfGrid(grid, [], [])).toEqual([{ colourwayId: ROUND.cells[0]!.colourwayId, size: '52', quantity: 2 }, { colourwayId: ROUND.cells[0]!.colourwayId, size: '54', quantity: 1 }])
    expect(cellsOfGrid({ [ANY_COLOUR]: { M: 1, L: 0 } }, [], [])).toEqual([{ size: 'M', quantity: 1 }])
  })

  it('is held until a style and a piece are named; the body is what the API takes (latest revision by default)', () => {
    const draft = { ...emptyNewDraft(JACKET_DETAIL.id), kind: 'FIT' as const, partyId: JACKET_DETAIL.brand!.id, charge: '95,50', dueDate: '2026-11-20' }
    expect(newDraftHeld(emptyNewDraft(), null, owner, false)?.key).toBe('new.held.style')
    expect(newDraftHeld(draft, JACKET_DETAIL, owner, false)?.key).toBe('new.held.cells')
    const ready = { ...draft, grid: { [JACKET_DETAIL.colourways[0]!.id]: { '52': 2 } } }
    expect(newDraftHeld(ready, JACKET_DETAIL, owner, false)).toBeNull()
    expect(newDraftHeld({ ...ready, partyId: null }, JACKET_DETAIL, owner, false)?.key).toBe('refusal.CHARGE_INTERNAL')
    expect(newDraftHeld({ ...ready, testZones: 'palm' }, JACKET_DETAIL, owner, false)?.key).toBe('refusal.CERTIFICATION_ONLY')
    expect(newDraftHeld({ ...ready, roundNo: '0' }, JACKET_DETAIL, owner, false)?.key).toBe('new.held.roundNo')
    expect(newBodyOf(ready, JACKET_DETAIL, null, owner)).toEqual({
      styleId: JACKET_DETAIL.id,
      kind: 'FIT',
      cells: [{ colourwayId: JACKET_DETAIL.colourways[0]!.id, size: '52', quantity: 2 }],
      partyId: JACKET_DETAIL.brand!.id,
      dueDate: '2026-11-20',
      chargeAmountMinor: 9550,
      chargeCurrency: 'EUR',
    })
    // Without the price grain the charge is never sent.
    expect(newBodyOf(ready, JACKET_DETAIL, null, samplesCan(ROLE_PERMISSIONS.production))).not.toHaveProperty('chargeAmountMinor')
  })

  it('a charge is typed as an amount in either language', () => {
    expect(parseCharge('95', 'EUR')).toBe(9500)
    expect(parseCharge('1.250,50', 'EUR')).toBe(125050)
    expect(parseCharge('1,250.50', 'EUR')).toBe(125050)
    expect(parseCharge('9,999', 'EUR')).toBe('bad')
    expect(parseCharge('abc', 'EUR')).toBe('bad')
    expect(parseCharge('', 'EUR')).toBeNull()
    expect(chargeEditText(9550, 'EUR', 'it')).toBe('95,50')
  })
})

describe('the Request saves only what changed', () => {
  it('nothing changed: nothing sent; a due day and the cells: one body with the version', () => {
    const draft = requestDraftOf(ROUND, 'en')
    expect(requestChanges(ROUND, draft, owner)).toEqual({ body: null, count: 0, problem: null })
    const changed = requestChanges(ROUND, { ...draft, dueDate: '2026-11-18', grid: { ...draft.grid, [ANY_COLOUR]: { '50': 1 } } }, owner)
    expect(changed.count).toBe(2)
    expect(changed.body).toMatchObject({ version: ROUND.version, dueDate: '2026-11-18' })
    expect(requestChanges(ROUND, { ...draft, charge: 'x' }, owner).problem?.key).toBe('new.held.charge')
    expect(requestChanges(ROUND, { ...draft, grid: {} }, owner).problem?.key).toBe('new.held.cells')
  })
})

describe('the fit, the approval, shipments, the work order', () => {
  it('a fit cell is typed only in the spec, while the fit is open, by whoever measures', () => {
    const rows = fitRowsOf(FIT)
    expect(rows.map((row) => row.code)).toEqual(['CHEST_W', 'SLEEVE_LEN', 'BACK_LEN', 'COLLAR'])
    expect(fitCellEditable(FIT, rows[0]!, '52', owner, false)).toBe(true)
    expect(fitCellEditable(FIT, rows[0]!, '52', samplesCan(ROLE_PERMISSIONS.sales), false)).toBe(false)
    expect(fitCellEditable({ ...FIT, editable: false }, rows[0]!, '52', owner, false)).toBe(false)
    expect(fitHeld({ ...FIT, editable: false, refusal: { code: 'FIT_CLOSED', message: '' } }, owner, false)?.key).toBe('refusal.FIT_CLOSED')
    expect(fitHeld({ ...FIT, spec: null }, owner, false)?.key).toBe('refusal.NO_SPEC')
  })

  it('an approval step held says the right it needs, else the rule; decide asks comments for the last two', () => {
    const view = { actions: { decide: { allowed: false, refusal: null, needs: 'sales.samples.decide' }, askBrand: { allowed: false, refusal: { code: 'BRAND_ASKED' as const, message: '' }, needs: null }, nextRound: { allowed: true, refusal: null, needs: null }, testResult: { allowed: false, refusal: null, needs: 'nobody.knows' }, raiseChangeRequest: { allowed: true, refusal: null, needs: null } } }
    const held = (action: 'decide' | 'askBrand' | 'nextRound' | 'testResult') => approvalHeld(view as never, action, false)
    expect(held('decide')).toEqual({ key: 'held.needs', params: { right: 'right.sales.samples.decide' } })
    expect(held('askBrand')?.key).toBe('refusal.BRAND_ASKED')
    expect(held('nextRound')).toBeNull()
    expect(held('testResult')?.key).toBe('held.noRight')
    expect(decideDraftHeld({ decision: null, comments: '' })?.key).toBe('decide.held.pick')
    expect(decideDraftHeld({ decision: 'REJECTED', comments: ' ' })?.key).toBe('decide.held.comments')
    expect(decideDraftHeld({ decision: 'APPROVED', comments: '' })).toBeNull()
  })

  it('a shipment is sent and received once each, received after sent; the tracking page is https', () => {
    const shipment = ROUND.shipmentsList[0]!
    expect(shipmentCellHeld(ROUND, shipment, 'sentAt', owner, false)?.key).toBe('refusal.SENT_ONCE')
    expect(shipmentCellHeld(ROUND, { ...shipment, sentAt: null, receivedAt: null }, 'receivedAt', owner, false)?.key).toBe('refusal.RECEIVED_BEFORE_SENT')
    expect(shipmentCellHeld(ROUND, shipment, 'carrierName', owner, false)).toBeNull()
    expect(shipmentValueProblem('trackingUrl', 'http://x')?.key).toBe('ship.problem.url')
    expect(shipmentValueProblem('trackingUrl', 'https://x.example/1')).toBeNull()
  })

  it('the work order dialog says its facts in our words', () => {
    expect(workOrderFacts(WO_OPTIONS, [WO_OPTIONS.lines[0]!.id])).toEqual({ blockers: [], warnings: [{ key: 'wo.warning.draft', params: { revision: 1 } }] })
    // B-W2b-284: a charged customer round with no order line says both why (no line; made on one).
    expect(workOrderFacts(WO_OPTIONS_NONE, []).blockers.map((line) => line.key)).toEqual(['wo.blocker.noLinesCustomer', 'refusal.ORDER_LINE_NEEDED'])
    expect(workOrderFacts(WO_OPTIONS, []).blockers[0]?.key).toBe('wo.blocker.pickLine')
  })

  it('a refusal is said by its code; a stale version reads again', () => {
    expect(writeProblem(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'refusal/ROUND_CLOSED', message: 'x' }])).key).toBe('refusal.ROUND_CLOSED')
    expect(writeProblem(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'refusal/UNHEARD_OF' }])).key).toBe('refusal.other')
    expect(writeProblem(new ApiError('conflict', 409, 'conflict', 'x')).stale).toBe(true)
    expect(writeProblem(new ApiError('invalid', 400, 'invalid', 'x', null, [{ path: 'body/cells/0/size' }])).paths).toEqual(['cells/0/size'])
  })
})

describe('words and navigation', () => {
  it('every code, stage, kind, decision, tile and right has words in both languages', () => {
    expect(new Set(KNOWN_REFUSALS)).toEqual(new Set([...SAMPLE_REFUSALS, ...DECISION_REFUSALS]))
    for (const locale of LOCALES) {
      const words = CATALOGUE[locale]['products-samples']!
      for (const code of KNOWN_REFUSALS) expect(words[`refusal.${code}`], `${locale} refusal.${code}`).toBeTruthy()
      for (const stage of SAMPLE_STAGES) expect(words[`stage.${stage}`], `${locale} stage.${stage}`).toBeTruthy()
      for (const kind of SAMPLE_KINDS) expect(words[`kind.${kind}`], `${locale} kind.${kind}`).toBeTruthy()
      for (const decision of SAMPLE_DECISIONS) expect(words[`decision.${decision}`], `${locale} decision.${decision}`).toBeTruthy()
      for (const tile of ROUND_TILES) expect(words[`tile.${tile}`], `${locale} tile.${tile}`).toBeTruthy()
      for (const right of KNOWN_RIGHTS) expect(words[`right.${right}`], `${locale} right.${right}`).toBeTruthy()
    }
  })

  it('the page is built, in the navigation of the roles that read it, and a SampleRound opens its record', () => {
    expect(OFFICE_PAGES.has('/products/samples')).toBe(true)
    expect(recordAddress({ type: 'SampleRound', id: 'r1' }, OFFICE_PAGES)).toBe('/products/samples/r1')
    expect(listAddress('/sales/samples/rounds', { tile: 'LATE' }, OFFICE_PAGES)).toBe('/products/samples?tile=LATE')
    const rows = (permissions: readonly string[]) => officeNavFor(permissionCheck([...permissions])).areas.flatMap((area) => (area.sections ?? []).flatMap((section) => section.items.map((item) => item.href)))
    expect(rows(ROLE_PERMISSIONS.sales)).toContain('/products/samples')
    expect(rows(ROLE_PERMISSIONS.warehouse)).not.toContain('/products/samples')
  })
})

const LEFT_KEY = /\b(?:common|held|list|record|tile|new|tab|live|row|col|keys|board|due|owner|round|refusal|problem|decide|request|sample|wo|fit|approval|ship|cancel|next|change|test|grid|kind|stage|decision|revision|spec|swatch|right|field|noAccess|activity)\.[a-zA-Z]+(?:\.[a-zA-Z_]+)*\b/

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
}

describe('every design case draws in both languages with no key left on screen', () => {
  for (const screen of [listScreen, recordScreen] as DesignScreen<unknown>[]) {
    for (const locale of LOCALES) {
      it(`${screen.screen} in ${locale}: ${screen.cases.length} cases`, () => {
        for (const item of screen.cases) {
          const html = render(screen, item.model, locale)
            .replace(/https?:\/\/[^"\s<]+/g, '')
            .replace(/data:[^"]+/g, '')
            .replace(/\b(?:sales|product|products|files|example)\.[a-z]+(?:\.[a-z]+)?\b/g, '')
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
        }
      })
    }
  }
})
