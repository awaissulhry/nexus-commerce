/**
 * CM-6 — change only some keys of `Campaign.dynamicBidding`, on the row as it is when the write runs.
 *
 * `dynamicBidding` is one JSON column shared by several writers: placement bias (`updatePlacementBidding`, which
 * rank-defend runs every 15 minutes), bid automation / Target ACoS / bid algorithm (`setBidAutomation`), the CPC
 * ceiling (`setCpcCeiling`) and the bid guardrails (`PATCH /campaigns/:id/guardrails`). Each one read the JSON, changed
 * its keys and wrote the WHOLE object back, so whatever another writer saved between that read and that write was
 * put back — a placement save could undo a Target ACoS edit, and the other way round.
 *
 * Here the keys are merged inside the UPDATE: `set` overwrites (or adds) top-level keys, `remove` deletes them, and
 * every other key stays as the row holds it at that moment. A row with no settings yet (or settings that are not an
 * object) starts from `{}`. `columns` (ordinary Campaign columns) are written in the same transaction, with
 * `updatedAt`, as the whole-object update did.
 */
import prisma from '../../db.js'

export async function patchDynamicBidding(
  campaignId: string,
  change: { set?: Record<string, unknown>; remove?: string[] },
  columns: Record<string, unknown> = {},
): Promise<void> {
  const set = change.set ?? {}
  const remove = change.remove ?? []
  await prisma.$transaction(async (tx) => {
    if (Object.keys(set).length > 0 || remove.length > 0) {
      await tx.$executeRaw`UPDATE "Campaign" SET "dynamicBidding" = (CASE WHEN jsonb_typeof("dynamicBidding") = 'object' THEN "dynamicBidding" ELSE '{}'::jsonb END - ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(remove)}::jsonb))) || ${JSON.stringify(set)}::jsonb WHERE id = ${campaignId}`
    }
    await tx.campaign.update({ where: { id: campaignId }, data: { ...columns, updatedAt: new Date() } as never })
  })
}
