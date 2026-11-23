import type { Prisma } from '@nexus/factory-db'
import { z } from 'zod'
import { id, instant, output } from '@nexus/factory-domain/core/contracts'
import { ForbiddenError, UnauthenticatedError, ValidationError } from '@nexus/factory-domain/core/errors'
import { holds, scopeWhere, type Actor } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { SALES_INQUIRIES_VIEW } from '@nexus/factory-domain/sales/inquiries/permissions'
import { ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import { QUOTES_VIEW } from '@nexus/factory-domain/sales/quotes/permissions'
// B-SA-074: the work orders' pictures, walled as the work-order list (a mixed one only for every-customer people).
import { WORKORDERS_VIEW } from '@nexus/factory-domain/production/work-orders/permissions'
import { workOrderWhere } from '../../production/work-orders/scope'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { processFiles } from '../../../platform/files/service'
import { hasSmallPreview, smallPreviewAddress } from '../../../platform/files/thumbs/small'
import { mainPictureThumbnails } from './main-picture'
import type { Client } from './store'
// B-SA-035: the order read's line pictures (the colourway's, else the style's main picture).
import { FILES_READ } from '@nexus/factory-domain/auth/permissions/catalogue'
import { isPictureType } from '@nexus/factory-domain/product/images/rules'
// B-SA-046d: the portal's own read of its lines' pictures goes through the content wall.
import { contentWalledFor } from '../../../platform/files/content-wall'

/**
 * B-SA-011 (sales page plan N8, picks P13, P18, R9; 12-lists-board §2.5; review C-12, BW-8): the small pictures of a page of
 * records in ONE read — POST /sales/orders/pictures, /sales/quotes/pictures and /sales/inquiries/pictures ({ids 1–200, each
 * once}), all through this one helper and one answer shape. The web's one picture part (factory-web lib/record-picture) asks it
 * for every row a list, a board or a week board draws, so a page of 50 rows is one call (it was up to 50, one per row).
 *
 *   which records  only those the reader may see — the record's own view permission over its company and customer, in ONE
 *                  query (orders.view, quotes.view, sales.inquiries.view; a request of a prospect has no customer): an id the
 *                  reader may not see, an unknown one, or a record with no style yet is simply absent — no 404 per id, no
 *                  count, nothing that says it exists.
 *   which picture  the record's first style (an order's first line, a quote's current version's first line, a request's first
 *                  line that names a style): that style's main picture (./main-picture.ts), its file only with files.read
 *                  over the file's company (no right, or no main picture: `fileId` null — the part draws its placeholder);
 *                  `styleCount` the record's distinct styles ("+2"); the style's code and name (the week board's cards hold
 *                  no picture field of their own).
 *   which address  the SMALL preview (~320 px, made with the stripped copy: no EXIF, no position — platform/files/thumbs/
 *                  small.ts), never the original: ONE presign per DISTINCT file (ten orders of one style share one address and
 *                  one gateway ledger row), at most 8 at a time, after the database read (the store is never called inside
 *                  it); `small` null until the preview exists. The addresses live 60 seconds (the part caches them by file id).
 *
 * Brand wall (BW-8): an office read only (the portal has its own walled reads). A private-label style belongs to one customer
 * (Style.brandPartyId) and only that customer's orders may hold it (sales line-checks private-label), so a person limited to
 * customer A gets the picture of A's own style on A's records and nothing of another customer's.
 */

/**
 * The record kinds a picture is read for (the web part's `source`; B-SA-074: and a work order, POST /production/work-orders/pictures;
 * B-CQ-030: and a customer's portal order, POST /sales/order-requests/pictures).
 */
export type PictureSource = 'order' | 'quote' | 'request' | 'workorder' | 'portalOrder'

/** The most ids one read takes (a page of a list; the POST /threads/unread precedent). */
export const PICTURES_MAX = 200
/** The most presigns at once. */
const PRESIGN_AT_ONCE = 8

/** The ids of one batch route's body (1–200; each id once — said in words by the handler). */
export const pictureIds = () => z.array(id()).min(1).max(PICTURES_MAX)

/** The ONE answer shape of the three routes. */
export const smallPicturesView = output({
  pictures: z.array(
    output({
      /** The record's id (an order, a quote, a request; B-SA-074: a work order). */
      id: id(),
      styleId: id(),
      styleCode: z.string(),
      styleName: z.string(),
      /** The record's distinct styles ("+2" beside the picture). */
      styleCount: z.number().int(),
      /** The main picture's file, only with files.read over its company; null: the placeholder. */
      fileId: id().nullable(),
      contentType: z.string().nullable(),
      /** A presigned GET of the ~320 px preview (60 seconds); null until it exists, or without a file. */
      small: output({ url: z.string(), expiresAt: instant() }).nullable(),
    }),
  ),
  asOf: instant(),
})

export interface SmallPicture {
  readonly id: string
  readonly styleId: string
  readonly styleCode: string
  readonly styleName: string
  readonly styleCount: number
  readonly fileId: string | null
  readonly contentType: string | null
  readonly small: { readonly url: string; readonly expiresAt: string } | null
}

/** A record the reader may see, with its lines' styles in their order (the first is the picture's). */
interface RecordStyles {
  readonly id: string
  readonly styleIds: readonly string[]
}

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)]

/** The lines' styles per record, in line order, as read (one row per line). */
function stylesPerRecord(ids: readonly string[], lines: readonly { readonly recordId: string; readonly styleId: string | null }[]): RecordStyles[] {
  const of = new Map<string, string[]>(ids.map((recordId) => [recordId, []]))
  for (const line of lines) if (line.styleId) of.get(line.recordId)?.push(line.styleId)
  return ids.map((recordId) => ({ id: recordId, styleIds: of.get(recordId) ?? [] }))
}

/** Each source's records the reader may see, among the asked ids, with their styles (one query for the records, one for the lines). */
const READS: Readonly<Record<PictureSource, (client: Client, actor: Actor, ids: readonly string[]) => Promise<RecordStyles[]>>> = Object.freeze({
  async order(client, actor, ids) {
    const seen = await client.salesOrder.findMany({ where: { AND: [scopeWhere(actor, ORDERS_VIEW, { company: 'companyId', party: 'partyId' }) as Prisma.SalesOrderWhereInput, { id: { in: [...ids] } }] }, select: { id: true } })
    const visible = seen.map((row) => row.id)
    const lines = visible.length > 0 ? await client.salesOrderLine.findMany({ where: { orderId: { in: visible } }, select: { orderId: true, styleId: true }, orderBy: [{ orderId: 'asc' }, { seq: 'asc' }] }) : []
    return stylesPerRecord(visible, lines.map((line) => ({ recordId: line.orderId, styleId: line.styleId })))
  },
  async quote(client, actor, ids) {
    const seen = await client.quote.findMany({ where: { AND: [scopeWhere(actor, QUOTES_VIEW, { company: 'companyId', party: 'partyId' }) as Prisma.QuoteWhereInput, { id: { in: [...ids] } }] }, select: { id: true, currentRevision: true } })
    if (seen.length === 0) return []
    // The current version of each (the list's row is its current version: quotes/row-picture.ts).
    const versions = await client.quoteVersion.findMany({ where: { OR: seen.map((quote) => ({ quoteId: quote.id, revision: quote.currentRevision })) }, select: { id: true, quoteId: true } })
    const quoteOf = new Map(versions.map((version) => [version.id, version.quoteId]))
    const lines = versions.length > 0 ? await client.quoteLine.findMany({ where: { versionId: { in: versions.map((version) => version.id) } }, select: { versionId: true, styleId: true }, orderBy: [{ versionId: 'asc' }, { seq: 'asc' }] }) : []
    return stylesPerRecord(
      seen.map((quote) => quote.id),
      lines.map((line) => ({ recordId: quoteOf.get(line.versionId)!, styleId: line.styleId })),
    )
  },
  async request(client, actor, ids) {
    // A request of a prospect has no customer yet (as the inquiries' list reads it: inquiries/inquiries.ts baseWhere).
    const seen = await client.inquiry.findMany({ where: { AND: [scopeWhere(actor, SALES_INQUIRIES_VIEW, { company: 'companyId', party: { field: 'partyId', nullable: true } }) as Prisma.InquiryWhereInput, { id: { in: [...ids] } }] }, select: { id: true } })
    const visible = seen.map((row) => row.id)
    const lines = visible.length > 0 ? await client.inquiryLine.findMany({ where: { inquiryId: { in: visible }, styleId: { not: null } }, select: { inquiryId: true, styleId: true }, orderBy: [{ inquiryId: 'asc' }, { seq: 'asc' }] }) : []
    return stylesPerRecord(visible, lines.map((line) => ({ recordId: line.inquiryId, styleId: line.styleId })))
  },
  // ── B-SA-074 (sales page plan N7, N8, R9; review OW-4 "consistent across the whole factory"; the production lane's yes) ──────
  // A work order makes ONE style: its picture is that style's main picture (styleCount 1). Walled exactly as the work-order list
  // (production/work-orders/scope workOrderWhere, workorders.view over its company, site and one customer): another customer's
  // work order, and a mixed one made before the one-customer rule (or a sample of no customer) for anyone who does not reach every
  // customer, is simply absent — as an unknown id. Office only (no floor or TV screen ever draws a customer's design).
  async workorder(client, actor, ids) {
    const seen = await client.workOrder.findMany({ where: { AND: [workOrderWhere(actor, WORKORDERS_VIEW), { id: { in: [...ids] } }] }, select: { id: true, styleId: true } })
    return seen.map((row) => ({ id: row.id, styleIds: [row.styleId] }))
  },
  // ── end B-SA-074
  // ── B-CQ-030 (customer page › Quotes & incoming, L12, Q3; 13-backend §5): a customer's portal order — sent, decided OR still a draft
  // (the drafts section draws it too) — walled exactly as the drafts read and Incoming (orders.view over its company and customer): its
  // first line that names a style (a described or made-to-measure line names none: skipped; none left: no picture, the placeholder).
  async portalOrder(client, actor, ids) {
    const seen = await client.portalOrderRequest.findMany({ where: { AND: [scopeWhere(actor, ORDERS_VIEW, { company: 'companyId', party: 'partyId' }) as Prisma.PortalOrderRequestWhereInput, { id: { in: [...ids] } }] }, select: { id: true } })
    const visible = seen.map((row) => row.id)
    const lines = visible.length > 0 ? await client.portalOrderRequestLine.findMany({ where: { requestId: { in: visible }, styleId: { not: null } }, select: { requestId: true, styleId: true }, orderBy: [{ requestId: 'asc' }, { seq: 'asc' }] }) : []
    return stylesPerRecord(visible, lines.map((line) => ({ recordId: line.requestId, styleId: line.styleId })))
  },
  // ── end B-CQ-030
})

/** The office reader (the routes are office only; a portal, floor or link session never reads these). */
function officeActorOf(caller: CommandCaller): Actor {
  const context = caller.factoryContext
  if (!context) throw new UnauthenticatedError()
  if (context.audience !== 'office') throw new ForbiddenError()
  return actorOf(context)
}

/** POST /sales/{orders,quotes,inquiries,order-requests}/pictures: the small pictures of the asked records the reader may see (see the file's head). */
export async function recordPictures(caller: CommandCaller, source: PictureSource, ids: readonly string[]): Promise<{ pictures: SmallPicture[]; asOf: string }> {
  const actor = officeActorOf(caller)
  if (new Set(ids).size !== ids.length) throw new ValidationError('Each id once: the same record was asked twice.', [{ path: 'body', message: 'Each id once.' }])
  type StoreFile = { readonly id: string; readonly contentType: string; readonly originalName: string; readonly storeAccountId: string; readonly thumbnailKey: string | null }
  const found = await caller.withClient(async (client) => {
    const records = (await READS[source](client, actor, ids)).filter((record) => record.styleIds.length > 0)
    const firstStyles = unique(records.map((record) => record.styleIds[0]!))
    const styles = new Map<string, { readonly code: string; readonly name: string }>()
    const files = new Map<string, StoreFile>()
    if (firstStyles.length === 0) return { records, styles, thumbnails: new Map<string, { readonly fileId: string; readonly contentType: string }>(), files }
    for (const style of await client.style.findMany({ where: { id: { in: firstStyles } }, select: { id: true, code: true, name: true } })) styles.set(style.id, style)
    const thumbnails = await mainPictureThumbnails(client, actor, firstStyles)
    const fileIds = unique([...thumbnails.values()].map((thumbnail) => thumbnail.fileId))
    if (fileIds.length > 0) for (const file of await client.storedFile.findMany({ where: { id: { in: fileIds } }, select: { id: true, contentType: true, originalName: true, storeAccountId: true, thumbnailKey: true } })) files.set(file.id, file)
    return { records, styles, thumbnails, files }
  })

  // The store is called outside the read (smallAddresses: one presign per distinct file with a small preview, a few at a time).
  const addresses = await smallAddresses(caller, [...found.files.values()])

  const pictures: SmallPicture[] = []
  for (const record of found.records) {
    const styleId = record.styleIds[0]!
    const style = found.styles.get(styleId)
    if (!style) continue
    const thumbnail = found.thumbnails.get(styleId)
    pictures.push({
      id: record.id,
      styleId,
      styleCode: style.code,
      styleName: style.name,
      styleCount: unique(record.styleIds).length,
      fileId: thumbnail?.fileId ?? null,
      contentType: thumbnail?.contentType ?? null,
      small: thumbnail ? (addresses.get(thumbnail.fileId) ?? null) : null,
    })
  }
  // In the asked order (the page's).
  const rank = new Map(ids.map((value, index) => [value, index]))
  pictures.sort((a, b) => rank.get(a.id)! - rank.get(b.id)!)
  return { pictures, asOf: toUtcIso(serverClock.now()) }
}

// ── B-SA-035 (sales page plan N2, N8, picks P2, P13; 10-order-page §2.1 O2, §2.2 L3, §3 F2) ─────────────────────────────────────
/** A stored file as the presign needs it. */
export interface PresignFile {
  readonly id: string
  readonly contentType: string
  readonly originalName: string
  readonly storeAccountId: string
  readonly thumbnailKey: string | null
}

/**
 * The small preview's address of each file that has one: ONE presign per DISTINCT file, at most 8 at a time (each writes its own
 * gateway ledger row). Called after the database read, never inside it (the batch routes and the order read share it).
 */
export async function smallAddresses(caller: CommandCaller, files: readonly PresignFile[]): Promise<Map<string, { url: string; expiresAt: string }>> {
  const wanted = [...new Map(files.filter((file) => hasSmallPreview(file)).map((file) => [file.id, file])).values()]
  const addresses = new Map<string, { url: string; expiresAt: string }>()
  for (let at = 0; at < wanted.length; at += PRESIGN_AT_ONCE) {
    const part = wanted.slice(at, at + PRESIGN_AT_ONCE)
    const made = await Promise.all(part.map((file) => smallPreviewAddress(processFiles(), caller, { storeAccountId: file.storeAccountId, thumbnailKey: file.thumbnailKey!, contentType: file.contentType, originalName: file.originalName })))
    part.forEach((file, index) => addresses.set(file.id, { url: made[index]!.url, expiresAt: made[index]!.expiresAt }))
  }
  return addresses
}

/** The key of one colour line's picture (a style × colourway). */
export const linePictureKey = (line: { readonly styleId: string; readonly colourwayId: string }): string => `${line.styleId}:${line.colourwayId}`

/** One colour line's picture: its file as the presign needs it (no address yet). */
export interface LinePictureFile extends PresignFile {
  readonly styleId: string
  readonly colourwayId: string
}

/**
 * The picture of each colour line of an order (style × colourway): the colourway's own picture (StyleImage.colourwayId — its
 * main one first, then by its place in the gallery), else the style's main picture (./main-picture.ts) — an AVAILABLE file a
 * browser shows (JPEG, PNG, WebP). Its file only for a reader holding files.read over the file's company (the list's thumbnail
 * rule, mainPictureThumbnails): without it, or without any picture, the line is absent (the part draws its placeholder). Keyed by
 * linePictureKey. A style an order holds is the customer's own (private label) or of our own collection (sales line checks).
 */
export async function linePictureFiles(client: Client, actor: Actor, lines: readonly { readonly styleId: string; readonly colourwayId: string }[]): Promise<Map<string, LinePictureFile>> {
  if (lines.length === 0 || !holds(actor, FILES_READ)) return new Map<string, LinePictureFile>()
  // The files the reader may open: AVAILABLE pictures over a company it reads files of (a shared style's file: no company).
  return pictureFilesOf(client, lines, async (fileIds) =>
    client.storedFile.findMany({
      where: { AND: [scopeWhere(actor, FILES_READ, { company: { field: 'companyId', nullable: true } }) as Prisma.StoredFileWhereInput, { id: { in: [...fileIds] }, status: 'AVAILABLE' }] },
      select: { id: true, contentType: true, originalName: true, storeAccountId: true, thumbnailKey: true },
    }),
  )
}

/** The pictures of colour lines, the files read by `filesOf` (who may open which): the colourway's own first, else the style's main. */
async function pictureFilesOf(client: Client, lines: readonly { readonly styleId: string; readonly colourwayId: string }[], filesOf: (fileIds: readonly string[]) => Promise<PresignFile[]>): Promise<Map<string, LinePictureFile>> {
  const out = new Map<string, LinePictureFile>()
  if (lines.length === 0) return out
  const styleIds = unique(lines.map((line) => line.styleId))
  const colourwayIds = unique(lines.map((line) => line.colourwayId))
  const own = await client.styleImage.findMany({
    where: { styleId: { in: styleIds }, colourwayId: { in: colourwayIds } },
    select: { styleId: true, colourwayId: true, fileId: true },
    orderBy: [{ isMain: 'desc' }, { seq: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
  })
  const mains = await client.styleImage.findMany({ where: { styleId: { in: styleIds }, isMain: true }, select: { styleId: true, fileId: true } })
  const fileIds = unique([...own.map((row) => row.fileId), ...mains.map((row) => row.fileId)])
  if (fileIds.length === 0) return out
  const files = await filesOf(fileIds)
  const byId = new Map(files.filter((file) => isPictureType(file.contentType)).map((file) => [file.id, file]))
  for (const line of lines) {
    const key = linePictureKey(line)
    if (out.has(key)) continue
    const colour = own.find((row) => row.styleId === line.styleId && row.colourwayId === line.colourwayId && byId.has(row.fileId))
    const main = mains.find((row) => row.styleId === line.styleId && byId.has(row.fileId))
    const file = byId.get((colour ?? main)?.fileId ?? '')
    if (file) out.set(key, { ...file, styleId: line.styleId, colourwayId: line.colourwayId })
  }
  return out
}
// ── end B-SA-035 ──

// ── B-SA-046d (sales page plan R6; 14-change-flow §2.4 "which lines (with picture)"): the portal's OWN walled read of its lines' pictures ─
/**
 * The picture of each colour line of a customer's OWN order, for the portal (never an office route: BW-8). Read in the tenant's
 * scope after the partner read found the order (the caller's job), with the office's choice of picture (the colourway's own,
 * else the style's main) and three walls of its own:
 *
 *   the style    only a style of this customer's own label or of our own collection (an order holds no other: sales line checks;
 *                held here too) — a line of any other style has no picture
 *   the content  the content wall (platform/files/content-wall contentWalledFor, the one rule of every portal read of files): a
 *                picture whose content, or its source's, names another customer is left out, uncounted
 *   the bytes    only the SMALL preview's address leaves (~320 px, the stripped copy: no EXIF, no position), presigned by the caller
 *                with smallAddresses as the tenant's system; never the original, never an id the portal could open
 */
export async function portalLinePictureFiles(client: Client, partyId: string, lines: readonly { readonly styleId: string; readonly colourwayId: string }[]): Promise<Map<string, LinePictureFile>> {
  if (lines.length === 0) return new Map<string, LinePictureFile>()
  const styleIds = unique(lines.map((line) => line.styleId))
  const allowed = new Set((await client.style.findMany({ where: { id: { in: styleIds }, OR: [{ brandPartyId: null }, { brandPartyId: partyId }] }, select: { id: true } })).map((row) => row.id))
  const own = lines.filter((line) => allowed.has(line.styleId))
  return pictureFilesOf(client, own, async (fileIds) => {
    const files = await client.storedFile.findMany({ where: { id: { in: [...fileIds] }, status: 'AVAILABLE' }, select: { id: true, contentType: true, originalName: true, storeAccountId: true, thumbnailKey: true } })
    const walled = files.length > 0 ? await contentWalledFor(client, partyId, files.map((file) => file.id)) : new Set<string>()
    return files.filter((file) => !walled.has(file.id))
  })
}
// ── end B-SA-046d ──
