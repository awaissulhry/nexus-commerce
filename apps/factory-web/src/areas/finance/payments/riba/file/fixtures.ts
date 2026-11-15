import { defineDesignScreen } from '../../../../../lib/design/design-screen'
import { RIBA_ISSUED } from '../fixtures'
import { cbiRecords } from '../model'
import { RibaFileView, type RibaFileModel } from './view/RibaFileView'

/**
 * SCR-511 — the Ri.Ba. file read back in its own tab (B-W2b-425, design finance.payments tab:riba-file), made-up data only: the
 * SCR-510 batch's file with invented names and test bank codes 00000, every record 120 characters.
 */

const record = (head: string): string => head.padEnd(120, ' ').slice(0, 120)
const receipt = (n: number, customer: string, amount: string) => [
  record(` 14${String(n).padStart(7, '0')}      301126      30000${amount}-000000000000000000000000000000000000000000000000E`),
  record(` 20${String(n).padStart(7, '0')}CALZATURIFICIO ESEMPIO SRL`),
  record(` 30${String(n).padStart(7, '0')}${customer}`),
  record(` 40${String(n).padStart(7, '0')}VIA DI PROVA 1                00100ROMA`),
  record(` 50${String(n).padStart(7, '0')}FATTURA FT-2026-0041${n} RATA 1`),
  record(` 51${String(n).padStart(7, '0')}0000000${n}`),
  record(` 70${String(n).padStart(7, '0')}`),
]
const TEXT = [
  record(' IBA1B2C00000141126RIBA2611140190f0e2'),
  ...receipt(1, 'BOUTIQUE PROVA SRL', '0000000183000'),
  ...receipt(2, 'NEGOZIO MODELLO SNC', '0000000120050'),
  ...receipt(3, 'PELLETTERIA FINTA SPA', '0000000179000'),
  record(' EFA1B2C00000141126RIBA2611140190f0e2      0000003000000000048205000000000000000000000000000023'),
].join('\r\n')

const model = (over: Partial<RibaFileModel> = {}): RibaFileModel => ({
  prefix: '/w/ALFA',
  price: true,
  batch: { status: 'ready', value: RIBA_ISSUED },
  records: { value: cbiRecords(TEXT), problem: null },
  busy: false,
  problem: null,
  ...over,
})

export const designScreen = defineDesignScreen<RibaFileModel>({
  screen: 'SCR-511',
  title: 'Finance › Payments › Ri.Ba. file download (new tab)',
  view: RibaFileView,
  cases: [
    { id: 'normal', label: 'The file read back, record by record', model: model(), note: 'Download hands over the file as kept on the batch: nothing is sent from here.' },
    { id: 'records-loading', label: 'Reading the file', model: model({ records: { value: null, problem: null } }) },
    { id: 'records-unreadable', label: 'The store cannot be read from this browser', model: model({ records: { value: null, problem: 'problem.read.unavailable' } }), note: 'Download still works; the read-back says why it is missing.' },
    { id: 'no-price', label: 'Without the price grain', model: model({ price: false, batch: { status: 'ready', value: { ...RIBA_ISSUED, total: undefined } } }) },
    { id: 'draft', label: 'A draft has no file yet', model: model({ batch: { status: 'ready', value: { ...RIBA_ISSUED, status: 'DRAFT', file: null, issuedAt: null, issuedBy: null } }, records: { value: null, problem: null } }) },
    { id: 'loading', label: 'Loading', model: model({ batch: { status: 'loading' }, records: { value: null, problem: null } }) },
    { id: 'not-found', label: 'No such batch', model: model({ batch: { status: 'not_found' }, records: { value: null, problem: null } }) },
    { id: 'forbidden', label: 'No permission (receivables.view)', model: model({ batch: { status: 'forbidden' }, records: { value: null, problem: null } }) },
    { id: 'error', label: 'Could not read', model: model({ batch: { status: 'error', problem: 'problem.read.internal' }, records: { value: null, problem: null } }) },
  ],
})
