import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { CARD_LEAVER, CARD_LUCIA, CARD_SARA, inPpeShell, NOW, uid, type PpeRoleDemo } from '../_demo/fixtures'
import { CardTabView, type CardTabModel } from './view/CardTabView'

/** SCR-211-card — the person PPE card for their file, printed (design plant.ppe/tab:card). Made-up data. */

interface CardCase {
  role: PpeRoleDemo
  model: CardTabModel
}

const model = (over: Partial<CardTabModel> = {}): CardTabModel => ({ canView: true, at: NOW, person: 'Elena Sicuri', cards: [{ id: CARD_SARA.employee.id, value: CARD_SARA, problem: null }], ...over })

function CardDesign({ model: entry }: { model: CardCase }) {
  return inPpeShell('/plant/ppe/card', createElement(CardTabView, { model: entry.model }), entry.role)
}

export const designScreen = defineDesignScreen<CardCase>({
  screen: 'SCR-211-card',
  title: 'PPE for workers › Person PPE card (print), new tab',
  view: CardDesign,
  cases: [
    { id: 'one', label: 'One person: kit against what is held, the receipts', model: { role: 'safety', model: model() }, note: 'Print is not printed; one card per page.' },
    { id: 'several', label: 'Print PPE cards: three people, one card each', model: { role: 'safety', model: model({ cards: [CARD_SARA, CARD_LUCIA, CARD_LEAVER].map((card) => ({ id: card.employee.id, value: card, problem: null })) }) } },
    { id: 'leaver', label: 'A person leaving: PPE still to be returned', model: { role: 'safety', model: model({ cards: [{ id: CARD_LEAVER.employee.id, value: CARD_LEAVER, problem: null }] }) } },
    { id: 'loading', label: 'Reading', model: { role: 'safety', model: model({ cards: [{ id: CARD_SARA.employee.id, value: null, problem: null }] }) } },
    { id: 'error', label: 'One card not found, the other read', model: { role: 'safety', model: model({ cards: [{ id: CARD_SARA.employee.id, value: CARD_SARA, problem: null }, { id: uid('9501', 99), value: null, problem: 'problem.notFound' }] }) } },
    { id: 'empty', label: 'No person chosen', model: { role: 'safety', model: model({ cards: [] }) } },
    { id: 'no-permission', label: 'Sales: no safety.view', model: { role: 'sales', model: model({ canView: false }) } },
  ],
})
