import type { FactoryClient } from '@nexus/factory-db'
import type { RetentionAction, SweepHeld } from '@nexus/factory-domain/privacy/retention/retention'
import type { CommandTx } from '../../../../core/command'

export type Reader = FactoryClient | CommandTx

/** Which records of the tenant one rule covers: its own company's, or (a tenant-wide rule) those no company rule of theirs covers. */
export interface SweepScope {
  /** The rule's company; null: the whole group. */
  readonly companyId: string | null
  /** For a tenant-wide rule: the companies with an active rule of their own for this record type (theirs wins). */
  readonly exceptCompanies: readonly string[]
}

/**
 * One record type a retention rule may name (B-W2b-405; PLT-204): from which date its period counts, which records are due once
 * the period passed, and what DELETE, ANONYMISE or ARCHIVE does to them. Every type the sweep knows is one entry of
 * `rules/index.ts`; a rule naming any other table only reports that nothing is known about it.
 */
export interface RetentionType {
  readonly recordType: string
  /** A company may have its own rule (the table has a company column). */
  readonly companyScoped: boolean
  /** The actions a person may choose for it (none: kept, a rule can only report). */
  readonly actions: readonly RetentionAction[]
  /** From which date the period counts, in words. */
  readonly countsFrom: string
  /** What an applying sweep does per action, in words (the screen and the notes). */
  readonly does: Readonly<Partial<Record<RetentionAction, string>>>
  /** Every due record is held for this reason whatever the action (the database keeps it), or null. */
  readonly holdsAll: SweepHeld | null
  /** How many records are due, and the first `take` of them (oldest first): counted from before the cut-off day. */
  due(db: Reader, scope: SweepScope, cut: Cutoff, now: Date, take: number): Promise<{ readonly total: number; readonly ids: readonly string[] }>
  /** Applies the action to due records inside the sweep's command: how many changed, and why the rest were held. */
  apply(tx: CommandTx, action: RetentionAction, ids: readonly string[], now: Date): Promise<{ readonly applied: number; readonly held: SweepHeld | null }>
}

/** The sweep's cut-off day: its first instant in Europe/Rome (for a time column) and the day itself (for a date column). */
export interface Cutoff {
  readonly instant: Date
  readonly day: Date
}

/** The company filter of a scope for a table whose company column may be null (a tenant-wide rule also takes rows of no company). */
export function companyWhere(scope: SweepScope): Record<string, unknown> {
  if (scope.companyId !== null) return { companyId: scope.companyId }
  return scope.exceptCompanies.length === 0 ? {} : { OR: [{ companyId: null }, { companyId: { notIn: [...scope.exceptCompanies] } }] }
}

/** The earlier of two instants. */
export const earlier = (a: Date, b: Date): Date => (a.getTime() <= b.getTime() ? a : b)

export const HOUR = 60 * 60 * 1000

/** Holds every due record (a type the database keeps as it is). */
export const holdAll =
  (held: SweepHeld) =>
  async (): Promise<{ applied: number; held: SweepHeld }> => ({ applied: 0, held })
