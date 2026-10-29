import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { demoBom, demoCompliance, demoStyle, newStyle, recordModel, REV, REVISIONS, SCALES, SIZES } from '../demo/fixtures'
import type { StyleRecordViewModel } from './record-model'
import { StyleRecordView } from './view/StyleRecordView'

/**
 * SCR-041 the Style studio — Overview and Colourways & sizes, with the band (revision in view, release held with its
 * reason), the release / revision / archive pop-ups, the thread beside the tab, and every state. Made-up data only
 * (demo/fixtures.ts): the jacket DEMO-JKT-01 with revision 2 released and revision 3 in draft (2 things before its
 * release: leather size 58 has no quantity, the zip has no colour for ANTR).
 */

const owner = recordModel('owner')
const released = [REVISIONS[1]!, REVISIONS[2]!]
const ready = recordModel('owner', { bom: { status: 'ready', value: demoBom({ complete: true }) } })

export const designScreen = defineDesignScreen<StyleRecordViewModel>({
  screen: 'SCR-041',
  title: 'Style studio: Overview, Colourways & sizes',
  view: StyleRecordView,
  cases: [
    { id: 'overview-owner', label: 'Owner: draft revision 3 in view', model: owner, note: 'Release revision 3 is held with "2 things to fix first"; r opens the check anyway. The side says what blocks and links each to its tab.' },
    { id: 'overview-product', label: 'Product office', model: recordModel('product') },
    { id: 'overview-production', label: 'Production manager (no cost)', model: recordModel('production'), note: 'Same studio; the Cost tab shows structure only (part 2).' },
    { id: 'overview-sales', label: 'Sales (reads)', model: recordModel('sales'), note: 'Identity drawn as text ("You can view, not change"); no BOM, routing or compliance tabs: the role does not read them.' },
    { id: 'overview-editing', label: 'Identity being changed', model: recordModel('owner', { identityDraft: { name: 'Giacca Touring Demo Evo', season: 'SS28' } }), note: 'The save bar counts the changes; ⌘S saves; leaving asks first.' },
    { id: 'overview-ready', label: 'Draft ready to release', model: ready, note: 'Release revision 3 is the primary; the check passes.' },
    { id: 'overview-released', label: 'No draft: revision 2 released', model: recordModel('owner', { style: { status: 'ready', value: demoStyle({ revisions: released }) }, revisionId: REV.r2, bom: { status: 'ready', value: demoBom({ revision: REVISIONS[1] }) } }), note: 'The primary becomes "Start revision 3".' },
    { id: 'overview-new', label: 'A brand-new style', model: recordModel('owner', { style: { status: 'ready', value: newStyle() }, revisionId: REV.r1, bom: { status: 'ready', value: demoBom({ revision: { ...REVISIONS[2]!, status: 'DRAFT' }, empty: true }) }, compliance: { status: 'idle' } }), note: 'Revision 1 is an empty draft; what it lacks links to its tab.' },
    { id: 'release-held', label: 'Release check: blocked', model: recordModel('owner', { dialog: { kind: 'release' } }), note: 'Every blocker in our words with Fix; the button is held with the first reason.' },
    { id: 'release-ready', label: 'Release check: passes', model: { ...ready, dialog: { kind: 'release' } }, note: 'What happens, in words; compliance points that stop production or shipping are said, not refused.' },
    { id: 'start-revision', label: 'Start revision 3', model: recordModel('owner', { style: { status: 'ready', value: demoStyle({ revisions: released }) }, revisionId: REV.r2, dialog: { kind: 'startRevision' } }) },
    { id: 'abandon', label: 'Abandon the draft', model: recordModel('owner', { dialog: { kind: 'abandon' } }) },
    { id: 'archive', label: 'Archive the style', model: recordModel('owner', { dialog: { kind: 'archive' } }) },
    { id: 'archived', label: 'Archived style', model: recordModel('owner', { style: { status: 'ready', value: demoStyle({ status: 'ARCHIVED' }) } }), note: 'Read only; Reactivate in ⋯.' },
    { id: 'variants-owner', label: 'Colourways & sizes', model: recordModel('owner', { tab: 'variants' }), note: 'Range card, colourways beside the body measures, the SKU matrix (Space / Shift+Space / arrows / Enter). Size 58 is not covered by the certificate: flagged.' },
    { id: 'variants-range', label: 'Range being changed', model: recordModel('owner', { tab: 'variants', rangeDraft: { sizeScaleId: SCALES[0]!.id, sizes: [...SIZES.slice(1), '60'], baseSize: '52' } }), note: 'Before Apply: adds 60 (3 SKUs), takes out 46 (3 SKUs off, never deleted).' },
    { id: 'variants-missing', label: 'SKUs to generate', model: recordModel('owner', { tab: 'variants', style: { status: 'ready', value: demoStyle({ missing: ['ROSSO:56', 'ROSSO:58'] }) } }), note: 'Generate 2 SKUs is the card\'s primary.' },
    { id: 'generate', label: 'Generate SKUs', model: recordModel('owner', { tab: 'variants', style: { status: 'ready', value: demoStyle({ missing: ['ROSSO:56', 'ROSSO:58'] }) }, dialog: { kind: 'generate' } }) },
    { id: 'colourway-add', label: 'Add a colourway', model: recordModel('owner', { tab: 'variants', dialog: { kind: 'colourway', colourwayId: null } }) },
    { id: 'colourway-edit', label: 'Edit a colourway in use', model: recordModel('owner', { tab: 'variants', dialog: { kind: 'colourway', colourwayId: demoStyle().colourways[0]!.id } }), note: 'Its code is fixed: SKUs and orders name it.' },
    { id: 'variants-sales', label: 'Colourways & sizes (sales)', model: recordModel('sales', { tab: 'variants' }), note: 'Read only: the chips are the range; every change is held with its reason.' },
    { id: 'variants-empty', label: 'Colourways & sizes: nothing yet', model: recordModel('owner', { tab: 'variants', style: { status: 'ready', value: newStyle() }, revisionId: REV.r1, compliance: { status: 'idle' } }) },
    { id: 'activity', label: 'Activity', model: recordModel('owner', { tab: 'activity' }) },
    { id: 'dock', label: 'Thread beside the tab (wide)', model: recordModel('owner', { dockOpen: true }), note: '⌘J; 1280 px and wider (the phone opens Activity instead).' },
    { id: 'changed', label: 'Changed by someone else', model: recordModel('owner', { changed: { at: '2026-10-29T09:20:00.000Z' }, dialog: { kind: 'colourway', colourwayId: null } }) },
    { id: 'refused', label: 'A write refused', model: recordModel('owner', { notice: { key: 'problem.write.moved', tone: 'danger' }, save: { state: 'failed', at: null } }) },
    { id: 'compliance-failed', label: 'One part failed to load', model: recordModel('owner', { compliance: { status: 'error', problem: 'problem.read.unavailable' } }), note: 'The rest of the record stays usable.' },
    { id: 'loading', label: 'Loading', model: recordModel('owner', { style: { status: 'loading' } }) },
    { id: 'error', label: 'Could not open', model: recordModel('owner', { style: { status: 'error', problem: 'problem.read.unavailable' } }) },
    { id: 'not-found', label: 'Not found', model: recordModel('owner', { style: { status: 'not_found' } }) },
    { id: 'no-permission', label: 'No access', model: recordModel('sales', { style: { status: 'forbidden' } }) },
    { id: 'compliance-docs', label: 'Release with documents missing', model: recordModel('owner', { bom: { status: 'ready', value: demoBom({ complete: true }) }, compliance: { status: 'ready', value: demoCompliance({ docs: 'missing' }) }, dialog: { kind: 'release' } }), note: 'The DoC and leaflet stop shipping, the certificate gap stops production of size 58: said in the check, not refused.' },
  ],
})
