import { isMeasurementSheet } from '@nexus/factory-domain/files/measurements'
import type { CommandTools } from '../../../core/command'
import type { Reader } from './log'

/**
 * The order's picture on the floor (owb- order workflow, b3.2; research R-base C: "floor files are read only when stamped with
 * the device's site", StoredFile.floorSiteId — the floor role's policy key; precedent: modules/sales/quote-proofs/freeze.ts,
 * which changes a file's sharing inside the command that needs it). Two hooks, no route:
 *
 *   floorOrderPicture(db, { salesOrderId, siteId })   S5's basket read calls it: the order's chosen picture ONLY when that file
 *                                                     is shared with the floor of the device's site (visibility FLOOR,
 *                                                     floorSiteId = the site), AVAILABLE, and never a priced file, body data
 *                                                     (a measurement sheet, a body or fitting photo), a voice note or a fiscal
 *                                                     archive; else null (the card shows no picture — never the office's file)
 *   stampOrderPictureForFloor(tools, { salesOrderId, siteId })
 *                                                     S3's "Print and start the work" calls it in its command: shares the
 *                                                     chosen picture with that site's floor (visibility + FLOOR, floorSiteId),
 *                                                     once, with an audit row; a file already on another site's floor, or one
 *                                                     that may never reach a floor, is left as it is (null)
 * The office's own picture reads stay ./picture-set and product/images/small-pictures.
 */

/** Body data and money never reach a floor. */
const NEVER_ON_THE_FLOOR_CATEGORIES: readonly string[] = ['MEASUREMENTS', 'BODY_PHOTO', 'MTM_PHOTO', 'FITTING_PHOTO']
const NEVER_ON_THE_FLOOR_KINDS: readonly string[] = ['FISCAL_ARCHIVE', 'AUDIO']

interface PictureFile {
  readonly id: string
  readonly contentType: string
  readonly status: string
  readonly kind: string
  readonly category: string | null
  readonly priced: boolean
  readonly visibility: readonly string[]
  readonly floorSiteId: string | null
}

const mayReachFloor = (file: PictureFile): boolean =>
  file.status === 'AVAILABLE' && !file.priced && !NEVER_ON_THE_FLOOR_KINDS.includes(file.kind) && !(file.category !== null && NEVER_ON_THE_FLOOR_CATEGORIES.includes(file.category)) && !isMeasurementSheet(file)

const PICTURE_FILE = { id: true, contentType: true, status: true, kind: true, category: true, priced: true, visibility: true, floorSiteId: true } as const

/** The order's chosen picture as the floor of `siteId` may see it, or null (see the file's head). */
export async function floorOrderPicture(db: Reader, input: { readonly salesOrderId: string; readonly siteId: string }): Promise<{ readonly fileId: string; readonly contentType: string } | null> {
  const order = await db.salesOrder.findUnique({ where: { id: input.salesOrderId }, select: { pictureFileId: true } })
  if (!order?.pictureFileId) return null
  const file = await db.storedFile.findUnique({ where: { id: order.pictureFileId }, select: PICTURE_FILE })
  if (!file || !mayReachFloor(file) || !file.visibility.includes('FLOOR') || file.floorSiteId !== input.siteId) return null
  return { fileId: file.id, contentType: file.contentType }
}

/** Shares the order's chosen picture with the floor of `siteId`, inside the caller's command (see the file's head). */
export async function stampOrderPictureForFloor(tools: Pick<CommandTools, 'tx' | 'audit'>, input: { readonly salesOrderId: string; readonly siteId: string; readonly reason: string }): Promise<string | null> {
  const order = await tools.tx.salesOrder.findUnique({ where: { id: input.salesOrderId }, select: { pictureFileId: true, companyId: true } })
  if (!order?.pictureFileId) return null
  const file = await tools.tx.storedFile.findUnique({ where: { id: order.pictureFileId }, select: { ...PICTURE_FILE, companyId: true } })
  if (!file || !mayReachFloor(file)) return null
  if (file.visibility.includes('FLOOR')) return file.floorSiteId === input.siteId ? file.id : null
  const visibility = [...file.visibility, 'FLOOR' as const]
  await tools.tx.storedFile.update({ where: { id: file.id }, data: { visibility, floorSiteId: input.siteId, version: { increment: 1 } }, select: { id: true } })
  tools.audit({ action: 'files.setVisibility', recordType: 'StoredFile', recordId: file.id, companyId: file.companyId ?? order.companyId, before: { visibility: file.visibility, floorSiteId: null }, after: { visibility, floorSiteId: input.siteId }, reason: input.reason })
  return file.id
}
