import type { FactoryClient } from '@nexus/factory-db'
import { LINK_PURPOSES, PURPOSE_RULES } from '@nexus/factory-domain/links/purposes'
import type { CommandTx } from '../../core/command'

/**
 * Where a link's record comes from (the port between the link mechanism and the modules that own records). A module
 * whose records can be opened by link (sales: Quote, DepositRequest; purchasing: PurchaseOrder; files: StoredFile)
 * registers a source for its record type when its routes load; the office's POST /links reads the record through it,
 * inside its command, to learn the company and the party the link is for, and the address it goes to.
 *
 * Fail closed: a record type no module offers cannot be linked (W0 ships none; the W1 modules bring theirs). A source
 * reads in the office caller's scope, so a record the caller's tenant does not hold is not found.
 */

export interface LinkRecord {
  /** The company the record belongs to. */
  readonly companyId: string
  /** The customer, supplier or subcontractor the record is for: the link's party. */
  readonly partyId: string
  /** The address the link goes to by default (the party's contact on the record), when known. */
  readonly email?: string | null
}

export interface LinkRecordSource {
  /** The record, or null when it does not exist (or is not one a link may open now, e.g. a quote not yet sent). */
  read(client: CommandTx | FactoryClient, recordId: string): Promise<LinkRecord | null>
}

const sources = new Map<string, LinkRecordSource>()
const linkable = new Set(LINK_PURPOSES.flatMap((purpose) => PURPOSE_RULES[purpose].recordTypes))

/**
 * Offers links to a record type. The type must be one a purpose opens (factory-domain links/purposes); registering it
 * twice is a bug. Returns the function that withdraws it (tests).
 */
export function registerLinkRecordSource(recordType: string, source: LinkRecordSource): () => void {
  if (!linkable.has(recordType)) throw new Error(`No link purpose opens a ${recordType} (factory-domain links/purposes).`)
  if (sources.has(recordType)) throw new Error(`A link record source for ${recordType} is registered twice.`)
  sources.set(recordType, source)
  return () => {
    if (sources.get(recordType) === source) sources.delete(recordType)
  }
}

/** The source of a record type, or undefined when no module offers links to it. */
export function linkRecordSource(recordType: string): LinkRecordSource | undefined {
  return sources.get(recordType)
}
