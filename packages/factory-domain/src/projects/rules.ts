/**
 * Projects (threads plan TH-5, B-TH-066 … B-TH-074; gaps PROJ-G01 … PROJ-G17; design Products › Development › Projects), pure.
 * factory-db projects.prisma (B-TH-065) holds the rows and the …_projects_th_guards triggers repeat every rule below for every
 * login; this file says each refusal FIRST, in words (Italian and English), so a person never meets the database's message.
 *
 * A project is the second kind of conversation, beside the one thread of each record: work on several records (a new
 * collection, a style family, a leather change across styles, a made-to-measure programme) or on work that has no record yet
 * (R&D, finding a supplier). Its conversation is a normal thread (record type `Project`); its people are the thread's followers;
 * it links the records it is about, both ways (each record lists its projects). No message is ever copied between a record's
 * thread and a project: each side lists the other.
 *
 *   ACTIVE ⇄ ON_HOLD;  ACTIVE | ON_HOLD ──close (DONE | STOPPED + one line)──▶ CLOSED ──reopen──▶ ACTIVE (the outcome goes)
 *
 * The rule people see (it must never confuse): about ONE record → that record's thread; about several records, or work with no
 * record yet → a project; about the customer in general → its account conversation.
 *
 * THE WALL (Owner, absolute): a project has ONE outside company (a customer, a brand, a supplier or a subcontractor) chosen when
 * it is made and never changed, or none (an office-only project). Its shared messages reach that company only; it links only
 * records of that company or of none; that company's portal people see it only when the office added them one by one (its
 * members); the office's own fields — the lead, the goal, the outcome and its words, the link notes, who did what — never reach
 * the portal. A refusal toward a customer is neutral ("not found"): it never says another customer exists.
 */

export const PROJECT_STATUSES = ['ACTIVE', 'ON_HOLD', 'CLOSED'] as const
export type ProjectStatus = (typeof PROJECT_STATUSES)[number]

export const PROJECT_OUTCOMES = ['DONE', 'STOPPED'] as const
export type ProjectOutcome = (typeof PROJECT_OUTCOMES)[number]

/** The statuses a project is "open" in (it takes links, people and changes). */
export const OPEN_PROJECT_STATUSES = ['ACTIVE', 'ON_HOLD'] as const satisfies readonly ProjectStatus[]
export const isOpenProject = (status: ProjectStatus): boolean => status !== 'CLOSED'

export const PROJECT_LIMITS = Object.freeze({
  /** One line. */
  name: 200,
  goal: 4000,
  /** The outcome's one line. */
  outcomeNote: 500,
  /** A link's note (why it is linked), one line. */
  linkNote: 500,
  /** The most rows the list reads (paged on the screen). */
  list: 1000,
  /** The most linked records the page shows (the count is exact). */
  links: 200,
  /** The most people the page shows (the count is exact). */
  people: 200,
  /** The most records "Add to project" takes in one go (the bulk bar's limit). */
  bulk: 200,
  /** Days without a message, past its target date, before the lead is nudged (PROJ.home-F04). */
  staleDays: 14,
  /** The most "similar name" projects the New project dialog shows (PROJ.new-F03). */
  similar: 5,
})

/** The record types a project links, with the column that says whose each is (the database's `factory_project_link_columns`). */
export const PROJECT_LINK_TYPES = [
  'Style',
  'SampleRound',
  'Quote',
  'SalesOrder',
  'PurchaseOrder',
  'SubcontractOrder',
  'ChangeRequest',
  'Certificate',
  'Inquiry',
  'Shipment',
  'MeasurementProfile',
] as const
export type ProjectLinkType = (typeof PROJECT_LINK_TYPES)[number]
export const isProjectLinkType = (type: string): type is ProjectLinkType => (PROJECT_LINK_TYPES as readonly string[]).includes(type)

/** How the page groups the linked records (PROJ.linked-F01), in this order. */
export const LINK_GROUPS: Readonly<Record<ProjectLinkType, string>> = Object.freeze({
  Style: 'STYLES',
  SampleRound: 'SAMPLES',
  Quote: 'QUOTES',
  SalesOrder: 'ORDERS',
  Inquiry: 'REQUESTS',
  Shipment: 'SHIPMENTS',
  ChangeRequest: 'CHANGES',
  PurchaseOrder: 'PURCHASE_ORDERS',
  SubcontractOrder: 'PURCHASE_ORDERS',
  Certificate: 'CERTIFICATES',
  MeasurementProfile: 'MEASUREMENTS',
})

/** The key of a link (the database's unique key): `link:<projectId>:<recordType>:<recordId>`. */
export const linkKeyOf = (projectId: string, recordType: string, recordId: string): string => `link:${projectId}:${recordType}:${recordId}`

/** The moves a person asks (close and reopen carry more than the status). */
export const PROJECT_MOVES = ['HOLD', 'RESUME', 'CLOSE', 'REOPEN'] as const
export type ProjectMove = (typeof PROJECT_MOVES)[number]

/** The status a move leads to, or null when it is not allowed from this status. */
export function moveTarget(from: ProjectStatus, move: ProjectMove): ProjectStatus | null {
  switch (move) {
    case 'HOLD':
      return from === 'ACTIVE' ? 'ON_HOLD' : null
    case 'RESUME':
      return from === 'ON_HOLD' ? 'ACTIVE' : null
    case 'CLOSE':
      return from === 'ACTIVE' || from === 'ON_HOLD' ? 'CLOSED' : null
    case 'REOPEN':
      return from === 'CLOSED' ? 'ACTIVE' : null
  }
}

/** The moves allowed now (the page's buttons). */
export const movesFrom = (status: ProjectStatus): ProjectMove[] => PROJECT_MOVES.filter((move) => moveTarget(status, move) !== null)

export type Words = { readonly it: string; readonly en: string }

export const STATUS_WORDS: Readonly<Record<ProjectStatus, Words>> = Object.freeze({
  ACTIVE: { it: 'Attivo', en: 'Active' },
  ON_HOLD: { it: 'In pausa', en: 'On hold' },
  CLOSED: { it: 'Chiuso', en: 'Closed' },
})

export const OUTCOME_WORDS: Readonly<Record<ProjectOutcome, Words>> = Object.freeze({
  DONE: { it: 'Concluso', en: 'Done' },
  STOPPED: { it: 'Fermato', en: 'Stopped' },
})

/** The one line the New project dialog says (PROJ.new-F01 "the rule in one line"). */
export const PROJECT_RULE_WORDS: Words = Object.freeze({
  it: 'Una conversazione su un solo record va nel suo thread; su più record, o su un lavoro che non ha ancora un record, va in un progetto.',
  en: 'A conversation about one record belongs in its thread; about several records, or work that has no record yet, it belongs in a project.',
})

/** Said plainly on the page until members-only office projects exist (PROJ privacy rule 5, B-TH-099). */
export const OFFICE_OPEN_WORDS: Words = Object.freeze({
  it: 'Chi in azienda legge i thread può aprire questo progetto.',
  en: 'Everyone in the company who reads threads can open this project.',
})

/** One line: no control characters, not blank, at most `longest` characters (the database's factory_recall_words_ok, lines off). */
export const isOneLine = (value: string, longest: number): boolean => value.trim() !== '' && value.length <= longest && !/[\u0000-\u001f\u007f]/.test(value)
/** A paragraph: line breaks and tabs allowed, no other control character, not blank, at most `longest`. */
export const isParagraph = (value: string, longest: number): boolean => value.trim() !== '' && value.length <= longest && !/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)

export interface ProjectIssue {
  readonly path: string
  readonly message: string
}

/** What is wrong with a project's own words (name, goal), or nothing. */
export function projectProblems(input: { readonly name?: string | undefined; readonly goal?: string | null | undefined }): ProjectIssue[] {
  const issues: ProjectIssue[] = []
  if (input.name !== undefined && !isOneLine(input.name.trim(), PROJECT_LIMITS.name)) issues.push({ path: 'body/name', message: `A project's name is one line of 1 to ${PROJECT_LIMITS.name} characters.` })
  if (input.goal !== undefined && input.goal !== null && input.goal.trim() !== '' && !isParagraph(input.goal.trim(), PROJECT_LIMITS.goal)) issues.push({ path: 'body/goal', message: `The goal is up to ${PROJECT_LIMITS.goal} characters.` })
  return issues
}

/** What is wrong with a close (the outcome and its one line), or nothing. */
export function closeProblems(input: { readonly outcome: string; readonly outcomeNote: string }): ProjectIssue[] {
  const issues: ProjectIssue[] = []
  if (!(PROJECT_OUTCOMES as readonly string[]).includes(input.outcome)) issues.push({ path: 'body/outcome', message: 'Say how it ended: DONE or STOPPED.' })
  if (!isOneLine(input.outcomeNote.trim(), PROJECT_LIMITS.outcomeNote)) issues.push({ path: 'body/outcomeNote', message: `Say the outcome in one line of 1 to ${PROJECT_LIMITS.outcomeNote} characters.` })
  return issues
}

// ---- refusals, in words (it + en): the code travels at `refusal/<CODE>` -----------------------------------------------------

export const PROJECT_REFUSALS = Object.freeze({
  CLOSED: {
    it: 'Il progetto è chiuso: riaprilo prima di cambiarlo.',
    en: 'The project is closed: reopen it before changing it.',
  },
  MOVE: {
    it: 'Il progetto non può passare a questo stato da quello in cui è.',
    en: 'The project cannot move to this status from the one it is in.',
  },
  PARTY_FIXED: {
    it: 'L’azienda esterna di un progetto si sceglie quando lo si crea e non cambia più.',
    en: 'A project’s outside company is chosen when it is made and never changes.',
  },
  PARTY_BLOCKED: {
    it: 'Questa azienda è bloccata o archiviata: un nuovo progetto non può essere condiviso con lei.',
    en: 'This company is blocked or archived: a new project cannot be shared with it.',
  },
  NOT_OUTSIDE: {
    it: 'Un progetto si condivide con un cliente, un marchio, un fornitore o un terzista, oppure con nessuno.',
    en: 'A project is shared with a customer, a brand, a supplier or a subcontractor, or with nobody outside.',
  },
  LEAD: {
    it: 'Il responsabile di un progetto è una persona attiva dell’ufficio che può leggerlo.',
    en: 'A project is led by an active office person who may read it.',
  },
  SEASON: {
    it: 'Questa stagione non è una stagione della società del progetto.',
    en: 'This season is not a season of the project’s company.',
  },
  LINK_TYPE: {
    it: 'Un progetto collega modelli, giri campione, preventivi, ordini, ordini d’acquisto e di lavorazione, modifiche, certificati, richieste, spedizioni e profili di misura.',
    en: 'A project links styles, sample rounds, quotes, orders, purchase and subcontract orders, changes, certificates, requests, shipments and measurement profiles.',
  },
  LINK_COMPANY: {
    it: 'Questo record è di un’altra società: un progetto collega solo record della propria società.',
    en: 'This record belongs to another company of the group: a project links records of its own company only.',
  },
  LINK_PARTY: {
    it: 'Questo record è di un’altra azienda esterna: non può entrare in questo progetto. Un progetto collega solo record della propria azienda esterna, o di nessuna.',
    en: 'This record belongs to another outside company: it cannot join this project. A project links records of its own outside company, or of none.',
  },
  LINK_OFFICE_ONLY: {
    it: 'Questo progetto è solo interno: collega solo record che non sono di un’azienda esterna.',
    en: 'This project is office-only: it links only records that belong to no outside company.',
  },
  ALREADY_LINKED: {
    it: 'Questo record è già collegato al progetto.',
    en: 'This record is linked to the project already.',
  },
  MEMBER_NOT_READER: {
    it: 'Questa persona non può leggere il progetto: si aggiunge solo chi può vederlo.',
    en: 'This person cannot read this project: only someone who may see it can be added.',
  },
  MEMBER_OFFICE_ONLY: {
    it: 'Il progetto è solo interno: le persone di un’azienda esterna non possono esserne membri.',
    en: 'The project is office-only: people of an outside company cannot be its members.',
  },
  MEMBER_OTHER_PARTY: {
    it: 'Si aggiungono solo le persone del portale dell’azienda esterna del progetto.',
    en: 'Only portal people of the project’s outside company can be added.',
  },
  MEMBER_LEAD: {
    it: 'Il responsabile resta nel progetto: scegli prima un nuovo responsabile.',
    en: 'The lead stays in the project: pick a new lead first.',
  },
  MEMBER_REMOVE: {
    it: 'Solo il responsabile del progetto, o chi gestisce i progetti, toglie un collega; ognuno può lasciarlo da sé.',
    en: 'Only the project’s lead, or someone who manages projects, removes a colleague; anyone may leave by themselves.',
  },
  NO_PARTY_REQUEST: {
    it: 'La richiesta non ha ancora un cliente: associala prima al suo cliente (l’azienda esterna di un progetto non cambia più dopo).',
    en: 'The request has no customer yet: match it to its customer first (a project’s outside company never changes afterwards).',
  },
})
export type ProjectRefusalCode = keyof typeof PROJECT_REFUSALS

// ---- the lines the project's thread gets (system lines, internal notes: the office reads them) ----------------------------

export const PROJECT_LINES = Object.freeze({
  created: (by: string): Words => ({ it: `Progetto creato da ${by}.`, en: `Project made by ${by}.` }),
  held: (by: string): Words => ({ it: `Messo in pausa da ${by}.`, en: `Put on hold by ${by}.` }),
  resumed: (by: string): Words => ({ it: `Ripreso da ${by}.`, en: `Resumed by ${by}.` }),
  closed: (by: string, outcome: ProjectOutcome, note: string): Words => ({
    it: `Chiuso da ${by} · ${OUTCOME_WORDS[outcome].it} · ${note}`,
    en: `Closed by ${by} · ${OUTCOME_WORDS[outcome].en} · ${note}`,
  }),
  reopened: (by: string): Words => ({ it: `Riaperto da ${by}.`, en: `Reopened by ${by}.` }),
  linked: (label: string, by: string): Words => ({ it: `Collegato ${label} · da ${by}`, en: `Linked ${label} · by ${by}` }),
  unlinked: (label: string, by: string): Words => ({ it: `Scollegato ${label} · da ${by}`, en: `Unlinked ${label} · by ${by}` }),
})

/** The system line in the thread: both languages on one line (the office reads Italian and English). */
export const lineOf = (words: Words): string => `${words.it} / ${words.en}`

// ---- dates ------------------------------------------------------------------------------------------------------------------

/** How a target date reads against today (PROJ.list-F06): overdue (red), within 7 days (amber), or later; a closed project: plain. */
export type TargetState = 'OVERDUE' | 'SOON' | 'LATER' | 'CLOSED'

const DAY_MS = 86_400_000
const dayNumber = (day: string): number => Math.floor(Date.parse(`${day}T00:00:00.000Z`) / DAY_MS)

export function targetStateOf(status: ProjectStatus, targetDate: string, today: string): { readonly state: TargetState; readonly days: number } {
  const days = dayNumber(targetDate) - dayNumber(today)
  if (status === 'CLOSED') return { state: 'CLOSED', days }
  if (days < 0) return { state: 'OVERDUE', days }
  if (days <= 7) return { state: 'SOON', days }
  return { state: 'LATER', days }
}

/** The words of a target date's state (with the days, never colour alone). */
export function targetWords(state: TargetState, days: number): Words | null {
  if (state === 'OVERDUE') return { it: `In ritardo di ${-days} g`, en: `Overdue ${-days} d` }
  if (state === 'SOON') return days === 0 ? { it: 'Scade oggi', en: 'Due today' } : { it: `Scade tra ${days} g`, en: `Due in ${days} d` }
  return null
}

/**
 * PROJ.home-F04: a project is stale when it is open, past its target date, and its conversation has had no message for
 * PROJECT_LIMITS.staleDays days (or none since it was made that long ago). Its lead is nudged: "close or update".
 */
export function isStale(input: { readonly status: ProjectStatus; readonly targetDate: string; readonly lastMessageAt: Date | null; readonly createdAt: Date }, today: string, now: Date): boolean {
  if (input.status === 'CLOSED') return false
  if (dayNumber(input.targetDate) >= dayNumber(today)) return false
  const last = input.lastMessageAt ?? input.createdAt
  return now.getTime() - last.getTime() >= PROJECT_LIMITS.staleDays * DAY_MS
}

/** The words of the nudge to the lead. */
export const staleWords = (label: string): Words => ({
  it: `${label} ha superato la data obiettivo e non ha messaggi da ${PROJECT_LIMITS.staleDays} giorni: chiudilo o aggiornalo.`,
  en: `${label} is past its target date and quiet for ${PROJECT_LIMITS.staleDays} days: close or update it.`,
})

/** A name alike another (the duplicate warning, PROJ.new-F03): the same words, case and spacing aside, or one inside the other. */
export function namesAlike(a: string, b: string): boolean {
  const plain = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  const x = plain(a)
  const y = plain(b)
  if (x === '' || y === '') return false
  return x === y || (x.length >= 4 && y.includes(x)) || (y.length >= 4 && x.includes(y))
}

// ---- linked news (B-TH-072; PROJ-G17, PROJ.linked-F08) -------------------------------------------------------------------

/** The actions a linked record's audit row counts as a decision even without a status move. */
const DECISION = /(decide|decision|approve|reject|accept|release|cancel|close|ship|confirm)/i

/** Whether a linked record's change is news for its project: a status move, or a decision. */
export const isLinkedNews = (action: string, status: { readonly from: string | null; readonly to: string | null } | null): boolean => status !== null || DECISION.test(action)

/**
 * "Very many: one line per record per day" (PROJ.linked-F08): of the entries newest first, the newest of each record and Rome
 * day, with how many moves it folds. Pure.
 */
export function foldPerRecordDay<T extends { readonly recordType: string; readonly recordId: string; readonly at: Date }>(entries: readonly T[], dayOf: (at: Date) => string): Array<T & { readonly folded: number }> {
  const seen = new Map<string, number>()
  const out: Array<T & { folded: number }> = []
  for (const entry of entries) {
    const key = `${entry.recordType}:${entry.recordId}:${dayOf(entry.at)}`
    const index = seen.get(key)
    if (index === undefined) {
      seen.set(key, out.length)
      out.push({ ...entry, folded: 1 })
    } else {
      out[index]!.folded += 1
    }
  }
  return out
}
