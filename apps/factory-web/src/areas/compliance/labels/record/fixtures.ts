import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { failedRead, reading, ready } from '../../../quality/_shared/model'
import { CAN, CHOICES, detailOf, GLOVES_R1, JACKET_R1, JACKET_R2, job, NOW, OLD_R1, PREFIX, previewOf, PRINTERS, SHARED_R1, TODAY, TSHIRT_R1, valuesFor, VEST_R1 } from '../demo'
import { draftOf } from '../model'
import { DEPTH_CAN, demoArtwork, demoChecks, demoDepth, demoTextile, gloveChecks, ME, PROOF_PICTURE, tshirtChecks } from '../depth/demo'
import type { LabelRecordModel } from '../view-model'
import { LabelRecordView } from './view/LabelRecordView'

/**
 * SCR-053 the label record — made-up data only (PLAN §3.1). The builder on the touring jacket's revision 2 draft (a part
 * that adds up to 95 %, a Dutch label with no built-in animal-origin words), the glove label ready to activate, the
 * active revision 1 frozen, a retired label, the category III vest without its notified-body number, a not-PPE t-shirt,
 * a label that does not fit, the compact preset, the dialogs (activate, retire, new revision, test print queued /
 * printed / failed), Versions and Test prints, the read states and the role cases.
 */

const jacketValues = valuesFor('jacket')
const draftDetail = detailOf(JACKET_R2)
const base: LabelRecordModel = {
  prefix: PREFIX,
  can: CAN.owner,
  tab: 'content',
  detail: ready(draftDetail),
  today: TODAY,
  draft: draftOf(JACKET_R2),
  preview: ready(previewOf(JACKET_R2, jacketValues)),
  ask: {},
  style: CHOICES,
  save: { state: 'idle', at: NOW },
  live: 'live',
  changed: null,
  notice: null,
  dialog: null,
  printers: ready(PRINTERS),
  prints: ready([job('PRINTED', 1), job('FAILED', 2)]),
  test: { job: null, label: null, printer: null },
  busy: false,
  problem: null,
  // B-W2b-270: the label's W2b parts (marking, rules, languages, artwork) in every case.
  depth: demoDepth(),
}

const of = (row: typeof JACKET_R1, key: Parameters<typeof valuesFor>[0], extra: Partial<LabelRecordModel> = {}): LabelRecordModel => ({
  ...base,
  detail: ready(detailOf(row)),
  draft: row.status === 'DRAFT' ? draftOf(row) : null,
  preview: ready(previewOf(row, valuesFor(key))),
  ...extra,
})

const glovesReady = of(GLOVES_R1, 'gloves')
const active = of(JACKET_R1, 'jacket')
const typed = { ...draftOf(JACKET_R2), composition: [{ part: 'Esterno', fibres: [{ fibre: 'poliammide', percent: '80' }, { fibre: 'poliestere', percent: '20' }] }, { part: 'Fodera', fibres: [{ fibre: 'poliestere', percent: '100' }] }], animalOriginTexts: { nl: 'Bevat niet-textieldelen van dierlijke oorsprong' } }
const tall = { ...draftOf(JACKET_R2), heightMm: '40', languages: ['it', 'en', 'de', 'fr', 'es'] }
const compact = { ...draftOf(GLOVES_R1), preset: 'COMPACT' as const }
const testLabel = previewOf(JACKET_R1, jacketValues).label

export const designScreen = defineDesignScreen<LabelRecordModel>({
  screen: 'SCR-053-label',
  title: 'Label record and builder',
  view: LabelRecordView,
  cases: [
    { id: 'draft-problems', label: 'Builder: revision 2 draft with problems', model: base, note: 'Activate is held with the count; each rule check names its field (Go to the field) with the API’s sentence under our words.' },
    { id: 'draft-typing', label: 'Builder: fixing it, not saved yet', model: { ...base, draft: typed }, note: 'The preview and the checks are the browser’s own render of the unsaved draft (the same rules as the server): Save, then Activate.' },
    { id: 'draft-ready', label: 'Glove label ready to activate', model: glovesReady, note: 'Every check passes; the compact preset, 40 × 80 mm.' },
    { id: 'activate', label: 'Activate (the approval)', model: { ...glovesReady, dialog: { kind: 'activate' } }, note: 'Every check passes; "Active labels are never edited: a change is revision 2."' },
    { id: 'activate-refused', label: 'Activate refused by the server', model: { ...glovesReady, dialog: { kind: 'activate' }, problem: { key: 'problem.state', lines: ['Label LBL-DEMO-GLV-01 r1 cannot be activated yet: 1 problem(s) to fix first.'] } } },
    { id: 'active', label: 'Active revision 1 (frozen)', model: active, note: 'Content as text, never greyed inputs; New revision 3 is held: revision 2 is a draft already.' },
    { id: 'active-revise', label: 'Active: new revision', model: of(SHARED_R1, 'jacket', { dialog: { kind: 'revise' } }), note: 'A shared label is previewed on the first style naming it.' },
    { id: 'retire', label: 'Retire an active label', model: { ...active, dialog: { kind: 'retire', reason: '' } }, note: 'The reach first: the released style revision naming it cannot release a work order any more.' },
    { id: 'retired', label: 'Retired', model: of(OLD_R1, 'jacket', { preview: failedRead('preview.needStyle'), notice: { key: 'done.retired', params: { code: 'LBL-DEMO-OLD', revision: 1 }, tone: 'success' } }), note: 'A shared label no style names has no preview: said, not drawn empty.' },
    { id: 'vest-cat3', label: 'Category III vest: no notified body', model: of(VEST_R1, 'vest'), note: 'The CE mark needs the notified-body number (art. 17(2)); no certificate covers the vest today (this garment only).' },
    { id: 'not-ppe', label: 'Not PPE (t-shirt)', model: of(TSHIRT_R1, 'tshirt'), note: 'No CE mark, no pictogram: the label prints the model, size, batch and maker.' },
    { id: 'does-not-fit', label: 'Text too long for the label', model: { ...base, draft: tall }, note: 'Five languages on 40 mm: "Does not fit" with the heights; the size check opens.' },
    { id: 'compact', label: 'Compact preset', model: { ...glovesReady, draft: compact } },
    { id: 'saving', label: 'Saving', model: { ...base, draft: typed, save: { state: 'saving', at: NOW } } },
    { id: 'save-refused', label: 'Save refused', model: { ...base, draft: typed, save: { state: 'failed', at: NOW }, notice: { key: 'notice.saveRefused', tone: 'danger', detail: ['body/widthMm: A label is 20 to 150 mm wide (at most 2 decimals).'] } } },
    { id: 'changed', label: 'Someone else saved it', model: { ...base, draft: typed, changed: { at: NOW } } },
    { id: 'discard', label: 'Discard the changes', model: { ...base, draft: typed, dialog: { kind: 'discard' } } },
    { id: 'test-choose', label: 'Print test label', model: { ...active, dialog: { kind: 'test', printerId: PRINTERS[0]!.id, copies: 1 } } },
    { id: 'test-queued', label: 'Test print queued', model: { ...active, dialog: { kind: 'test', printerId: PRINTERS[0]!.id, copies: 1 }, test: { job: job('QUEUED', 3), label: testLabel, printer: PRINTERS[0]! } } },
    { id: 'test-printed', label: 'Test print printed', model: { ...active, dialog: { kind: 'test', printerId: PRINTERS[0]!.id, copies: 2 }, test: { job: job('PRINTED', 4, { copies: 2 }), label: testLabel, printer: PRINTERS[0]! } } },
    { id: 'test-failed', label: 'Test print failed', model: { ...active, dialog: { kind: 'test', printerId: PRINTERS[0]!.id, copies: 1 }, test: { job: job('FAILED', 5), label: testLabel, printer: PRINTERS[0]! } }, note: 'The printer’s words under "Not printed", and Retry.' },
    { id: 'test-no-printer', label: 'Test print: no printer', model: { ...active, printers: ready([]), dialog: { kind: 'test', printerId: null, copies: 1 } } },
    { id: 'versions', label: 'Versions', model: { ...active, tab: 'versions' }, note: 'Every revision with links; the style revisions and work orders that use this one.' },
    { id: 'prints', label: 'Test prints', model: { ...active, tab: 'prints' } },
    { id: 'prints-empty', label: 'No test print yet', model: { ...active, tab: 'prints', prints: ready([]) } },
    { id: 'developer', label: 'Product developer (reads a draft)', model: { ...base, can: CAN.developer, draft: null }, note: 'The content as text with "You can view this draft, not change it"; Activate and Print test label held with their reasons.' },
    { id: 'quality', label: 'Quality (writes)', model: { ...base, can: CAN.quality } },
    { id: 'preview-failed', label: 'Preview could not be drawn', model: { ...base, preview: failedRead('problem.unavailable') } },
    { id: 'loading', label: 'Loading', model: { ...base, detail: reading(), draft: null, preview: reading() } },
    { id: 'error', label: 'Could not load', model: { ...base, detail: failedRead('problem.unavailable'), draft: null } },
    { id: 'not-found', label: 'Not found', model: { ...base, detail: failedRead('problem.notFound'), draft: null } },
    { id: 'no-permission', label: 'Sales: no access', model: { ...base, can: CAN.sales, draft: null } },
    // ---- B-W2b-270: Labels & marking in depth ----
    {
      id: 'w2b-builder',
      label: 'W2b: builder with marking, BOM composition and the rules',
      model: base,
      note: 'Kind and marking after the maker (QR to the batch, GPSR contact with "Fill from operator roles", the removable-protectors warning waiting for the PPE consultant); the BOM’s composition after the label’s (Use for the label); Marking and textile rules beside the preview: DE cannot print (no de warning), textile share 82 % applies, Made in Italy allowed — each with its laws.',
    },
    {
      id: 'w2b-marking-edited',
      label: 'W2b: marking changed, not saved',
      model: { ...base, depth: demoDepth({ marking: { kind: 'PPE_GARMENT', qrTarget: 'STYLE_DOC', gpsrContact: 'Officina Demo S.r.l.\nVia dell’Esempio 12, 00000 Borgo Demo (XX)\nassistenza@example.com' } }) },
      note: 'The save bar counts the marking’s changes with the content’s; Save sends the content, then the marking.',
    },
    { id: 'w2b-rules-ch', label: 'W2b: the rules for Switzerland', model: { ...base, depth: demoDepth({ market: 'CH' }) }, note: 'A market needing de, fr and it: the class warning has no approved de or fr words.' },
    { id: 'w2b-glove', label: 'W2b: glove marking, level 1 KP granted', model: of(GLOVES_R1, 'gloves', { depth: demoDepth({ checks: ready(gloveChecks()), textile: ready(demoTextile(GLOVES_R1)), artwork: ready(demoArtwork(GLOVES_R1)) }) }) },
    { id: 'w2b-fibre-care-gpsr', label: 'W2b: fibre & care label of a non-PPE line with its GPSR contact', model: of(TSHIRT_R1, 'tshirt', { depth: demoDepth({ checks: ready(tshirtChecks()), artwork: ready(demoArtwork(TSHIRT_R1, { versions: [], approvedId: null, workOrders: [] })) }) }) },
    { id: 'w2b-active-facts', label: 'W2b: active label — marking as text', model: { ...active, depth: demoDepth({ checks: ready(demoChecks(JACKET_R1)), artwork: ready(demoArtwork(JACKET_R1)) }) }, note: 'An active label is never edited: kind, QR and contact read as text; the rules still show.' },
    { id: 'w2b-checks-loading', label: 'W2b: rules being read', model: { ...base, depth: demoDepth({ checks: reading(), textile: reading() }) } },
    { id: 'w2b-checks-failed', label: 'W2b: rules could not be read', model: { ...base, depth: demoDepth({ checks: failedRead('problem.unavailable'), textile: failedRead('problem.unavailable') }) }, note: 'Each panel says what failed with Try again; the builder stays usable.' },
    { id: 'w2b-no-style', label: 'W2b: a shared label no style names', model: of(OLD_R1, 'jacket', { preview: failedRead('preview.needStyle'), depth: demoDepth({ checks: failedRead('depth.needStyle'), textile: null, artwork: ready(demoArtwork(OLD_R1, { versions: [], approvedId: null, workOrders: [] })) }) }) },
    { id: 'w2b-languages', label: 'W2b: Languages', model: { ...base, tab: 'languages' }, note: 'Columns: it, en, nl on the label; de and fr needed by DE, FR, CH and missing → the label cannot print there. The warning’s de cell is missing ✕ and blocks DE and CH; fr waits for approval.' },
    { id: 'w2b-languages-selected', label: 'W2b: two phrases selected, approve their proposals', model: { ...base, tab: 'languages', depth: demoDepth({ selectedPhrases: ['warning.protectors-removable', 'marking.animal-origin'] }) }, note: 'Approve 1 translation: the nl proposal is yours (held), the fr one is someone else’s.' },
    { id: 'w2b-languages-translate', label: 'W2b: Translate the warning', model: { ...base, tab: 'languages', dialog: { kind: 'translate', key: 'warning.protectors-removable', texts: { de: 'Die Protektoren sind herausnehmbar.' } } }, note: 'Each language: approved words, the waiting proposal with Approve, a field that proposes when left.' },
    { id: 'w2b-languages-saving', label: 'W2b: a proposal being saved', model: { ...base, tab: 'languages', dialog: { kind: 'translate', key: 'warning.protectors-removable', texts: { de: 'Die Protektoren sind herausnehmbar.' } }, depth: demoDepth({ writing: 'warning.protectors-removable|de' }) } },
    { id: 'w2b-languages-refused', label: 'W2b: a proposal refused', model: { ...base, tab: 'languages', dialog: { kind: 'translate', key: 'warning.protectors-removable', texts: { de: 'x' } }, depth: demoDepth({ cellProblem: { at: 'warning.protectors-removable|de', key: 'problem.conflict' } }) } },
    { id: 'w2b-languages-developer', label: 'W2b: Languages, product developer (reads)', model: { ...base, tab: 'languages', can: CAN.developer, draft: null, depth: demoDepth({ can: DEPTH_CAN.developer, phrases: ready({ ...demoDepth().phrases.value!, mayManage: false, mayApprove: false }) }) }, note: 'Fill from the library and the approvals held with their reasons.' },
    { id: 'w2b-languages-loading', label: 'W2b: Languages being read', model: { ...base, tab: 'languages', depth: demoDepth({ phrases: reading() }) } },
    { id: 'w2b-languages-failed', label: 'W2b: phrase library could not be read', model: { ...base, tab: 'languages', depth: demoDepth({ phrases: failedRead('problem.unavailable') }) } },
    { id: 'w2b-artwork', label: 'W2b: Artwork & approval', model: { ...base, tab: 'artwork' }, note: 'v3 waits for a second person (SignOffPanel), v2 prints, v1 retired; the work orders follow the proof in force at their first print. Send to the brand is held: the portal approval comes later.' },
    { id: 'w2b-artwork-own', label: 'W2b: your own proof', model: { ...base, tab: 'artwork', depth: demoDepth({ artwork: ready(demoArtwork(undefined, { versions: demoArtwork().versions.map((version) => (version.versionNo === 3 ? { ...version, byYou: true, author: { id: ME, name: 'Tu (demo)' } } : version)) })) }) }, note: 'Approve is held: "You made this proof: a second person approves it."' },
    { id: 'w2b-artwork-empty', label: 'W2b: no proof yet', model: { ...base, tab: 'artwork', depth: demoDepth({ artwork: ready(demoArtwork(undefined, { versions: [], approvedId: null })) }) } },
    { id: 'w2b-artwork-view', label: 'W2b: artwork, product developer (reads)', model: { ...base, tab: 'artwork', can: CAN.developer, draft: null, depth: demoDepth({ can: DEPTH_CAN.developer, artwork: ready(demoArtwork(undefined, { mayManage: false, mayApprove: false })) }) } },
    { id: 'w2b-artwork-loading', label: 'W2b: artwork being read', model: { ...base, tab: 'artwork', depth: demoDepth({ artwork: reading() }) } },
    { id: 'w2b-artwork-failed', label: 'W2b: artwork could not be read', model: { ...base, tab: 'artwork', depth: demoDepth({ artwork: failedRead('problem.unavailable') }) } },
    {
      id: 'w2b-approve',
      label: 'W2b: Approve artwork (pop:lb-approve)',
      model: { ...base, tab: 'artwork', dialog: { kind: 'approveProof', versionId: demoArtwork().versions[0]!.id, reason: '' }, depth: demoDepth({ proof: { versionId: demoArtwork().versions[0]!.id, src: ready(PROOF_PICTURE) } }) },
      note: 'The proof beside its sign-off; approving retires v2 (one proof prints per label revision).',
    },
    { id: 'w2b-approve-loading', label: 'W2b: Approve, proof being read', model: { ...base, tab: 'artwork', dialog: { kind: 'approveProof', versionId: demoArtwork().versions[0]!.id, reason: '' }, depth: demoDepth({ proof: { versionId: demoArtwork().versions[0]!.id, src: reading() } }) } },
    {
      id: 'w2b-approve-refused',
      label: 'W2b: Approve refused by the server',
      model: { ...base, tab: 'artwork', busy: false, dialog: { kind: 'approveProof', versionId: demoArtwork().versions[0]!.id, reason: 'Va bene.' }, depth: demoDepth({ proof: { versionId: demoArtwork().versions[0]!.id, src: ready(PROOF_PICTURE) }, cellProblem: { at: `proof|${demoArtwork().versions[0]!.id}`, key: 'problem.conflict', lines: ['Artwork v3 changed meanwhile.'] } }) },
    },
    { id: 'w2b-add-proof', label: 'W2b: Add a proof', model: { ...base, tab: 'artwork', dialog: { kind: 'addProof', note: 'Nuovo indirizzo (demo).' }, depth: demoDepth({ picked: { name: 'LBL-DEMO-JKT-01-r2-v4.pdf', contentType: 'application/pdf', size: 182_000, bytes: new ArrayBuffer(0) } }) } },
    { id: 'w2b-add-proof-wrong', label: 'W2b: Add a proof, not a PDF or picture', model: { ...base, tab: 'artwork', dialog: { kind: 'addProof', note: '' }, depth: demoDepth({ picked: { name: 'notes.txt', contentType: 'text/plain', size: 1200, bytes: new ArrayBuffer(0) } }) } },
    { id: 'w2b-retire-proof', label: 'W2b: Retire the approved proof', model: { ...base, tab: 'artwork', dialog: { kind: 'retireProof', versionId: demoArtwork().versions[1]!.id, reason: '' } } },
    { id: 'w2b-approved-notice', label: 'W2b: after approving', model: { ...base, tab: 'artwork', notice: { key: 'depth.done.proofApproved', params: { n: 3 }, tone: 'success' } } },
  ],
})

