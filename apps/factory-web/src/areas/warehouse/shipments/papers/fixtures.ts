import { defineDesignScreen } from '../../../../lib/design/design-screen'
import type { Pack, Proformas } from './api'
import type { PapersModel, PublicDoc } from './model'
import { PapersView } from './view/PapersView'

/**
 * SCR-596 — Documents in depth (B-W2b-410 on B-W2b-391 and B-W2b-166; design sh-docs-other "proforma, generated documents
 * with versions · Print all (one merged PDF)", sh-doc-conf "the public DoC link"): the driver's pack, the proforma, the public
 * DoC pages. Made-up data only (styles DEMO-JKT, DEMO-PNT; printer "Ufficio A4").
 */

const uid = (n: number) => `0190f0e2-7413-7000-8000-${String(n).padStart(12, '0')}`

const pack = (over: Partial<Pack> = {}): Pack => ({
  shipmentId: uid(1),
  number: 'SH-26-0107',
  status: 'PACKED',
  parts: [
    { kind: 'LABELS', state: 'READY', number: null, files: 3, test: false },
    { kind: 'PACKING_LIST', state: 'READY', number: 'PL-26-0107', files: 1, test: false },
    { kind: 'DDT', state: 'READY', number: '153/2026', files: 1, test: false },
    { kind: 'COMMERCIAL_INVOICE', state: 'NONE', number: null, files: 0, test: false },
    { kind: 'PROFORMA', state: 'NOT_SHOWN', number: 'PF-26-0012', files: 0, test: false },
  ],
  test: false,
  latest: { documentId: uid(20), version: 2, pages: 7, createdAt: '2026-11-14T11:30:00.000Z', current: true },
  printer: { id: uid(21), code: 'A4-1', name: 'Ufficio A4' },
  ...over,
})

const proformas = (over: Partial<Proformas> = {}): Proformas => ({
  label: 'SH-26-0107',
  purpose: 'CUSTOMS',
  number: 'PF-26-0012',
  versions: [
    { documentId: uid(31), version: 2, number: 'PF-26-0012', language: 'en', fileId: uid(41), createdAt: '2026-11-14T11:10:00.000Z', createdBy: 'Marta Demo', current: true },
    { documentId: uid(32), version: 1, number: 'PF-26-0012', language: 'it', fileId: uid(42), createdAt: '2026-11-13T16:00:00.000Z', createdBy: 'Marta Demo', current: false },
  ],
  problems: [],
  ...over,
})

const docs: PublicDoc[] = [
  { styleId: uid(51), styleCode: 'DEMO-JKT', styleName: 'Demo touring jacket', code: '7K3Q-M2XA', address: 'https://factory.example/doc/7K3QM2XA', live: true },
  { styleId: uid(52), styleCode: 'DEMO-PNT', styleName: 'Demo touring trousers', code: '9RT4-B7KC', address: 'https://factory.example/doc/9RT4B7KC', live: false },
]

const ALL = { pack: true, printDocuments: true, readFiles: true, proforma: true, price: true }
const model = (over: Partial<PapersModel> = {}): PapersModel => ({
  number: 'SH-26-0107',
  status: 'PACKED',
  pack: { state: 'ready', value: pack() },
  proformas: { state: 'ready', value: proformas() },
  docs: { state: 'ready', value: docs },
  can: ALL,
  pdf: null,
  dialog: null,
  busy: false,
  problem: null,
  done: null,
  ...over,
})

export const designScreen = defineDesignScreen<PapersModel>({
  screen: 'SCR-596',
  title: 'Shipment › Documents: the driver\'s pack as one PDF, the proforma, the public DoC pages',
  view: PapersView,
  part: true,
  cases: [
    { id: 'all', label: 'Pack ready (proforma only named: priced), proforma v2, two public DoC pages (one not live)', model: model(), note: 'Under W1\'s Documents tab of SCR-067.' },
    { id: 'pack-missing', label: 'Pack: a label and the DDT missing, not made yet', model: model({ pack: { state: 'ready', value: pack({ latest: null, parts: [{ kind: 'LABELS', state: 'MISSING', number: null, files: 1, test: false }, { kind: 'PACKING_LIST', state: 'MISSING', number: null, files: 0, test: false }, { kind: 'DDT', state: 'MISSING', number: null, files: 0, test: false }, { kind: 'COMMERCIAL_INVOICE', state: 'NONE', number: null, files: 0, test: false }, { kind: 'PROFORMA', state: 'NONE', number: null, files: 0, test: false }] }) } }) },
    { id: 'pack-test', label: 'Pack with TEST labels (test mode)', model: model({ pack: { state: 'ready', value: pack({ test: true, parts: pack().parts.map((part) => (part.kind === 'LABELS' ? { ...part, test: true } : part)) }) } }) },
    { id: 'pack-made', label: 'Made and printed: version 3 sent to the printer', model: model({ done: { key: 'pack.done.printed', params: { version: 3, pages: 7 } } }) },
    { id: 'pack-no-printer', label: 'No document printer: Make and print held with why', model: model({ pack: { state: 'ready', value: pack({ printer: null }) } }) },
    { id: 'pdf', label: 'The merged PDF opening in the viewer', model: model({ pdf: { version: 2, data: null, problem: null } }) },
    { id: 'pdf-failed', label: 'The merged PDF could not be read', model: model({ pdf: { version: 2, data: null, problem: { key: 'problem.read.unavailable' } } }) },
    { id: 'proforma-dialog', label: 'Make a new proforma version: language and notes', model: model({ dialog: { kind: 'proforma', language: 'en', notes: 'Goods for exhibition, returning in May.' } }) },
    { id: 'proforma-blocked', label: 'Proforma blocked: a line has no price', model: model({ proformas: { state: 'ready', value: proformas({ versions: [], number: null, problems: ['DEMO-JKT BLK 52: no order line prices it.'] }) } }) },
    { id: 'no-price', label: 'Warehouse without prices: no proforma card, pack only', model: model({ proformas: null, can: { ...ALL, proforma: false, price: false } }) },
    { id: 'no-pack-right', label: 'Sales without the packing right: proforma and DoC only', model: model({ pack: null, can: { ...ALL, pack: false } }) },
    { id: 'loading', label: 'Loading', model: model({ pack: { state: 'loading' }, proformas: { state: 'loading' }, docs: { state: 'loading' } }) },
    { id: 'error', label: 'Could not be read: Try again', model: model({ pack: { state: 'error', problem: { key: 'problem.read.internal' } }, proformas: { state: 'error', problem: { key: 'problem.read.forbidden' } } }) },
  ],
})
