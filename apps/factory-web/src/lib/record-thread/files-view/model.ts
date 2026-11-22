import type { FileAudience, FileKind } from '../../../record-panels/model'
import { fileSeries, recordFiles, type FileOrigin, type FileSeries, type FilesParty, type ThreadFile } from '../files/model'
import { namedSeries, pricedLockedOf } from '../files/model' // F-CP-144
import { isPicture } from '@nexus/factory-domain/files/thumbs/strip' // F-OP-125: the previews route's own picture rule
import type { ViewerFile } from '../popups/model' // F-OP-127

/**
 * B-TH-299 — the Files view (threads plan T9; features T9-F01…F06, F09, F10, F13): every file of ONE record (its POST /files
 * files) in a centred window up to 1160 px (a full-screen sheet on a phone): groups, versions, real multi-select with a
 * counted bulk bar, the upload with the system's kinds and an audience, retention, legal hold and quarantine read-only,
 * "Missing before Shipped" from the required-document rule. Tabs that do work or use their own file API keep their files
 * (R-1 to R-4): only the record's own files come here. The pure part; no React, no API.
 *
 * Not drawn until the back end has it: groups by origin (From the customer · Ours · Made by us · Floor) wait for the
 * file's origin (WALL-G13, B-TH-029) — until then the files group by the system's kinds; "Use on the quote / order /
 * style" (N8, B-TH-024); mark-up and expiry stay on the record's Files tab. B-TH-283 (N11, B-TH-083): the upload asks "This is a
 * measurement sheet" (a PDF or a photo; never for the floor); a sheet is locked for who may not open it, and marked for who may.
 *
 * Brand wall (W13, W25, W26): "Share with <customer>" shares with THIS record's party only (B-TH-003 refuses any other);
 * the Customer mark shows only on files shared with this party; another record's file is never listed.
 */

/** A group of the window: by origin when every file says where it came from, else by the system's kind. */
export type GroupKey = { readonly by: 'origin'; readonly origin: FileOrigin } | { readonly by: 'kind'; readonly kind: FileKind }

export interface FilesGroup {
  readonly key: string
  readonly group: GroupKey
  readonly series: readonly FileSeries[]
}

const ORIGINS: readonly FileOrigin[] = ['party', 'ours', 'made', 'floor']
const KINDS: readonly FileKind[] = ['PHOTO', 'DOCUMENT', 'CERTIFICATE', 'ATTACHMENT', 'AUDIO', 'FISCAL_ARCHIVE']

/** The record's documents in groups: by origin once the API says it for every file (WALL-G13), else by kind; empty groups hidden. */
export function filesGroups(files: readonly ThreadFile[], record: { readonly type: string; readonly id: string }): FilesGroup[] {
  // F-CP-144: a priced document locked for this reader is in no group (never named, never chosen): ONE counted line says it.
  const series = namedSeries(fileSeries(recordFiles(files, record)))
  const byOrigin = series.length > 0 && series.every((one) => one.latest.origin)
  if (byOrigin) {
    return ORIGINS.map((origin) => ({ key: `origin:${origin}`, group: { by: 'origin' as const, origin }, series: series.filter((one) => one.latest.origin === origin) })).filter((group) => group.series.length > 0)
  }
  return KINDS.map((kind) => ({ key: `kind:${kind}`, group: { by: 'kind' as const, kind }, series: series.filter((one) => one.latest.kind === kind) })).filter((group) => group.series.length > 0)
}

/** F-CP-144: the record's priced documents this reader may not open, counted ("2 priced documents — you cannot open them"). */
export const pricedLockedIn = (files: readonly ThreadFile[], record: { readonly type: string; readonly id: string }): number => pricedLockedOf(fileSeries(recordFiles(files, record)))

/** What the person may do in the window (their rights over the record; the API checks every call again). */
export interface FilesAbilities {
  /** files.upload */
  readonly upload: boolean
  /** files.manage: change who sees a file (share with the record's party, office only). */
  readonly share: boolean
  /** files.delete */
  readonly delete: boolean
  /** F-CP-144 (B-CP-014): files.read — "Mark as priced" (anyone who reaches the record; taking it off is a price holder's). */
  readonly mark?: boolean
}

/** The bulk bar's actions, each with the files it reaches (only those it is allowed for: the button says the count). */
export interface BulkReach {
  readonly download: readonly string[]
  /** Shared with THIS record's party (B-TH-003); empty without a party or the right. */
  readonly share: readonly string[]
  readonly officeOnly: readonly string[]
  readonly remove: readonly string[]
  /** Chosen files a legal hold keeps (Delete refuses them, said in words). */
  readonly onHold: number
}

/** What each bulk action reaches among the chosen files (the files in force of the chosen documents). */
export function bulkReach(chosen: readonly ThreadFile[], party: FilesParty | null, can: FilesAbilities): BulkReach {
  // B-TH-231: a sheet locked for this reader is neither downloaded nor shared by them (they cannot open it).
  const available = chosen.filter((file) => file.status === 'AVAILABLE' && !file.locked)
  const sharedWithParty = (file: ThreadFile) => file.visibility.includes('PARTNER') && party !== null && file.partyId === party.id
  return {
    download: available.map((file) => file.id),
    share: can.share && party ? available.filter((file) => !sharedWithParty(file)).map((file) => file.id) : [],
    officeOnly: can.share ? chosen.filter((file) => file.visibility.some((audience) => audience !== 'OFFICE')).map((file) => file.id) : [],
    remove: can.delete ? chosen.filter((file) => !file.legalHold).map((file) => file.id) : [],
    onHold: can.delete ? chosen.filter((file) => file.legalHold).length : 0,
  }
}

/** A range for shift-click: the ids from the last clicked row to this one, in the window's order. */
export function rangeOf(order: readonly string[], from: string | null, to: string): string[] {
  const end = order.indexOf(to)
  const start = from === null ? -1 : order.indexOf(from)
  if (start < 0 || end < 0) return [to]
  const [low, high] = start <= end ? [start, end] : [end, start]
  return order.slice(low, high + 1)
}

/** The read-only lines of a file: held, legal hold, retention (kept until, due for removal). Keys of `record-thread-files-view`. */
export function keepLines(file: ThreadFile, now: number): { readonly key: string; readonly tone: 'neutral' | 'warning' | 'danger'; readonly params?: Readonly<Record<string, string | number>> }[] {
  const lines: { key: string; tone: 'neutral' | 'warning' | 'danger'; params?: Record<string, string | number> }[] = []
  if (file.status === 'QUARANTINED') lines.push({ key: file.quarantineReason === 'virus_found' ? 'keep.infected' : file.quarantineReason === 'scan_pending' ? 'keep.scanPending' : 'keep.held', tone: file.quarantineReason === 'virus_found' ? 'danger' : 'warning' })
  if (file.legalHold) lines.push({ key: 'keep.legalHold', tone: 'warning' })
  if (file.retainUntil) lines.push(Date.parse(file.retainUntil) < now ? { key: 'keep.due', tone: 'neutral' } : { key: 'keep.until', tone: 'neutral', params: { date: file.retainUntil } })
  return lines
}

/** A required document still missing before a status move (the required-document rule): WARN lets the move go, BLOCK refuses it. */
export interface MissingDocument {
  readonly id: string
  /** The document's name as the rule calls it ("Declaration of conformity"). */
  readonly document: string
  /** The status it is needed before ("Shipped"), in words. */
  readonly before: string
  readonly level: 'WARN' | 'BLOCK'
}

/** The upload being asked: the dropped files, then one kind and one audience for all of them (the audience starts on Office). */
export interface UploadAsk {
  readonly files: readonly { readonly name: string; readonly sizeBytes: number }[]
  readonly kind: FileKind
  readonly audience: 'OFFICE' | Exclude<FileAudience, 'OFFICE'>
  /** The kinds and audiences this record takes (record-panels' uploadChoices). */
  readonly kinds: readonly FileKind[]
  readonly audiences: readonly FileAudience[]
  /** B-TH-283 (B-TH-083): "This is a measurement sheet" — filed as body data (only holders of the measurements right open it). */
  readonly sheet?: boolean
  /** F-CP-144 (B-CP-014): "This file shows prices" — then only people who see prices open it. */
  readonly priced?: boolean
}

/** B-TH-283: why the upload waits (a key of record-thread-files-view), or null: a measurement sheet never goes to the floor. */
export const uploadAskHeld = (ask: Pick<UploadAsk, 'sheet' | 'audience'>): string | null => (ask.sheet && ask.audience === 'FLOOR' ? 'upload.sheetFloor' : null)

/** F-CP-144: why the upload waits (a key of `record-files`), or null: a file that shows prices never goes to the floor (it sees none). */
export const uploadPricedHeld = (ask: Pick<UploadAsk, 'priced' | 'audience'>): string | null => (ask.priced && ask.audience === 'FLOOR' ? 'priced.floor' : null)

export const START_AUDIENCE: FileAudience = 'OFFICE'

// ── F-SA-237 (sales page plan N9, picks P14, R7; 10-order-page §2.7; review BW-1) ───────────────────────────────────────────────
/**
 * A SALES ORDER's files (the T9 rule "one record's files" changes for a SalesOrder, by the lane agreement): every file of the order
 * by where it comes from — the order and its thread, its lines and artwork, the customer's requests, production, quality, shipments
 * and invoices, returns — from ONE walled read (`GET /sales/orders/:orderId/files`, B-SA-036). The order's Files tab and the thread's
 * Files window on the order draw the SAME body from it. Each file says who can see it (shared with the customer / office only), where
 * it hangs, "also on …" exactly as the read names it (only this customer's records the reader reaches; any other counted); files the
 * reader may not open are counted, never named. A file opens through the read's own route, never the generic preview.
 */
export const ORDER_FILE_AUDIENCES = ['CUSTOMER_CAN_SEE', 'OFFICE_ONLY'] as const
export type OrderFileAudience = (typeof ORDER_FILE_AUDIENCES)[number]

export interface OrderFileRef {
  readonly type: string
  readonly id: string
  readonly label: string
}

export interface OrderFile {
  readonly id: string
  readonly name: string
  readonly kind: string
  readonly category: string | null
  readonly contentType: string
  readonly sizeBytes: number
  readonly versionNo: number
  readonly at: string
  /** F-OF-101 (B-OF-003, S3): `state` — an annulled DDT's paper, an invoice's replaced file (kept by law; absent: in force). */
  readonly from: OrderFileRef & { readonly state?: OrderFileState | null }
  readonly line: { readonly id: string; readonly seq: number } | null
  readonly audience: OrderFileAudience
  readonly bodyData: boolean
  readonly alsoOn: readonly OrderFileRef[]
  readonly alsoOnOther: number
  readonly inThread: { readonly messageId: string } | null
  /** F-SA-238: a library document (a DDT, an invoice …) in its own words; absent: a plain file. */
  readonly documentWords?: { readonly it: string; readonly en: string } | null
  /** F-OP-125 (B-OP-050, office only): who added it — a person or the customer by name; the floor never by a worker's name. */
  readonly addedBy?: { readonly kind: 'PERSON' | 'FLOOR' | 'CUSTOMER'; readonly name: string | null } | null
  // ---- F-OF-101 (order FILES tab, 15-steps W1): what the read says of each file — every one OPTIONAL until its server step lands
  // (B-OF-001, S3); absent: the tab draws what it drew before (never a fake 0, never a held door for a missing fact).
  /** F2-B1 (B-PT-013, sent today): a tech-pack file — the version the request named; `newer`: the one in force is newer. */
  readonly techPack?: { readonly named: number; readonly newer: boolean } | null
  /** The file's lock for every act (StoredFile.version). */
  readonly version?: number
  readonly seriesId?: string | null
  /** The versions kept of its document (> 1: "Versions…"). */
  readonly versions?: number
  readonly kept?: { readonly legalHold: boolean; readonly retainUntil: string | null }
  /** A fiscal copy (never a version, never deleted). */
  readonly fiscal?: boolean
  /** A paper Nexus made (never deleted). */
  readonly made?: 'GENERATED' | 'INVOICE' | 'POD' | 'RETURN_LABEL' | null
  readonly bornPriced?: boolean
  readonly priced?: boolean
  /** F-OF-102: the TRUE audiences beyond the office (empty: office only); absent: the two-state `audience`. */
  readonly audiences?: readonly OrderFileReach[]
  // ---- end F-OF-101
}

/** F-OP-125 (B5): a made-to-measure line's newest worksheet (body data; opened by the made-to-measure route, each opening recorded). */
export interface OrderWorksheet {
  readonly documentId: string
  readonly profileId: string
  readonly line: { readonly id: string; readonly seq: number }
  readonly version: number
  readonly number: string | null
  readonly language: string
  readonly createdAt: string
}

export interface OrderFilesGroup {
  readonly key: string
  /** The group's words as the read gives them (it + en). */
  readonly words: { readonly it: string; readonly en: string }
  readonly files: readonly OrderFile[]
  /** F-OP-125 (B5): the LINES group's MTM worksheets the read sends (the measurements right only; else counted in measurementsLeftOut). */
  readonly worksheets?: readonly OrderWorksheet[]
  readonly leftOut: number
  readonly measurementsLeftOut: number
  /** F-CP-144 (B-CP-023): the group's priced documents this reader may not open (counted, never named); absent: none. */
  readonly pricedLeftOut?: number
  /** F-OF-102 (B-OF-002, S3): the group's files held by the virus scan (counted; the reader's own are cards too); absent: none said. */
  readonly heldCount?: number
}

export interface OrderFilesRead {
  readonly order: { readonly id: string; readonly number: string }
  readonly groups: readonly OrderFilesGroup[]
  readonly total: number
  readonly truncated: boolean
  // ---- F-OF-101 / F-OF-102 (B-OF-001, B-OF-002, S3; optional until they land) ----
  /** The reader's OWN office uploads still held by the virus scan (a card each; nobody else's is named). */
  readonly held?: readonly OrderHeldFile[]
  /** What the reader may do over THIS order's scope; absent: the session's rights decide, as before. */
  readonly may?: OrderFilesMay
  readonly cap?: number
  // ---- end F-OF-101 / F-OF-102
}

/** The order's files on screen: the read (null while it is read), a failed read, and what this person may do. */
export interface OrderFilesModel {
  readonly read: OrderFilesRead | null
  readonly problem: string | null
  readonly selected: readonly string[]
  /** files.manage: share the order's OWN files with its customer. */
  readonly canShare: boolean
  readonly busy?: boolean
  /** F-OP-126: the previews read for the cards in view, by file id (absent: the kind's icon until it comes). */
  readonly previews?: Readonly<Record<string, CardPreview>>
  /** F-OP-127: the ONE viewer while open — the walk of every file in display order, the one shown, the card to give the focus back to. */
  readonly viewer?: { readonly files: readonly ViewerFile[]; readonly index: number; readonly returnTo: HTMLElement | null } | null
  /**
   * F-SA-238: `customer` — the portal's face of the same body: the customer's own shared files only, no audience label (all are
   * theirs), no "also on", no left-out count (never "n hidden"), no choosing or sharing; default `office`.
   */
  readonly face?: 'office' | 'customer'
  // ---- F-OF-101 / F-OF-103 (order FILES tab, W1) ----
  /** What the reader may do here (the read's `may`, else the session's rights); absent: no act is offered. */
  readonly may?: OrderFilesMay
  /** "Add files…": the upload being asked (where it goes, what it is, who sees it), or null. */
  readonly upload?: UploadAsk | null
  /** The last upload's outcome: files refused (with why) and files the virus scan holds (said, never lost: F5-B6). */
  readonly uploadOutcome?: { readonly refused: readonly { readonly name: string; readonly reason: string }[]; readonly held: readonly string[] }
  // ---- end F-OF-101 / F-OF-103
}

/**
 * The groups that list a file (or a worksheet, F-OP-125; F-OF-102: a file held by the virus scan). F-OF-101 (P0-B1): a group whose only
 * files are ones the reader may not open is not drawn — those are counted ONCE, on the counted line under the Files head, never under
 * a heading "Order & thread 0" nor as "+ 1" under a group.
 */
export const orderGroupsShown = (read: OrderFilesRead): OrderFilesGroup[] => read.groups.filter((group) => group.files.length > 0 || (group.worksheets?.length ?? 0) > 0 || (group.heldCount ?? 0) > 0 || (read.held ?? []).some((held) => held.group === group.key))

/** F-CP-144: the order's priced documents this reader may not open, counted over every group ("2 priced documents — you cannot open them"). */
export const orderPricedLeftOut = (read: OrderFilesRead): number => read.groups.reduce((sum, group) => sum + (group.pricedLeftOut ?? 0), 0)

/** "N files you cannot open": every group's left-out files and body data without the right, counted. */
export const orderLeftOut = (read: OrderFilesRead): number => read.groups.reduce((sum, group) => sum + group.leftOut + group.measurementsLeftOut, 0)

/** Every listed file once, in the groups' order (the keys walk it; the bulk bar counts it). */
export const orderFilesOf = (read: OrderFilesRead): OrderFile[] => read.groups.flatMap((group) => group.files)

/** A file of the order itself (not of a line, a work order, a shipment …): only these are shared from here (Share N own). */
export const isOwnFile = (file: Pick<OrderFile, 'from'>, orderId: string): boolean => file.from.type === 'SalesOrder' && file.from.id === orderId

/** What the bulk bar reaches: Download every chosen file; Share the chosen OWN files still office only (with the right). */
export function orderBulkReach(chosen: readonly OrderFile[], orderId: string, canShare: boolean): { readonly download: readonly string[]; readonly share: readonly string[] } {
  return {
    download: chosen.map((file) => file.id),
    share: canShare ? chosen.filter((file) => isOwnFile(file, orderId) && file.audience === 'OFFICE_ONLY').map((file) => file.id) : [],
  }
}

/**
 * F-SA-238: the portal read (GET /portal/sales-orders/:orderId/files, B-SA-037) as the body reads it — the customer's groups, every file
 * shared with it (no audience, no "also on", nothing counted), labels by the customer's own numbers (a record with none: no chip).
 */
export function portalFilesRead(read: { readonly order: { readonly id: string }; readonly groups: readonly { readonly key: string; readonly words: { readonly it: string; readonly en: string }; readonly files: readonly { readonly id: string; readonly name: string; readonly kind: string; readonly category: string | null; readonly documentWords: { readonly it: string; readonly en: string } | null; readonly contentType: string; readonly sizeBytes: number; readonly versionNo: number; readonly at: string; readonly from: { readonly type: string; readonly id: string; readonly label: string | null }; readonly line: { readonly id: string; readonly seq: number } | null }[] }[]; readonly total: number }, ownNumber: string): OrderFilesRead {
  return {
    order: { id: read.order.id, number: ownNumber },
    groups: read.groups.map((group) => ({
      key: group.key,
      words: group.words,
      files: group.files.map((file) => ({ ...file, from: { type: file.from.type, id: file.from.id, label: file.from.label ?? '' }, audience: 'CUSTOMER_CAN_SEE' as const, bodyData: false, alsoOn: [], alsoOnOther: 0, inThread: null })),
      worksheets: [], // F-OP-125: none in the portal
      leftOut: 0,
      measurementsLeftOut: 0,
    })),
    total: read.total,
    truncated: false,
  }
}

/** Where a file sits, in words: "in the conversation" for a thread attachment, else its record ("from WO-0311"). */
export function sourceOf(file: Pick<OrderFile, 'from' | 'inThread'>, orderId: string): { readonly key: string; readonly params?: Readonly<Record<string, string>> } {
  if (file.inThread) return { key: 'order.source.thread' }
  if (file.from.type === 'SalesOrder' && file.from.id === orderId) return { key: 'order.source.order' }
  return { key: 'order.source.from', params: { record: file.from.label } }
}
// ── end F-SA-237

// ── F-OP-125 (order page plan N7 "files like Gmail"; 10-order-page §9.1): the order's file cards ───────────────────────────────────
/** What a card's preview area shows (the API's previews route says the same kinds, B-OP-050 previewKindOf). */
export type CardKind = 'PICTURE' | 'PDF' | 'OTHER' | 'LOCKED'

/** A card's kind (the previews route's own rule, B-OP-050 previewKindOf): body data is LOCKED whatever it is (a lock, never a picture); a
 *  picture (factory-domain isPicture); a PDF; anything else (Word, Excel, a ZIP …). */
export function cardKindOf(file: Pick<OrderFile, 'contentType' | 'bodyData'>): CardKind {
  if (file.bodyData) return 'LOCKED'
  if (isPicture(file.contentType)) return 'PICTURE'
  return file.contentType.split(';')[0]!.trim().toLowerCase() === 'application/pdf' ? 'PDF' : 'OTHER'
}

/** The card's type word, as a mail client says it: the name's extension ("PDF", "DOCX", "JPG"), else the type's ("PNG"); never a sentence. */
export function typeLabelOf(file: Pick<OrderFile, 'name' | 'contentType'>): string {
  const dot = file.name.lastIndexOf('.')
  const extension = dot > 0 && dot < file.name.length - 1 ? file.name.slice(dot + 1) : ''
  if (/^[A-Za-z0-9]{1,5}$/.test(extension)) return extension.toUpperCase()
  const subtype = file.contentType.split(';')[0]!.split('/')[1] ?? ''
  return /^[A-Za-z0-9]{1,5}$/.test(subtype) ? subtype.toUpperCase() : ''
}

/** "added by <name>" (office only): a person or the customer by name; the floor as "the floor" — never a worker; nobody known: none. */
export function addedByOf(file: Pick<OrderFile, 'addedBy'>): { readonly key: string; readonly params?: Readonly<Record<string, string>> } | null {
  const who = file.addedBy
  if (!who) return null
  if (who.kind === 'FLOOR') return { key: 'card.addedByFloor' }
  return who.name ? { key: 'card.addedBy', params: { name: who.name } } : null
}

/** The LINES group's worksheets (B5), in line order. */
export const orderWorksheetsOf = (group: Pick<OrderFilesGroup, 'worksheets'>): OrderWorksheet[] => [...(group.worksheets ?? [])].sort((a, b) => a.line.seq - b.line.seq)

/** The cards in the order they are drawn (each group's files, then its worksheets): the keys and the viewer walk them. */
export const cardOrderOf = (read: OrderFilesRead): string[] => orderGroupsShown(read).flatMap((group) => [...group.files.map((file) => file.id), ...orderWorksheetsOf(group).map((sheet) => worksheetCardId(sheet))])

/** A worksheet's card id (never a file id: it opens through the made-to-measure route). */
export const worksheetCardId = (sheet: Pick<OrderWorksheet, 'documentId'>): string => `worksheet:${sheet.documentId}`

/** ← / → / ↑ / ↓ over the cards: the next card's place, a grid row being `columns` cards; null at either end (no wrap). */
export function cardStep(at: number, count: number, key: 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown', columns: number): number | null {
  const step = key === 'ArrowLeft' ? -1 : key === 'ArrowRight' ? 1 : key === 'ArrowUp' ? -Math.max(1, columns) : Math.max(1, columns)
  const next = at + step
  return next < 0 || next >= count ? null : next
}
// ── end F-OP-125

// ── F-OP-126 (review R-14): what a card's preview area shows once its preview is read (none yet: the kind's icon) ──
/** picture: the small preview's address; page: PDF page 1 drawn here (a data URL); largePdf: "Large PDF: open it to see it"; icon: none. */
export type CardPreview = { readonly kind: 'picture'; readonly src: string } | { readonly kind: 'page'; readonly src: string } | { readonly kind: 'largePdf' } | { readonly kind: 'icon' }
// ── end F-OP-126

// ── F-OF-101 (order FILES tab, 10-design §5; 13-backend B-OF-001…003; 15-steps W1): the tab's groups, their blocks, the counted line ──
/** B-OF-003: a paper of its source that stands replaced, kept by law (folded under "Show N older", said on its card). */
export type OrderFileState = 'ANNULLED' | 'REPLACED'
/** B-OF-001: who beyond the office sees a file — the TRUE chip (F-OF-102). */
export type OrderFileReach = 'CUSTOMER' | 'LINK' | 'FLOOR'
/** B-OF-002: one of the reader's OWN uploads the virus scan still holds (never opened, never previewed). */
export interface OrderHeldFile {
  readonly id: string
  readonly name: string
  /** The read's group key it shows in (the order's or its lines'). */
  readonly group: string
  readonly at: string
  readonly reason: 'SCAN_PENDING' | 'INFECTED' | 'SCAN_FAILED' | 'OTHER'
}
/** B-OF-001: what the reader may do over THIS order's scope (company + customer). */
export interface OrderFilesMay {
  readonly upload: boolean
  readonly delete: boolean
  readonly share: boolean
  readonly ask: boolean
  readonly askCustomer: boolean
}

/** The tab's own group for the invoices and credit notes: the read keeps them in SHIPMENTS ("Shipments & invoices"); the web splits them off. */
export const INVOICES_GROUP = 'INVOICES'
/** The groups the web names itself (the read's one SHIPMENTS group becomes "Shipments" and "Invoices & credit notes"): `order.group.<key>`. */
export const OWN_WORDS_GROUPS: readonly string[] = ['SHIPMENTS', INVOICES_GROUP]
/** The groups drawn as one block per source record, each with its door "Open on … ›" (the record's own page keeps its commands). */
const BLOCK_GROUPS: readonly string[] = ['TECH_PACK', 'REQUESTS', 'PRODUCTION', 'QUALITY', 'SHIPMENTS', INVOICES_GROUP, 'RETURNS']
/** Production and Quality: one block per work order / inspection number (a hold, a defect or a check sits under it). */
const BY_LABEL: readonly string[] = ['PRODUCTION', 'QUALITY']
/** The record a block's door opens first when several kinds share the block (a work order before its hold). */
const HOME_FIRST: readonly string[] = ['WorkOrder', 'Inspection', 'Shipment', 'Invoice', 'Complaint', 'ReturnAuthorisation']

/** A file of an invoice or a credit note (B-OF-003: credit notes join the invoices' records). */
export const isInvoiceFile = (file: Pick<OrderFile, 'from'>): boolean => file.from.type === 'Invoice'
/** An annulled DDT's paper or a replaced invoice file: folded, said on its card ("Annulled — kept by law"). */
export const foldedOf = (file: Pick<OrderFile, 'from'>): boolean => file.from.state === 'ANNULLED' || file.from.state === 'REPLACED'

/** One source inside a group (a shipment, a work order, an invoice …): its head and door, the files in force, the folded papers. */
export interface OrderFilesBlock {
  readonly key: string
  /** null: no head (the order's own groups); `label` null: a door only ("Open on the Changes tab ›"). */
  readonly head: { readonly label: string | null; readonly door: OrderFileRef | null } | null
  readonly files: readonly OrderFile[]
  readonly older: readonly OrderFile[]
}

/** One group of the tab as it is drawn. */
export interface OrderFilesSection {
  readonly key: string
  /** The read's words; null: the web's own (`order.group.<key>`, OWN_WORDS_GROUPS). */
  readonly words: { readonly it: string; readonly en: string } | null
  readonly blocks: readonly OrderFilesBlock[]
  readonly worksheets: readonly OrderWorksheet[]
  /** F-OF-102: the reader's own uploads the scan holds (cards); `checking`: everyone else's, counted ("1 being checked"). */
  readonly held: readonly OrderHeldFile[]
  readonly checking: number
  /** The cards it lists (files in force + worksheets; the folded papers not counted). */
  readonly count: number
}

function blocksOf(key: string, files: readonly OrderFile[], face: 'office' | 'customer'): OrderFilesBlock[] {
  if (files.length === 0) return []
  const split = (list: readonly OrderFile[]) => ({ files: list.filter((file) => !foldedOf(file)), older: list.filter(foldedOf) })
  // The customer's face: no doors, no office words — the group's cards only.
  if (face === 'customer' || !BLOCK_GROUPS.includes(key)) return [{ key, head: null, ...split(files) }]
  // Requests: their files open on this order's Changes tab (one door; the request's code is no head).
  if (key === 'REQUESTS') return [{ key, head: { label: null, door: files[0]!.from }, ...split(files) }]
  const order: string[] = []
  const byKey = new Map<string, OrderFile[]>()
  for (const file of files) {
    const id = BY_LABEL.includes(key) ? `label:${file.from.label}` : `${file.from.type}:${file.from.id}`
    const list = byKey.get(id)
    if (list) list.push(file)
    else {
      byKey.set(id, [file])
      order.push(id)
    }
  }
  return order.map((id) => {
    const list = byKey.get(id)!
    const home = HOME_FIRST.map((type) => list.find((file) => file.from.type === type)).find((file) => file !== undefined) ?? list[0]!
    return { key: `${key}:${id}`, head: { label: home.from.label || null, door: { type: home.from.type, id: home.from.id, label: home.from.label } }, ...split(list) }
  })
}

/**
 * The tab's groups in the read's order (10-design §5): SHIPMENTS split into Shipments and Invoices & credit notes by `from.type`; one
 * block per source in the groups made on other pages (Production by work order, one block per shipment, invoice, case …); the
 * folded papers under their block; the reader's held uploads and everyone else's counted. A group with nothing to draw is left out.
 */
export function orderSectionsOf(read: OrderFilesRead, face: 'office' | 'customer' = 'office'): OrderFilesSection[] {
  const office = face === 'office'
  const out: OrderFilesSection[] = []
  for (const group of read.groups) {
    const parts: (readonly [string, readonly OrderFile[]])[] =
      group.key === 'SHIPMENTS' ? [['SHIPMENTS', group.files.filter((file) => !isInvoiceFile(file))], [INVOICES_GROUP, group.files.filter(isInvoiceFile)]] : [[group.key, group.files]]
    for (const [key, files] of parts) {
      const first = key === group.key
      const worksheets = office && first ? orderWorksheetsOf(group) : []
      const held = office && first ? (read.held ?? []).filter((one) => one.group === group.key) : []
      const checking = office && first ? Math.max(0, (group.heldCount ?? 0) - held.length) : 0
      if (files.length === 0 && worksheets.length === 0 && held.length === 0 && checking === 0) continue
      out.push({ key, words: OWN_WORDS_GROUPS.includes(key) ? null : group.words, blocks: blocksOf(key, files, face), worksheets, held, checking, count: files.filter((file) => !foldedOf(file)).length + worksheets.length })
    }
  }
  return out
}

/** Every listed file in display order (groups → blocks → the files in force, then the folded ones): the keys and the ONE viewer walk it. */
export const orderShownFilesOf = (sections: readonly OrderFilesSection[]): OrderFile[] => sections.flatMap((section) => section.blocks.flatMap((block) => [...block.files, ...block.older]))

/** The files a box may choose (the files in force; never a folded paper). */
export const orderChoosableOf = (sections: readonly OrderFilesSection[]): OrderFile[] => sections.flatMap((section) => section.blocks.flatMap((block) => block.files))

/** The counted line (P0-B1/B2): the files the reader may not open, said ONCE with the reasons, and the files the virus scan holds. */
export interface OrderCounted {
  readonly locked: number
  readonly priced: number
  readonly sheets: number
  readonly role: number
  readonly checking: number
}

export function orderCountedOf(read: OrderFilesRead, sections: readonly OrderFilesSection[]): OrderCounted {
  const priced = orderPricedLeftOut(read)
  const sheets = read.groups.reduce((sum, group) => sum + group.measurementsLeftOut, 0)
  const role = read.groups.reduce((sum, group) => sum + group.leftOut, 0)
  return { locked: priced + sheets + role, priced, sheets, role, checking: sections.reduce((sum, section) => sum + section.checking, 0) }
}

/** F-OF-102: shared with this order's customer — the true audiences when the read says them, else the two-state audience. */
export const sharedWithCustomer = (file: Pick<OrderFile, 'audience' | 'audiences'>): boolean => (file.audiences ? file.audiences.includes('CUSTOMER') : file.audience === 'CUSTOMER_CAN_SEE')

/** The Files section's answer — "23 files · 13 shared with <customer> · newest 21 Nov" — in the reader's own numbers. */
export function filesAnswerOf(sections: readonly OrderFilesSection[]): { readonly count: number; readonly shared: number; readonly newest: string | null } {
  const files = orderChoosableOf(sections)
  return {
    count: sections.reduce((sum, section) => sum + section.count, 0),
    shared: files.filter(sharedWithCustomer).length,
    newest: files.reduce<string | null>((best, file) => (best === null || file.at > best ? file.at : best), null),
  }
}

/** The tab's one answer above its sections (keys of record-thread-files-view): how many files the order has, what the scan holds. */
export function tabAnswerOf(read: OrderFilesRead, counted: Pick<OrderCounted, 'locked'>): { readonly parts: readonly { readonly key: string; readonly params?: Readonly<Record<string, number>> }[]; readonly tone: 'info' | 'warning' } {
  const held = read.groups.reduce((sum, group) => sum + (group.heldCount ?? 0), 0)
  if (read.total === 0 && held === 0) return { parts: [{ key: counted.locked > 0 ? 'tab.noneOpen' : 'tab.none' }], tone: 'info' }
  const parts: { key: string; params?: Record<string, number> }[] = [{ key: 'tab.files', params: { count: read.total } }]
  if (held > 0) parts.push({ key: 'held.checking', params: { count: held } })
  return { parts, tone: held > 0 ? 'warning' : 'info' }
}
// ── end F-OF-101
