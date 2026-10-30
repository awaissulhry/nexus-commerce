import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { CAN, demoBom, demoCompliance, demoStyle, demoTypeChanges, recordModel, REV, REVISIONS } from '../demo/fixtures'
import type { StyleRecordViewModel } from '../record/record-model'
import { StyleRecordView } from '../record/view/StyleRecordView'

/**
 * SCR-045 Compliance of DEMO-JKT-01 — made-up certificate CERT-DEMO-0001 (EN 17092-4, class A, notified body 0000)
 * covering sizes 46–56 in every colourway, valid 47 more days; size 58 is not covered. DoC and leaflet in it, en, de.
 */

const LABELS = [
  { id: '0190f0e2-8888-7000-8000-000000000001', code: 'ETI-DEMO-JKT', revision: 2, name: 'Etichetta giacche touring (demo)', styleId: null, status: 'ACTIVE', languages: ['it', 'en', 'de'] },
  { id: '0190f0e2-8888-7000-8000-000000000002', code: 'ETI-DEMO-BASE', revision: 1, name: 'Etichetta base (demo)', styleId: null, status: 'ACTIVE', languages: ['it', 'en'] },
]
const released = { style: { status: 'ready' as const, value: demoStyle() }, revisionId: REV.r2, bom: { status: 'ready' as const, value: demoBom({ revision: REVISIONS[1] }) } }
const compliance = (overrides: Partial<StyleRecordViewModel> = {}, role: 'owner' | 'production' | 'product' = 'owner') => recordModel(role, { tab: 'compliance', ...released, compliance: { status: 'ready', value: demoCompliance() }, ...overrides })
const draft = { revisionId: REV.r3, bom: { status: 'ready' as const, value: demoBom() }, compliance: { status: 'ready' as const, value: demoCompliance({ revision: REVISIONS[0], docs: 'missing', label: false }) }, libraries: { scales: null, colours: null, brands: null, labels: LABELS, workshops: null } }

export const designScreen = defineDesignScreen<StyleRecordViewModel>({
  screen: 'SCR-045',
  title: 'Style studio: Compliance',
  view: StyleRecordView,
  cases: [
    { id: 'owner', label: 'Released revision 2', model: compliance(), note: 'Checks with what each stops; coverage colourway × size (58 not covered, the rest expiring in 47 days); DoC and leaflet per language; the label; tracking.' },
    { id: 'docs-older', label: 'Documents only for an older revision', model: compliance({ compliance: { status: 'ready', value: demoCompliance({ docs: 'older' }) } }), note: '"Only for rev 1": upload the signed one for revision 2.' },
    { id: 'upload', label: 'Upload a signed DoC', model: compliance({ dialog: { kind: 'upload', documentKind: 'DECLARATION_OF_CONFORMITY', language: 'de' } }) },
    { id: 'draft', label: 'Draft revision 3: name its label', model: compliance(draft), note: 'A draft names an active label template here; its documents are still missing.' },
    { id: 'production', label: 'Production manager (reads)', model: compliance({}, 'production'), note: 'Upload held with its reason; downloads open.' },
    { id: 'not-ppe', label: 'Not PPE', model: compliance({ style: { status: 'ready', value: demoStyle({ ppe: { ppeCategory: 'NOT_PPE', ppeStandard: null, ppeClass: null } }) }, compliance: { status: 'ready', value: demoCompliance({ notPpe: true }) } }) },
    { id: 'loading', label: 'Loading', model: compliance({ compliance: { status: 'loading' } }) },
    { id: 'error', label: 'Could not load', model: compliance({ compliance: { status: 'error', problem: 'problem.read.unavailable' } }) },
    // W2a (B-W2a-66): Changes that may need the notified body (design style.cp.change).
    { id: 'w2a-changes-draft', label: 'W2a Draft revision 3 changes the protector and the lining', model: compliance({ ...draft, typeChanges: { status: 'ready', value: demoTypeChanges('draft') } }), note: 'Found now against the type CERT-DEMO-0001 approved (revision 2); Tell Compliance makes a task on the style.' },
    { id: 'w2a-changes-held', label: 'W2a Released revision 2: its class label is held', model: compliance({ typeChanges: { status: 'ready', value: demoTypeChanges('released') } }), note: 'The notified body was told; the label waits for its answer.' },
    { id: 'w2a-tell', label: 'W2a Tell Compliance: the New task dialog, filled', model: compliance({ ...draft, typeChanges: { status: 'ready', value: demoTypeChanges('draft') }, dialog: { kind: 'tellCompliance', certificateId: demoTypeChanges('draft').certificates[0]!.certificate.id }, taskPeople: { status: 'ready', data: [{ id: '0190f0e2-3333-7000-8000-000000000001', name: 'Giulia Demo', me: true }, { id: '0190f0e2-3333-7000-8000-000000000002', name: 'Marco Demo', me: false }] } }) },
    { id: 'w2a-changes-none', label: 'W2a Nothing relevant changed: the section is hidden', model: compliance({ ...draft, typeChanges: { status: 'ready', value: demoTypeChanges('none') } }) },
    { id: 'w2a-changes-no-task', label: 'W2a Without the right to make tasks: Tell Compliance held', model: compliance({ ...draft, typeChanges: { status: 'ready', value: demoTypeChanges('draft') }, can: { ...CAN.owner, tellCompliance: false } }) },
    { id: 'w2a-changes-failed', label: 'W2a The changes could not be read', model: compliance({ typeChanges: { status: 'error', problem: 'problem.read.unavailable' } }) },
  ],
})
