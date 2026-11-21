'use client'

import type { Order } from '../../../api'
import { ChangesDepth } from '../../../changes-depth/view/ChangesDepth' // B-W2b-323
import type { OrderRecordActions, OrderRecordModel } from '../../record-model'

/**
 * F-OC-101 (order CHANGES tab, 10-design §4) — section 2, Can it still change? (#freeze): second, under Waiting (O2 = A), so the two
 * one-line answers sit together. Today's freeze panel in its place (what each part of the order needs at the stage it reached); W2
 * (F-OC-202) gives it the verdict sentence, the door to the Lines tab and Each part.
 */
export function FreezeSection({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  return (
    <section id="freeze" className="fw-pt-sec fw-so-anchor">
      <ChangesDepth order={order} model={model.depth} actions={actions?.depth} />
    </section>
  )
}
