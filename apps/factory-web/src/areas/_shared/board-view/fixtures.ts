import { defineDesignScreen } from '../../../lib/design/design-screen'
import { BoardViewLabView, type BoardViewLabModel, type LabCard, type LabLane } from './view/BoardViewLabView'

/**
 * SCR-244 — the board (kanban) view for lists (DS part D19, B-W2a-24; NEW id: the DS part has no screen of its own; the
 * NCR board SCR-145 (B-W2a-68) and the hold board on SCR-078/079 (B-W2a-67) use it). Made-up nonconformances, holds,
 * lots and hides. In the browser the moves work for real (kept in the view only): drag, the keyboard (Space or M, ← →,
 * Enter, Escape), the Move to… menu; a drop on Closed waits for the closing signature (the app's dialog) and Cancel
 * says "was not moved". Each case is one state of the design: the NCR board, the hold board, a keyboard move under way,
 * refusals with their reason, the closing dialog, the phone list, loading, a failed read, empty, filtered, no
 * permission, read-only and offline.
 */

const ncrLanes: LabLane[] = [
  { id: 'open', name: { it: 'Aperte', en: 'Open' }, tone: 'danger', total: 6, oldestDays: 12 },
  { id: 'contained', name: { it: 'Contenute', en: 'Contained' }, tone: 'warning', oldestDays: 4 },
  { id: 'decided', name: { it: 'Decise', en: 'Decided' }, tone: 'info' },
  { id: 'closed', name: { it: 'Chiuse', en: 'Closed' }, tone: 'success', managersOnly: true, dialogOnly: true },
]

const MAJOR = { it: 'Maggiore', en: 'Major' }
const MINOR = { it: 'Minore', en: 'Minor' }
const QUALITY = { it: 'Qualità', en: 'Quality' }
const WAREHOUSE = { it: 'Magazzino', en: 'Warehouse' }

const ncrCards: LabCard[] = [
  { id: 'n108', number: 'NCR-0108', laneId: 'open', title: { it: 'La cucitura si apre alla tasca porta-protezioni', en: 'Seam opens at the armour pocket' }, severity: MAJOR, owner: QUALITY, dueDays: 2, decided: { done: 37, total: 40 }, marks: [{ text: { it: 'Reclamo cliente', en: 'Customer complaint' }, tone: 'danger' }] },
  { id: 'n109', number: 'NCR-0109', laneId: 'open', title: { it: 'Colore della zip diverso dal campione', en: 'Zip colour does not match the sample' }, severity: MINOR, owner: QUALITY, dueDays: 5 },
  { id: 'n104', number: 'NCR-0104', laneId: 'contained', title: { it: 'Fori in due pelli del lotto L-2231', en: 'Holes in two hides of lot L-2231' }, severity: MAJOR, owner: WAREHOUSE, dueDays: 0 },
  { id: 'n103', number: 'NCR-0103', laneId: 'contained', title: { it: 'Imbottitura spostata su 6 giacche', en: 'Padding shifted in 6 jackets' }, severity: MINOR, owner: QUALITY, dueDays: -1, decided: { done: 2, total: 6 } },
  { id: 'n102', number: 'NCR-0102', laneId: 'decided', title: { it: 'Etichetta taglia sbagliata su 12 giacche', en: 'Wrong size label on 12 jackets' }, severity: MINOR, owner: QUALITY, decided: { done: 12, total: 12 }, marks: [{ text: { it: 'Rilavorazione', en: 'Rework' }, tone: 'info' }] },
  { id: 'n101', number: 'NCR-0101', laneId: 'decided', title: { it: 'Densità del punto sotto la specifica', en: 'Stitch density under the spec' }, severity: MINOR, owner: QUALITY, decided: { done: 8, total: 8 }, waitingSignature: true },
]

const holdLanes: LabLane[] = [
  { id: 'new', name: { it: 'Nuovi', en: 'New' }, tone: 'danger', oldestDays: 0 },
  { id: 'investigating', name: { it: 'In verifica', en: 'Investigating' }, tone: 'warning', oldestDays: 3 },
  { id: 'waiting', name: { it: 'Attesa decisione', en: 'Waiting decision' }, tone: 'info', oldestDays: 6 },
  { id: 'ready', name: { it: 'Pronti al rilascio', en: 'Ready to release' }, tone: 'success', oldestDays: 1 },
  { id: 'released', name: { it: 'Rilasciati', en: 'Released' }, tone: 'neutral', dialogOnly: true },
]

const holdCards: LabCard[] = [
  { id: 'h31', number: 'HLD-0031', laneId: 'new', title: { it: 'Pelle con macchie', en: 'Stained hide' }, subject: 'HIDE-DEMO-0442', quantity: { it: '1 pelle · 4,2 m²', en: '1 hide · 4.2 m²' }, ageDays: 0, owner: WAREHOUSE, reason: { text: { it: 'Macchia', en: 'Stain' }, tone: 'warning' } },
  { id: 'h29', number: 'HLD-0029', laneId: 'investigating', title: { it: 'Lotto zip senza certificato', en: 'Zip lot without a certificate' }, subject: 'LOT-DEMO-2231', quantity: { it: '400 pz', en: '400 pcs' }, ageDays: 3, owner: QUALITY, reason: { text: { it: 'Documento mancante', en: 'Missing document' }, tone: 'danger' } },
  { id: 'h27', number: 'HLD-0027', laneId: 'waiting', title: { it: 'Ordine di lavoro fermo al controllo', en: 'Work order stopped at inspection' }, subject: 'WO-DEMO-0212', quantity: { it: '24 capi', en: '24 garments' }, ageDays: 6, owner: QUALITY, reason: { text: { it: 'Cucitura', en: 'Seam' }, tone: 'danger' } },
  { id: 'h25', number: 'HLD-0025', laneId: 'ready', title: { it: 'Protezioni ricontrollate', en: 'Armour rechecked' }, subject: 'LOT-DEMO-2207', quantity: { it: '60 pz', en: '60 pcs' }, ageDays: 1, owner: QUALITY, reason: { text: { it: 'Controllo ripetuto', en: 'Recheck' }, tone: 'info' } },
]

const ncr = (patch: Partial<BoardViewLabModel> = {}): BoardViewLabModel => ({ board: 'ncr', lanes: ncrLanes, cards: ncrCards, layout: 'board', load: 'ready', ...patch })

export const designScreen = defineDesignScreen<BoardViewLabModel>({
  screen: 'SCR-244',
  title: 'Board view for lists (DS part D19)',
  view: BoardViewLabView,
  cases: [
    {
      id: 'ncr',
      label: 'NCR board (quality manager)',
      model: ncr({ manager: true }),
      note: 'Open → Contained → Decided → Closed; each card: number, title, severity, owner, the due date and the decided bar. Drag a card, or Tab to it and press Space; the Move to… menu lists every column. Closed takes a drop through the closing signature.',
    },
    {
      id: 'holds',
      label: 'Hold board',
      model: { board: 'holds', lanes: holdLanes, cards: holdCards, layout: 'board', load: 'ready' },
      note: 'New · Investigating · Waiting decision · Ready to release, with the count and the oldest age per lane; each card: hold number, subject, quantity, age, owner and the reason in words. Released is never reached by a drag alone: the drop opens the release dialog.',
    },
    {
      id: 'moving',
      label: 'Keyboard move under way',
      model: ncr({ manager: true, defaultMove: { cardId: 'n109', to: 'contained' } }),
      note: 'NCR-0109 picked up and taken to Contained: the column is outlined and a ghost says "Drop here". Focus the card: ← → go on, Enter drops, Escape cancels.',
    },
    {
      id: 'refused',
      label: 'Refused with the reason',
      model: ncr({ defaultMove: { cardId: 'n108', to: 'decided' } }),
      note: 'NCR-0108 may not go to Decided: "3 of 40 garments not decided" (the app\'s rule). Closed is held for this person (only quality managers close); NCR-0101 waits for its signature and cannot move. Each refusal says why, on the ghost, in the menu and in words.',
    },
    {
      id: 'closing',
      label: 'A drop on Closed: the closing signature',
      model: ncr({ manager: true, closing: 'n102' }),
      note: 'The board hands the move to the app, which asks for the signature first. Sign and close moves the card; Cancel answers "was not moved" and the card stays in Decided.',
    },
    {
      id: 'list',
      label: 'Phone: the columns stack',
      model: ncr({ manager: true, layout: 'list' }),
      note: 'Below 640 px of its own width (also at Phone 390) the columns stack; each card keeps Move to… and the keyboard moves.',
    },
    { id: 'loading', label: 'Loading', model: ncr({ load: 'loading' }), note: 'The columns first, skeleton cards after.' },
    { id: 'error', label: 'Read failed', model: ncr({ load: 'error' }), note: 'A failed read is never drawn as an empty board: the reason in words and Try again.' },
    { id: 'empty', label: 'Empty', model: ncr({ load: 'empty' }), note: 'No open NCRs, and where a new one comes from.' },
    { id: 'filtered', label: 'No rows match the filters', model: ncr({ load: 'filtered' }), note: 'The list\'s filters hide every row: Clear filters.' },
    { id: 'no-permission', label: 'No permission', model: ncr({ load: 'no-permission' }), note: 'By address only (the page is not in the Pages overlay): what is needed and who grants it.' },
    { id: 'read-only', label: 'Read-only', model: ncr({ held: 'readOnly' }), note: 'A person who may look but not move: the board is drawn, the reason is said at rest and on every attempt; cards still open.' },
    { id: 'offline', label: 'Offline', model: ncr({ held: 'offline' }), note: 'The last copy with its time; moves wait until the connection is back.' },
  ],
})
