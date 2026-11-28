'use client'

import { Pill } from '@nexus/ui/primitives'
import type { LifeNote, OrderLife } from '@nexus/factory-domain/sales/order-life'
import { lifeChipOf, lifeOfStatus, type OrderStatusCode, type Phrase, type StateChipModel } from '../model'
import { useCellWords } from '../words'
import '../order-cells.css'

/**
 * What the chip draws:
 *   life     owb-b4 w4.1 — ONE of the nine life words (the domain's `orderLifeOf` answer, or the life a server's read sends) and its
 *            note: S1, S2 and S5 pass it once they have the facts (the shipments, the print, the warehouse leg).
 *   status   owb-b4 w4.1 — today's status code (the office's, the customer's, a portal request's), mapped through `orderLifeOf`; a
 *            partly shipped one says its pieces when given.
 *   chip     pg-w1 — today's model (the words the caller has, its tone and mark): the office's sheet and the portal's list and band
 *            draw it until S2 / S1 pass `life` or `status` (then this input goes, after a grep shows no caller).
 */
export type StateChipProps =
  | { readonly life: OrderLife; readonly note?: LifeNote | null }
  | { readonly status: OrderStatusCode; readonly pieces?: { readonly shipped: number; readonly total: number } | null }
  | { readonly chip: StateChipModel }

/**
 * pg-w1 (18-lead-settles Z1, Z16 P4; 10-design § 1.5) — the status chip of an order: the DS Pill with its mark (11 px), the words and,
 * after a dot, a tail. ONE chip for one status on every page: the office's sheet, the customer's portal list and the order page's
 * band. owb-b4 w4.1: the nine life words (design word table "The states of an order, in every door") — icon + tone + word, outlined
 * before the work and when gone; the customer reads "At the factory’s warehouse" (the outside words). It draws its input only.
 */
export function StateChip(props: StateChipProps) {
  const words = useCellWords()
  if ('chip' in props) {
    const { chip } = props
    const Icon = chip.mark
    return (
      <Pill tone={chip.tone} icon={<Icon size={11} aria-hidden />} className={chip.line ? 'fw-sheet-st is-line' : 'fw-sheet-st'}>
        {chip.words}
        {chip.tail ? ` · ${chip.tail}` : ''}
      </Pill>
    )
  }
  const model = lifeChipOf('life' in props ? { life: props.life, note: props.note ?? null } : lifeOfStatus(props.status, props.pieces))
  const say = (phrase: Phrase) => words.life(phrase.key, phrase.params)
  const Icon = model.mark
  return (
    <Pill tone={model.tone} icon={<Icon size={11} aria-hidden />} className={model.line ? 'fw-sheet-st is-line' : 'fw-sheet-st'} data-life={model.life}>
      {say(model.word)}
      {model.tail ? ` · ${say(model.tail)}` : ''}
    </Pill>
  )
}
