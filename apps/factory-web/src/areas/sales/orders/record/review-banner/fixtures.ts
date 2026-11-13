import { createElement } from 'react'
import { defineDesignScreen } from '../../../../../lib/design/design-screen'
import type { DocumentUnits } from '../../../mtm/api'
import { inShell, order, PREFIX, type Role } from '../../_demo/fixtures'
import { APPROVAL_PENDING, depthModel } from '../../depth/demo/fixtures'
import type { Approval } from '../../depth/api'
import { base } from '../fixtures'
import type { OrderRecordModel } from '../record-model'
import { OrderRecordView } from '../view/OrderRecordView'
import { reviewBannerOf, type ReviewBannerModel } from './model'
import { ReviewBanner } from './view/ReviewBanner'

/**
 * SCR-039-review-banner — "Waits for the factory review" on the order studio (B-W2b-368, XF1:02) with made-up data only: an order
 * made with a made-to-measure unit whose measures wait, the reason MEASUREMENTS and each unit's review (the rider profile); two
 * units (one waiting, one asked for more); a role without the right to see measurements (Open the review held with why); the
 * template stopped since (the off state in words); the credit holding it too (the yes banner says both reasons); reading; a read
 * that failed; a confirmed order (no banner).
 */

const uid = (n: number) => `0190f0e2-3680-7000-8000-${String(n).padStart(12, '0')}`
const unit = (n: number, over: { review?: 'WAITING' | 'NEED_MORE' | 'CONFIRMED'; rider?: string; revision?: number; off?: boolean } = {}): DocumentUnits['units'][number] => ({
  lineId: uid(100 + n),
  seq: n * 10,
  style: { id: uid(200), code: 'DEMO-JKT-MTM' },
  colourway: { id: uid(300), code: 'BLK' },
  baseSize: '52',
  profile: { id: uid(400 + n), riderName: over.rider ?? 'Marco Esempio', garmentType: 'JACKET', revision: over.revision ?? 2, latestRevision: over.revision ?? 2, review: over.review ?? 'WAITING', takenAt: '2026-10-27T09:30:00.000Z' },
  verdict: over.off ? 'BLOCK' : 'WARN',
  suggestedBaseSize: '52',
  insideCertifiedRange: true,
  findings: [
    ...(over.off ? [{ code: 'MTM_NOT_STARTED' as const, severity: 'BLOCKS' as const, message: 'x' }] : []),
    ...(over.review === 'CONFIRMED' ? [] : [{ code: 'MTM_NOT_CONFIRMED' as const, severity: 'WARNING' as const, message: 'x' }]),
  ],
})
const made = (units: DocumentUnits['units'], waits = true): DocumentUnits => ({ kind: 'ORDER', id: uid(1), number: 'SO-2026-0088', status: waits ? 'PENDING_APPROVAL' : 'CONFIRMED', waitsForReview: waits, units })

const WITH_MEASURES = ['orders.view', 'orders.manage', 'sales.measurements.view']
const banner = (units: DocumentUnits['units'], permissions: readonly string[] = WITH_MEASURES, waits = true): ReviewBannerModel => reviewBannerOf(made(units, waits), permissions, PREFIX)

const MEASURES_ONLY: Approval = { ...APPROVAL_PENDING, reasons: [{ reason: 'MEASUREMENTS' }], requests: [], may: { ask: true, withdraw: false } }
const MEASURES_AND_CREDIT: Approval = { ...APPROVAL_PENDING, reasons: [{ reason: 'CREDIT_HOLD' }, { reason: 'MEASUREMENTS' }], requests: [], creditHold: { checkId: uid(900), requestTaskId: null }, may: { ask: false, withdraw: false } }

const waiting = order('CONFIRMED', { status: 'PENDING_APPROVAL' })
type Case = { readonly role: Role; readonly record: OrderRecordModel }
const record = (role: Role, model: ReviewBannerModel | null, approval: Approval = MEASURES_ONLY, value = waiting): Case => {
  const shown = base(role, value, { depth: depthModel(role, { approval: { value: approval, problem: null } }), reviewBanner: createElement(ReviewBanner, { model }) })
  return { role, record: shown.record }
}

function ReviewBannerDesign({ model }: { model: Case }) {
  return inShell(`/sales/orders/${model.record.order.status === 'ready' ? model.record.order.value.id : 'x'}`, createElement(OrderRecordView, { model: model.record }), model.role)
}

export const designScreen = defineDesignScreen<Case>({
  screen: 'SCR-039-review-banner',
  title: 'Order studio › Waits for the factory review (made-to-measure)',
  view: ReviewBannerDesign,
  cases: [
    { id: 'waiting', label: 'Sales · Waits for the factory review: one unit, its review linked', model: record('sales', banner([unit(1)])), note: 'Only the factory review holds it: no yes is asked, so the yes banner stays away. Open the review opens the rider profile’s review.' },
    { id: 'two-units', label: 'Sales · Two units: one waiting, one asked for more', model: record('sales', banner([unit(1), unit(2, { review: 'NEED_MORE', rider: 'Sara Prova', revision: 1 })])) },
    { id: 'no-right', label: 'Production manager · Open the review held: no right to see measurements', model: record('manager', banner([unit(1)], ['orders.view'])), note: 'The held button says why on hover and focus.' },
    { id: 'off', label: 'Sales · Made-to-measure stopped for JACKET since the order (the off state in words)', model: record('sales', banner([unit(1, { off: true })])) },
    { id: 'credit-too', label: 'Sales · The customer’s credit holds it too: the yes banner names both reasons', model: record('sales', banner([unit(1)]), MEASURES_AND_CREDIT) },
    { id: 'reading', label: 'Sales · Reading the units', model: record('sales', { state: 'loading' }) },
    { id: 'failed', label: 'Sales · The units couldn’t be read (Try again)', model: record('sales', { state: 'error', problem: { key: 'banner.problem.unavailable' } }) },
    { id: 'confirmed', label: 'Sales · Confirmed: nothing waits (no banner)', model: record('sales', banner([unit(1, { review: 'CONFIRMED' })], WITH_MEASURES, false), { ...MEASURES_ONLY, status: 'CONFIRMED', waiting: false, reasons: [] }, order('CONFIRMED')) },
  ],
})
