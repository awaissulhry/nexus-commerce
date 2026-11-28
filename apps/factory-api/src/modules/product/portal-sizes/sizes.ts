import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { FactoryClient } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { PROTECTOR_POCKETS, type ProtectorPocket } from '@nexus/factory-domain/product/protectors/rules'
import { contentWalledFor } from '../../../platform/files/content-wall'
import { systemCallerOf } from '../../../platform/files/files'
import { appClock } from '../../../platform/portal/tasks/clock'
import { portalReader } from '../../sales/portal-orders/access'
import { readCatalogue } from '../../sales/portal-ordering/catalogue'
import { REVISION_COLUMNS, STYLE_COLUMNS } from '../bom/store'
import { mainPictures } from '../images/main-picture'
import { smallAddresses, type PresignFile } from '../images/small-pictures'
import { loadSpec, specViewOf } from '../measures/store'
import type { CatalogueSizesView } from './contract'

/**
 * owb-pd4s s.3 (S4 products; design order-workflow-2026-11-25 § 5q "Customer": "the size table of the range, its own measurement
 * sheets, how to measure, the protectors. Nothing to type"): `GET /portal/catalogue/:styleId/sizes`, the customer's portal session
 * (portal.catalogue.view, its party). Read in the tenant's scope as the person, only for a style this customer's catalogue offers
 * today — the catalogue's OWN check (modules/sales/portal-ordering/catalogue readCatalogue, as GET /portal/catalogue/:styleId and the
 * fibres read use it; never copied): another customer's design, a draft or archived style and an unknown id are one and the same 404.
 *
 *   sizes      the style's range and base size; mode MADE_TO_MEASURE for a made-to-measure style with no range, else SIZES
 *   points     the live measurement spec (DRAFT or APPROVED) of the style's newest RELEASED revision (the catalogue's revisionNow):
 *              each point's code, its name in the person's language, how to measure it, and its value per size in millimetres
 *              (a point typed in centimetres × 10); no revision named → no point. A DRAFT revision's numbers never leave.
 *   protectors that revision's protector placement: each pocket with its highest level, plus the usual zones of the product's kind
 *              (a jacket: shoulders, elbows, back; a suit: shoulders, elbows, back, hips, knees; trousers: hips, knees) at NONE when
 *              nothing is placed there; in the pockets' order. No released revision → none.
 *   picture    the style's main picture past the content wall (platform/files/content-wall: a picture whose content names another
 *              customer never leaves), as its SMALL preview presigned for 60 seconds as the tenant's system after the read (the
 *              partner role holds no store account); none without a small preview.
 * Never a cost, a price, a revision number, a route, a worker, a material or a tolerance.
 */

/** The usual protector zones of a kind of product (design § 5q PROT_ZONES), shown at NONE when nothing is placed there. */
const ZONES_OF: Readonly<Partial<Record<string, readonly ProtectorPocket[]>>> = Object.freeze({
  JACKET: ['SHOULDER', 'ELBOW', 'BACK'],
  SUIT: ['SHOULDER', 'ELBOW', 'BACK', 'HIP', 'KNEE'],
  TROUSERS: ['HIP', 'KNEE'],
})

export interface PortalSizesInput {
  readonly companyId: string
  readonly partyId: string
  readonly day: BusinessDate
  readonly styleId: string
  /** The person's language (it, en …); a point's name in it when the library has one. */
  readonly locale: string | null
}

/** The answer without its picture's address, and the picture's file to presign (null: none). */
export interface PortalSizesRead {
  readonly answer: Omit<CatalogueSizesView, 'picture'>
  readonly pictureFile: PresignFile | null
}

/** A spec value in millimetres: centimetres × 10, to two places; null when not a number. */
export function millimetres(nominal: string, uom: string): number | null {
  const value = Number(nominal)
  if (!Number.isFinite(value)) return null
  return Math.round((uom === 'CM' ? value * 10 : value) * 100) / 100
}

/** Each placed pocket with its highest level, and the usual zones of the kind at NONE; in the pockets' order. */
export function protectorZones(productType: string, placements: readonly { readonly pocket: string; readonly level: string }[]): CatalogueSizesView['protectors'] {
  const highest = new Map<string, string>()
  for (const placement of placements) if ((highest.get(placement.pocket) ?? '') < placement.level) highest.set(placement.pocket, placement.level)
  const usual = ZONES_OF[productType] ?? []
  return PROTECTOR_POCKETS.filter((pocket) => usual.includes(pocket) || highest.has(pocket)).map((zone): CatalogueSizesView['protectors'][number] => {
    const level = highest.get(zone)
    return { zone, level: level === '2' ? 'LEVEL_2' : level === '1' ? 'LEVEL_1' : 'NONE' }
  })
}

/** The style's main picture, as the presign needs it, when this customer may see it (the content wall); else null. */
async function pictureFileOf(db: FactoryClient, partyId: string, styleId: string): Promise<PresignFile | null> {
  const main = (await mainPictures(db, [styleId])).get(styleId)
  if (!main) return null
  const file = await db.storedFile.findUnique({ where: { id: main.fileId }, select: { id: true, contentType: true, originalName: true, storeAccountId: true, thumbnailKey: true } })
  if (!file) return null
  const walled = await contentWalledFor(db, partyId, [file.id])
  return walled.has(file.id) ? null : file
}

/** The Sizes of one style for one customer on a day; null when its catalogue does not offer the style (the route's 404). */
export async function portalSizesFor(db: FactoryClient, input: PortalSizesInput): Promise<PortalSizesRead | null> {
  const catalogue = await readCatalogue(db, { companyId: input.companyId, partyId: input.partyId, day: input.day, styleIds: [input.styleId] })
  const offered = catalogue.styles.get(input.styleId)
  if (!offered) return null
  const style = await db.style.findUnique({ where: { id: input.styleId }, select: { ...STYLE_COLUMNS, productType: true, mtmAllowed: true } })
  if (!style) return null
  const pictureFile = await pictureFileOf(db, input.partyId, style.id)
  const base = { mode: style.mtmAllowed && style.sizes.length === 0 ? ('MADE_TO_MEASURE' as const) : ('SIZES' as const), sizes: [...style.sizes], baseSize: style.baseSize }
  const revision = offered.revisionNow === null ? null : await db.styleRevision.findFirst({ where: { styleId: style.id, revision: offered.revisionNow, status: 'RELEASED' }, select: REVISION_COLUMNS })
  if (!revision) return { answer: { ...base, points: [], protectors: [] }, pictureFile }

  const spec = specViewOf(await loadSpec(db, style, revision))
  const language = (input.locale ?? '').slice(0, 2).toLowerCase()
  const points = spec.spec === null
    ? []
    : spec.points.map((point) => ({
        code: point.code,
        name: (language ? point.nameI18n?.[language] : undefined) ?? point.name,
        howTo: point.howTo?.trim() ? point.howTo : null,
        values: Object.fromEntries(point.cells.map((cell) => [cell.size, cell.value ? millimetres(cell.value.nominal, point.uom) : null])),
      }))
  const placements = await db.protectorPlacement.findMany({ where: { revisionId: revision.id }, select: { pocket: true, level: true }, orderBy: { seq: 'asc' } })
  return { answer: { ...base, points, protectors: protectorZones(style.productType, placements) }, pictureFile }
}

/** GET /portal/catalogue/:styleId/sizes (the customer's portal session; read as the person). */
export async function catalogueSizes(app: FastifyInstance, request: FastifyRequest, styleId: string): Promise<CatalogueSizesView> {
  const reader = portalReader(app, request)
  if (!isUuid(styleId)) throw new NotFoundError('Style not found.')
  const day = businessDate(appClock(app).now())
  const read = await reader.inTenant((db) => portalSizesFor(db, { companyId: reader.session.company.id, partyId: reader.session.partyId, day, styleId, locale: reader.session.person.locale }))
  // Not in the customer's catalogue: the same answer as a style that does not exist.
  if (!read) throw new NotFoundError('Style not found.')
  // The store is called after the read, as the tenant's system (the partner role holds no store account).
  const file = read.pictureFile
  const address = file ? (await smallAddresses(systemCallerOf(request)(reader.session.tenantId), [file])).get(file.id) : undefined
  return { ...read.answer, picture: file && address ? { fileId: file.id, url: address.url } : null }
}
