import { defineDesignScreen } from '../../../lib/design/design-screen'
import { onFloor, signedInFrame } from '../../frame/fixtures'
import type { PickerReason } from '../reasons/model'
import type { DispatchEntry, DispatchList, MyMessages, PutLast, WorkMessage } from './model'
import { MyWorkView, type MyWorkViewModel } from './view/MyWorkView'

/**
 * SCR-089's cases (design floor.mywork; MES-021): the station's queue from the published plan — the next task big, then
 * the rest (rush first, then due date, then sequence) — a row opened, "List changed · Show", a new plan announced,
 * "Can't find it?" and Put it last with its reason tile, and every state (loading, failed, offline from this tablet,
 * offline with nothing kept, no station, nothing published, the first plan later, nothing queued, all done, the notice
 * holding scans, no permission). B-W2b-71: the material flag, my list across stations, "For your work" and the messages,
 * Call for help: Material with each reason it is held, and the warehouse tablet. Made-up data only: a "Demo" plant,
 * made-up orders and styles; no person, no money.
 */

const STATION = 'SEW-04 · Linea 2 St 4'
const AS_OF = '2026-10-29T08:42:00.000Z'

const entry = (slotId: string, number: string, seq: number, name: string, state: DispatchEntry['state'], extra: Partial<DispatchEntry> & { rush?: boolean; due?: string | null; hold?: string | null; style?: string } = {}): DispatchEntry => {
  const { rush = false, due = '2026-11-20', hold = null, style = 'Giacca moto Demo', ...rest } = extra
  return {
    slotId,
    workOrder: { id: `wo-${slotId}`, number, status: state === 'ON_HOLD' ? 'ON_HOLD' : state === 'NOT_RELEASED' ? 'DRAFT' : 'IN_PROGRESS', priority: rush ? 1 : 0, rush, dueDate: due, style: { code: 'GIA-01', name: style }, holdReason: hold },
    operation: { id: `op-${slotId}`, seq, code: `OP${seq}`, name },
    previous: seq > 10 ? { seq: seq - 10, code: `OP${seq - 10}`, name: 'Taglio pelle' } : null,
    startAt: '2026-10-29T07:00:00.000Z',
    endAt: '2026-10-29T09:00:00.000Z',
    garments: 20,
    minutes: '120.0',
    state,
    words: '',
    arrived: state === 'READY' ? 20 : 0,
    waiting: state === 'READY' ? 12 : 0,
    done: state === 'DONE' ? 20 : state === 'READY' ? 8 : 0,
    ...rest,
  }
}

const ENTRIES: DispatchEntry[] = [
  entry('s1', 'WO-DEMO-0051', 20, 'Cucire fianchi', 'READY', { rush: true, due: '2026-11-06', style: 'Giacca Aria Demo', material: { state: 'IN_STOCK', date: null } }),
  entry('s2', 'WO-DEMO-0042', 20, 'Cucire fianchi', 'READY', { due: '2026-11-12', material: { state: 'ON_THE_WAY', date: '2026-11-03' } }),
  entry('s3', 'WO-DEMO-0047', 20, 'Cucire fianchi', 'WAITING_FOR_PREVIOUS', { due: '2026-11-14', style: 'Gilet Demo', material: { state: 'MISSING', date: null } }),
  entry('s4', 'WO-DEMO-0049', 30, 'Attaccare maniche', 'ON_HOLD', { due: '2026-11-18', hold: 'Verifica qualità della pelle (demo)', material: { state: 'IN_STOCK', date: null } }),
  entry('s5', 'WO-DEMO-0053', 20, 'Cucire fianchi', 'NOT_RELEASED', { due: null, style: 'Pantalone Demo', material: { state: 'NOT_KNOWN', date: null } }),
  entry('s6', 'WO-DEMO-0038', 20, 'Cucire fianchi', 'DONE', { due: '2026-11-04' }),
]

const NEAR = { id: 'st-sew-04', code: 'SEW-04', name: STATION }
const FAR = { id: 'st-sew-07', code: 'SEW-07', name: 'SEW-07 · Linea 3 St 7' }
const MINE: DispatchEntry[] = [
  { ...ENTRIES[0]!, station: NEAR, bundles: 2, current: true },
  { ...ENTRIES[1]!, station: FAR, bundles: 1, current: false },
  { ...ENTRIES[2]!, station: FAR, bundles: 0, current: false },
]

const message = (id: string, number: string, from: WorkMessage['from'], text: string, at: string, cut = false): WorkMessage => ({ id, workOrder: { id: `wo-${id}`, number }, from, text, cut, at })

const MESSAGES: MyMessages = {
  asOf: AS_OF,
  messages: [
    message('m1', 'WO-DEMO-0051', 'OFFICE', 'Per questa commessa usate il filo rinforzato: la scatola nuova è sul carrello 3.\nSe manca, chiamate il magazzino.', '2026-10-29T08:12:00.000Z'),
    message('m2', 'WO-DEMO-0042', 'FLOOR', 'Cuciture diverse (B-000123 a Op 20 Cucire fianchi): manica sinistra', '2026-10-29T07:41:00.000Z'),
    message('m3', 'WO-DEMO-0047', 'OFFICE', 'Le taglie 52 vanno controllate una a una prima di passarle avanti.', '2026-10-28T15:30:00.000Z'),
  ],
}

const list = (extra: Partial<DispatchList> = {}): DispatchList => ({
  site: { id: 'site-a', code: 'A1', name: 'Stabilimento Demo Nord', timeZone: 'Europe/Rome' },
  target: { kind: 'STATION', id: 'st-sew-04', code: 'SEW-04', name: STATION, line: { id: 'l2', code: 'L2', name: 'Linea 2' }, workCentre: { id: 'wc-sew', code: 'SEW', name: 'Cucitura' } },
  asOf: AS_OF,
  version: { id: 'v12', number: 12, coversFrom: '2026-10-29', coversTo: '2026-11-04', effectiveFrom: '2026-10-29T05:00:00.000Z', publishedAt: '2026-10-28T15:10:00.000Z' },
  upcoming: null,
  next: ENTRIES[0]!,
  entries: ENTRIES,
  words: null,
  ...extra,
})

const PAUSE: PickerReason[] = [
  { id: 'MATERIAL_WAIT', list: 'PAUSE', code: 'MATERIAL_WAIT', labelIt: 'Attesa materiale', labelEn: 'Waiting for material', labelI18n: {}, icon: 'package', colour: '#b87503', photo: null, needsDetail: false, sortOrder: 10 },
  { id: 'MACHINE', list: 'PAUSE', code: 'MACHINE', labelIt: 'Macchina ferma', labelEn: 'Machine stopped', labelI18n: {}, icon: 'alert', colour: '#e5484d', photo: null, needsDetail: false, sortOrder: 20 },
  { id: 'INSTRUCTIONS', list: 'PAUSE', code: 'INSTRUCTIONS', labelIt: 'Attesa istruzioni', labelEn: 'Waiting for instructions', labelI18n: {}, icon: 'flag', colour: '#1f6fde', photo: null, needsDetail: false, sortOrder: 30 },
  { id: 'BREAK', list: 'PAUSE', code: 'BREAK', labelIt: 'Pausa', labelEn: 'Break', labelI18n: {}, icon: 'clock', colour: '#059669', photo: null, needsDetail: false, sortOrder: 40 },
  { id: 'OTHER', list: 'PAUSE', code: 'OTHER', labelIt: 'Altro', labelEn: 'Other', labelI18n: {}, icon: 'camera', colour: '#5b6573', photo: null, needsDetail: true, sortOrder: 90 },
]

const PUT_LAST: PutLast = { slotId: 's1', code: 'MATERIAL_WAIT', labelIt: 'Attesa materiale', labelEn: 'Waiting for material', at: AS_OF }

const frame = (extra: Parameters<typeof signedInFrame>[1] = {}) => signedInFrame('tile.mywork', { station: { name: STATION, site: 'Stabilimento Demo Nord' }, ...extra })

const model = (extra: Partial<MyWorkViewModel> = {}): MyWorkViewModel => ({ frame: frame(), step: { kind: 'list' }, list: list(), putLast: [], mode: 'sewing', helpHeld: null, ...extra })

export const designScreen = defineDesignScreen<MyWorkViewModel>({
  screen: 'SCR-089',
  title: 'Floor My work',
  view: onFloor(MyWorkView),
  cases: [
    {
      id: 'queue',
      label: 'Next big, then the queue',
      model: model(),
      note: 'The station\'s queue from the plan in force (v12): the first ready task big — work order, style, operation, pieces left, its status word, Rush with an icon and a word, the material flag — then the rest, rush first, then due date, then sequence. Each row says its material: in stock, on the way or missing, by icon, tone and word (MES-026; nothing known: no pill). Nothing starts from a row: scanning the real bundle opens Operation with it (MES-188). One finished task is counted in the footer, not listed. Arrows move rows, Enter opens one; the keys sit in the footer\'s info icon. No unread message: "For your work" is hidden.',
    },
    { id: 'entry', label: 'A row opened', model: model({ step: { kind: 'entry', slotId: 's4' } }), note: 'Its card as a step, the hold\'s words from the office; scanning still starts the work. Back or Esc returns to the list.' },
    {
      id: 'changed',
      label: 'List changed · Show',
      model: model({ changed: true, pending: 2 }),
      note: 'A plan was published, a bundle was reported elsewhere, a hold or the material changed: the fresher list waits behind one big button (the DS FloorListUpdates), so no row moves under a gloved finger (anatomy §1.6).',
    },
    {
      id: 'upcoming',
      label: 'A new plan announced',
      model: model({ list: list({ upcoming: { id: 'v13', number: 13, effectiveFrom: '2026-10-30T05:00:00.000Z' } }) }),
      note: 'The office published v13 for tomorrow: the floor works to v12 until v13 starts, and says when.',
    },
    {
      id: 'material-on-the-way',
      label: 'Material on the way',
      model: model({ list: list({ entries: [ENTRIES[1]!, ...ENTRIES.slice(2)] }) }),
      note: 'The flag on the card is the work order\'s and says so: nothing yet says which operation uses which component (schema need of B-W2b-49). The status word stays what the scans say.',
    },
    {
      id: 'material-missing',
      label: 'Material missing',
      model: model({ list: list({ entries: [{ ...ENTRIES[1]!, material: { state: 'MISSING', date: null } }, ...ENTRIES.slice(2)] }) }),
    },
    {
      id: 'material-unknown',
      label: 'Material not known',
      model: model({ list: list({ entries: [{ ...ENTRIES[1]!, material: { state: 'NOT_KNOWN', date: null } }, ...ENTRIES.slice(2)] }) }),
      note: 'The plan says nothing about its material: the card says so; a row shows no pill.',
    },
    {
      id: 'person',
      label: 'My list across stations',
      model: model({ list: list({ person: true, entries: MINE }) }),
      note: 'MES-022: the day\'s assignments name this person, so the list is theirs, across stations: the status says "My list", the work they are on comes first ("In progress"), a row names its station. With nothing open on it, the station\'s queue is back.',
    },
    {
      id: 'for-your-work',
      label: 'For your work: Messages 3',
      model: model({ messages: MESSAGES }),
      note: 'COL-036: the chip counts the open messages on my work orders not opened on this tablet, above Next: on a tablet the card fills the screen, so below it nobody would see it. Hidden at zero. "New instructions" joins it with W2b-4.',
    },
    { id: 'messages', label: 'Messages: the list', model: model({ step: { kind: 'messages' }, messages: MESSAGES, seen: ['m3'] }), note: 'Newest first: the work order, the first words, where it comes from (the office or another station: never who) and when. Arrows move rows, Enter opens one, Esc goes back.' },
    { id: 'message', label: 'One message', model: model({ step: { kind: 'message', id: 'm1' }, messages: MESSAGES, seen: ['m1'] }), note: 'The whole text, Read aloud where the tablet has a voice for the language. Opening it marks it on this tablet only: nothing records who read what (art. 4).' },
    {
      id: 'message-cut',
      label: 'One message, cut for the tablet',
      model: model({ step: { kind: 'message', id: 'm9' }, messages: { asOf: AS_OF, messages: [message('m9', 'WO-DEMO-0051', 'OFFICE', 'Nota lunga dell\'ufficio (demo). '.repeat(30).trim(), '2026-10-29T08:12:00.000Z', true)] }, seen: ['m9'] }),
      note: 'A tablet shows the first 1,000 characters and says the rest is in the office.',
    },
    { id: 'message-gone', label: 'A message no longer open', model: model({ step: { kind: 'message', id: 'gone' }, messages: MESSAGES, seen: [] }), note: 'The office closed the conversation meanwhile.' },
    { id: 'messages-none', label: 'Messages: none left', model: model({ step: { kind: 'messages' }, messages: { asOf: AS_OF, messages: [] } }) },
    {
      id: 'messages-offline',
      label: 'Messages from this tablet',
      model: model({ frame: frame({ online: false, pending: 1 }), step: { kind: 'messages' }, messages: MESSAGES, messagesAsOf: AS_OF, problem: 'offline' }),
      note: 'Read earlier in this visit: shown as of then; opening one still works.',
    },
    { id: 'messages-failed', label: 'The messages could not be read', model: model({ messagesFailed: true }), note: 'Hidden at zero must not read as "no messages": it says so, in one quiet line, and the work goes on.' },
    { id: 'cant-find', label: 'Can\'t find it?', model: model({ cantFind: 's1' }), note: 'Design main action: Call for help: Material, one tap through the tablet\'s queue; or Put it last with a reason tile; or Back. Esc closes.' },
    { id: 'help-reading', label: 'Call for help: checking who to call', model: model({ cantFind: 's1', helpHeld: 'reading' }) },
    { id: 'help-offline', label: 'Call for help held: offline, never read', model: model({ frame: frame({ online: false }), cantFind: 's1', helpHeld: 'offline' }), note: 'Offline the call still goes through the queue when this tablet read the site\'s help types in this visit; only a tablet that never did is held.' },
    { id: 'help-failed', label: 'Call for help held: the office does not answer', model: model({ cantFind: 's1', helpHeld: 'failed' }) },
    { id: 'help-no-type', label: 'Call for help held: no material call here', model: model({ cantFind: 's1', helpHeld: 'noType' }), note: 'Who fixes it, in words: the office (Production › Floor rules & codes).' },
    { id: 'help-no-station', label: 'Call for help held: no station', model: model({ list: list({ target: null, person: true, entries: MINE }), cantFind: 's1', helpHeld: 'noStation' }) },
    { id: 'help-open', label: 'Call for help held: already open here', model: model({ cantFind: 's1', helpHeld: 'open' }), note: 'One open call per type and station (MES-143): a second tap would only answer the same call.' },
    { id: 'help-waiting', label: 'Call for help held: yours waits to be sent', model: model({ frame: frame({ online: false, pending: 1 }), asOf: AS_OF, problem: 'offline', cantFind: 's1', helpHeld: 'waiting', call: { number: 'WO-DEMO-0051', seq: 20, ticks: 'saved' } }) },
    { id: 'help-sent', label: 'Help called: recorded', model: model({ call: { number: 'WO-DEMO-0051', seq: 20, ticks: 'recorded' } }), note: 'The two ticks: the office has it. Who is coming is on Call for help (B-W2b-70).' },
    { id: 'help-saved', label: 'Help called: saved on this tablet', model: model({ frame: frame({ online: false, pending: 1 }), asOf: AS_OF, problem: 'offline', call: { number: 'WO-DEMO-0051', seq: 20, ticks: 'saved' } }), note: 'Offline: one tick; it goes when the network is back.' },
    { id: 'help-refused', label: 'Help called: refused', model: model({ call: { number: 'WO-DEMO-0051', seq: 20, ticks: 'refused', refusal: 'TYPE_INACTIVE' } }), note: 'The office switched the type off meanwhile: the words say what happened and who to ask.' },
    {
      id: 'put-last-reason',
      label: 'Put it last: the reason tile',
      model: model({ frame: frame(), step: { kind: 'reason', slotId: 's1', picker: { purpose: 'putLast', subject: 'WO-DEMO-0051 · Op 20 Cucire fianchi', reasons: PAUSE, value: 'MATERIAL_WAIT' } } }),
      note: 'The reason picker (SCR-091) over the office\'s PAUSE list, pick one; Done waits for a pick, with the words.',
    },
    {
      id: 'put-last-done',
      label: 'Put last on this tablet',
      model: model({ putLast: [PUT_LAST], putLastDone: { slotId: 's1' } }),
      note: 'The task moves to the end of THIS tablet\'s list with its reason; the next ready one comes up. The office\'s plan does not change (the floor never writes the plan, Owner answer P3). The mark drops when the task is done or a new plan comes.',
    },
    {
      id: 'none-ready',
      label: 'Nothing ready yet',
      model: model({ list: list({ next: null, entries: ENTRIES.filter((row) => row.state !== 'READY') }) }),
      note: 'Every task waits for something; the list says what.',
    },
    { id: 'loading', label: 'Loading', model: model({ step: { kind: 'loading' }, list: null }) },
    { id: 'error', label: 'Could not load the queue', model: model({ list: null, problem: 'error' }), note: 'Design words: scan a bundle to work anyway; Try again.' },
    {
      id: 'offline-kept',
      label: 'Offline: the queue from this tablet',
      model: model({ frame: frame({ online: false, pending: 2 }), asOf: AS_OF, problem: 'offline' }),
      note: 'Read earlier in this visit: shown as of then. Scans still work (they queue).',
    },
    {
      id: 'offline-none',
      label: 'Offline: never read on this tablet',
      model: model({ frame: frame({ online: false }), list: null, problem: 'offline' }),
    },
    {
      id: 'no-station',
      label: 'Tablet at no station',
      model: model({ mode: null, list: list({ target: null, next: null, entries: [] }) }),
      note: 'Who fixes it, in words: the office places the tablet at a station (Admin › Devices & printers).',
    },
    {
      id: 'warehouse',
      label: 'Warehouse tablet: the task list held',
      model: model({ mode: 'warehouse', list: list({ target: null, next: null, entries: [] }) }),
      note: 'The warehouse variant is held: its task inbox (SCM-274) comes with picking and put-away (W2b-5). Home has no My work tile at the warehouse (six tiles at most, Scan always among them); the page says it in words if it is opened. No station is how the app tells a warehouse tablet, so the words also say who places a tablet that belongs to a station.',
    },
    { id: 'nothing-published', label: 'No plan published yet', model: model({ list: list({ version: null, next: null, entries: [] }) }) },
    {
      id: 'first-upcoming',
      label: 'The first plan starts later',
      model: model({ list: list({ version: null, upcoming: { id: 'v1', number: 1, effectiveFrom: '2026-11-02T05:00:00.000Z' }, next: null, entries: [] }) }),
    },
    { id: 'empty', label: 'Nothing queued for this station', model: model({ list: list({ next: null, entries: [] }) }), note: 'Design words: "Nothing queued for this station. Scan a bundle to work on it."' },
    { id: 'all-done', label: 'Everything planned here is done', model: model({ list: list({ next: null, entries: [ENTRIES[5]!] }) }) },
    { id: 'notice-held', label: 'Scans held by the worker notice', model: model({ held: true }), note: 'The queue reads (it names nobody); the scan field is held with the reason until the notice is read.' },
    { id: 'no-permission', label: 'No permission', model: model({ step: { kind: 'noPermission' }, list: null }), note: 'A person without floor.work at this station (fail closed).' },
  ],
})
