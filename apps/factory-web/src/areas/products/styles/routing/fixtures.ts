import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { demoBom, demoCost, demoRouting, demoStyle, demoSubcontractedRouting, newStyle, OPERATIONS, recordModel, REV, REVISIONS, WORKSHOPS } from '../demo/fixtures'
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
    { id: 'subcontracted', label: 'W2a: subcontracted operations', model: routing({ routing: { status: 'ready', value: demoSubcontractedRouting() } }), note: 'Tile "Subcontracted operations 2"; the Subcontracted column: workshop, €4.50 per piece, 6 days there and back; the finishing "fee agreed per order".' },
    { id: 'subcontracted-production', label: 'W2a: subcontracted (production manager)', model: routing({ routing: { status: 'ready', value: demoSubcontractedRouting({ cost: false }) } }, 'production'), note: 'The fee is "Not in your role" (the cost grain); workshop and days shown.' },
    { id: 'subcontract-dialog', label: 'W2a: Subcontract details', model: routing({ routing: { status: 'ready', value: demoSubcontractedRouting() }, dialog: { kind: 'subcontract', stepId: demoRouting().steps[3]!.id } }), note: 'Done in-house or by a workshop of this company or of every company; fee per piece (cost grain); transit days; a new workshop starts with no fee and days.' },
    { id: 'subcontract-new', label: 'W2a: Subcontract an in-house step', model: routing({ routing: { status: 'ready', value: demoSubcontractedRouting() }, dialog: { kind: 'subcontract', stepId: demoRouting().steps[2]!.id } }) },
    { id: 'subcontract-production', label: 'W2a: Subcontract details (production manager)', model: routing({ routing: { status: 'ready', value: demoSubcontractedRouting({ cost: false }) }, dialog: { kind: 'subcontract', stepId: demoRouting().steps[3]!.id } }, 'production'), note: 'No parties list in the role: the workshop is shown, another cannot be picked (said); the fee is "Not in your role"; transit days change.' },
    { id: 'subcontract-loading', label: 'W2a: Subcontract details, workshops being read', model: routing({ routing: { status: 'ready', value: demoSubcontractedRouting() }, libraries: { scales: null, colours: null, brands: null, labels: null, workshops: null }, dialog: { kind: 'subcontract', stepId: demoRouting().steps[2]!.id } }) },
    { id: 'subcontract-none', label: 'W2a: no workshop on record', model: routing({ routing: { status: 'ready', value: demoSubcontractedRouting() }, libraries: { scales: null, colours: null, brands: null, labels: null, workshops: [WORKSHOPS[2]!] }, dialog: { kind: 'subcontract', stepId: demoRouting().steps[2]!.id } }), note: 'Only another company\'s workshop exists: none may work for this style (add one in Customers & suppliers).' },
    { id: 'subcontract-frozen', label: 'W2a: subcontracted on a released revision', model: routing({ style: { status: 'ready', value: demoStyle() }, revisionId: REV.r2, routing: { status: 'ready', value: demoSubcontractedRouting({ revision: REVISIONS[1] }) }, bom: { status: 'ready', value: demoBom({ revision: REVISIONS[1] }) }, dialog: { kind: 'subcontract', stepId: demoRouting().steps[3]!.id } }), note: 'Read only: the details as text, with why.' },
    { id: 'subcontract-sales', label: 'W2a: (sales has no routing tab)', model: recordModel('sales', { tab: 'routing' }), note: 'Sales does not read routings: the tab is absent, Overview opens.' },
    { id: 'loading', label: 'Loading', model: routing({ routing: { status: 'loading' } }) },
    { id: 'error', label: 'Could not load', model: routing({ routing: { status: 'error', problem: 'problem.read.unavailable' } }) },
  ],
})
