import type { FactoryClient } from '@nexus/factory-db'
import type { DataSubjectKind } from '@nexus/factory-domain/privacy/retention/requests'
import type { ErasureMethod } from '@nexus/factory-domain/privacy/retention/retention'
import type { ErasureBlocked, KeptWhy } from '@nexus/factory-domain/privacy/retention/erasure'
import type { CommandCaller, CommandEvent, CommandTx } from '../../../../core/command'
import type { FilesRuntime } from '../../../files/service'

export type Reader = FactoryClient | CommandTx

/** One person a request names, as the sources need them (B-W2b-405): their record, name, company, e-mail and linked ids. */
export interface PersonFacts {
  readonly kind: DataSubjectKind
  readonly recordType: string
  readonly recordId: string
  /** The person's name as shown (the confirm phrase); an erased one says so. */
  readonly name: string
  /** Nothing of the person is left in their own record. */
  readonly erased: boolean
  /** The company the person's record belongs to; null: the whole group (an office account, a contact of a group-wide party). */
  readonly companyId: string | null
  readonly email: string | null
  /** CONTACT: the party, and whether it is a person (a rider) rather than an organisation. */
  readonly partyId: string | null
  readonly partyIsPerson: boolean
  /** WORKER: the employee record and the floor accounts; USER or WORKER: the office account. */
  readonly employeeId: string | null
  readonly workerIds: readonly string[]
  readonly userId: string | null
  /** Why an erasure cannot run now (a 409), or null. */
  readonly blocked: ErasureBlocked | null
}

/** What an applying source may do inside the erasure's command. */
export interface ApplyTools {
  readonly tx: CommandTx
  readonly now: Date
  readonly actorId: string
  /** The record's ErasureRecord, written in this command before any change (the database's door takes it: B-W2b-F54). */
  readonly erasureId: string
  emit(event: CommandEvent): void
}

/**
 * What the erasure does to one record (one ErasureRecord): column names only, never values. ANONYMISED and DELETED carry their
 * change (`apply`, run inside the erasure's command after every ErasureRecord is written); KEPT carries why the law keeps it. An
 * ANONYMISED record may name personal columns it keeps, with why (a received mail's envelope sender).
 */
export interface PlannedRecord {
  readonly recordType: string
  readonly recordId: string
  readonly method: ErasureMethod
  readonly erasedFields: readonly string[]
  readonly keptFields: readonly string[]
  readonly why: KeptWhy | null
  readonly apply?: (tools: ApplyTools) => Promise<void>
  /** B-W2b-GF1: after the erasure's commit (never inside it): e.g. a deleted file's object removed from the store, best effort. */
  readonly after?: (files: FilesRuntime, caller: CommandCaller, now: Date) => Promise<void>
}

/** One part of a person's data package: rows written out as JSON (dates as ISO strings), at most ROWS of them. */
export interface Section {
  readonly key: string
  readonly title: string
  readonly rows: readonly Record<string, unknown>[]
  readonly truncated: boolean
}

export interface Collected {
  readonly sections: readonly Section[]
  /** Records whose AVAILABLE files go into the package (the person's photos, the documents they sent). */
  readonly fileRecords: readonly { readonly recordType: string; readonly recordId: string }[]
}

/**
 * One source of a person's data (B-W2b-405; PLT-202, PLT-203): what it holds about a person of its kinds (the access package)
 * and what an erasure does to it (with the law's exceptions). ONE LINE PER SOURCE in sources/index.ts.
 */
export interface PersonSource {
  readonly key: string
  readonly kinds: readonly DataSubjectKind[]
  collect(db: Reader, person: PersonFacts): Promise<Collected>
  plan(db: Reader, person: PersonFacts, now: Date): Promise<readonly PlannedRecord[]>
}

/** The most rows one section holds (oldest first); a longer list says so (`truncated`). */
export const ROWS = 2000

/** Rows as plain JSON: dates as ISO strings, decimals and big numbers as strings. */
export function plainRows(rows: readonly object[]): Record<string, unknown>[] {
  return rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [key, value instanceof Date ? value.toISOString() : typeof value === 'bigint' ? value.toString() : value !== null && typeof value === 'object' && 'toFixed' in value ? String(value) : value]),
    ),
  )
}

export const section = (key: string, title: string, rows: readonly object[]): Section => ({ key, title, rows: plainRows(rows.slice(0, ROWS)), truncated: rows.length > ROWS })

export const kept = (recordType: string, recordId: string, why: KeptWhy, keptFields: readonly string[] = []): PlannedRecord => ({ recordType, recordId, method: 'KEPT', erasedFields: [], keptFields, why })

export const NONE: Collected = Object.freeze({ sections: [], fileRecords: [] })
