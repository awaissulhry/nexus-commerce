import { definePartnerView, type PartnerReader, type PartnerRecord } from '../view'

/**
 * A brand's own private-label styles (B-TH-073; threads plan TH-5, PROJ-G16, wall tests T09 and T12; modules/product/styles;
 * the office index's ../../indexers/style.ts, whose entry carries the style's brand as its party since B-TH-030): the brand
 * discusses ONE style in the portal on its thread (platform/threads/partner).
 *
 * Which styles: only those whose private label names the session's party (Style.brandPartyId). A style's thread is shared with
 * that brand alone (records.ts: the thread's party is the style's brandPartyId), so an open-range style — one the party's rounds,
 * order lines or requests merely name — has no conversation a brand could read or write: it is discussed on that round's,
 * order's or request's own thread, never here, and never another brand's private label (T09: brand B finds and opens none of
 * brand A's; T12).
 *
 * How it is read — partner first: factory-db grants the partner role no read of Style (product.json), so the party is first
 * read in the PARTNER scope (the party's own row: its row-level security names the session's party, never a caller's word),
 * then the styles in the TENANT scope through the reader's `inTenant` (../view PartnerReader) (the portal pages' rule, modules/sales/portal-samples:
 * the tenant's rows only for what names the party), kept to `brandPartyId` = that party. Without a reader it opens
 * none (fail closed). Read: our style code, its name, its season and status, the names in other languages as words the brand
 * may type. Never a cost or a price, never the description, the customs data or who changed it.
 */

const STYLE_FIELDS = { id: true, companyId: true, code: true, name: true, nameI18n: true, season: true, status: true, createdAt: true } as const

/** The style's names in other languages (StyleText's mirror on the style), as words the brand may type. */
function otherNames(name: string, names: unknown): string[] {
  if (!names || typeof names !== 'object' || Array.isArray(names)) return []
  return Object.values(names as Record<string, unknown>).filter((value): value is string => typeof value === 'string' && value.trim() !== '' && value.trim() !== name)
}

export default definePartnerView({
  recordType: 'Style',
  group: 'samples',
  kinds: ['CUSTOMER'],
  async read(client, ids, reader?: PartnerReader): Promise<PartnerRecord[]> {
    if (ids.length === 0 || !reader) return []
    // Partner first: the session's own party, as its row-level security names it (one row, or none: nothing opens).
    const own = await client.party.findMany({ select: { id: true }, take: 2 })
    if (own.length !== 1) return []
    const partyId = own[0]!.id
    const rows = await reader.inTenant((tenant) => tenant.style.findMany({ where: { id: { in: [...ids] }, brandPartyId: partyId }, select: STYLE_FIELDS }))
    return rows.map((row) => ({
      id: row.id,
      companyId: row.companyId,
      theirRef: null,
      ourRef: row.code,
      subtitle: row.name,
      status: row.status,
      date: row.createdAt,
      words: [row.season, ...otherNames(row.name, row.nameI18n)],
    }))
  },
})
