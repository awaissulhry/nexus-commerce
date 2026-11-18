import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement, type ComponentType } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { HOLD_BRAND_WORDS_MAX, HOLD_LIFT_REASON_MAX, HOLD_NOTE_MAX } from '@nexus/factory-domain/production/holds/kinds'
import { REASON_LIST_GROUPS } from '@nexus/factory-domain/reasons/lists'
import { leftKeys, renderView, textOf } from '../../../../lib/record-thread/parts/testing'
import { LOCALES } from '../../../../lib/i18n/locales'
import { designScreen } from '../record/fixtures'
import { CUSTOMER_PAUSE, demoCan, HOLD, HOLD_REASONS, LIFTED_HOLD, PLAIN_HOLD, plainHeldWorkOrder, plainHolds, PRODUCTION_HOLD_REASONS, heldWorkOrder } from './demo/fixtures'
import { bulkHoldHeld, dailyCan, dialogReasons, HOLD_DIALOG_LIMITS, holdHeld, holdKindOf, liftHeld, placeHeld, plainHoldsOf, plainHoldWords, releaseTargetHeld, releaseTargetOf } from './model'

// The DS Modal draws only after it mounts in a browser: here a plain section, so a dialog's words are read on the server too (as the
// other dialog tests do).
vi.mock('@nexus/ui/components', async (original) => {
  const actual = await original<typeof import('@nexus/ui/components')>()
  const Modal = ({ open, title, children, footer }: { open: boolean; title?: unknown; children?: unknown; footer?: unknown }) => (open ? createElement('section', { role: 'dialog', 'data-modal': '' }, createElement('h2', null, title as never), children as never, footer as never) : null)
  return { ...actual, Modal }
})

/**
 * F-PR-05b — ONE "Put on hold" dialog (production plan §5 "holds (one dialog)"; B-PR-21 "the reason chosen decides the kind"; review
 * R-38: the list's Hold N opens the same dialog): the reasons of HOLD place a quality hold (quality.holds.place → /quality/holds),
 * those of PRODUCTION_HOLD a plain production hold (workorders.hold → /production/work-orders/…/holds, the customer reads its own words
 * or the reason's, never the office's note). Release the hold opens what the work order is held under: a quality hold (Quality's
 * release) or a plain one (lifted here with why). The holds card shows both kinds. PW-10 (web side): Hold N sends only the picked rows.
 */

const view = designScreen.view as ComponentType<{ model: unknown }>
const draw = (id: string, locale: 'it' | 'en' = 'en') => renderView(view, designScreen.cases.find((item) => item.id === id)!.model, locale)
const ALL = [...HOLD_REASONS, ...PRODUCTION_HOLD_REASONS]
const manager = demoCan('manager')
const qualityOnly = dailyCan(['workorders.view', 'quality.holds.view', 'quality.holds.place'])
const productionOnly = dailyCan(['workorders.view', 'workorders.hold'])
const nobody = dailyCan(['workorders.view'])

describe('F-PR-05b — the reason decides the kind', () => {
  it('a HOLD reason is a quality hold, a PRODUCTION_HOLD reason a production hold', () => {
    expect(holdKindOf(HOLD_REASONS[0]!)).toBe('QUALITY')
    expect(holdKindOf(PRODUCTION_HOLD_REASONS[0]!)).toBe('PRODUCTION')
  })

  it('each kind is offered only with its right; nothing while the reasons are read', () => {
    expect(manager.productionHold).toBe(true)
    expect(dialogReasons(ALL, manager)).toEqual({ QUALITY: HOLD_REASONS, PRODUCTION: PRODUCTION_HOLD_REASONS })
    expect(dialogReasons(ALL, qualityOnly)).toEqual({ QUALITY: HOLD_REASONS, PRODUCTION: [] })
    expect(dialogReasons(ALL, productionOnly)).toEqual({ QUALITY: [], PRODUCTION: PRODUCTION_HOLD_REASONS })
    expect(dialogReasons(null, manager)).toBeNull()
  })

  it('Put on hold waits only when neither right is held; Hold N the same', () => {
    expect(holdHeld({ status: 'IN_PROGRESS' }, productionOnly)).toBeNull()
    expect(holdHeld({ status: 'IN_PROGRESS' }, qualityOnly)).toBeNull()
    expect(holdHeld({ status: 'IN_PROGRESS' }, nobody)).toEqual({ key: 'held.noHoldPlace' })
    expect(bulkHoldHeld([{ status: 'RELEASED' }], productionOnly)).toBeNull()
    expect(bulkHoldHeld([{ status: 'RELEASED' }], nobody)).toEqual({ key: 'held.noHoldPlace' })
  })

  it('the dialog’s limits are the API’s: a quality note 500, the office note 2000, the customer’s words one line of 500', () => {
    expect(HOLD_DIALOG_LIMITS).toEqual({ qualityNote: 500, productionNote: HOLD_NOTE_MAX, customerWords: HOLD_BRAND_WORDS_MAX, liftReason: HOLD_LIFT_REASON_MAX })
    const production = PRODUCTION_HOLD_REASONS.filter((reason) => reason.list === 'PRODUCTION_HOLD')
    expect(placeHeld('MATERIAL_MISSING', 'x'.repeat(600), production, false)).toBeNull()
    expect(placeHeld('MATERIAL_MISSING', 'x'.repeat(HOLD_NOTE_MAX + 1), production, false)).toEqual({ key: 'hold.held.noteLongProduction', params: { count: HOLD_NOTE_MAX } })
    expect(placeHeld('MATERIAL_MISSING', '', production, false, { customerWords: 'one\ntwo' })).toEqual({ key: 'hold.held.customerWordsLine' })
    expect(placeHeld('MATERIAL_MISSING', '', production, false, { customerWords: 'x'.repeat(HOLD_BRAND_WORDS_MAX + 1) })).toEqual({ key: 'hold.held.customerWordsLong', params: { count: HOLD_BRAND_WORDS_MAX } })
    expect(placeHeld('OTHER', ' ', production, false)).toEqual({ key: 'hold.held.note' })
    expect(placeHeld('QUALITY_CHECK', 'x'.repeat(501), HOLD_REASONS, false)).toEqual({ key: 'hold.held.noteLong' })
  })

  it('a reason of a kind the person may not place waits, in words', () => {
    const production = PRODUCTION_HOLD_REASONS.filter((reason) => reason.list === 'PRODUCTION_HOLD')
    expect(placeHeld('MATERIAL_MISSING', '', production, false, { can: qualityOnly })).toEqual({ key: 'held.noProductionHold' })
    expect(placeHeld('QUALITY_CHECK', '', HOLD_REASONS, false, { can: productionOnly })).toEqual({ key: 'held.noQualityHold' })
    expect(placeHeld('MATERIAL_MISSING', '', production, false, { can: productionOnly })).toBeNull()
  })
})

describe('F-PR-05b — Release the hold: what the work order is held under', () => {
  it('a quality hold → Quality’s release; a plain hold → lifted here; another record → that record lifts it', () => {
    expect(releaseTargetOf(heldWorkOrder(), [HOLD], null)).toEqual({ kind: 'quality', holdId: HOLD.id })
    expect(releaseTargetOf(plainHeldWorkOrder(), [HOLD], plainHolds([PLAIN_HOLD]))).toEqual({ kind: 'plain', holdId: PLAIN_HOLD.id })
    const ncr = { ...heldWorkOrder(), hold: { ...heldWorkOrder().hold!, recordType: 'Nonconformance', recordId: 'ncr-1' } }
    expect(releaseTargetOf(ncr, [], null)).toEqual({ kind: 'record' })
    expect(releaseTargetOf({ status: 'IN_PROGRESS', hold: null }, [], null)).toEqual({ kind: 'none' })
  })

  it('each target waits on its own right', () => {
    expect(releaseTargetHeld({ kind: 'plain', holdId: 'h' }, productionOnly)).toBeNull()
    expect(releaseTargetHeld({ kind: 'plain', holdId: 'h' }, qualityOnly)).toEqual({ key: 'held.noProductionHold' })
    expect(releaseTargetHeld({ kind: 'quality', holdId: 'h' }, demoCan('quality'))).toBeNull()
    expect(releaseTargetHeld({ kind: 'record' }, manager)).toEqual({ key: 'held.underRecord' })
  })

  it('lifting a plain hold asks why, in one line of at most 500', () => {
    expect(liftHeld(PLAIN_HOLD, nobody, 'ok', false)).toEqual({ key: 'held.noProductionHold' })
    expect(liftHeld(PLAIN_HOLD, productionOnly, ' ', false)).toEqual({ key: 'liftHold.held.reason' })
    expect(liftHeld(PLAIN_HOLD, productionOnly, 'a\nb', false)).toEqual({ key: 'liftHold.held.line' })
    expect(liftHeld(PLAIN_HOLD, productionOnly, 'x'.repeat(501), false)).toEqual({ key: 'liftHold.held.long', params: { count: 500 } })
    expect(liftHeld(LIFTED_HOLD, productionOnly, 'ok', false)).toEqual({ key: 'held.holdNotActive' })
    expect(liftHeld(PLAIN_HOLD, productionOnly, 'Lining arrived', false)).toBeNull()
  })

  it('the standing plain holds oldest first, the lifted newest first; a production reason in the person’s words', () => {
    const read = plainHolds([CUSTOMER_PAUSE, LIFTED_HOLD, PLAIN_HOLD])
    expect(plainHoldsOf(read).standing.map((hold) => hold.id)).toEqual([PLAIN_HOLD.id, CUSTOMER_PAUSE.id])
    expect(plainHoldsOf(read).lifted.map((hold) => hold.id)).toEqual([LIFTED_HOLD.id])
    expect(plainHoldWords(PLAIN_HOLD, ALL, 'it')).toBe('Materiale mancante')
    expect(plainHoldWords(PLAIN_HOLD, null, 'it')).toBe(PLAIN_HOLD.reason)
  })
})

describe('F-PR-05b — on screen', () => {
  const CASES = ['hold-dialog-production', 'hold-dialog-quality', 'hold-plain', 'hold-customer-pause', 'hold-lift', 'hold-lift-no-right', 'hold-plain-failed']

  it('every case draws in both languages with no key left', () => {
    for (const id of CASES) for (const locale of LOCALES) expect(leftKeys(draw(id, locale), ['hold', 'holds', 'liftHold', 'held', 'notice']), `${id} ${locale}`).toEqual([])
  })

  it('the dialog offers both lists as groups; a production reason asks the office note and what the customer reads', () => {
    const html = draw('hold-dialog-production')
    expect(html).toContain('<optgroup')
    const text = textOf(html)
    expect(text).toContain('Production hold: we lift it ourselves')
    expect(text).toContain('Office note')
    expect(text).toContain('What the customer reads')
    expect(textOf(draw('hold-dialog-quality'))).toContain('Quality hold: quality releases it')
    expect(textOf(draw('hold-dialog-quality'))).not.toContain('What the customer reads')
  })

  it('held under a production hold: the card shows its reason, the note marked Office only, what the customer reads, the lifted one; the band releases it', () => {
    const text = textOf(draw('hold-plain'))
    expect(text).toContain('Material missing')
    expect(text).toContain('Office only')
    expect(text).toContain('The customer reads: A lining is late from our supplier')
    expect(text).toContain('lifted')
    expect(text).toContain('Release the hold')
    // A plain hold is the card's own: never "the hold comes from another record".
    expect(text).not.toContain('comes from another record')
    expect(textOf(draw('hold-customer-pause'))).toContain('Paused at the customer’s request')
  })

  // ---- F-PR-16 (the browser walk): Enter sends only from the send button
  it('Enter in a one-line field sends nothing: the fields of Put on hold and Release the hold sit in no form (the button and ⌘↵ send)', () => {
    // The DS Modal draws only in a browser: the dialogs' own source is read (the walk checked the screen).
    const source = readFileSync(join(__dirname, 'view', 'DailyDialogs.tsx'), 'utf8')
    for (const [from, to] of [['export function HoldDialog(', '// ---- F-PR-05b: Release a plain hold'], ['function LiftHoldDialog(', 'function ReleaseHoldDialog(']] as const) {
      const dialog = source.slice(source.indexOf(from), source.indexOf(to))
      expect(dialog.length, from).toBeGreaterThan(100)
      expect(dialog, from).not.toContain('<form')
      expect(dialog, from).toContain('<div className="fw-pr-dialog" onKeyDown={submitKeys(go)}>')
      expect(dialog, from).toContain('aria-keyshortcuts="Meta+Enter Control+Enter"')
    }
  })
  // ---- end F-PR-16

  it('the lift dialog says a standing quality hold keeps it held; without the right Release waits in words', () => {
    expect(textOf(draw('hold-lift'))).toContain('1 quality hold still stands')
    expect(draw('hold-lift-no-right')).toContain('production hold right')
    expect(textOf(draw('hold-plain-failed'))).toContain('Try again')
  })

  it('the list’s Hold N opens the same dialog and routes a production reason to Hold N with a production reason (one command)', () => {
    const page = readFileSync(join(__dirname, '..', 'WorkOrdersPage.tsx'), 'utf8')
    expect(page).toContain("input.kind === 'PRODUCTION'")
    expect(page).toContain('placeProductionHolds(api, { workOrderIds: input.workOrderIds')
    const api = readFileSync(join(__dirname, 'api.ts'), 'utf8')
    expect(api).toContain("'/production/work-orders/holds'")
    expect(api).toContain("pickerReasons(api, ['HOLD', PRODUCTION_HOLD_LIST]")
    const list = readFileSync(join(__dirname, '..', 'view', 'WorkOrdersListView.tsx'), 'utf8')
    expect(list).toContain('<HoldDialog')
  })

  it('PRODUCTION_HOLD reasons are kept on Production › Floor rules, beside HOLD', () => {
    const lists = [...REASON_LIST_GROUPS.floorRules]
    expect(lists.indexOf('PRODUCTION_HOLD')).toBe(lists.indexOf('HOLD') + 1)
  })
})
