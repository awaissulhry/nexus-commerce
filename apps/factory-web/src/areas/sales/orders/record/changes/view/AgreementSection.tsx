'use client'

import type { Order } from '../../../api'
import type { OrderRecordActions, OrderRecordModel } from '../../record-model'
import { DocumentsTab } from '../../view/DocumentsTab'

/**
 * F-OC-101 (order CHANGES tab, 10-design §6) — section 4, Customer's agreement (#confirmation: the band's, the list's and the
 * document links land here): how the customer said yes and our confirmation, today's parts in their place; W2 (F-OC-203) makes it
 * one card with one answer.
 */
export function AgreementSection({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  return (
    <section id="confirmation" className="fw-pt-sec fw-so-anchor" aria-labelledby="fw-so-confirmation-title">
      <DocumentsTab order={order} model={model} actions={actions} />
    </section>
  )
}
