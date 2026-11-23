/**
 * F-CL-104 (customers list plan §1, 10-design §8, 13-backend §8.5): "Set production supervisor for N…", pure — who the one pick runs
 * on and who it leaves out with why (not read; already this person), the body of each write (the version read, the backup kept),
 * and the receipt's numbers. The window reads each customer's portal settings (GET /partners/:id/production) and writes the ONE
 * existing route per customer (PUT /production/brands/:id/supervisor), one at a time. Worker privacy: only office people are named.
 */

/** The customers' settings are read this many at a time (as the Orders sheet's many-order windows read their orders). */
export const SUPERVISOR_READS_AT_ONCE = 5

/** An office person named on a customer's portal settings. */
export interface SupervisorPerson {
  readonly id: string
  readonly name: string
  readonly active: boolean
}

/** Why, in words: a key and its catalogue (customers-list, production-supervisor or portal-access), with its params. */
export interface SupervisorWhy {
  readonly ns: 'customers-list' | 'production-supervisor' | 'portal-access'
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
}

/** A ticked customer as the window knows it: being read, read (its version, supervisor and backup), or not readable (why). */
export type SupervisorTarget =
  | { readonly id: string; readonly name: string; readonly state: 'reading' }
  | { readonly id: string; readonly name: string; readonly state: 'read'; readonly version: number; readonly supervisor: SupervisorPerson | null; readonly backup: SupervisorPerson | null }
  | { readonly id: string; readonly name: string; readonly state: 'unread'; readonly why: SupervisorWhy }

export type ReadTarget = Extract<SupervisorTarget, { state: 'read' }>

/** What happened to one customer of the run. */
export type SupervisorOutcome = { readonly kind: 'done' } | { readonly kind: 'notRun' } | { readonly kind: 'failed'; readonly why: SupervisorWhy }

export interface SupervisorPlan {
  readonly runs: readonly ReadTarget[]
  /** Left out, with why: not readable, or already this person ("Already so"). */
  readonly notOn: ReadonlyArray<{ readonly id: string; readonly name: string; readonly why: SupervisorWhy; readonly already: boolean }>
}

/** The pick runs on every read customer whose supervisor is someone else (or nobody); the rest say why. */
export function supervisorPlanOf(targets: readonly SupervisorTarget[], pickedId: string | null): SupervisorPlan {
  const runs: ReadTarget[] = []
  const notOn: Array<SupervisorPlan['notOn'][number]> = []
  for (const target of targets) {
    if (target.state === 'unread') notOn.push({ id: target.id, name: target.name, why: target.why, already: false })
    else if (target.state === 'read') {
      if (pickedId !== null && target.supervisor?.id === pickedId) notOn.push({ id: target.id, name: target.name, why: { ns: 'customers-list', key: 'supervisor.already', params: { name: target.supervisor.name } }, already: true })
      else runs.push(target)
    }
  }
  return { runs, notOn }
}

/** One write: the pick, the backup kept (none when the backup is the pick: a backup is never its own supervisor), the version read. */
export function supervisorBodyOf(target: ReadTarget, pickedId: string): { readonly supervisorId: string; readonly backupId: string | null; readonly version: number } {
  return { supervisorId: pickedId, backupId: target.backup && target.backup.id !== pickedId ? target.backup.id : null, version: target.version }
}

/** The receipt's numbers: made now, already so, not run (the window was stopped), left out (not readable, or refused). */
export function supervisorSummaryOf(plan: SupervisorPlan, outcomes: Readonly<Record<string, SupervisorOutcome>>): { readonly done: number; readonly same: number; readonly notRun: number; readonly left: number } {
  const of = (kind: SupervisorOutcome['kind']) => plan.runs.filter((target) => outcomes[target.id]?.kind === kind).length
  return { done: of('done'), same: plan.notOn.filter((line) => line.already).length, notRun: of('notRun'), left: of('failed') + plan.notOn.filter((line) => !line.already).length }
}

/** The customers "Run the rest again" takes: those the run did not reach (stopped) or that were refused. */
export function supervisorRestOf(plan: SupervisorPlan, outcomes: Readonly<Record<string, SupervisorOutcome>>): string[] {
  return plan.runs.filter((target) => outcomes[target.id]?.kind === 'notRun' || outcomes[target.id]?.kind === 'failed').map((target) => target.id)
}

// ---- the window's model (drawn by view/SupervisorManyDialog, filled by use-supervisor-many) ----------------------------------

/** Who may supervise: the first customer's pick list (the server judges each of the others). */
export type SupervisorPeople =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly people: ReadonlyArray<{ readonly id: string; readonly name: string; readonly me: boolean }>; readonly complete: boolean }
  | { readonly status: 'error'; readonly why: SupervisorWhy }

export interface SupervisorManyModel {
  readonly step: 'read' | 'pick' | 'running' | 'done'
  readonly targets: readonly SupervisorTarget[]
  readonly people: SupervisorPeople
  readonly picked: string | null
  readonly outcomes: Readonly<Record<string, SupervisorOutcome>>
  /** Running: how many of the run are done. */
  readonly done: number
  /** Stop after this one was asked. */
  readonly stopping: boolean
}

export interface SupervisorManyActions {
  readonly onPick: (personId: string | null) => void
  readonly onGo: () => void
  readonly onStop: () => void
  readonly onRunRest: () => void
  readonly onClose: () => void
}
