import { defineDesignScreen } from '../design-screen'
import { DsPartsLab, type DsPartsLabModel } from './view/DsPartsLab'

/**
 * The shared DS parts lab (`/design/ds-parts`, B-W2b-09): grid card list (D3), RecordNav (D13), SaveStatus (D6),
 * CheckList, TraceTree, MarginMeter, Waterfall, BarList, the print view, FileRow actions and SelectableCard, in the
 * gallery's language through `useDsLabels()`. Light and dark, 1440 and 390, Italian and English are the gallery's own
 * switches. Made-up data.
 */
export const designScreen = defineDesignScreen<DsPartsLabModel>({
  screen: 'ds-parts',
  title: 'Shared DS parts the W2a screens composed (B-W2b-09)',
  view: DsPartsLab,
  cases: [
    { id: 'parts', label: 'Every part', model: {}, note: 'Every part working: sort and select cards, J / K, the save demo, fix the certificate, drill down a bar.' },
    { id: 'card-list-select', label: 'Card list: select mode', model: { show: 'card-list', cardList: 'select' }, note: 'Best at 390: Select all (mixed), a held box (shipped), the bulk action, Done.' },
    { id: 'card-list-reading', label: 'Card list: reading', model: { show: 'card-list', cardList: 'reading' } },
    { id: 'card-list-empty', label: 'Card list: nothing matches', model: { show: 'card-list', cardList: 'empty' } },
    { id: 'record-first', label: 'Record nav: first record', model: { record: 'PO-0001' }, note: 'Previous is held and says why.' },
    { id: 'record-paged', label: 'Record nav: paged list', model: { paged: true, record: 'PO-0056' }, note: '56 of 60: the last row of this page; Next held "on this page".' },
    { id: 'checks-ready', label: 'Checks: all pass', model: { checks: 'ready' }, note: 'Release is armed.' },
    { id: 'trace-reach', label: 'Trace: choose the reach', model: { trace: 'reach' }, note: 'A mixed branch, a held branch (shipped), the held Hold button.' },
    { id: 'no-grain', label: 'Without the cost grain', model: { grain: false }, note: 'The meters draw nothing; the cost waterfall says why; the bars are empty.' },
    { id: 'print', label: 'Print view', model: { show: 'print' }, note: 'Paper preview: always light on paper; the strip is not printed.' },
    { id: 'print-reading', label: 'Print view: reading', model: { show: 'print', printReading: true }, note: 'Print is held while the report is read.' },
  ],
})
