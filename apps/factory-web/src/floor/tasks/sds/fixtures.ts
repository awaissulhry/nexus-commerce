import { defineDesignScreen } from '../../../lib/design/design-screen'
import { samplePdf } from '../../../areas/_shared/document-send/sample-pdf'
import { onFloor, signedInFrame } from '../../frame/fixtures'
import type { SdsPack } from './api'
import { SdsView, type SdsModel } from './view/SdsView'

/**
 * SCR-213-floor's cases (B-W2b-143; design plant.chemicals "SDS at the cabinet by QR, readable offline on floor devices"): a
 * cabinet up to date, kept while offline, some sheets not taken, every cabinet, a sheet open full screen, a sheet not on the
 * tablet yet, a product without a sheet, an unknown cabinet, nothing kept yet, reading. Made-up products of a made-up "Demo"
 * plant and a made-up one-page PDF: no person, no money.
 */

const AT = '2026-11-03T07:12:00.000Z'
const frame = (extra: Partial<SdsModel['frame']> = {}) => signedInFrame('tile.sds', { station: { name: 'TAG-01 · Taglio 1', site: 'Stabilimento Demo Nord' }, ...extra })
const sheet = (n: number, language: string, version = '3.1') => ({ id: `sheet-${n}`, versionLabel: version, revisedOn: '2026-08-25', language, fileId: `file-${n}`, sizeBytes: 180_000, sha256: 'a'.repeat(64) })

const PACK: SdsPack = {
  siteId: 'site-n',
  site: { code: 'STAB-N', name: 'Stabilimento Demo Nord' },
  language: 'it',
  at: AT,
  chemicals: [
    { id: 'c-1', name: 'Colla a contatto Demo 90', supplier: 'Colle Demo', use: 'GLUE', ghsPictograms: ['GHS02', 'GHS07'], signalWord: 'DANGER', hazardStatements: ['H225', 'H319', 'H336', 'EUH066'], precautionStatements: ['P210', 'P233', 'P305+P351+P338'], storagePlace: 'Armadio colle, reparto taglio', cabinetCode: 'CAB-TAG-1', maxQuantity: '25', maxQuantityUnit: 'L', ppe: ['Guanti in nitrile', 'Occhiali di protezione'], current: [sheet(1, 'it'), sheet(2, 'en')] },
    { id: 'c-2', name: 'Tinta bordi Esempio nera', supplier: null, use: 'EDGE_PAINT', ghsPictograms: ['GHS07'], signalWord: 'WARNING', hazardStatements: ['H319'], precautionStatements: ['P280'], storagePlace: 'Armadio colle, reparto taglio', cabinetCode: 'CAB-TAG-1', maxQuantity: '5', maxQuantityUnit: 'L', ppe: [], current: [sheet(3, 'en', '1')] },
    { id: 'c-3', name: 'Diluente Demo D-12', supplier: 'Solventi Demo', use: 'SOLVENT', ghsPictograms: ['GHS02', 'GHS07', 'GHS08'], signalWord: 'DANGER', hazardStatements: ['H225', 'H304', 'H336'], precautionStatements: ['P210', 'P301+P310'], storagePlace: 'Armadio infiammabili, finissaggio', cabinetCode: 'CAB-FIN-1', maxQuantity: '10', maxQuantityUnit: 'L', ppe: ['Semimaschera filtro A1'], current: [] },
    { id: 'c-4', name: 'Olio macchine Demo 22', supplier: null, use: 'OIL', ghsPictograms: [], signalWord: null, hazardStatements: [], precautionStatements: [], storagePlace: 'Manutenzione, scaffale 3', cabinetCode: null, maxQuantity: null, maxQuantityUnit: null, ppe: [], current: [sheet(4, 'it', '2.0')] },
  ],
}
const KEPT = new Set(['file-1', 'file-2', 'file-3', 'file-4'])
const PDF = samplePdf(['SCHEDA DI DATI DI SICUREZZA (esempio)', 'Colla a contatto Demo 90 - versione 3.1', 'Dati inventati per il riesame del design'])

const model = (extra: Partial<SdsModel> = {}): SdsModel => ({ frame: frame(), cabinet: 'CAB-TAG-1', pack: PACK, kept: KEPT, state: 'fresh', open: null, readerLanguage: 'it', ...extra })

export const designScreen = defineDesignScreen<SdsModel>({
  screen: 'SCR-213-floor',
  title: 'Floor › Safety data sheets at the cabinet (the cabinet QR)',
  view: onFloor(SdsView),
  cases: [
    { id: 'cabinet', label: 'A cabinet, up to date', model: model(), note: 'What the QR opens: every product of the cabinet with its pictograms, signal word, H and P statements, PPE, and its sheets (the reader\'s language first).' },
    { id: 'offline', label: 'No network: the sheets kept on the tablet', model: model({ state: 'offline', frame: frame({ online: false }) }) },
    { id: 'partial', label: 'Some sheets not taken this time', model: model({ state: 'partial', kept: new Set(['file-1', 'file-4']) }) },
    { id: 'every-cabinet', label: 'Every cabinet of the site (no cabinet named)', model: model({ cabinet: null }) },
    { id: 'no-sheet', label: 'A product without a sheet: ask the safety officer', model: model({ cabinet: 'CAB-FIN-1' }) },
    { id: 'open', label: 'A sheet open full screen (from the kept bytes)', model: model({ open: { sheetId: 'sheet-1', title: 'Colla a contatto Demo 90 · versione 3.1 · Italiano', bytes: PDF, problem: false } }) },
    { id: 'open-missing', label: 'A sheet not on this tablet yet', model: model({ open: { sheetId: 'sheet-3', title: 'Tinta bordi Esempio nera · versione 1 · Inglese', bytes: null, problem: true }, state: 'offline', frame: frame({ online: false }) }) },
    { id: 'unknown-cabinet', label: 'A cabinet the tablet does not know (an old label)', model: model({ cabinet: 'CAB-OLD-9' }) },
    { id: 'nothing-kept', label: 'Offline and nothing kept yet', model: model({ pack: null, kept: new Set(), state: 'nothingKept', frame: frame({ online: false }) }) },
    { id: 'reading', label: 'Reading the first time', model: model({ pack: null, kept: new Set(), state: 'reading' }) },
  ],
})
