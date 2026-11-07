import type { FactoryClient } from '@nexus/factory-db'
import type { PartnerKind } from '@nexus/factory-domain/auth/partners/kinds'
import type { Grain } from '@nexus/factory-domain/auth/grains/grains'
import type { PartnerSearchGroup } from '@nexus/factory-domain/search/partner/contracts'

/**
 * The partner view of a record type (B-W2b-168; SAL-084, COL-059): what a partner sees of one of its own records — the
 * fields the portal shows and searches, read through the partner's wall. Each indexer of a record a partner may open
 * (./views/<record>.ts beside the indexer of ../indexers/<record>.ts) names here its partner-visible fields:
 *
 *   recordType  the API's model name (`SalesOrder`), as the indexer's and the thread's
 *   group       the portal search group it is found in (orders, documents, returns, jobs, pos); null: never searched
 *               (the account: its thread only)
 *   kinds       the partner kinds whose portal shows it (a supplier never sees a sales order of its party)
 *   grain       a money grain the reader must hold over the record to find it (an invoice: the price grain), even though
 *               no amount is ever shown here
 *   read        the records of these ids that the partner sees, read in the PARTNER scope (factory_partner_runtime: the
 *               party's row-level security, the partner column grants — a hidden column is never selected) and only in
 *               the states the partner knows them in (a quote once sent, a PO once sent, a job once issued, a delivery
 *               once shipped): its references (theirs first, ours second), one line under it, its status code, its
 *               date and the other words the partner may type
 *   lookup      the partner's records whose own references hold the typed text, read the same way (their reference,
 *               their article codes, a tracking number): found even where the office index does not hold them
 *
 * Never money, never a worker, never anything only the office sees (an internal note, who in the office did what).
 * A later portal step adds a record type with its file and one line in ./views.ts (a merge point).
 */

export interface PartnerRecord {
  readonly id: string
  /** The record's company (null: tenant-wide): the session's company must reach it. */
  readonly companyId: string | null
  /** Their own reference, shown first (their PO number, their order reference); null when they gave none. */
  readonly theirRef: string | null
  /** Our number, shown second. */
  readonly ourRef: string | null
  readonly subtitle: string | null
  readonly status: string | null
  readonly date: Date | null
  /** More words the partner sees and may type. */
  readonly words: readonly (string | null | undefined)[]
}

export interface PartnerView {
  readonly recordType: string
  readonly group: PartnerSearchGroup | null
  readonly kinds: readonly PartnerKind[]
  readonly grain?: Grain
  read(client: FactoryClient, ids: readonly string[]): Promise<PartnerRecord[]>
  lookup?(client: FactoryClient, typed: string, take: number): Promise<string[]>
}

export class PartnerViewConfigError extends Error {
  override name = 'PartnerViewConfigError'
}

const RECORD_TYPE = /^[A-Z][A-Za-z0-9]{0,63}$/

/** Declares a partner view; a bad record type or no partner kind throws at once. */
export function definePartnerView(view: PartnerView): PartnerView {
  if (!RECORD_TYPE.test(view.recordType)) throw new PartnerViewConfigError(`Partner view ${JSON.stringify(view.recordType)}: the record type is the API's model name`)
  if (view.kinds.length === 0) throw new PartnerViewConfigError(`Partner view ${view.recordType}: names the partner kinds that see it`)
  return Object.freeze({ ...view, kinds: Object.freeze([...view.kinds]) })
}

/** The ids of rows (a lookup's answer). */
export const idsOf = (rows: readonly { readonly id: string }[]): string[] => rows.map((row) => row.id)

/** Case aside, whole (`number` typed whole) or inside (a reference). */
export const equalsTyped = (typed: string) => ({ equals: typed, mode: 'insensitive' as const })
export const holdsTyped = (typed: string) => ({ contains: typed, mode: 'insensitive' as const })
