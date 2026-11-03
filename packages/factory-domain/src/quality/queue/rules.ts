/**
 * My inspections (B-W2b-106; QHS-068 the inspector queue, QHS-065 scan to start, QHS-062 offline inspections; design
 * floor.mywork "inspector queue: blocking lots first, waiting time", floor.final and floor.incoming "scan", "Works offline").
 * Pure, so the tests hold them; apps/factory-api modules/quality/queue reads the records B-W2b-97 (final inspections on a
 * plan), B-W2b-98 (incoming inspections), B-W2b-99 (in-process checks) and B-W2b-101 (records a rule opened) made, and
 * writes only through their own commands.
 *
 *   the queue   every due inspection the viewer may see, of three record kinds plus the work orders whose finished
 *               garments wait for a final inspection nobody opened yet; sorted by what each holds up (a run first, then
 *               work that waits for a lot or garments due to ship, then stock in quarantine, then the rest), then by the
 *               earliest date that work needs it, then by how long it has waited. No person in a row: whose it is says
 *               only "yours", "nobody's yet" or "someone else's" (Owner answer W1; Statuto dei Lavoratori art. 4).
 *   scan        a code read off a label or typed: what it names (a lot, a hide, a bundle, a garment serial, a carton, a
 *               work order, an inspection's number) and which inspection that leads to at this bench.
 *   offline     what the tablet keeps (the open inspections it may record, with their plans) and which writes its queue
 *               holds; opening, signing and cancelling wait for the network (a number, a PIN checked by the office).
 */

export type Lang = 'it' | 'en'
export type Words = Readonly<Record<Lang, string>>

// ---- what is in the queue -------------------------------------------------------------------------------------------------------

/** A row's kind: a final inspection, garments that wait for one, an incoming inspection, an in-process check. */
export const QUEUE_KINDS = ['FINAL', 'FINAL_DUE', 'INCOMING', 'FIRST_PIECE', 'CUTTING', 'ROVING', 'END_OF_LINE'] as const
export type QueueKind = (typeof QUEUE_KINDS)[number]

export const KIND_WORDS: Readonly<Record<QueueKind, Words>> = Object.freeze({
  FINAL: { it: 'Collaudo finale', en: 'Final inspection' },
  FINAL_DUE: { it: 'Da collaudare', en: 'Waiting for final inspection' },
  INCOMING: { it: 'Controllo in accettazione', en: 'Incoming inspection' },
  FIRST_PIECE: { it: 'Primo capo', en: 'First piece' },
  CUTTING: { it: 'Controllo taglio', en: 'Cutting inspection' },
  ROVING: { it: 'Controllo in linea', en: 'Roving check' },
  END_OF_LINE: { it: 'Fine linea', en: 'End of line' },
})

/** The record a row is (none for garments that wait: nobody opened their inspection yet). */
export type QueueRecordType = 'Inspection' | 'IncomingInspection' | 'InProcessCheck'

export const RECORD_OF_KIND: Readonly<Record<QueueKind, QueueRecordType | null>> = Object.freeze({
  FINAL: 'Inspection',
  FINAL_DUE: null,
  INCOMING: 'IncomingInspection',
  FIRST_PIECE: 'InProcessCheck',
  CUTTING: 'InProcessCheck',
  ROVING: 'InProcessCheck',
  END_OF_LINE: 'InProcessCheck',
})

/** Whose a row is, seen from the viewer: never who the other person is. */
export const TAKEN = ['MINE', 'NOBODY', 'OTHER'] as const
export type Taken = (typeof TAKEN)[number]

export interface Person {
  readonly workerId: string | null
  readonly userId: string | null
}

const isPerson = (who: Person, viewer: Person): boolean => (viewer.workerId !== null && who.workerId === viewer.workerId) || (viewer.userId !== null && who.userId === viewer.userId)
const nobody = (who: Person): boolean => who.workerId === null && who.userId === null

/**
 * Whose a record is: the assignee's once one is set (a final inspection, W2a), else its inspector's; a record nobody took (a
 * rule opened it, B-W2b-101) is nobody's yet: the first person who records it takes it.
 */
export function takenOf(inspector: Person, viewer: Person, assigned: Person = { workerId: null, userId: null }): Taken {
  if (!nobody(assigned)) return isPerson(assigned, viewer) ? 'MINE' : 'OTHER'
  if (nobody(inspector)) return 'NOBODY'
  return isPerson(inspector, viewer) ? 'MINE' : 'OTHER'
}

/** "My inspections": the viewer's own and the ones nobody took yet. */
export const isMine = (taken: Taken): boolean => taken !== 'OTHER'

// ---- what a row holds up ------------------------------------------------------------------------------------------------------------

/**
 * What waits for an inspection, most urgent first:
 *   RUN          a first piece: every other bundle of the run waits at the operation (the database holds them)
 *   WORK_ORDERS  a lot in quarantine that open work orders need (the material cannot be issued)
 *   SHIPPING     garments that cannot be released, so not packed or shipped
 *   STOCK        a lot in quarantine nothing needs yet
 *   NONE         nothing waits (a roving, cutting or end-of-line check; a lot already released)
 */
export const BLOCKS = ['RUN', 'WORK_ORDERS', 'SHIPPING', 'STOCK', 'NONE'] as const
export type Blocks = (typeof BLOCKS)[number]

/** Garments due to ship within this many days count as urgent as work that waits for a lot. */
export const SHIP_HORIZON_DAYS = 7

export type BlockFacts =
  | { readonly kind: 'FIRST_PIECE'; readonly workOrder: string; readonly operation: string | null; readonly open: boolean }
  | { readonly kind: 'INCOMING'; readonly lot: string | null; readonly lotStatus: string | null; readonly units: string | null; readonly neededBy: { readonly workOrders: number; readonly earliest: string | null } }
  | { readonly kind: 'FINAL' | 'FINAL_DUE'; readonly workOrder: string; readonly garments: number; readonly dueDate: string | null }
  | { readonly kind: 'CUTTING' | 'ROVING' | 'END_OF_LINE' }

export interface Block {
  readonly what: Blocks
  /** 0 most urgent … 3 nothing waits. */
  readonly rank: number
  /** The day the work that waits needs it (a work order's due day), when known. */
  readonly needBy: string | null
  /** How much waits: work orders, garments (null when nothing is counted). */
  readonly count: number | null
  readonly words: Words
}

const DAY_MS = 86_400_000
const dayNumber = (day: string): number => Math.floor(Date.parse(`${day}T00:00:00.000Z`) / DAY_MS)

/** Is a due day within the horizon from today (or past)? */
export const withinDays = (day: string | null, today: string, days: number): boolean => day !== null && dayNumber(day) - dayNumber(today) <= days

export function blockOf(facts: BlockFacts, today: string): Block {
  switch (facts.kind) {
    case 'FIRST_PIECE': {
      if (!facts.open) return { what: 'NONE', rank: 3, needBy: null, count: null, words: { it: 'Nessuna attesa.', en: 'Nothing waits.' } }
      const at = facts.operation ? ` ${facts.operation}` : ''
      return {
        what: 'RUN',
        rank: 0,
        needBy: null,
        count: null,
        words: { it: `Ferma la produzione di ${facts.workOrder}${at ? ` in${at}` : ''}: gli altri fasci aspettano questo primo capo.`, en: `Holds the run of ${facts.workOrder}${at ? ` at${at}` : ''}: the other bundles wait for this first piece.` },
      }
    }
    case 'INCOMING': {
      const lot = facts.lot ?? '—'
      if (facts.lotStatus !== null && facts.lotStatus !== 'QUARANTINE') {
        return { what: 'NONE', rank: 3, needBy: null, count: null, words: { it: `Il lotto ${lot} non è in quarantena (${facts.lotStatus.toLowerCase()}): nulla lo aspetta.`, en: `Lot ${lot} is not in quarantine (${facts.lotStatus.toLowerCase()}): nothing waits for it.` } }
      }
      if (facts.neededBy.workOrders > 0) {
        const n = facts.neededBy.workOrders
        const by = facts.neededBy.earliest ? { it: ` · la prima entro il ${facts.neededBy.earliest}`, en: ` · the first due ${facts.neededBy.earliest}` } : { it: '', en: '' }
        return {
          what: 'WORK_ORDERS',
          rank: 1,
          needBy: facts.neededBy.earliest,
          count: n,
          words: { it: `${n === 1 ? '1 ordine di lavoro aspetta' : `${n} ordini di lavoro aspettano`} il lotto ${lot}${by.it}.`, en: `${n === 1 ? '1 work order needs' : `${n} work orders need`} lot ${lot}${by.en}.` },
        }
      }
      const units = facts.units ? ` (${facts.units})` : ''
      return { what: 'STOCK', rank: 2, needBy: null, count: null, words: { it: `Il lotto ${lot}${units} aspetta in quarantena.`, en: `Lot ${lot}${units} waits in quarantine.` } }
    }
    case 'FINAL':
    case 'FINAL_DUE': {
      const g = facts.garments
      const urgent = withinDays(facts.dueDate, today, SHIP_HORIZON_DAYS)
      const due = facts.dueDate ? { it: ` · da consegnare entro il ${facts.dueDate}`, en: ` · due ${facts.dueDate}` } : { it: '', en: '' }
      return {
        what: 'SHIPPING',
        rank: urgent ? 1 : 2,
        needBy: facts.dueDate,
        count: g,
        words: { it: `${g === 1 ? '1 capo' : `${g} capi`} di ${facts.workOrder} non ${g === 1 ? 'può essere rilasciato' : 'possono essere rilasciati'} né spediti${due.it}.`, en: `${g === 1 ? '1 garment' : `${g} garments`} of ${facts.workOrder} cannot be released or shipped${due.en}.` },
      }
    }
    default:
      return { what: 'NONE', rank: 3, needBy: null, count: null, words: { it: 'Nessuna attesa: il lavoro continua.', en: 'Nothing waits: the work goes on.' } }
  }
}

// ---- how long it has waited -----------------------------------------------------------------------------------------------------------

export interface Waiting {
  readonly minutes: number
  readonly words: Words
}

/** "Waiting 2 h 10 min" from when the work began to wait (its record opened, its garments finished). */
export function waitingOf(since: Date, now: Date): Waiting {
  const minutes = Math.max(0, Math.floor((now.getTime() - since.getTime()) / 60_000))
  if (minutes < 1) return { minutes, words: { it: 'In attesa da adesso', en: 'Waiting since just now' } }
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const mins = minutes % 60
  const span = (dayWord: string) => (days > 0 ? `${days} ${dayWord}${hours > 0 ? ` ${hours} h` : ''}` : hours > 0 ? `${hours} h${mins > 0 ? ` ${mins} min` : ''}` : `${mins} min`)
  return { minutes, words: { it: `In attesa da ${span('g')}`, en: `Waiting ${span('d')}` } }
}

/**
 * When the oldest garment no inspection covers was finished: the reports at the last operation in time order (good garments),
 * the first `covered` taken by the releases and the open inspections (first in, first out); null when nothing waits. A
 * report history that never reaches past `covered` (a correction elsewhere) falls back to the last report.
 */
export function oldestWaitingSince(reports: readonly { readonly at: string; readonly good: number }[], covered: number): string | null {
  let total = 0
  for (const report of reports) {
    total += report.good
    if (total > covered) return report.at
  }
  return reports.length > 0 && total > 0 ? reports[reports.length - 1]!.at : null
}

// ---- the order ---------------------------------------------------------------------------------------------------------------------

export interface Ordered {
  readonly block: Pick<Block, 'rank' | 'needBy'>
  readonly dueAt: string | null
  readonly waitingSince: string | null
  /** A stable last word (the row's key). */
  readonly key: string
}

const earliestOf = (row: Ordered): number | null => {
  const days = [row.block.needBy ? Date.parse(`${row.block.needBy}T23:59:59.999Z`) : null, row.dueAt ? Date.parse(row.dueAt) : null].filter((value): value is number => value !== null && Number.isFinite(value))
  return days.length > 0 ? Math.min(...days) : null
}

/**
 * Blocking first (rank), then the earliest day something needs it (the work order's due day or the inspection's own due time;
 * a row without one after those with one), then the one that has waited longest, then the key.
 */
export function compareRows(a: Ordered, b: Ordered): number {
  if (a.block.rank !== b.block.rank) return a.block.rank - b.block.rank
  const ea = earliestOf(a)
  const eb = earliestOf(b)
  if (ea !== eb) {
    if (ea === null) return 1
    if (eb === null) return -1
    return ea - eb
  }
  const wa = a.waitingSince ? Date.parse(a.waitingSince) : null
  const wb = b.waitingSince ? Date.parse(b.waitingSince) : null
  if (wa !== wb) {
    if (wa === null) return 1
    if (wb === null) return -1
    return wa - wb
  }
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
}

export const queueOrder = <Row extends Ordered>(rows: readonly Row[]): Row[] => [...rows].sort(compareRows)

// ---- scan to start --------------------------------------------------------------------------------------------------------------------

/** The bench a scan comes from: it says which inspection a code leads to when a code could lead to more than one. */
export const SCAN_STAGES = ['INCOMING', 'IN_LINE', 'FINAL'] as const
export type ScanStage = (typeof SCAN_STAGES)[number]

/** What a code names. */
export const FOUND_TYPES = ['LOT', 'HIDE', 'BUNDLE', 'SERIAL', 'CARTON', 'WORK_ORDER', 'INSPECTION', 'INCOMING_INSPECTION'] as const
export type FoundType = (typeof FOUND_TYPES)[number]

/** The inspection kinds a code can lead to: incoming (a lot), in-line (a bundle, a work order's cutting), final (garments). */
export type ScanTarget = 'INCOMING' | 'IN_LINE' | 'FINAL'

const NAME: Readonly<Record<FoundType, Words>> = Object.freeze({
  LOT: { it: 'un lotto', en: 'a lot' },
  HIDE: { it: 'una pelle', en: 'a hide' },
  BUNDLE: { it: 'un fascio', en: 'a bundle' },
  SERIAL: { it: 'un numero di serie', en: 'a garment serial' },
  CARTON: { it: 'un collo', en: 'a carton' },
  WORK_ORDER: { it: 'un ordine di lavoro', en: 'a work order' },
  INSPECTION: { it: 'un collaudo finale', en: 'a final inspection' },
  INCOMING_INSPECTION: { it: 'un controllo in accettazione', en: 'an incoming inspection' },
})

const STAGE_TAKES: Readonly<Record<ScanStage, Words>> = Object.freeze({
  INCOMING: { it: 'Qui si scansiona il lotto o una sua pelle.', en: 'Scan the lot or one of its hides here.' },
  IN_LINE: { it: 'Qui si scansiona il fascio (o l’ordine di lavoro per il taglio).', en: 'Scan the bundle here (or the work order for a cutting inspection).' },
  FINAL: { it: 'Qui si scansiona l’ordine di lavoro, un fascio, un numero di serie o un collo.', en: 'Scan the work order, a bundle, a garment serial or a carton here.' },
})

/** Which inspections a code can lead to, before the stage picks one. */
export const TARGETS_OF: Readonly<Record<FoundType, readonly ScanTarget[]>> = Object.freeze({
  LOT: ['INCOMING'],
  HIDE: ['INCOMING'],
  BUNDLE: ['IN_LINE', 'FINAL'],
  SERIAL: ['FINAL'],
  CARTON: ['FINAL'],
  WORK_ORDER: ['FINAL', 'IN_LINE'],
  INSPECTION: ['FINAL'],
  INCOMING_INSPECTION: ['INCOMING'],
})

/**
 * The inspection a code leads to at this bench: the one target the stage names (a code of another bench is refused in words),
 * or, with no stage, the targets the code can lead to (the API then takes the one with an open record, or asks).
 */
export function scanTargets(found: FoundType, stage: ScanStage | null): { readonly ok: true; readonly targets: readonly ScanTarget[] } | { readonly ok: false; readonly words: Words } {
  const targets = TARGETS_OF[found]
  if (stage === null) return { ok: true, targets }
  if (targets.includes(stage)) return { ok: true, targets: [stage] }
  return {
    ok: false,
    words: { it: `Questo è ${NAME[found].it}: non si controlla a questo banco. ${STAGE_TAKES[stage].it}`, en: `This is ${NAME[found].en}: it is not inspected at this bench. ${STAGE_TAKES[stage].en}` },
  }
}

/** A code that names nothing the viewer may inspect. */
export const unknownCodeWords = (code: string): Words => ({
  it: `Nessun lotto, pelle, fascio, numero di serie, collo, ordine di lavoro o collaudo ha il codice ${code}.`,
  en: `No lot, hide, bundle, garment serial, carton, work order or inspection has the code ${code}.`,
})

/** What a scan answers. */
export const SCAN_OUTCOMES = ['OPEN', 'START', 'CHOOSE', 'NOTHING'] as const
export type ScanOutcome = (typeof SCAN_OUTCOMES)[number]

/** The in-process checks that open from a scan and are recorded afterwards; roving and end of line are one step. */
export const STARTABLE_CHECKS = ['FIRST_PIECE', 'CUTTING'] as const
export type StartableCheck = (typeof STARTABLE_CHECKS)[number]

export const oneStepWords: Words = {
  it: 'Un controllo in linea o di fine linea si registra in un passo, con il suo esito: non si apre prima.',
  en: 'A roving or end-of-line check is recorded in one step, with what it found: it is not opened first.',
}

/** Garments of a work order a new final inspection can take: finished, not released, not in an open inspection. */
export const garmentsToInspect = (facts: { readonly finished: number | null; readonly released: number; readonly inOpenInspections: number }): number =>
  facts.finished === null ? 0 : Math.max(0, facts.finished - facts.released - facts.inOpenInspections)

// ---- offline -----------------------------------------------------------------------------------------------------------------------------

/** The writes the tablet's queue keeps (factory-domain floor-sync kinds), by the record they go on. */
export const FINAL_WHATS = ['RESULTS', 'MEASUREMENTS', 'COUNT', 'IDENTITY', 'DEFECTS', 'CHECKLIST'] as const
export type FinalWhat = (typeof FINAL_WHATS)[number]
export const INCOMING_WHATS = ['HIDE', 'HIDE_REMOVED', 'RESULTS'] as const
export type IncomingWhat = (typeof INCOMING_WHATS)[number]

export const OFFLINE_LIMITS = Object.freeze({
  /** Open inspections a tablet keeps with their plans. */
  records: 25,
  /** How long a kept copy is trusted before the tablet reads it again when the network is back. */
  keepHours: 12,
  /** Rows of the queue. */
  rows: 200,
})

export const OFFLINE_WORDS: Readonly<{ queued: Words; held: Words }> = Object.freeze({
  queued: {
    it: 'Senza rete restano sul tablet e partono da sole: esiti dei controlli, misure, conteggio del campione, numeri di serie, difetti, pelle per pelle.',
    en: 'Without the network these stay on the tablet and go by themselves: check results, measurements, the sample count, serial scans, defects, hide by hide.',
  },
  held: {
    it: 'Aspettano la rete: aprire un controllo (prende il numero dall’ufficio), firmare con il PIN, annullare, le foto.',
    en: 'These wait for the network: opening an inspection (it takes its number from the office), signing with the PIN, cancelling, photos.',
  },
})
