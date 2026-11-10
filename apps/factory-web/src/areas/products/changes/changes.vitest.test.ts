import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CHANGE_ORDER_STATUSES, CHANGE_PRIORITIES, CHANGE_REQUEST_SOURCES, CHANGE_REQUEST_STATUSES, WIP_DISPOSITIONS } from '@nexus/factory-domain/product/changes/rules'
import { CHANGE_KINDS, CHANGE_ROWS, CHANGE_TILES } from '@nexus/factory-domain/product/changes/screens'
import { SECTION_IDS } from '@nexus/factory-domain/product/versions/compare'
import { ApiError } from '../../../lib/api/errors'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { listAddress, recordAddress } from '../../../lib/records/record-links'
import { permissionCheck } from '../../../lib/session/session'
import { OFFICE_PAGES, officeNavFor } from '../../../shell/nav/office-nav'
import { DRAFT_ORDER, JACKET_DETAIL, ME, ORDER, ORDERS, readOf, REQUEST, REQUESTS, ROLE_PERMISSIONS, SMV } from './demo/fixtures'
import { designScreen as listScreen } from './fixtures'
import {
  actionHeld,
  addressOf,
  addressText,
  approversHeld,
  approversOf,
  changesCan,
  decideHeld,
  decideHeldOfRow,
  emptyNewOrder,
  emptyNewRequest,
  HOME_ADDRESS,
  KNOWN_REFUSALS,
  linkable,
  newOrderBody,
  newOrderHeld,
  newRequestBody,
  newRequestHeld,
  noticesOf,
  orderChanges,
  orderDraftOf,
  requestChanges,
  requestDraftOf,
  requestEditable,
  rowOfOrder,
  rowOfRequest,
  rowOfSmv,
  rowsOf,
  sameWip,
  sourceHeld,
  tileCounts,
  wipBody,
  wipLinesOf,
  writeProblem,
} from './model'
import { designScreen as recordScreen } from './record/fixtures'

const owner = changesCan(ROLE_PERMISSIONS.owner)

describe('who may do what, by the role templates', () => {
  it('production writes, triages and approves; quality raises and approves; sales and the planner raise and read; the warehouse has no page', () => {
    const production = changesCan(ROLE_PERMISSIONS.production)
    expect([production.view, production.request, production.manage, production.approve]).toEqual([true, true, true, true])
    const quality = changesCan(ROLE_PERMISSIONS.quality)
    expect([quality.view, quality.request, quality.manage, quality.approve]).toEqual([true, true, false, true])
    const sales = changesCan(ROLE_PERMISSIONS.sales)
    expect([sales.view, sales.request, sales.manage, sales.approve, sales.smvView]).toEqual([true, true, false, false, false])
    const planner = changesCan(ROLE_PERMISSIONS.planner)
    expect([planner.view, planner.manage, planner.approve]).toEqual([true, false, false])
    expect(changesCan(ROLE_PERMISSIONS.warehouse).view).toBe(false)
  })
})

describe('the address: one filter model (the tiles are saved rows)', () => {
  it('reads and writes every term; ALL is no term; nonsense is dropped', () => {
    const style = JACKET_DETAIL.id
    const read = addressOf(new URLSearchParams(`view=released&tile=TO_RELEASE&kind=order&styleId=${style}&q=collar&new=1&decide=order:${ORDER.id}`))
    expect(read).toMatchObject({ view: 'released', tile: 'TO_RELEASE', kind: 'order', style, q: 'collar', isNew: true, decide: `order:${ORDER.id}` })
    expect(addressText(read)).toBe(`?view=released&style=${style}&q=collar&new=1&decide=order%3A${ORDER.id}`)
    expect(addressOf(new URLSearchParams('tile=ALL&kind=nope&style=x&decide=bad'))).toEqual(HOME_ADDRESS)
    expect(addressText({ ...HOME_ADDRESS, tile: 'MINE_TO_APPROVE', kind: 'smv' })).toBe('?tile=MINE_TO_APPROVE&kind=smv')
  })

  it('the saved rows and tiles are the domain’s', () => {
    expect(CHANGE_TILES.every((tile) => (CHANGE_ROWS as readonly string[]).includes(tile))).toBe(true)
    expect([...CHANGE_KINDS]).toEqual(['request', 'order', 'smv'])
  })
})

describe('one list over three reads', () => {
  it('every change newest first; to triage keeps the API’s order (most urgent first); a kind keeps one read', () => {
    const all = rowsOf(readOf(), HOME_ADDRESS)
    expect(all).toHaveLength(REQUESTS.length + ORDERS.length + SMV.length)
    expect([...all].sort((a, b) => b.at.localeCompare(a.at)).map((row) => row.id)).toEqual(all.map((row) => row.id))
    const triage = rowsOf(readOf(REQUESTS.slice(0, 2), [], null), { ...HOME_ADDRESS, tile: 'TO_TRIAGE' })
    expect(triage.map((row) => row.recordId)).toEqual([REQUESTS[0]!.id, REQUESTS[1]!.id])
    expect(rowsOf(readOf(), { ...HOME_ADDRESS, kind: 'smv' }).every((row) => row.kind === 'smv')).toBe(true)
  })

  it('waiting for my approval lists the SMV changes I may decide; a style filter leaves SMV changes out and says so', () => {
    const mine = rowsOf(readOf([], [ORDERS[0]!], SMV), { ...HOME_ADDRESS, tile: 'MINE_TO_APPROVE' })
    expect(mine.map((row) => row.kind)).toEqual(expect.arrayContaining(['order', 'smv']))
    expect(mine.filter((row) => row.kind === 'smv')).toHaveLength(1)
    const styled = { ...HOME_ADDRESS, style: JACKET_DETAIL.id }
    expect(rowsOf(readOf(), styled).some((row) => row.kind === 'smv')).toBe(false)
    expect(noticesOf(readOf(), styled, owner).map((one) => one.id)).toContain('smvStyle')
  })

  it('tiles: each the list’s total under that saved row; unknown is null ("—"), never 0', () => {
    expect(tileCounts(readOf())).toEqual({ TO_TRIAGE: 2, MINE_TO_APPROVE: 2, TO_RELEASE: 1, RELEASED_THIS_MONTH: 1 })
    expect(tileCounts(null)).toEqual({ TO_TRIAGE: null, MINE_TO_APPROVE: null, TO_RELEASE: null, RELEASED_THIS_MONTH: null })
  })

  it('notices: the most serious first; the SMV changes out of the role, failed or a list cut short', () => {
    const sales = changesCan(ROLE_PERMISSIONS.sales)
    expect(noticesOf(readOf(), HOME_ADDRESS, sales).map((one) => one.id)).toEqual(['smvRole'])
    const failed = { ...readOf(REQUESTS, ORDERS, null, false), smvFailed: true }
    expect(noticesOf(failed, HOME_ADDRESS, owner).map((one) => one.id)).toEqual(['smvFailed', 'incomplete'])
    expect(noticesOf(readOf(), { ...HOME_ADDRESS, view: 'released' }, owner)).toEqual([])
  })
})

describe('Approve change: held with the reason', () => {
  it('a request needs the triage right and to be undecided; an order the approve right, not its author, waiting; an SMV change a second person', () => {
    expect(decideHeldOfRow(rowOfRequest(REQUESTS[0]!), owner, ME, false)).toBeNull()
    expect(decideHeldOfRow(rowOfRequest(REQUESTS[0]!), changesCan(ROLE_PERMISSIONS.quality), ME, false)).toEqual({ key: 'held.noTriage' })
    expect(decideHeldOfRow(rowOfRequest(REQUESTS[3]!), owner, ME, false)?.key).toBe('held.requestDecided')
    expect(decideHeldOfRow(rowOfOrder(ORDERS[0]!), owner, ME, false)).toBeNull()
    expect(decideHeldOfRow(rowOfOrder({ ...ORDERS[0]!, authorId: ME }), owner, ME, false)).toEqual({ key: 'refusal.OWN_APPROVAL' })
    expect(decideHeldOfRow(rowOfOrder(ORDERS[2]!), owner, ME, false)?.key).toBe('held.orderNotWaiting')
    expect(decideHeldOfRow(rowOfSmv(SMV[1]!), owner, ME, false)).toEqual({ key: 'held.ownSmv' })
    expect(decideHeldOfRow(rowOfOrder(ORDERS[0]!), owner, ME, true)).toEqual({ key: 'held.offline' })
  })

  it('a rejection says why; a hold from the record wins', () => {
    expect(decideHeld('REJECTED', ' ', null)).toEqual({ key: 'refusal.REASON_NEEDED' })
    expect(decideHeld('REJECTED', 'Not tested on 56', null)).toBeNull()
    expect(decideHeld('APPROVED', '', { key: 'held.offline' })).toEqual({ key: 'held.offline' })
  })

  it('a record action is held for a missing right in its own words, else by the API’s refusal', () => {
    expect(actionHeld(ORDER, 'decide', changesCan(ROLE_PERMISSIONS.planner), false)).toEqual({ key: 'held.noApprove' })
    expect(actionHeld(ORDER, 'release', owner, false)).toEqual({ key: 'refusal.NOT_APPROVED' })
    expect(actionHeld(ORDER, 'decide', owner, false)).toBeNull()
  })
})

describe('New change request and New change order', () => {
  it('a request is held until its style, who asked, what and why; the body is what the API takes', () => {
    const draft = { ...emptyNewRequest(JACKET_DETAIL.id), source: 'CUSTOMER' as const }
    expect(newRequestHeld(draft, JACKET_DETAIL, owner, false)).toEqual({ key: 'new.heldCustomer' })
    expect(newRequestHeld({ ...draft, partyId: 'p1' }, JACKET_DETAIL, owner, false)).toEqual({ key: 'new.heldTitle' })
    const ready = { ...draft, partyId: 'p1', title: ' Collar 52 ', reason: 'Too tight', revisionId: JACKET_DETAIL.revisions[1]!.id }
    expect(newRequestHeld(ready, JACKET_DETAIL, owner, false)).toBeNull()
    expect(newRequestBody(ready, JACKET_DETAIL, 'c1')).toEqual({ styleId: JACKET_DETAIL.id, source: 'CUSTOMER', partyId: 'p1', revisionId: JACKET_DETAIL.revisions[1]!.id, title: 'Collar 52', reason: 'Too tight', priority: 'NORMAL' })
    expect(newRequestBody(ready, { ...JACKET_DETAIL, companyId: null }, 'c1').companyId).toBe('c1')
    expect(sourceHeld('CUSTOMER', changesCan(ROLE_PERMISSIONS.planner))).toEqual({ key: 'held.needs', params: { right: 'right.parties.view' } })
    expect(sourceHeld('SAMPLE', changesCan(['product.changes.view', 'product.changes.request']))).toEqual({ key: 'held.needs', params: { right: 'right.sales.samples.view' } })
  })

  it('a change order needs the style’s released revision and its day when it takes effect from a date; it carries only free requests', () => {
    const draft = { ...emptyNewOrder(JACKET_DETAIL.id, [REQUESTS[1]!.id]), title: 'Piping', reason: 'Brand' }
    expect(newOrderHeld(draft, JACKET_DETAIL, owner, false)).toBeNull()
    expect(newOrderHeld(draft, { ...JACKET_DETAIL, revisions: [{ id: 'r', revision: 1, status: 'DRAFT' }] }, owner, false)).toEqual({ key: 'refusal.NO_RELEASED_REVISION' })
    expect(newOrderHeld({ ...draft, effect: 'DATE' }, JACKET_DETAIL, owner, false)).toEqual({ key: 'refusal.EFFECT_DATE' })
    expect(newOrderBody({ ...draft, effect: 'DATE', effectiveDate: '2026-11-20' }, JACKET_DETAIL, null)).toEqual({ styleId: JACKET_DETAIL.id, title: 'Piping', reason: 'Brand', priority: 'NORMAL', effect: 'DATE', effectiveDate: '2026-11-20', requestIds: [REQUESTS[1]!.id] })
    expect(REQUESTS.filter(linkable).map((one) => one.id)).toEqual([REQUESTS[0]!.id, REQUESTS[1]!.id])
  })
})

describe('the record saves only what changed', () => {
  it('a request: all until decided, the priority alone once accepted, none after', () => {
    expect(requestEditable(REQUEST, owner, false).fields).toBe('all')
    expect(requestEditable({ status: 'ACCEPTED' }, owner, false).fields).toBe('priority')
    expect(requestEditable({ status: 'DONE' }, owner, false).fields).toBe('none')
    expect(requestChanges(REQUEST, requestDraftOf(REQUEST)).body).toBeNull()
    expect(requestChanges(REQUEST, { ...requestDraftOf(REQUEST), priority: 'LOW', revisionId: '' })).toEqual({ body: { version: REQUEST.version, priority: 'LOW', revisionId: null }, count: 2, problem: null })
  })

  it('a change order: what, why, when while a draft; the priority after; a day only with DATE', () => {
    expect(orderChanges(DRAFT_ORDER, { ...orderDraftOf(DRAFT_ORDER), effect: 'DATE', effectiveDate: '' }).problem).toEqual({ key: 'refusal.EFFECT_DATE' })
    expect(orderChanges(DRAFT_ORDER, { ...orderDraftOf(DRAFT_ORDER), description: ' New ', effect: 'DATE', effectiveDate: '2026-11-20' }).body).toEqual({ version: DRAFT_ORDER.version, description: 'New', effect: 'DATE', effectiveDate: '2026-11-20' })
    expect(orderChanges(ORDER, { ...orderDraftOf(ORDER), title: 'Other', priority: 'URGENT' }).body).toEqual({ version: ORDER.version, priority: 'URGENT' })
  })

  it('approvers never name the author; the work in progress is the whole list of decided work orders', () => {
    expect(approversHeld(DRAFT_ORDER, [{ userId: ME, name: 'Me', required: true, decided: false }], owner, false)).toEqual({ key: 'refusal.OWN_APPROVAL' })
    expect(approversHeld(ORDER, approversOf(ORDER), owner, false)).toBeNull()
    const lines = wipLinesOf(ORDER)
    expect(lines.map((line) => line.disposition)).toEqual(['FINISH_OLD', 'REWORK', ''])
    expect(sameWip(ORDER, lines)).toBe(true)
    const changed = lines.map((line) => (line.disposition === '' ? { ...line, disposition: 'HOLD' as const } : line))
    expect(sameWip(ORDER, changed)).toBe(false)
    expect(wipBody(changed)).toHaveLength(3)
  })

  it('a refusal is said by its code; a stale version reads again', () => {
    expect(writeProblem(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'refusal/OWN_APPROVAL' }]))).toMatchObject({ key: 'refusal.OWN_APPROVAL', stale: false })
    expect(writeProblem(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'refusal/SOMETHING_NEW' }])).key).toBe('refusal.other')
    expect(writeProblem(new ApiError('conflict', 409, 'conflict', 'x', null, [])).stale).toBe(true)
    expect(writeProblem(new ApiError('invalid', 400, 'invalid', 'x', null, [{ path: 'body/approvers/0/userId' }])).paths).toEqual(['approvers/0/userId'])
  })
})

describe('words and navigation', () => {
  it('every code, status, source, priority, kind, row, tile, part and disposition has words in both languages', () => {
    for (const locale of LOCALES) {
      const words = CATALOGUE[locale]['products-changes']!
      const keys = [
        ...KNOWN_REFUSALS.map((code) => `refusal.${code}`),
        ...CHANGE_REQUEST_STATUSES.map((status) => `request.${status}`),
        ...CHANGE_ORDER_STATUSES.map((status) => `order.${status}`),
        ...CHANGE_REQUEST_SOURCES.map((source) => `source.${source}`),
        ...CHANGE_PRIORITIES.map((priority) => `priority.${priority}`),
        ...CHANGE_KINDS.map((kind) => `kind.${kind}`),
        ...CHANGE_ROWS.map((row) => `rows.${row}`),
        ...CHANGE_TILES.flatMap((tile) => [`tile.${tile}`, `tile.hint.${tile}`]),
        ...SECTION_IDS.map((section) => `section.${section}`),
        ...WIP_DISPOSITIONS.map((disposition) => `disposition.${disposition}`),
      ]
      for (const key of keys) expect(words[key], `${locale} ${key}`).toBeTruthy()
    }
  })

  it('the page is built, in the navigation of the roles that read it; a change request and a change order open their records', () => {
    expect(OFFICE_PAGES.has('/products/changes')).toBe(true)
    expect(recordAddress({ type: 'ChangeRequest', id: 'r1' }, OFFICE_PAGES)).toBe('/products/changes/requests/r1')
    expect(recordAddress({ type: 'ChangeOrder', id: 'o1' }, OFFICE_PAGES)).toBe('/products/changes/orders/o1')
    expect(listAddress('/product/change-orders', { tile: 'MINE_TO_APPROVE' }, OFFICE_PAGES)).toBe('/products/changes?tile=MINE_TO_APPROVE')
    const rows = (permissions: readonly string[]) => officeNavFor(permissionCheck([...permissions])).areas.flatMap((area) => (area.sections ?? []).flatMap((section) => section.items.map((item) => item.href)))
    expect(rows(ROLE_PERMISSIONS.quality)).toContain('/products/changes')
    expect(rows(ROLE_PERMISSIONS.warehouse)).not.toContain('/products/changes')
  })
})

const LEFT_KEY = /\b(?:common|held|list|record|tile|rows|view|notice|new|newOrder|tab|live|row|col|keys|kind|request|order|smv|smvSource|smvRun|source|priority|effect|decision|revision|disposition|document|section|cmp|refusal|problem|decide|redline|impact|approvals|approvers|affected|photos|activity|dialog|released|field|right|person|raised|noAccess|style)\.[a-zA-Z]+(?:\.[a-zA-Z_]+)*\b/

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
            .replace(/\b(?:product|products|files|example|sales|parties)\.[a-z]+(?:\.[a-z]+)?\b/g, '')
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
        }
      })
    }
  }
})
