'use client'

import { useSearchParams } from 'next/navigation' // F-OP-119 (F-OP-210's tab links)
import { useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { Order } from '../../api'
import type { OrderRecordActions, OrderRecordModel } from '../record-model'
import { tabHref } from '../../../../_shared/record-frame/address'
import { TabLink } from '../../../../../lib/tab-link/TabLink'
// ---- F-OS-101 (order SHIPMENTS tab, 10-design §1; plan D1): the layout only — the tab's one answer and three sections, each its own file
import { receivedOf, whereOf } from '../shipments/where'
import { SHIPMENTS_TAB_NS } from '../shipments/word'
import { AfterSalesSection } from '../shipments/view/AfterSalesSection'
import { ShipmentsHead } from '../shipments/view/ShipmentsHead'
import { ShipmentsSection } from '../shipments/view/ShipmentsSection'
import { WhereSection } from '../shipments/view/WhereSection'
import '../shipments/view/shipments.css'
// ---- end F-OS-101

/**
 * F-OS-101 (order SHIPMENTS tab; 10-design §1; plan D1 — four sections become three, every function kept) — the tab's LAYOUT, and only
 * that. Its root is the Production kit's size container (`fw-pt`, production.css, which the kit imports: every section chooses by the
 * room the tab has, never the screen, so the thread dock opening or closing re-lays it at once). Under the tab's one answer
 * (ShipmentsHead), three sections that stack:
 *
 *   Where every garment is (#left)        every garment in one bucket, the buckets add up (WhereSection.tsx)
 *   Shipments (#shipments; #deliveries)   one row per shipment, the old Deliveries card's columns in each row (ShipmentsSection.tsx)
 *   Complaints & returns (#after-sales)   one list, by what the reader may see (AfterSalesSection.tsx)
 *
 * The tab is a window on Warehouse › Shipments, not a home: every step opens Warehouse's own window in place or "Next ›" into it.
 * Warehouse's words come with the tab (SHIPMENTS_TAB_NS); the dialogs a row opens are its container's (use-shipments-acts).
 */
export function ShipmentsTab({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const search = useSearchParams()?.toString() ?? ''
  const recordHref = `${model.prefix}/sales/orders/${order.id}`
  const where = whereOf(order, receivedOf(model.shipmentDeliveries?.value ?? null))
  return (
    <WithMessages namespaces={SHIPMENTS_TAB_NS}>
      <div className="fw-pt fw-os">
        <ShipmentsHead order={order} model={model} where={where} />
        <WhereSection order={order} model={model} actions={actions} where={where} />
        <ShipmentsSection order={order} model={model} actions={actions} where={where} />
        {model.shipmentTracking /* F-OP-119: the tracking dialog of the shipment opened (its container) */}
        {model.newShipment /* F-OP-121: Warehouse's New shipment, opened in place (its container) */}
        {/* F-OP-123: Record a shipment made elsewhere… — its dialog is the page's, mounted once (OrderRecordView, F-OO-111). */}
        <AfterSalesSection order={order} model={model} actions={actions} />
        <p className="fw-so-hint">
          {/* F-OM-104 (P0-B11): the door lands on Money › Invoices & credit notes (invoices.view), else on Payments. */}
          <TabLink className="fw-so-link" href={`${tabHref(recordHref, 'money', search) /* F-OP-119: F-OP-210's tab link */}#${model.can.viewInvoices ? 'invoices' : 'payments'}`}>
            {t('ship.moneyDoor')}
          </TabLink>
        </p>
      </div>
    </WithMessages>
  )
}
