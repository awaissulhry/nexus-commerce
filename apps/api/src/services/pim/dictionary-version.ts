/**
 * P3b S4 (docs/attributes/PLAN.md §10.9) — the business dictionary's version, for cache keys.
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
      (SELECT concat(count(*), ':', coalesce(max("updatedAt")::text, '')) FROM "ProductFamily")) AS v`
  return row?.v ?? ''
}
