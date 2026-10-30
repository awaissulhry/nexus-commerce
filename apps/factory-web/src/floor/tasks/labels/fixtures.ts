import { defineDesignScreen } from '../../../lib/design/design-screen'
import { onFloor, signedInFrame } from '../../frame/fixtures'
import type { LabelsView as LabelsAnswer, RenderedLabel, ViewCell } from './api'
import { labelsStepOf, orderOf, type LabelsState } from './steps'
import type { JobModel } from './model'
import { LabelsView, type LabelsViewModel } from './view/LabelsView'

/**
 * SCR-096's cases: garment labels at the final operation, at tablet width, from the scan to the printed labels, with
 * every state the design names (scan, a code of no work order, loading, error, no permission; the gate green with the
 * batch number, a serial style, a size the certificate gate refuses, a retired label layout, the floor not ready, no
 * label template; the printer picked when the site has several, none that takes the label; printing with each job's
 * state and Retry, Print all with a size refused; the reprint question with its reasons, for a batch and for a serial;
 * offline with the last read kept; a refused print; done) and the roles (a packing operator, a team leader, a worker
 * without labels). Made-up work orders, styles, certificates, batches and serials of a made-up "Demo" plant; no
 * customer, no money, never another person.
 */

const PACK = 'PACK-01 · Banco imballo'
const frame = (extra: Partial<LabelsViewModel['frame']> = {}) => signedInFrame('tile.labels', { station: { name: PACK, site: 'Stabilimento Demo Nord' }, ...extra })
const AT = '2026-10-29T09:41:00.000Z'
const PRINTED_AT = '2026-10-29T08:12:00.000Z'

const covered = { outcome: 'covered' as const, certificate: { id: 'cert-demo-17', number: 'CERT-DEMO-17', standard: 'EN 17092-4', ppeClass: 'A', validTo: '2028-03-31' }, words: '' }
const cell = (size: string, finished: number, labelled: number, extra: Partial<ViewCell> = {}): ViewCell => ({
  workOrderSizeId: `cell-nero-${size}`,
  colourwayId: 'cw-nero',
  colourwayCode: 'NERO',
  colourwayName: 'Nero',
  size,
  quantity: finished + 2,
  finished,
  labelled,
  reprinted: 0,
  toLabel: Math.max(0, finished - labelled),
  overLabelled: Math.max(0, labelled - finished),
  gate: covered,
  printable: true,
  refusal: null,
  ...extra,
})

/** The label as compliance/labels renders it for one size (stand-in marks, the batch as a barcode). */
const preview = (serial: string | null, model = 'GIA-01 Giacca moto Demo'): RenderedLabel => ({
  template: { id: 'tpl-demo', code: 'ETI-GIACCA', revision: 2, status: 'ACTIVE', name: 'Etichetta giacca moto' },
  sample: false,
  banner: [],
  preset: 'STANDARD',
  languages: ['it', 'en'],
  blocks: [
    { field: 'ceMark', value: null, lines: [], graphic: { kind: 'CE', notifiedBodyNumber: null }, placeholder: false },
    { field: 'pictogram', value: null, lines: [], graphic: { kind: 'PICTOGRAM', pictogram: 'MOTORCYCLIST', standardCode: 'EN 17092-4', ppeClass: 'A' }, placeholder: false },
    { field: 'model', value: model, lines: [{ text: model, language: null }], graphic: null, placeholder: false },
    { field: 'size', value: '52', lines: [{ text: 'Taglia / Size 52', language: null }], graphic: null, placeholder: false },
    { field: 'composition', value: null, lines: [{ text: 'Esterno: pelle bovina 100% · Outer: cowhide 100%', language: null }], graphic: null, placeholder: false },
    { field: 'animalOrigin', value: null, lines: [{ text: 'Contiene parti non tessili di origine animale', language: 'it' }, { text: 'Contains non-textile parts of animal origin', language: 'en' }], graphic: null, placeholder: false },
    { field: 'care', value: null, lines: [], graphic: { kind: 'CARE', symbols: [{ code: 'W0', mark: 'W0', words: 'Do not wash' }, { code: 'B0', mark: 'B0', words: 'Do not bleach' }, { code: 'I1', mark: 'I1', words: 'Iron low' }] }, placeholder: false },
    { field: 'maker', value: null, lines: [{ text: 'Officina Demo S.r.l. · Via Esempio 1 · IT', language: null }], graphic: null, placeholder: false },
    { field: 'batchOrSerial', value: serial ?? 'BT-DM-26-041', lines: [], graphic: { kind: 'BARCODE', value: serial ?? 'BT-DM-26-041' }, placeholder: false },
  ],
  fit: { widthMm: '50', heightMm: '80', fits: true },
  printable: true,
})

const printers = { one: [{ id: 'printer-label', code: 'LBL-PACK-01', name: 'Etichette imballo', labelWidthMm: 50, labelHeightMm: 80, holdsLabel: true }] }

const answer = (cells: ViewCell[], extra: Partial<LabelsAnswer> = {}): LabelsAnswer => ({
  workOrder: { id: 'wo-demo-0042', number: 'WO-DEMO-0042', batchNumber: 'BT-DM-26-041', status: 'IN_PROGRESS', siteId: 'site-demo', releasedAt: '2026-10-20T07:00:00.000Z', style: { id: 'style-demo', code: 'GIA-01', name: 'Giacca moto Demo' } },
  tracking: 'BATCH',
  label: { id: 'tpl-demo', code: 'ETI-GIACCA', revision: 2, status: 'ACTIVE', widthMm: '50', heightMm: '80' },
  finalOperation: { id: 'op-demo-40', seq: 40, code: 'PACK', name: 'Controllo e imballo' },
  date: '2026-10-29',
  blocked: null,
  cells,
  printers: printers.one,
  preview: preview(null),
  ...extra,
})

const CELLS = [cell('48', 2, 2), cell('50', 4, 0), cell('52', 6, 2), cell('54', 3, 0), cell('56', 0, 0)]
const BATCH = answer(CELLS)
const refused60 = cell('60', 2, 0, { gate: { outcome: 'refused', certificate: null, words: '' }, printable: false, refusal: { code: 'CERTIFICATE', message: 'No certificate covers size 60.', fix: 'Ask quality.', workOrderSizeId: 'cell-nero-60' } })
const WITH_60 = answer([...CELLS, refused60])

const base = (extra: Partial<LabelsState> = {}, view: LabelsAnswer = BATCH): LabelsState => ({
  view,
  previewCell: 'cell-nero-52',
  picked: 'cell-nero-52',
  printer: null,
  serial: null,
  online: true,
  busy: false,
  jobs: [],
  refused: [],
  problems: [],
  note: null,
  reading: null,
  printedTotal: 0,
  ...extra,
})
const model = (step: LabelsViewModel['step'], extra: Partial<LabelsViewModel> = {}): LabelsViewModel => ({ frame: frame(), online: true, step, ...extra })
const labels = (state: Partial<LabelsState> = {}, view?: LabelsAnswer) => labelsStepOf(base(state, view))

const SERIAL = answer([cell('50', 2, 2), cell('52', 3, 1), cell('54', 1, 0)], {
  workOrder: { ...BATCH.workOrder, id: 'wo-demo-0055', number: 'WO-DEMO-0055', batchNumber: 'BT-DM-26-055', style: { id: 'style-tuta', code: 'TUT-02', name: 'Tuta pista Demo' } },
  tracking: 'SERIAL',
  preview: { ...preview('SN-7K-00A01T-4', 'TUT-02 Tuta pista Demo'), template: { ...preview(null).template, name: 'Etichetta tuta pista' } },
})

const RETIRED = answer(CELLS.map((entry) => ({ ...entry, printable: false, refusal: { code: 'TEMPLATE_NOT_ACTIVE', message: 'The template is RETIRED.', fix: 'Ask the office.', workOrderSizeId: entry.workOrderSizeId } })), { label: { ...BATCH.label!, status: 'RETIRED' }, preview: null })

const JOBS: JobModel[] = [
  { id: 'job-1', what: 'NERO 48', serial: null, copies: 2, status: 'PRINTED', detail: null, version: 3, reprint: false },
  { id: 'job-2', what: 'NERO 50', serial: null, copies: 4, status: 'SENT', detail: null, version: 2, reprint: false },
  { id: 'job-3', what: 'NERO 52', serial: null, copies: 4, status: 'QUEUED', detail: null, version: 1, reprint: false },
  { id: 'job-4', what: 'NERO 54', serial: null, copies: 3, status: 'FAILED', detail: 'La stampante LBL-PACK-01 non ha risposto.', version: 2, reprint: false },
]
const AFTER_ALL = answer([cell('48', 2, 2), cell('50', 4, 4), cell('52', 6, 6), cell('54', 3, 3), cell('56', 0, 0), refused60])

const SEVERAL = answer(CELLS, {
  printers: [
    { id: 'printer-a', code: 'LBL-PACK-01', name: 'Etichette banco 1', labelWidthMm: 50, labelHeightMm: 80, holdsLabel: true },
    { id: 'printer-b', code: 'LBL-PACK-02', name: 'Etichette banco 2', labelWidthMm: 60, labelHeightMm: 90, holdsLabel: true },
    { id: 'printer-c', code: 'LBL-CUT-01', name: 'Cartellini taglio', labelWidthMm: 100, labelHeightMm: 50, holdsLabel: false },
  ],
})
const NONE_FITS = answer(CELLS, { printers: [{ id: 'printer-c', code: 'LBL-CUT-01', name: 'Cartellini taglio', labelWidthMm: 100, labelHeightMm: 40, holdsLabel: false }] })
const FULL = answer([cell('48', 2, 2), cell('50', 4, 4), cell('52', 6, 6, { reprinted: 1 }), cell('54', 3, 3)])
const size52 = labelsStepOf(base({}, FULL)).picked!

export const designScreen = defineDesignScreen<LabelsViewModel>({
  screen: 'SCR-096',
  title: 'Garment labels',
  view: onFloor(LabelsView),
  cases: [
    { id: 'scan', label: 'For which work order? Scan the traveller or a bundle', model: model({ kind: 'scan' }), note: 'A bundle ticket at the final operation opens its size at once; a serial label opens it to print again.' },
    { id: 'not-here', label: 'A code that is no work order, bundle or serial', model: model({ kind: 'scan', note: { kind: 'notHere', code: 'HD-7K-0003RJ-M', why: 'otherLabel' } }) },
    { id: 'not-found', label: 'A number of no work order at this site', model: model({ kind: 'scan', note: { kind: 'notHere', code: 'WO-DEMO-9999', why: 'notFound' } }) },
    { id: 'loading', label: 'Reading', model: model({ kind: 'loading', code: 'WO-DEMO-0042' }) },
    { id: 'error', label: 'The office does not answer', model: model({ kind: 'problem', problem: { kind: 'unavailable' }, code: 'WO-DEMO-0042' }) },
    { id: 'no-permission', label: 'A worker without garment labels', model: model({ kind: 'noPermission' }), note: 'The Garment labels tile needs production.serials: a sewing operator opening the address sees this.' },
    {
      id: 'gate-ok',
      label: 'Batch number: the certificate covers the size, the label to scale',
      model: model(labels()),
      note: 'Print one size = scan → size → Print (2 taps); Print all = 1 tap. The marks are stand-ins, said under the label.',
    },
    { id: 'serial-style', label: 'A serial per garment (the style says)', model: model(labels({ previewCell: 'cell-nero-52', picked: 'cell-nero-52' }, SERIAL)), note: 'Each label gets its own serial when it prints; the one shown is an example of its form.' },
    {
      id: 'gate-refused',
      label: 'No valid certificate covers size 60: held with the reason',
      model: model(labels({ picked: 'cell-nero-60', previewCell: 'cell-nero-60' }, { ...WITH_60, preview: null })),
      note: 'Red, in place of the label: labels cannot print, tell quality. Print all still prints the other sizes.',
    },
    { id: 'template-retired', label: 'The label layout was retired', model: model(labels({}, RETIRED)) },
    {
      id: 'floor-not-ready',
      label: 'The floor is not ready (privacy steps): nothing prints',
      model: model({ kind: 'blocked', order: orderOf(BATCH), refusal: { code: 'FLOOR_NOT_READY', message: 'The site is not ready for floor work.', fix: 'Ask the office.', workOrderSizeId: null } }),
    },
    { id: 'no-template', label: 'The style names no label', model: model({ kind: 'blocked', order: orderOf(BATCH), refusal: { code: 'NO_LABEL_TEMPLATE', message: 'No label template.', fix: 'Ask quality.', workOrderSizeId: null } }) },
    { id: 'printing', label: 'Printing: waiting, sent, printed, failed with Retry', model: model(labels({ jobs: JOBS, note: { kind: 'printed', count: 13, sizes: 'NERO 48, NERO 50, NERO 52, NERO 54' }, printedTotal: 13 }, answer([cell('48', 2, 2), cell('50', 4, 4), cell('52', 6, 6), cell('54', 3, 3), cell('56', 0, 0)]))) },
    {
      id: 'some-refused',
      label: 'Print all: one size refused by the certificate gate, the others printed',
      model: model(labels({ jobs: JOBS.slice(0, 3), refused: [refused60.refusal!], note: { kind: 'printed', count: 10, sizes: 'NERO 50, NERO 52, NERO 54' }, printedTotal: 10 }, AFTER_ALL)),
    },
    { id: 'pick-printer', label: 'Several label printers: pick one first', model: model(labels({}, SEVERAL)), note: 'Only the printers whose stock takes the label are offered; the pick is kept for the visit.' },
    { id: 'printer-picked', label: 'A printer picked', model: model(labels({ printer: 'printer-b' }, SEVERAL)) },
    { id: 'no-printer', label: 'No label printer here takes the label', model: model(labels({}, NONE_FITS)) },
    { id: 'all-labelled', label: 'Every garment of the size labelled: Reprint asks why', model: model(labels({}, FULL)) },
    {
      id: 'reprint',
      label: 'Reprint: how many and why',
      model: model({ kind: 'reprint', order: orderOf(FULL), size: size52, serial: null, count: 6, printedAt: PRINTED_AT, held: null }),
      note: 'Every reprint is logged with its reason; never more labels than were printed. Enter = Cancel.',
    },
    {
      id: 'reprint-serial',
      label: 'Reprint of one serial (scanned)',
      model: model({ kind: 'reprint', order: orderOf(SERIAL), size: labelsStepOf(base({ picked: 'cell-nero-50' }, SERIAL)).picked!, serial: 'SN-7K-00A01T-4', count: 1, printedAt: null, held: null }),
    },
    {
      id: 'offline',
      label: 'Offline: printing waits, the last read stays',
      model: model(labels({ online: false }), { online: false, asOf: AT, frame: frame({ online: false }) }),
      note: 'Garment labels never queue: each print is logged by the office at once.',
    },
    {
      id: 'refused-write',
      label: 'A print the office refused (more than finished)',
      model: model(labels(), { notice: { kind: 'refused', code: 'MORE_THAN_FINISHED', message: 'NERO 52 has 6 garments finished and 2 of them labelled.', fix: 'Read the numbers again.' } }),
    },
    { id: 'done', label: 'All labels printed', model: model({ kind: 'done', number: 'WO-DEMO-0042', labels: 15 }) },
    { id: 'team-leader', label: 'A team leader at the bench', model: model(labels(), { frame: frame({ operator: { name: 'Teo Demo' } }) }) },
  ],
})
