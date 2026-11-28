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
// owb-ss3 step 3.2: the legs of "to our warehouse first" (read by their own container: this layout fetches nothing).
import { OrderLegs } from '../shipments/legs/OrderLegs'

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
 *
 * owb-ss3 step 3.2 (design plan § 5n, § 7): the sections are drawn inside the legs' container (`OrderLegs`): the bar gets its "At our
 * warehouse" part, each row its leg (chip + It arrived at the warehouse / Send on to the customer, by the server's `may`), and Create
 * shipment… opens for plan OR pack and send (shipping.plan OR shipping.manage).
 */
export function ShipmentsTab({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const search = useSearchParams()?.toString() ?? ''
  const recordHref = `${model.prefix}/sales/orders/${order.id}`
  const received = receivedOf(model.shipmentDeliveries?.value ?? null)
  // owb-ss3: the legs are read again when the order's shipments change (a status or a version).
  const stamp = order.chain.shipments.map((row) => `${row.id}:${row.status}:${row.version ?? ''}`).join('|')
  return (
    <WithMessages namespaces={SHIPMENTS_TAB_NS}>
      <OrderLegs orderId={order.id} stamp={stamp}>
        {(legs) => {
          const where = whereOf(order, received, legs.atWarehouse)
          return (
            <div className="fw-pt fw-os">
              <ShipmentsHead order={order} model={model} where={where} />
              <WhereSection order={order} model={model} actions={actions} where={where} plan={legs.rights.plan} />
              <ShipmentsSection order={order} model={model} actions={actions} where={where} legs={legs} />
              {model.shipmentDoor /* F-OP-119 → F-OS-201: the one shipment window opened from its row (its container) */}
              {model.newShipment /* F-OP-121: Warehouse's New shipment, opened in place (its container) */}
              {/* F-OP-123: Record a shipment made elsewhere… — its dialog is the page's, mounted once (OrderRecordView, F-OO-111). */}
              <AfterSalesSection order={order} model={model} actions={actions} />
              {model.afterSalesDoor /* F-OS-303: Returns' New return, Quality's Log complaint or the claim link, opened in place (its container) */}
              <p className="fw-so-hint">
                {/* F-OM-104 (P0-B11): the door lands on Money › Invoices & credit notes (invoices.view), else on Payments. */}
                <TabLink className="fw-so-link" href={`${tabHref(recordHref, 'money', search) /* F-OP-119: F-OP-210's tab link */}#${model.can.viewInvoices ? 'invoices' : 'payments'}`}>
                  {t('ship.moneyDoor')}
                </TabLink>
              </p>
            </div>
          )
        }}
      </OrderLegs>
    </WithMessages>
  )
}
