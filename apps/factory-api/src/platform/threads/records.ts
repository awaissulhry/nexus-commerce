import type { FactoryClient } from '@nexus/factory-db'
import type { CommandTx } from '../../core/command'

/**
 * Which records have a thread, and whose they are (plan A1 §2.3; COL-001). A thread takes its company, site and party
 * from its RECORD, never from the caller: nobody can file a record's conversation under another company (where its
 * staff would not see it) or share it with another party. Each record type that has a thread names a resolver here,
 * which reads the record in the caller's office scope and answers its scope, or null when there is no such record.
 *
 * A module adds its records in the same change that gives them a thread panel, one line each:
 *   Quote: async (tx, id) => scopeOf(await tx.quote.findUnique({ where: { id }, select: { companyId: true, partyId: true } })),
 * W0 knows the tenancy core's own records. Tests add made-up types with `useThreadRecords`.
 */

export interface RecordScope {
  /** The record's company; null for a tenant-wide record. */
  readonly companyId: string | null
  /** The record's site, when it sits on one. */
  readonly siteId: string | null
  /** The record's customer, supplier or subcontractor: the only party its shared messages may reach. */
  readonly partyId: string | null
}

export type RecordResolver = (client: FactoryClient | CommandTx, recordId: string) => Promise<RecordScope | null>

export const THREAD_RECORDS: Readonly<Record<string, RecordResolver>> = Object.freeze({
  Company: async (client, id) => ((await client.company.findUnique({ where: { id }, select: { id: true } })) ? { companyId: id, siteId: null, partyId: null } : null),
  Site: async (client, id) => {
    const site = await client.site.findUnique({ where: { id }, select: { companyId: true } })
    return site ? { companyId: site.companyId, siteId: id, partyId: null } : null
  },
  // modules/compliance/certificates (SCR-051): the holder company (none: brand-held); the party only when a brand holds
  // it (the brand is the legal maker), not a supplier holding a protector's certificate.
  Certificate: async (client, id) => {
    const certificate = await client.certificate.findUnique({ where: { id }, select: { companyId: true, holderPartyId: true, holderParty: { select: { roles: true } } } })
    if (!certificate) return null
    return { companyId: certificate.companyId, siteId: null, partyId: certificate.holderParty?.roles.includes('BRAND') ? certificate.holderPartyId : null }
  },
  // modules/product/styles (SCR-041): the style's company (none: tenant-wide); the party is the brand a private-label
  // style is made for, so its tech-pack questions can be shared with that brand only.
  Style: async (client, id) => {
    const style = await client.style.findUnique({ where: { id }, select: { companyId: true, brandPartyId: true } })
    return style ? { companyId: style.companyId, siteId: null, partyId: style.brandPartyId } : null
  },
})

let extra: Readonly<Record<string, RecordResolver>> = {}

/** Test only: more record types (a made-up `Quote` with a party). `undefined` removes them again. */
export function useThreadRecords(resolvers: Readonly<Record<string, RecordResolver>> | undefined): void {
  extra = resolvers ?? {}
}

/** The record's scope, or null when its type has no thread or the record does not exist (for this caller). */
export async function resolveRecord(client: FactoryClient | CommandTx, recordType: string, recordId: string): Promise<RecordScope | null> {
  const resolver = Object.hasOwn(THREAD_RECORDS, recordType) ? THREAD_RECORDS[recordType] : Object.hasOwn(extra, recordType) ? extra[recordType] : undefined
  return resolver ? resolver(client, recordId) : null
}
