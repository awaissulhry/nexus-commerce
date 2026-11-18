import { DESCRIPTION_MAX, TITLE_MAX } from '../tasks/rules' // B-PR-43b

/**
 * B-PR-15 (production plan schema wave 3/5; lead pick L24; review fixes R-42, R-43, R-44): the issues that need an answer,
 * pure — the lists the database's ProductionIssue mirrors (factory-db domain-mirrors keeps them equal). B-PR-43b adds the due
 * and answered rules and their words here, B-PR-45 the escalation steps (the clock itself is supervisor.ts escalationClock).
 *
 *   source   BRAND   the customer's "Report a problem" on one or many of its own orders (one portal message per order thread)
 *            OFFICE  the office's "Needs an answer" on a note (one internal note per picked record)
 *   status   OPEN → ANSWERED (a BRAND issue: the first shared office message in that order's thread after it was raised; an
 *            OFFICE issue: its task done) or CANCELLED; an OFFICE issue whose task reopens is OPEN again (R-42)
 *
 * One Task per batch (record = the first order; R-43): every issue of a batch names the batch's task, and answering closes
 * every issue of the batch. An issue is about a sales order or a work order of ONE customer; the customer reads only
 * "Waiting on us since <date>" / "Answered", never the issue, its task or who answers (R-41).
 */
export const ISSUE_SOURCES = ['BRAND', 'OFFICE'] as const
export type IssueSource = (typeof ISSUE_SOURCES)[number]

export const ISSUE_STATUSES = ['OPEN', 'ANSWERED', 'CANCELLED'] as const
export type IssueStatus = (typeof ISSUE_STATUSES)[number]

/** The records an issue may be about (ProductionIssue.recordType). */
export const ISSUE_RECORD_TYPES = ['SalesOrder', 'WorkOrder'] as const
export type IssueRecordType = (typeof ISSUE_RECORD_TYPES)[number]

// ---- B-PR-43b (production plan §3 "Issues"; lead pick L24; review fixes R-42, R-43, R-44, R-48): the due and answered rules, and
// the office's words. The due day and step time are the escalation clock's (supervisor.ts escalationClock: raise + 1 working day,
// 08:00 company time, over the company's calendar); escalation itself is B-PR-45's.

/** The time of day an issue's task is due: the escalation's step time (R-44), on the due day. */
export const ISSUE_DUE_TIME = '08:00'

/** What happened to an issue's task: the status it has now (tasks/rules TASK_STATUSES). */
export const ISSUE_TASK_MOVES = ['DONE', 'OPEN', 'CANCELLED'] as const
export type IssueTaskMove = (typeof ISSUE_TASK_MOVES)[number]

/**
 * R-42: an issue's status after its task moved (the task's status NOW, so a late event never undoes a later move), or null (no
 * change).
 *   OFFICE   task done → ANSWERED; task reopened → OPEN again (from ANSWERED); task cancelled → CANCELLED (nobody is asked any
 *            more; CANCELLED is final: a task reopened after that asks nothing again)
 *   BRAND    no task move answers it: only the first shared office message in its order's thread after it was raised does — a
 *            ticked task alone keeps the customer's "Waiting on us" and shows the office "No reply sent yet" (`officeIssueNote`)
 */
export function issueAfterTask(issue: { readonly source: IssueSource; readonly status: IssueStatus }, move: IssueTaskMove): IssueStatus | null {
  if (issue.source !== 'OFFICE') return null
  if (move === 'DONE' && issue.status === 'OPEN') return 'ANSWERED'
  if (move === 'OPEN' && issue.status === 'ANSWERED') return 'OPEN'
  if (move === 'CANCELLED' && issue.status === 'OPEN') return 'CANCELLED'
  return null
}

/** A thread message as the answered rule reads it (Message: direction, audience, author kind, held, at). */
export interface AnsweringMessage {
  readonly direction: string
  readonly audience: string
  readonly authorKind: string
  /** An OUTBOUND mail still in its undo window (B-TH-048): no customer reads it yet; it answers once it leaves (released). */
  readonly held: boolean
  readonly at: Date
}

/**
 * R-42 / R-43: whether a message answers a BRAND issue — a SHARED message a person of the office wrote (OUTBOUND, audience
 * PARTNER, author USER) that the customer can read (not held), in the thread of one of its batch's orders, at or after the issue
 * was raised, while the issue is open. The same rule as the customer's own read of "Answered" (brand-portal access.ts
 * officeAnswers). One such message answers every issue of the batch (the others read "Answered in SO-xxxx": `answeredInOrderId`).
 */
export function answersBrandIssue(issue: { readonly source: IssueSource; readonly status: IssueStatus; readonly raisedAt: Date }, message: AnsweringMessage): boolean {
  return (
    issue.source === 'BRAND' &&
    issue.status === 'OPEN' &&
    message.direction === 'OUTBOUND' &&
    message.audience === 'PARTNER' &&
    message.authorKind === 'USER' &&
    !message.held &&
    message.at.getTime() >= issue.raisedAt.getTime()
  )
}

/** What the office reads beside an issue (null: nothing more than its status). */
export type OfficeIssueNote = 'NO_REPLY_YET'

/**
 * R-42: the office's line of an issue beside its task — a customer's issue whose task was ticked done while no reply went out
 * still reads "No reply sent yet" (the customer keeps "Waiting on us"); every other issue reads its status alone.
 */
export function officeIssueNote(issue: { readonly source: IssueSource; readonly status: IssueStatus }, taskStatus: IssueTaskMove | null): OfficeIssueNote | null {
  return issue.source === 'BRAND' && issue.status === 'OPEN' && taskStatus === 'DONE' ? 'NO_REPLY_YET' : null
}

/** When an issue counts as answered: the answer's time, never before the issue was raised (the database's rule). */
export const answeredAtOf = (issue: { readonly raisedAt: Date }, at: Date): Date => (at.getTime() < issue.raisedAt.getTime() ? issue.raisedAt : at)

/** The office's words of an issue (the customer reads only "Waiting on us since …" / "Answered", B-PR-18). */
export const ISSUE_WORDS = Object.freeze({
  NO_REPLY_YET: { it: 'Nessuna risposta ancora inviata', en: 'No reply sent yet' },
  ANSWERED_IN: { it: 'Risposto in {number}', en: 'Answered in {number}' },
  NO_CUSTOMER: {
    it: 'Un ordine di lavoro di più clienti o di nessuno non apre una richiesta di risposta: la nota è scritta senza.',
    en: 'A work order of several customers or of none raises no issue: its note is written without one.',
  },
  TASK_ONE: { it: 'Rispondi alla nota su {record}', en: 'Answer the note on {record}' },
  TASK_MANY: { it: 'Rispondi alla nota su {count} record di {customer}', en: 'Answer the note on {count} records of {customer}' },
  TASK_RECORDS: { it: 'Record: {records}', en: 'Records: {records}' },
})

/** The task's title and description in its assignee's language (Italian by default). */
export function issueTaskWords(input: { readonly locale: string | null | undefined; readonly labels: readonly string[]; readonly customer: string; readonly excerpt: string }): { readonly title: string; readonly description: string } {
  const lang = input.locale?.toLowerCase().startsWith('en') ? 'en' : 'it'
  const fill = (text: string, values: Record<string, string>) => text.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? '')
  const title = input.labels.length === 1 ? fill(ISSUE_WORDS.TASK_ONE[lang], { record: input.labels[0]! }) : fill(ISSUE_WORDS.TASK_MANY[lang], { count: String(input.labels.length), customer: input.customer })
  const records = fill(ISSUE_WORDS.TASK_RECORDS[lang], { records: input.labels.join(', ') })
  return { title: title.slice(0, TITLE_MAX), description: `${input.excerpt}\n\n${records}`.slice(0, DESCRIPTION_MAX) }
}
// ---- end B-PR-43b

// ---- B-PR-45 (production plan §1 "Report a problem", §3 "Issues", §7.12; lead pick L24, L25; review fixes R-41, R-42, R-43, R-44,
// R-48): the customer's "Report a problem", the escalation steps and the office's issue list words. The clock is supervisor.ts
// escalationClock (raise + 1 working day → step 1, + 2 → step 2, 08:00 company time); these are who each step goes to and what
// one escalation is. The customer never reads any of it but its own "Waiting on us since …" / "Answered" (B-PR-18).

/** The most orders one "Report a problem" names (L25: a bulk action of the portal names at most 50). */
export const PROBLEM_ORDERS_MAX = 50

/**
 * Who a step goes to (R-44): step 1 the customer's backup (PortalSettings.productionBackupId), else the people holding the
 * production manager's role; step 2 the people holding the Owner's or the Admin's role. Each one is checked again on the
 * order itself (reads its thread, may hold a task there) before anything is given to them (PW-17).
 */
export const ESCALATION_ROLE_KEYS: Readonly<Record<1 | 2, readonly string[]>> = Object.freeze({ 1: Object.freeze(['production_manager']), 2: Object.freeze(['owner', 'admin']) })

export type EscalationAudience = 'BACKUP' | 'PRODUCTION_MANAGERS' | 'OWNER_AND_ADMIN'

/** Step 1: the backup when there is one who may take it, else the production managers; step 2: the Owner and Admin. */
export const escalationAudienceOf = (step: 1 | 2, backupTakes: boolean): EscalationAudience => (step === 2 ? 'OWNER_AND_ADMIN' : backupTakes ? 'BACKUP' : 'PRODUCTION_MANAGERS')

/** An open issue as the escalation scan reads it. */
export interface EscalatingIssue {
  readonly id: string
  readonly companyId: string
  readonly partyId: string
  readonly taskId: string
  readonly batchId: string | null
  readonly source: IssueSource
  readonly status: IssueStatus
  readonly raisedAt: Date
  readonly escalationStep: number
}

/**
 * One escalation: the open issues of one batch and its task (a lone issue: itself). A customer's batch has ONE task (R-43); an
 * office batch may have one per supervisor, and each task is answered on its own, so each escalates on its own. Its clock runs
 * from the earliest raise; `taken` is the lowest step its issues took (a step goes to every issue still below it).
 */
export interface EscalationUnit {
  readonly key: string
  readonly companyId: string
  readonly partyId: string
  readonly taskId: string
  readonly batchId: string | null
  readonly raisedAt: Date
  readonly taken: 0 | 1 | 2
  readonly issueIds: readonly string[]
}

const stepOf = (value: number): 0 | 1 | 2 => (value >= 2 ? 2 : value >= 1 ? 1 : 0)

/** The open issues grouped into escalations (R-43: one per batch and step), in a stable order (earliest raise first). */
export function escalationUnitsOf(issues: readonly EscalatingIssue[]): EscalationUnit[] {
  const units = new Map<string, { companyId: string; partyId: string; taskId: string; batchId: string | null; raisedAt: Date; taken: 0 | 1 | 2; issueIds: string[] }>()
  for (const issue of issues) {
    if (issue.status !== 'OPEN') continue
    const batchKey = issue.batchId ? `${issue.batchId}.${issue.taskId}` : issue.id
    const found = units.get(batchKey)
    // A batch is one customer's at one company (raise.ts, the problems command): an issue that says otherwise is never merged
    // into it (it escalates alone, to the people of its own customer).
    const key = found && (found.partyId !== issue.partyId || found.companyId !== issue.companyId) ? issue.id : batchKey
    const unit = units.get(key)
    if (!unit) {
      units.set(key, { companyId: issue.companyId, partyId: issue.partyId, taskId: issue.taskId, batchId: issue.batchId, raisedAt: issue.raisedAt, taken: stepOf(issue.escalationStep), issueIds: [issue.id] })
      continue
    }
    if (issue.raisedAt.getTime() < unit.raisedAt.getTime()) unit.raisedAt = issue.raisedAt
    unit.taken = Math.min(unit.taken, stepOf(issue.escalationStep)) as 0 | 1 | 2
    unit.issueIds.push(issue.id)
  }
  return [...units.entries()]
    .map(([key, unit]) => ({ key, ...unit, issueIds: [...unit.issueIds].sort() }))
    .sort((a, b) => a.raisedAt.getTime() - b.raisedAt.getTime() || a.key.localeCompare(b.key))
}

/** The system command of one escalation step (one per batch and step: a second tick answers from its receipt). */
export const escalationCommandKey = (unit: Pick<EscalationUnit, 'key'>, step: 1 | 2): string => `issue-escalate:${unit.key}:${step}`

/** The first person of a chain who may take the batch's task (the order's supervisor, the customer's backup, a production manager). */
export function firstTaker(chain: readonly (string | null)[], takes: ReadonlySet<string>): string | null {
  for (const userId of chain) if (userId !== null && takes.has(userId)) return userId
  return null
}

/** The customer's report and the escalation, in Italian and English (office words but the two the customer reads). */
export const PROBLEM_WORDS = Object.freeze({
  // The customer's (portal) refusals: they never name anyone, nor another customer.
  NOT_IN_PRODUCTION: { it: 'Questo ordine non è in produzione: scrivete nella sua conversazione.', en: 'This order is not in production: write in its conversation.' },
  NOT_SENT: { it: 'Messaggio non inviato.', en: 'Message not sent.' },
  NONE_SENT: { it: 'Nessun messaggio inviato.', en: 'No message was sent.' },
  // The office's.
  TASK_ONE: { it: 'Rispondi al problema segnalato da {customer} su {record}', en: 'Answer the problem {customer} reported on {record}' },
  TASK_MANY: { it: 'Rispondi al problema segnalato da {customer} su {count} ordini', en: 'Answer the problem {customer} reported on {count} orders' },
  TASK_ORDERS: { it: 'Ordini: {records}', en: 'Orders: {records}' },
  TASK_HOW: {
    it: "Rispondi nella conversazione dell'ordine con un messaggio condiviso: il cliente legge solo quello. Spuntare l'attività non è una risposta.",
    en: "Answer in the order's conversation with a shared message: the customer reads only that. Ticking the task is no answer.",
  },
  ESCALATED_1: { it: 'Senza risposta da 1 giorno lavorativo: {what}', en: 'No answer after 1 working day: {what}' },
  ESCALATED_2: { it: 'Senza risposta da 2 giorni lavorativi: {what}', en: 'No answer after 2 working days: {what}' },
  WHAT_BRAND_ONE: { it: 'il problema segnalato da {customer} su {record}', en: 'the problem {customer} reported on {record}' },
  WHAT_BRAND_MANY: { it: 'il problema segnalato da {customer} su {count} ordini', en: 'the problem {customer} reported on {count} orders' },
  WHAT_OFFICE_ONE: { it: 'la nota su {record}', en: 'the note on {record}' },
  WHAT_OFFICE_MANY: { it: 'la nota su {count} record di {customer}', en: 'the note on {count} records of {customer}' },
})

/** The office's words beside an issue in its list. */
export const ISSUE_STATUS_WORDS: Readonly<Record<IssueStatus, { readonly it: string; readonly en: string }>> = Object.freeze({
  OPEN: { it: 'In attesa di risposta', en: 'Waiting for an answer' },
  ANSWERED: { it: 'Risposto', en: 'Answered' },
  CANCELLED: { it: 'Annullato', en: 'Cancelled' },
})
export const ISSUE_SOURCE_WORDS: Readonly<Record<IssueSource, { readonly it: string; readonly en: string }>> = Object.freeze({
  BRAND: { it: 'Segnalato dal cliente', en: 'Reported by the customer' },
  OFFICE: { it: 'Nota che chiede risposta', en: 'Note that needs an answer' },
})
export const ESCALATION_STEP_WORDS: Readonly<Record<1 | 2, { readonly it: string; readonly en: string }>> = Object.freeze({
  1: { it: 'Passato al vice (o ai responsabili di produzione)', en: 'Passed to the backup (or the production managers)' },
  2: { it: "Passato al titolare e all'amministratore", en: 'Passed to the Owner and Admin' },
})

const langOf = (locale: string | null | undefined): 'it' | 'en' => (locale?.toLowerCase().startsWith('en') ? 'en' : 'it')
const fill = (text: string, values: Record<string, string>) => text.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? '')

/** The batch task of a customer's report, in its assignee's language (Italian by default): the first order names it, all are listed. */
export function problemTaskWords(input: { readonly locale: string | null | undefined; readonly labels: readonly string[]; readonly customer: string; readonly excerpt: string }): { readonly title: string; readonly description: string } {
  const lang = langOf(input.locale)
  const title = input.labels.length === 1 ? fill(PROBLEM_WORDS.TASK_ONE[lang], { customer: input.customer, record: input.labels[0]! }) : fill(PROBLEM_WORDS.TASK_MANY[lang], { customer: input.customer, count: String(input.labels.length) })
  const orders = fill(PROBLEM_WORDS.TASK_ORDERS[lang], { records: input.labels.join(', ') })
  return { title: title.slice(0, TITLE_MAX), description: `${input.excerpt}\n\n${orders}\n\n${PROBLEM_WORDS.TASK_HOW[lang]}`.slice(0, DESCRIPTION_MAX) }
}

/** An escalation task, in its assignee's language: the step, what waits (the customer's report or the office's note), its records. */
export function escalationTaskWords(input: { readonly locale: string | null | undefined; readonly step: 1 | 2; readonly source: IssueSource; readonly labels: readonly string[]; readonly customer: string; readonly excerpt: string }): { readonly title: string; readonly description: string } {
  const lang = langOf(input.locale)
  const one = input.labels.length === 1
  const what =
    input.source === 'BRAND'
      ? fill((one ? PROBLEM_WORDS.WHAT_BRAND_ONE : PROBLEM_WORDS.WHAT_BRAND_MANY)[lang], { customer: input.customer, record: input.labels[0] ?? '', count: String(input.labels.length) })
      : fill((one ? PROBLEM_WORDS.WHAT_OFFICE_ONE : PROBLEM_WORDS.WHAT_OFFICE_MANY)[lang], { customer: input.customer, record: input.labels[0] ?? '', count: String(input.labels.length) })
  const title = fill((input.step === 1 ? PROBLEM_WORDS.ESCALATED_1 : PROBLEM_WORDS.ESCALATED_2)[lang], { what })
  const records = fill((input.source === 'BRAND' ? PROBLEM_WORDS.TASK_ORDERS : ISSUE_WORDS.TASK_RECORDS)[lang], { records: input.labels.join(', ') })
  const how = input.source === 'BRAND' ? `\n\n${PROBLEM_WORDS.TASK_HOW[lang]}` : ''
  return { title: title.slice(0, TITLE_MAX), description: `${input.excerpt}\n\n${records}${how}`.slice(0, DESCRIPTION_MAX) }
}
// ---- end B-PR-45
