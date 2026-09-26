/**
 * P3b S4 (docs/attributes/PLAN.md §10.9) — the business dictionary's version, for cache keys. Since S6 it also covers
 * what the channel footprint and the "used by" marks read (accounts, markets and their mapping rules, cached Amazon
 * schemas), so a connect or a mapping change shows at once too.
 *
 * The column caches (`getSheetColumns`, `getStudioColumns`, `GET /products/sheet/columns`) kept a column set for 5
 * minutes whatever changed in the dictionary, so a new attribute, a placement move or an archive showed up to 5 minutes
 * late. Their keys now carry this stamp: the latest change and the row count of each dictionary table (a delete lowers a
 * count; every other change moves an `updatedAt`). One indexed aggregate per table, in the request's business.
 */
import prisma from '../../db.js'

export async function dictionaryVersion(): Promise<string> {
  const [row] = await prisma.$queryRaw<Array<{ v: string }>>`
    SELECT concat_ws('|',
      (SELECT concat(count(*), ':', coalesce(max("updatedAt")::text, '')) FROM "CustomAttribute"),
      (SELECT concat(count(*), ':', coalesce(max("updatedAt")::text, '')) FROM "FamilyAttribute"),
      (SELECT concat(count(*), ':', coalesce(max("updatedAt")::text, '')) FROM "AttributeOption"),
      (SELECT concat(count(*), ':', coalesce(max("updatedAt")::text, '')) FROM "AttributeGroup"),
      (SELECT concat(count(*), ':', coalesce(max("updatedAt")::text, '')) FROM "ProductFamily"),
      (SELECT concat(count(*), ':', coalesce(max("updatedAt")::text, '')) FROM "ChannelConnection"),
      (SELECT concat(count(*), ':', coalesce(max("updatedAt")::text, '')) FROM "Marketplace"),
      (SELECT concat(count(*), ':', coalesce(max("fetchedAt")::text, '')) FROM "CategorySchema" WHERE channel = 'AMAZON')) AS v`
  return row?.v ?? ''
}
