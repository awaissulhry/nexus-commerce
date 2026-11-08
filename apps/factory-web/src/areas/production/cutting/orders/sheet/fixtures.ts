import { createElement } from 'react'
import { defineDesignScreen } from '../../../../../lib/design/design-screen'
import { at, PREFIX } from '../../demo/fixtures'
import { RECORD, RECORD_CANCELLED, RECORD_LEATHER, RECORD_PLANNED, RECORD_RELEASED } from '../demo/fixtures'
import { LaySheetView, type LaySheetModel } from './view/LaySheetView'

/**
 * SCR-238-sheet — the lay sheet / cut ticket on paper (design production.cutting tab:ct-tab-sheet, "paper at the cutting table"),
 * made-up data only: every lay of a released cut order with its ticket (Code 128), marker, rolls to spread and the blanks of
 * the spreading report and the count; one lay; a planned cut order (no ticket yet, said); a leather cut order; reading, failed,
 * nothing asked, no permission.
 */

const model = (over: Partial<LaySheetModel> = {}): LaySheetModel => ({
  prefix: PREFIX,
  can: true,
  person: 'Alex Demo',
  at: at(30, 8, 45),
  company: 'Demo Factory Srl',
  timeZone: 'Europe/Rome',
  record: RECORD_RELEASED,
  problem: null,
  layId: null,
  nothing: false,
  ...over,
})

export const designScreen = defineDesignScreen<LaySheetModel>({
  screen: 'SCR-238-sheet',
  title: 'Lay sheet / cut ticket (print)',
  view: ({ model: given }) => createElement(LaySheetView, { model: given }),
  cases: [
    { id: 'all', label: 'Released: both lays, each with its ticket, rolls and the blanks to fill', model: model() },
    { id: 'one', label: 'One lay asked (from the Lays grid): lay 2', model: model({ record: RECORD, layId: RECORD.lays[1]!.id }) },
    { id: 'planned', label: 'Planned: no ticket yet (made at release), said', model: model({ record: RECORD_PLANNED }) },
    { id: 'leather', label: 'Leather cut order: one ticket, the work orders’ garments', model: model({ record: RECORD_LEATHER }) },
    { id: 'cancelled', label: 'Cancelled: Print held with why', model: model({ record: RECORD_CANCELLED }) },
    { id: 'reading', label: 'Still reading (Print held)', model: model({ record: null }) },
    { id: 'failed', label: 'The read failed', model: model({ record: null, problem: 'problem.offline' }) },
    { id: 'nothing', label: 'No cut order asked', model: model({ record: null, nothing: true }) },
    { id: 'no-permission', label: 'No production.cutting.view', model: model({ can: false, record: null }) },
  ],
})
