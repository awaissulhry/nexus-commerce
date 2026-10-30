import type { Prisma } from '@nexus/factory-db'
import { sourceOf, type ReasonList, type ReasonSource } from '@nexus/factory-domain/reasons/lists'
import { scrapReasonStore } from '../../modules/production/settings/scrap-reasons'
import { reasonCodeStore } from './store'

/**
 * The sources of the ONE reason list editor (B-W2a-18): each table that keeps reason lists, behind the same small
 * interface, so the routes, the commands and the screens are the same for every list.
 *
 *   REASON_CODE   platform/reasons/store.ts                       ReasonCode: the eleven lists of factory-domain
 *                                                                 reasons/lists REASON_CODE_LISTS
 *   SCRAP_REASON  modules/production/settings/scrap-reasons.ts    ScrapReason: SCRAP and REWORK (the scans reference it)
 *
 * The defect library (DefectCode, quality wave 6/7, B-W2a-26) joins as a third source with one line here and its list
 * in factory-domain reasons/lists (its API is quality's; its picture and categories stay on its own page).
 */

type Client = Prisma.TransactionClient

/** One reason as the editor and the pickers see it, whatever its table. */
export interface ReasonRow {
  readonly id: string
  readonly list: ReasonList
  readonly code: string
  readonly labelIt: string
  readonly labelEn: string
  /** The other floor languages' words (empty where the source keeps none). */
  readonly labelI18n: Readonly<Record<string, string>>
  readonly icon: string | null
  readonly colour: string | null
  readonly needsDetail: boolean
  readonly sortOrder: number
  readonly active: boolean
  readonly version: number
  readonly createdAt: Date
  readonly updatedAt: Date
}

export interface NewReasonRow {
  readonly id: string
  readonly code: string
  readonly labelIt: string
  readonly labelEn: string
  readonly labelI18n: Readonly<Record<string, string>>
  readonly icon: string | null
  readonly colour: string | null
  readonly needsDetail: boolean
  readonly sortOrder: number
  readonly at: Date
  readonly createdById: string | null
}

/** What a command changes on a reason (only the fields present). */
export interface ReasonChange {
  readonly labelIt?: string
  readonly labelEn?: string
  readonly labelI18n?: Readonly<Record<string, string>>
  readonly icon?: string | null
  readonly colour?: string | null
  readonly needsDetail?: boolean
  readonly active?: boolean
  readonly sortOrder?: number
}

export interface ReasonStore {
  readonly source: ReasonSource
  readonly lists: readonly ReasonList[]
  /** The reasons of these lists (of this source), in tile order. */
  rows(client: Client, lists: readonly ReasonList[], filter?: { readonly activeOnly?: boolean }): Promise<ReasonRow[]>
  /** One reason of the list, or null. */
  row(client: Client, list: ReasonList, id: string): Promise<ReasonRow | null>
  create(tx: Client, list: ReasonList, data: NewReasonRow): Promise<ReasonRow>
  /** A change inside a command whose record guard already checked and bumped the version. */
  update(tx: Client, list: ReasonList, id: string, change: ReasonChange, at: Date): Promise<ReasonRow>
  /** A change of one of many rows: only at the version read (bumped here); null when it moved on. */
  updateAtVersion(tx: Client, list: ReasonList, id: string, version: number, change: ReasonChange, at: Date): Promise<ReasonRow | null>
  /** How many records name each code of the list (codes no record names are absent). */
  usage(client: Client, list: ReasonList): Promise<Map<string, number>>
}

const STORES: Readonly<Record<ReasonSource, ReasonStore>> = { REASON_CODE: reasonCodeStore, SCRAP_REASON: scrapReasonStore }

/** The store that keeps this list. */
export const storeOf = (list: ReasonList): ReasonStore => STORES[sourceOf(list)]

/** The model command()'s record guard locks for one reason of the list. */
export const modelOf = (list: ReasonList): 'ReasonCode' | 'ScrapReason' => (sourceOf(list) === 'SCRAP_REASON' ? 'ScrapReason' : 'ReasonCode')

/** The reasons of many lists, from each source once, in the order of the lists asked. */
export async function rowsOf(client: Client, lists: readonly ReasonList[], filter: { readonly activeOnly?: boolean } = {}): Promise<ReasonRow[]> {
  const rows: ReasonRow[] = []
  for (const store of Object.values(STORES)) {
    const mine = lists.filter((list) => store.lists.includes(list))
    if (mine.length > 0) rows.push(...(await store.rows(client, mine, filter)))
  }
  const place = new Map(lists.map((list, index) => [list, index]))
  return rows.sort((a, b) => (place.get(a.list) ?? 0) - (place.get(b.list) ?? 0) || a.sortOrder - b.sortOrder || a.code.localeCompare(b.code))
}
