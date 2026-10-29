import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { demoBom, demoCost, demoRouting, demoStyle, newStyle, OPERATIONS, recordModel, REV, REVISIONS } from '../demo/fixtures'
import type { StyleRecordViewModel } from '../record/record-model'
import { StyleRecordView } from '../record/view/StyleRecordView'

/**
 * SCR-043 Operations (routing) of DEMO-JKT-01 — made-up data only: nine operations, 96.5 standard minutes per garment
 * (cutting 12.5, sewing 64, assembly 9, finishing 6, inspection 5), four scanned, the final check last.
 */

const routing = (overrides: Partial<StyleRecordViewModel> = {}, role: 'owner' | 'production' | 'sales' = 'owner') =>
  recordModel(role, { tab: 'routing', cost: { status: 'ready', value: demoCost() }, ...overrides })

export const designScreen = defineDesignScreen<StyleRecordViewModel>({
  screen: 'SCR-043',
  title: 'Style studio: Operations (routing)',
  view: StyleRecordView,
  cases: [
    { id: 'owner', label: 'Routing (draft revision 3)', model: routing(), note: 'Minutes by department (a tile filters), the labour cost with the cost grain; minutes typed here; scanned switches; the final operation.' },
    { id: 'differs', label: 'Minutes differ from the library', model: routing({ routing: { status: 'ready', value: demoRouting({ differs: true }) } }), note: '"Library: 17 min · Use library value".' },
    { id: 'production', label: 'Production manager (no cost)', model: routing({}, 'production'), note: 'Labour per garment: "Not in your role".' },
    { id: 'add', label: 'Add operations', model: routing({ dialog: { kind: 'addOperations' }, operationSearch: { query: '', kind: null, results: OPERATIONS, problem: null } }), note: 'Several at once, in the order ticked.' },
    { id: 'remove', label: 'Remove the final operation', model: routing({ dialog: { kind: 'removeStep', stepId: demoRouting().steps[8]!.id } }) },
    { id: 'released', label: 'Released revision 2 (frozen)', model: routing({ style: { status: 'ready', value: demoStyle() }, revisionId: REV.r2, routing: { status: 'ready', value: demoRouting({ revision: REVISIONS[1] }) }, bom: { status: 'ready', value: demoBom({ revision: REVISIONS[1] }) } }) },
    { id: 'empty', label: 'No operations yet', model: recordModel('owner', { tab: 'routing', style: { status: 'ready', value: newStyle() }, revisionId: REV.r1, routing: { status: 'ready', value: demoRouting({ revision: { ...REVISIONS[2]!, status: 'DRAFT' }, empty: true }) }, bom: { status: 'ready', value: demoBom({ revision: { ...REVISIONS[2]!, status: 'DRAFT' }, empty: true }) }, compliance: { status: 'idle' } }) },
    { id: 'loading', label: 'Loading', model: routing({ routing: { status: 'loading' } }) },
    { id: 'error', label: 'Could not load', model: routing({ routing: { status: 'error', problem: 'problem.read.unavailable' } }) },
  ],
})
