import type { CutRefusal } from '@nexus/factory-domain/production/cutting/rules'
import type { CommandTx } from '../../../core/command'
import { cuttingRulesFor } from '../settings/cutting-rules'

/**
 * The photo of the hide before cutting, where the site asks it (B-W2b-219; MES-060; design floor.hidecut "Photo of the hide":
 * "optional per site"; ProductionSettings.hidePhotoRequired, B-W2b-204's column, set on the Cutting card of Floor rules &
 * codes). The hide check (GET …/cutting/hides answer, `checks.photo.required`) says so, and a cut of the hide's pieces is
 * refused in words (PHOTO_REQUIRED) until a photo of the hide taken at the table goes with it (`photoFileId`, uploaded first:
 * ./photos.ts). Once a live entry of the hide names its photo, the hide's later entries need none (it was on the table).
 * The floor reads the column of its own site's row.
 */

/** Does the site ask a photo of the hide before cutting (no floor rules: no)? */
export async function hidePhotoRequiredFor(db: Pick<CommandTx, 'productionSettings'>, siteId: string): Promise<boolean> {
  return (await cuttingRulesFor(db, siteId)).rules.hidePhotoRequired
}

/** Was the hide photographed on the table already (a live entry, not reversed, names a photo)? */
export async function hidePhotographed(db: Pick<CommandTx, 'cutLog'>, hideId: string): Promise<boolean> {
  const entry = await db.cutLog.findFirst({ where: { hideId, photoFileId: { not: null }, reversalOfId: null, reversals: { none: {} } }, select: { id: true } })
  return entry !== null
}

/** What the hide check says of the photo: asked by the site and not taken yet for this hide. */
export async function photoCheck(db: Pick<CommandTx, 'productionSettings' | 'cutLog'>, siteId: string, hideId: string): Promise<{ readonly required: boolean }> {
  if (!(await hidePhotoRequiredFor(db, siteId))) return { required: false }
  return { required: !(await hidePhotographed(db, hideId)) }
}

/** A cut of pieces without the photo the site asks: refused in words (else null). */
export async function photoRefusal(db: Pick<CommandTx, 'productionSettings' | 'cutLog'>, facts: { readonly siteId: string; readonly hideId: string; readonly hideCode: string; readonly photoFileId: string | null | undefined }): Promise<CutRefusal | null> {
  if (facts.photoFileId) return null
  if (!(await photoCheck(db, facts.siteId, facts.hideId)).required) return null
  return { code: 'PHOTO_REQUIRED', message: `This site asks a photo of hide ${facts.hideCode} on the table before it is cut: take the photo, then cut.` }
}
