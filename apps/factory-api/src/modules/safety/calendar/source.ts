import type { FactoryClient } from '@nexus/factory-db'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { CALENDAR_KIND } from '@nexus/factory-domain/safety/calendar/rules'
import type { OfficeContext } from '../../../core/context'

/**
 * What a source of the safety calendar is (B-W2b-120; QHS-227; plan: "The calendar reads a folder of sources
 * (modules/safety/calendar/sources/*.ts): each later step adds one new file for its deadlines, so no later step edits this
 * one"). A source file default-exports `defineCalendarSource({ kind, read })`; ./source-files.ts finds the files, ./registry.ts
 * loads them when the calendar routes register (and the production build makes each one an entry point).
 *
 * A source reads its own tables with the caller's office client (row-level security holds) inside the scope the calendar
 * hands it (safety.view over companies and sites, the screen's company, `?companyId=&siteId=`), for the days asked, and
 * returns its items: never a person's name where its page keeps names behind a gate of its own (a health visit, an injured
 * person), never money. The calendar adds the company and site words, the owner's name and each item's state.
 */

/** The days and the place one read asks for. */
export interface CalendarWindow {
  readonly from: BusinessDate
  readonly to: BusinessDate
  /**
   * The first day an item still OPEN is read from (≤ from): with `late`, what is still late from before the window (the
   * list and the tiles never lose an overdue item); else `from`. Done and cancelled items are read from `from` only.
   */
  readonly openFrom: BusinessDate
  readonly today: BusinessDate
  readonly companyId?: string | undefined
  readonly siteId?: string | undefined
}

/** The scope filters a source puts in its `where` (each already holds the screen's company and the asked narrowing). */
export interface SourceScope {
  /** A table with `companyId` and a nullable `siteId` (null: the whole company). */
  readonly place: Record<string, unknown>
  /** A table with `companyId` and `siteId` (a machine's plan, an assessment, a person). */
  readonly site: Record<string, unknown>
}

export interface SourceItem {
  /** Unique in the read: `<kind>:<record id>`, or `<kind>:<group>` for a count. */
  readonly key: string
  readonly kind: string
  readonly recordType: string | null
  readonly recordId: string | null
  readonly companyId: string
  readonly siteId: string | null
  readonly dueOn: BusinessDate
  readonly done?: boolean
  readonly cancelled?: boolean
  /** No fixed day in the plan (said "to confirm", never late). */
  readonly toConfirm?: boolean
  /** How many people, visits or reports the item stands for (null: one record). */
  readonly count: number | null
  readonly params: Readonly<Record<string, string>>
  readonly ownerId: string | null
  readonly evidence: { readonly required: boolean; readonly onFile: boolean } | null
  readonly law: string | null
  readonly source: { readonly page: string | null; readonly recordType: string | null; readonly recordId: string | null; readonly parentType: string | null; readonly parentId: string | null }
  readonly editable: boolean
}

export interface CalendarSource {
  /** The kind(s) it makes, for the "could not be read" words (the first is its name). */
  readonly kind: string
  read(client: FactoryClient, context: OfficeContext, window: CalendarWindow, scope: SourceScope): Promise<readonly SourceItem[]>
}

const SOURCE = Symbol.for('nexus.factory.safety.calendarSource')

export function defineCalendarSource(source: CalendarSource): CalendarSource {
  if (!CALENDAR_KIND.test(source.kind)) throw new Error(`A calendar source's kind is a code in capitals, not ${JSON.stringify(source.kind)}`)
  return Object.freeze({ ...source, [SOURCE]: true })
}

export const isCalendarSource = (value: unknown): value is CalendarSource => typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[SOURCE] === true

/** The source's link: where the item is kept. */
export const sourceOf = (page: string | null, recordType: string | null = null, recordId: string | null = null, parentType: string | null = null, parentId: string | null = null): SourceItem['source'] => ({ page, recordType, recordId, parentType, parentId })

/** A DATE column as a day. */
export const dayOfDate = (value: Date): BusinessDate => value.toISOString().slice(0, 10)
/** A day as a DATE column takes it. */
export const dateOfDay = (day: BusinessDate): Date => new Date(`${day}T00:00:00.000Z`)
