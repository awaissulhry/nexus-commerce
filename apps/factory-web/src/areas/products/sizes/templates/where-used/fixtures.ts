import { defineDesignScreen } from '../../../../../lib/design/design-screen'
import type { WhereUsedView } from '@nexus/factory-domain/sales/mtm/where-used'
import { PREFIX, uid } from '../../../library/demo'
import { canOf, SUIT, SUIT_RULES } from '../demo/fixtures'
import { TemplateRecordView, type TemplateRecordModel } from '../record/view/TemplateRecordView'

/**
 * SCR-049-template-whereused — where a measurement template is used, beyond counts (B-W2b-371, XF2:04; design template.whereused)
 * with made-up data only: the styles measured with it (flagged made to measure or not) and the open orders whose made-to-measure
 * units it serves (each unit's line, style, colourway, base size, revision and review, the rider for a reader of measurements);
 * the orders held for a role that reads no orders; a rider's name left out for a reader of orders without measurements; none yet;
 * reading; the read failed.
 */

const VALUE: WhereUsedView = {
  template: { id: SUIT.id, code: SUIT.code },
  styles: [
    { id: uid('4941', 1), code: 'DEMO-SUIT-01', name: 'Demo race suit one piece', season: 'FW27', status: 'RELEASED', lifecycle: 'IN_PRODUCTION', madeToMeasure: true, companyId: null },
    { id: uid('4941', 2), code: 'DEMO-SUIT-02', name: 'Demo race suit two pieces', season: 'SS27', status: 'DRAFT', lifecycle: 'DEVELOPMENT', madeToMeasure: true, companyId: null },
    { id: uid('4941', 3), code: 'DEMO-SUIT-TRK', name: 'Demo track suit', season: null, status: 'RELEASED', lifecycle: 'APPROVED', madeToMeasure: false, companyId: null },
  ],
  orders: [
    {
      id: uid('4942', 1),
      number: 'SO-DEMO-0003',
      status: 'PENDING_APPROVAL',
      companyId: uid('0001', 1),
      customer: { id: uid('4943', 1), code: 'DEMO-R1', name: 'Demo Rider One' },
      units: [{ lineId: uid('4944', 1), seq: 10, style: { id: uid('4941', 1), code: 'DEMO-SUIT-01' }, colourway: 'BLK', baseSize: '52', profile: { id: uid('4945', 1), revision: 3, review: 'WAITING' }, rider: 'Demo Rider One' }],
    },
    {
      id: uid('4942', 2),
      number: 'SO-DEMO-0007',
      status: 'IN_PRODUCTION',
      companyId: uid('0001', 1),
      customer: { id: uid('4943', 2), code: 'DEMO-TEAM', name: 'Demo Racing Team' },
      units: [
        { lineId: uid('4944', 2), seq: 10, style: { id: uid('4941', 1), code: 'DEMO-SUIT-01' }, colourway: 'RED', baseSize: '50', profile: { id: uid('4945', 2), revision: 1, review: 'CONFIRMED' }, rider: 'Demo Rider Two' },
        { lineId: uid('4944', 3), seq: 20, style: { id: uid('4941', 2), code: 'DEMO-SUIT-02' }, colourway: 'RED', baseSize: '54', profile: { id: uid('4945', 3), revision: 2, review: 'CONFIRMED' }, rider: 'Demo Rider Three' },
      ],
    },
  ],
  moreOrders: false,
}
const base: TemplateRecordModel = { prefix: PREFIX, can: canOf('owner'), tab: 'whereused', template: { status: 'ready', value: SUIT }, rules: { value: SUIT_RULES, problem: null }, edit: null, dialog: null, notice: null, changed: null, busy: false, whereUsed: { value: VALUE, problem: null } }

export const designScreen = defineDesignScreen<TemplateRecordModel>({
  screen: 'SCR-049-template-whereused',
  title: 'Measurement template › Where used: styles and open orders',
  view: TemplateRecordView,
  cases: [
    { id: 'lists', label: 'Where used: the counts, the three styles measured with it, the two open orders it serves (units, revisions, riders)', model: base },
    { id: 'no-orders-right', label: 'A role that reads no orders: the styles, the orders held with why', model: { ...base, can: canOf('developer'), whereUsed: { value: { ...VALUE, orders: null }, problem: null } } },
    { id: 'no-riders', label: 'A reader of orders without measurements: the units without the rider', model: { ...base, can: canOf('sales'), whereUsed: { value: { ...VALUE, orders: VALUE.orders!.map((order) => ({ ...order, units: order.units.map((unit) => ({ ...unit, rider: null })) })) }, problem: null } } },
    { id: 'none', label: 'No style and no open order yet', model: { ...base, template: { status: 'ready', value: { ...SUIT, styles: { measured: 0, madeToMeasure: 0 }, profiles: 0 } }, whereUsed: { value: { ...VALUE, styles: [], orders: [] }, problem: null } } },
    { id: 'reading', label: 'Reading where it is used', model: { ...base, whereUsed: { value: null, problem: null } } },
    { id: 'failed', label: 'The read failed (Try again)', model: { ...base, whereUsed: { value: null, problem: 'problem.unavailable' } } },
  ],
})
