import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, textOf } from '../../record-thread/parts/testing'
import { designScreen } from '../../../areas/sales/orders/record/fixtures'
import type { WorkOrderActsModel } from './use-work-order-acts'
import { WorkOrderActsDialogs } from './view/WorkOrderActsDialogs'
// ---- F-OO-108: Hold the whole order… — the domain plan, the body with every version, the dialog drawn
import { readFileSync } from 'node:fs'
import { ApiError } from '../../api/errors'
import type { ApiClient } from '../../api/client'
import { placeProductionHolds } from '../../../areas/production/work-orders/daily/api'
import { actsCanOf, orderHoldOf, orderHoldProblemOf, orderHoldWriteOf, type ActsRow } from './model'
// ---- end F-OO-108
// ---- F-OO-109: ONE Lift for N work orders — the holds sent with their versions, the dialog with the list, one = today's dialog
import { liftProductionHolds } from '../../../areas/production/work-orders/daily/api'
import { CUSTOMER_PAUSE, PLAIN_HOLD, plainHolds } from '../../../areas/production/work-orders/daily/demo/fixtures'
import { liftManyHeld, liftManyHoldsOf, liftManyProblemOf, type LiftManyWorkOrder } from './model'
import { LiftHoldDialog, type HoldParts } from './view/HoldDialog'
// ---- end F-OO-109

// The DS Modal draws only after it mounts in a browser: here a plain section, so a dialog's words are read on the server too (as the
// daily page's dialog tests do).
vi.mock('@nexus/ui/components', async (original) => {
  const actual = await original<typeof import('@nexus/ui/components')>()
  const Modal = ({ open, title, children, footer }: { open: boolean; title?: unknown; children?: unknown; footer?: unknown }) => (open ? createElement('section', { role: 'dialog', 'data-modal': '' }, createElement('h2', null, title as never), children as never, footer as never) : null)
  return { ...actual, Modal }
})

/**
 * F-OP-114 / F-OP-115 (10-order-page §5.2; review R-16) — the dialogs a work-order row's ⋯ opens on the order page, drawn from the
 * order record's design cases (made-up data). Cancel… with pieces cut says the API's own words and offers nothing to pick; Hold…
 * and Release… are the lib's one copy.
 */
const actsOf = (id: string): WorkOrderActsModel => (designScreen.cases.find((item) => item.id === id)!.model as { record: { workOrderActs: WorkOrderActsModel } }).record.workOrderActs
const draw = (id: string, locale: 'en' | 'it' = 'en') => render(createElement(WorkOrderActsDialogs, { model: actsOf(id) }), locale)

describe('F-OP-115: Cancel… from a work-order row (R-16)', () => {
  it('pieces cut: the API’s words that name the way out, no outcome picker and no reason to type; Cancel held with the same words', () => {
    const html = draw('wo-cancel-cut')
    const text = textOf(html)
    expect(text).toContain('8 pieces are cut: lower the work order to the cut instead')
    expect(html).not.toContain('<select')
    expect(html).not.toContain('<textarea')
    expect(text).toContain('Cancel work order')
    // What stays with it: the stock issued to it (until returned by hand).
    expect(text).toContain('Issued to it (it stays on it until returned by hand): DEMO-LEATHER-BLK 96.0 dm2')
    expect(textOf(draw('wo-cancel-cut', 'it'))).toContain("8 pezzi sono già tagliati: riduci l'ordine di lavoro al tagliato")
  })

  it('nothing cut: the reason is asked, then Cancel work order', () => {
    const html = draw('wo-cancel-draft')
    expect(html).toContain('<textarea')
    expect(textOf(html)).toContain('The draft stops; its pieces go back to the order lines.')
    expect(textOf(html)).not.toContain('pieces are cut')
  })
})

describe('F-OP-114: Hold… and Release… from a work-order row — the lib’s one copy', () => {
  it('Hold…: both reason lists as groups, the floor’s words, how it is lifted', () => {
    const html = draw('wo-hold-dialog')
    expect(html).toContain('<optgroup')
    const text = textOf(html)
    expect(text).toContain('Floor tablets refuse to start it and show the reason.')
    expect(textOf(draw('wo-hold-dialog', 'it'))).toContain('I tablet del reparto rifiutano di avviarlo e mostrano il motivo.')
  })

  it('Release…: the release check in the dialog, each condition in words, the open ones holding it', () => {
    const text = textOf(draw('wo-release-dialog'))
    for (const words of ['Release check', 'Style revision', 'Bill of materials', 'Sizes', 'Deposit']) expect(text, words).toContain(words)
    expect(text).toContain('Taking it back: cancel it with a reason; a different spec is a new work order.')
  })

  it('no key is left in either language', () => {
    for (const id of ['wo-cancel-cut', 'wo-cancel-draft', 'wo-hold-dialog', 'wo-release-dialog'])
      for (const locale of ['en', 'it'] as const) expect(textOf(draw(id, locale)), `${id} ${locale}`).not.toMatch(/\b(wo|hold|release|cancel|check|held|production)\.[a-zA-Z]+/)
  })
})


// ---- F-OO-108 (order overview §1.4; B-OO-005, review F13, F16): "Hold the whole order…" — the ONE plan, every version sent ----------
describe('F-OO-108: Hold the whole order… — the domain plan, the shared and not reached left out in words, every version sent', () => {
  const RIGHTS = { manage: true, release: true, hold: true, why: null }
  const row = (id: string, number: string, status: string, over: Partial<ActsRow> = {}): ActsRow => ({ id, number, status, held: false, rush: false, due: null, sharedWithOtherCustomers: false, version: 3, rights: RIGHTS, ...over })
  const SHARED = { en: 'Shared with other customers: change it on its page.', it: 'Condiviso con altri clienti: cambialo dalla sua pagina.' }

  it('the plan: the open own ones with their versions; a shared one and one held already left out with why; those not reached counted', () => {
    const plan = orderHoldOf(
      [row('w-1', 'WO-00021', 'IN_PROGRESS', { version: 7 }), row('w-2', 'WO-00022', 'RELEASED', { held: true, version: 4 }), row('w-3', 'WO-00019', 'RELEASED', { sharedWithOtherCustomers: true, rights: { manage: false, release: false, hold: false, why: SHARED } }), row('w-4', 'WO-00023', 'DRAFT', { version: 1 })],
      { leftOut: 1, waitingForYes: false },
    )
    expect([plan.ids, plan.numbers, plan.versions]).toEqual([['w-1', 'w-4'], ['WO-00021', 'WO-00023'], { 'w-1': 7, 'w-4': 1 }])
    expect(plan.left).toEqual([
      { id: 'w-2', number: 'WO-00022', words: { it: 'Già in sospeso.', en: 'On hold already.' } },
      { id: 'w-3', number: 'WO-00019', words: { it: 'Condiviso con altri clienti: mettilo in sospeso dalla sua pagina.', en: 'Shared with other customers: hold it on its page.' } },
    ])
    // F13: the one not reached is counted, never named (two cases, two sets of words).
    expect(plan.notReached).toBe(1)
    expect(JSON.stringify(plan.left)).not.toMatch(/outside|not reached/i)
    expect(plan.held).toBeNull()
  })

  it('held with words: Sales (no hold right) — Production does it; nothing to hold yet; every one on hold already', () => {
    const sales = orderHoldOf([row('w-1', 'WO-00021', 'IN_PROGRESS', { rights: { ...RIGHTS, hold: false } })], { leftOut: 0, waitingForYes: false })
    expect(sales.held?.code).toBe('NO_RIGHT')
    expect(orderHoldOf([], { leftOut: 0, waitingForYes: false }).held).toEqual({ code: 'NONE_YET', words: { it: 'Ancora niente da fermare: nessun ordine di lavoro è stato creato per questo ordine.', en: 'Nothing to hold yet: no work order is made for this order.' } })
    expect(orderHoldOf([row('w-1', 'WO-00021', 'ON_HOLD'), row('w-2', 'WO-00022', 'RELEASED', { held: true })], { leftOut: 0, waitingForYes: false }).held).toEqual({ code: 'ALL_ON_HOLD', words: { it: 'Ogni ordine di lavoro aperto di questo ordine è già in sospeso.', en: 'Every open work order of this order is on hold already.' } })
    // An older read without a version: never sent without one — not the reader's to hold from here.
    expect(orderHoldOf([row('w-1', 'WO-00021', 'IN_PROGRESS', { version: undefined })], { leftOut: 0, waitingForYes: false }).ids).toEqual([])
  })

  it('the body carries every version (a production reason); a quality reason sends one quality hold; the client posts the versions', async () => {
    const plan = { ids: ['w-1', 'w-4'], versions: { 'w-1': 7, 'w-4': 1 } }
    expect(orderHoldWriteOf(plan, { kind: 'PRODUCTION', reasonCode: 'LEATHER_CHECK', reasonNote: 'Tannery batch 12', customerWords: null })).toEqual({ route: 'production', body: { reasonCode: 'LEATHER_CHECK', note: 'Tannery batch 12', brandWords: null, workOrderIds: ['w-1', 'w-4'], versions: { 'w-1': 7, 'w-4': 1 } } })
    expect(orderHoldWriteOf(plan, { kind: 'QUALITY', reasonCode: 'SHADE', reasonNote: null, customerWords: null })).toEqual({ route: 'quality', body: { workOrderIds: ['w-1', 'w-4'], reasonCode: 'SHADE', reasonNote: null } })
    const posts: { path: string; body: unknown }[] = []
    const api = { post: async (path: string, options: { body: unknown }) => (posts.push({ path, body: options.body }), { holds: [], workOrders: [] }) } as unknown as ApiClient
    await placeProductionHolds(api, orderHoldWriteOf(plan, { kind: 'PRODUCTION', reasonCode: 'LEATHER_CHECK', reasonNote: null, customerWords: null }).body as never, 'key-1')
    expect(posts).toEqual([{ path: '/production/work-orders/holds', body: { reasonCode: 'LEATHER_CHECK', workOrderIds: ['w-1', 'w-4'], versions: { 'w-1': 7, 'w-4': 1 } } }])
    // Production's list sends none (B-OO-005 made them optional for it): its body is as it was.
    posts.length = 0
    await placeProductionHolds(api, { reasonCode: 'LEATHER_CHECK', note: null, brandWords: null, workOrderIds: ['w-1'] }, 'key-2')
    expect(posts).toEqual([{ path: '/production/work-orders/holds', body: { reasonCode: 'LEATHER_CHECK', workOrderIds: ['w-1'] } }])
  })

  it('a stale version (409 at body/versions/<id>, nothing held) is said by its number; anything else in the production lane\'s words', () => {
    const plan = { ids: ['w-1', 'w-4'], numbers: ['WO-00021', 'WO-00023'] }
    const stale = new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'body/versions/w-4', message: 'Changed since it was read.' }])
    expect(orderHoldProblemOf(stale, plan)).toEqual({ key: 'orders:where.hold.stale', params: { count: 1, numbers: 'WO-00023' } })
    expect(orderHoldProblemOf(new ApiError('conflict', 409, 'invalid_state', 'x'), plan)).toEqual({ key: 'production-work-orders:problem.conflict' })
    expect(orderHoldProblemOf(new ApiError('forbidden', 403, 'forbidden', 'x'), plan)).toEqual({ key: 'production-work-orders:problem.forbidden' })
  })

  it('drawn: the ONE Hold dialog on the plan\'s work orders, and under them what it leaves out, each with why (en + it)', () => {
    const text = textOf(draw('f-oo-108-dialog'))
    for (const words of ['Put WO-00021 on hold', 'WO-00022 — On hold already.', 'WO-00019 — Shared with other customers: hold it on its page.', '1 work order outside what you can open is not held from here: Production holds it', '12 made-to-measure units are held from their own pages', 'Floor tablets refuse to start it and show the reason.']) expect(text, words).toContain(words)
    const it = textOf(draw('f-oo-108-dialog', 'it'))
    for (const words of ['WO-00019 — Condiviso con altri clienti: mettilo in sospeso dalla sua pagina.', '12 capi su misura si mettono in sospeso dalle loro pagine']) expect(it, words).toContain(words)
    // Refused: a work order changed since it was read — by its number, nothing held.
    expect(textOf(draw('f-oo-108-dialog-stale'))).toContain('WO-00021 changed since it was read: nothing was held. The list was read again — hold again.')
    for (const locale of ['en', 'it'] as const) expect(textOf(draw('f-oo-108-dialog', locale)), locale).not.toMatch(/\b(?:where|hold|wo)\.[a-zA-Z]+/)
  })

  it('source: the domain\'s plan imported (no web copy); the hook sends the builder\'s body; Quality\'s holds right in the acts', () => {
    const model = readFileSync(new URL('./model.ts', import.meta.url), 'utf8')
    expect(model).toContain("import { orderHoldPlanOf, type OrderHoldPlan } from '@nexus/factory-domain/production/holds/rules'")
    expect(model).not.toMatch(/function orderHoldPlanOf/)
    const hook = readFileSync(new URL('./use-work-order-acts.ts', import.meta.url), 'utf8')
    expect(hook).toContain("write.route === 'production' ? placeProductionHolds(api, write.body, key) : placeHold(api, write.body, key)")
    expect(actsCanOf(['workorders.view', 'quality.holds.view']).qualityView).toBe(true)
    expect(actsCanOf(['workorders.view']).qualityView).toBe(false)
  })
})
// ---- end F-OO-108


// ---- F-OO-109 (order overview §1.3; N5, B-OO-006): ONE Lift for a hold standing on N work orders ---------------------------------
describe('F-OO-109: Lift… for N work orders — each one\'s holds read, ONE call with every hold and its version, all or none', () => {
  const on = (id: string, number: string, holds: Parameters<typeof plainHolds>[0], quality = 0): LiftManyWorkOrder => {
    const read = plainHolds(holds.map((hold) => ({ ...hold, workOrderId: id })), quality)
    return { id, number, holds: { value: { ...read, workOrder: { ...read.workOrder, id, number } }, problem: null } }
  }
  const PAUSE_A = { ...CUSTOMER_PAUSE, id: 'h-a', version: 2 }
  const PAUSE_B = { ...CUSTOMER_PAUSE, id: 'h-b', version: 5 }
  const OURS_B = { ...PLAIN_HOLD, id: 'h-c', version: 3 }
  const TWO = [on('w-1', 'WO-00021', [PAUSE_A]), on('w-2', 'WO-00022', [PAUSE_B, OURS_B], 1)]

  it('the body lists every hold of the strip\'s kind with its version (our own hold on the same work order stays); the client posts them', async () => {
    expect(liftManyHoldsOf(TWO, 'BRAND')).toEqual([{ workOrderId: 'w-1', holdId: 'h-a', version: 2 }, { workOrderId: 'w-2', holdId: 'h-b', version: 5 }])
    expect(liftManyHoldsOf(TWO, 'PRODUCTION')).toEqual([{ workOrderId: 'w-2', holdId: 'h-c', version: 3 }])
    const posts: { path: string; body: unknown; key: unknown }[] = []
    const api = { post: async (path: string, options: { body: unknown; idempotencyKey?: unknown }) => (posts.push({ path, body: options.body, key: options.idempotencyKey }), { holds: [], workOrders: [] }) } as unknown as ApiClient
    await liftProductionHolds(api, { holds: liftManyHoldsOf(TWO, 'BRAND'), reason: 'The customer confirmed the colour' }, 'key-1')
    expect(posts).toEqual([{ path: '/production/work-orders/holds/lift', body: { holds: [{ workOrderId: 'w-1', holdId: 'h-a', version: 2 }, { workOrderId: 'w-2', holdId: 'h-b', version: 5 }], reason: 'The customer confirmed the colour' }, key: 'key-1' }])
  })

  it('held with words: the right, still reading, a read failed, none standing any more, why (one line, within its limit), busy', () => {
    const can = { productionHold: true }
    expect(liftManyHeld(TWO, 'BRAND', { productionHold: false }, 'why', false)).toEqual({ key: 'held.noProductionHold' })
    expect(liftManyHeld([TWO[0]!, { ...TWO[1]!, holds: { value: null, problem: null } }], 'BRAND', can, 'why', false)).toEqual({ key: 'held.loading' })
    expect(liftManyHeld([TWO[0]!, { ...TWO[1]!, holds: { value: null, problem: 'problem.read' } }], 'BRAND', can, 'why', false)).toEqual({ key: 'orders:where.lift.held.failed' })
    expect(liftManyHeld([on('w-1', 'WO-00021', [OURS_B]), on('w-2', 'WO-00022', [])], 'BRAND', can, 'why', false)).toEqual({ key: 'orders:where.lift.held.none' })
    expect(liftManyHeld(TWO, 'BRAND', can, '  ', false)).toEqual({ key: 'liftHold.held.reason' })
    expect(liftManyHeld(TWO, 'BRAND', can, 'one\ntwo', false)).toEqual({ key: 'liftHold.held.line' })
    expect(liftManyHeld(TWO, 'BRAND', can, 'x'.repeat(501), false)).toEqual({ key: 'liftHold.held.long', params: { count: 500 } })
    expect(liftManyHeld(TWO, 'BRAND', can, 'why', true)).toEqual({ key: 'held.busy' })
    expect(liftManyHeld(TWO, 'BRAND', can, 'why', false)).toBeNull()
  })

  it('all or none: a hold changed since it was read is named by its work order; one lifted meanwhile — nothing lifted, read again', () => {
    const sent = liftManyHoldsOf(TWO, 'BRAND')
    const stale = new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'body/holds/1/version', message: 'Changed since it was read.' }])
    expect(liftManyProblemOf(stale, sent, TWO)).toEqual({ key: 'orders:where.lift.stale', params: { count: 1, numbers: 'WO-00022' } })
    expect(liftManyProblemOf(new ApiError('conflict', 409, 'invalid_state', 'The hold on WO-00021 was lifted meanwhile.'), sent, TWO)).toEqual({ key: 'orders:where.lift.meanwhile' })
    expect(liftManyProblemOf(new ApiError('forbidden', 403, 'forbidden', 'x'), sent, TWO)).toEqual({ key: 'production-work-orders:problem.forbidden' })
  })

  it('one work order = today\'s dialog unchanged (the WO record page and the row\'s Lift… use it): a list of one draws the same', () => {
    const parts: HoldParts = { reasons: null, can: { holdsPlace: false, productionHold: true }, busy: false, problem: null, productionHolds: TWO[0]!.holds }
    const alone = render(createElement(LiftHoldDialog, { holdId: null, parts, onCancel: () => undefined }))
    const listOfOne = render(createElement(LiftHoldDialog, { holdId: null, parts, onCancel: () => undefined, many: { kind: 'BRAND', workOrders: [TWO[0]!], shared: [], notReached: 0 } }))
    expect(listOfOne).toBe(alone)
    expect(textOf(alone)).toContain('Release the hold')
    expect(textOf(alone)).not.toContain('All or none')
    // Its source: the single dialog's body is as it was (F-PR-05b), the list is a dialog of its own.
    const source = readFileSync(new URL('./view/HoldDialog.tsx', import.meta.url), 'utf8')
    const one = source.slice(source.indexOf('function LiftOneHold('), source.indexOf('// ---- end F-PR-05b'))
    for (const part of ['const standing = plainHoldsOf(read).standing', "title={t('liftHold.title')}", "{t('liftHold.go')}", 'onLift?.({ holdId: hold.id, version: hold.version, reason: reason.trim() })']) expect(one, part).toContain(part)
    expect(one).not.toContain('where.lift')
  })

  it('several, drawn: each one\'s pause, what stays (a quality hold, the shared one, those not reached), the customer told once, ONE Lift', () => {
    const text = textOf(draw('f-oo-109-lift-dialog'))
    for (const words of ["Lift the customer's pause on 2 work orders", 'WO-00021 — Paused at the customer’s request', 'WO-00022 — Paused at the customer’s request', '1 quality hold still stands', 'All or none: if one changed meanwhile, nothing is lifted and the list is read again.', 'The customer is told once that the work resumed — not once per work order.', "WO-00019 also makes another customer's work: it is lifted on its own page", '1 work order outside what you can open stays held: Production lifts it', 'Lift 2 holds']) expect(text, words).toContain(words)
    expect(draw('f-oo-109-lift-dialog')).toMatch(/aria-description="Say why the hold is lifted\."[^>]*>[\s\S]*?Lift 2 holds/)
    expect(textOf(draw('f-oo-109-lift-stale'))).toContain('WO-00022 changed since it was read: nothing was lifted. The holds were read again — lift again.')
    expect(draw('f-oo-109-lift-reading')).toMatch(/aria-description="Still reading\."/)
    const it = textOf(draw('f-oo-109-lift-dialog', 'it'))
    for (const words of ['Togli la pausa del cliente su 2 ordini di lavoro', 'Tutti o nessuno', 'Il cliente viene avvisato una volta sola che il lavoro è ripreso', 'Togli 2 blocchi']) expect(it, words).toContain(words)
    for (const locale of ['en', 'it'] as const) expect(textOf(draw('f-oo-109-lift-dialog', locale)), locale).not.toMatch(/\b(?:where|liftHold|held)\.[a-zA-Z]+/)
  })

  it('source: ONE call (the bulk lift), never a loop of single lifts; each work order\'s own holds read', () => {
    const hook = readFileSync(new URL('./use-work-order-acts.ts', import.meta.url), 'utf8')
    const block = hook.slice(hook.indexOf('onLiftManyGo: (reason) => {'), hook.indexOf('onCloseLiftMany:'))
    expect(block).toContain('liftProductionHolds(api, { holds, reason: reason.trim() }, key)')
    expect(block).not.toContain('liftProductionHold(')
    expect(hook).toContain('listProductionHolds(api, id)')
  })
})
// ---- end F-OO-109

// ---- fx6 (end check 2, th9 step 12): ONE right for the Lift door and its dialog — the row's own workorders.hold ------------------------
describe('fx6: Lift… opens its dialog with the right that drew the door', () => {
  it('the dialog of Hold… and of Lift… both carry the row’s hold right (the lift read “needs the production hold right” before)', () => {
    const hook = readFileSync(new URL('./use-work-order-acts.ts', import.meta.url), 'utf8')
    expect(hook).toContain("...(act === 'hold' || act === 'lift' ? { holdRight: row.rights?.hold ?? false } : {})")
    const dialogs = readFileSync(new URL('./view/WorkOrderActsDialogs.tsx', import.meta.url), 'utf8')
    expect(dialogs).toContain('productionHold: dialog.holdRight ?? false')
  })
})
