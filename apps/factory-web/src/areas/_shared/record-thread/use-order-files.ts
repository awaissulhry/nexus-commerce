'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ApiClient } from '../../../lib/api/client'
import { isApiError } from '../../../lib/api/errors'
import type { FilesViewActions } from '../../../lib/record-thread/files-view/view/FilesView'
import { isOwnFile, type OrderFilesModel, type OrderFilesRead } from '../../../lib/record-thread/files-view/model'
// F-OP-126 (R-14): the cards' previews, only those in view, through the order's walled batch route.
import { orderFilesOf } from '../../../lib/record-thread/files-view/model'
import { orderPricedLeftOut } from '../../../lib/record-thread/files-view/model' // F-CP-144
import { useFilePreviews } from '../../../lib/record-thread/files-view/use-file-previews'
import { useOrderFileViewer } from '../../../lib/record-thread/files-view/use-order-file-viewer' // F-OP-127
import { orderSectionsOf, orderShownFilesOf, type OrderFileRef } from '../../../lib/record-thread/files-view/model' // F-OF-101: the walk in display order
// F-OF-103: "Add files…" — the ONE upload of the Files window (moved out of the dock), with "Where it goes": the order or a line.
import { useFileUpload } from '../../../lib/record-thread/files-view/use-file-upload'
import type { OrderFilesMay, UploadPlace } from '../../../lib/record-thread/files-view/model'
import { uploadChoices } from '../../../record-panels/model'
import { useFileAsks } from './use-file-asks' // F-OF-201: "Waiting for files"
import { listFiles } from '../../../record-panels/api'
import { storeUrl } from '../../../record-panels/store'
import { openOrderFile, readOrderFiles, shareWithParty } from './api'
import { readOrderFilePreviews } from './api' // F-OP-126
import { openWorksheet } from '../../sales/mtm/api' // F-OP-125 (B5): a worksheet opens by the made-to-measure route (recorded there)
import type { ThreadFile } from '../../../lib/record-thread/files/model' // F-OP-215: the dock's files line over the order's set
import { FILE_KINDS, type FileKind } from '../../../record-panels/model' // F-OP-215
import type { FileAudience } from '../../../record-panels/model' // F-OF-102
import { sharedWithCustomer } from '../../../lib/record-thread/files-view/model' // F-OF-102

/**
 * F-SA-237 (sales page plan N9, P14) — a sales order's files, the container part the order's Files tab AND the thread's Files window
 * on the order both use (one read, one way to open): reads `GET /sales/orders/:orderId/files` while shown; F-OP-127: opens a file in
 * the ONE viewer through the read's own route (body data only when asked, recorded there — never the generic preview); Download N; Share N OWN files (the order's own, still office only) with the order's customer — each file at its version
 * as `GET /files` reads it now (B-TH-003 refuses any other party). Refusals are words of `record-thread-files-view`.
 *
 * F-OP-125 (order page N-1): THE order-files container — the order page mounts it ONCE (OrderRecord.tsx) and gives the same model to
 * the Files tab and, later, to the dock (F-OP-215): one read, one count. The read is made the first time it is wanted and kept while
 * the page stays; news of the order's files (the live channel) reads it again when it is shown, or the next time it is wanted. A
 * made-to-measure worksheet (B5) opens through its own route, which records the opening on the profile.
 */
export function useOrderFiles(
  api: ApiClient,
  input: {
    readonly orderId: string | null
    readonly enabled: boolean
    readonly partyId: string | null
    readonly canShare: boolean
    readonly onProblem?: (key: string) => void
    /** F-OP-125: the page's own container keeps its read across tabs (true); a window that mounts its own reads again each time it opens. */
    readonly keep?: boolean
    /** F-OF-101: a block's door "Open on … ›" — the source record's own page (order-file-href.ts); absent: no door. */
    readonly hrefOf?: (record: OrderFileRef) => string | null
    // ---- F-OF-103: "Add files…" — the order's company, its lines (where a file may go), the session's rights until the read's `may` lands
    readonly companyId?: string | null
    readonly lines?: readonly { readonly id: string; readonly seq: number; readonly what: string | null }[]
    readonly canUpload?: boolean
    readonly canDelete?: boolean
    /** After an upload, what else reads again (the dock: its record's own files); the ORDER's read is read again here (F5-B8). */
    readonly onUploaded?: () => void
    // ---- end F-OF-103
    // ---- F-OF-201: "Waiting for files" — the order's work orders (a floor ask lands on one), the order's state (L1), the session's rights
    // until the read's `may` lands (tasks.manage + threads.post; partners.tasks.manage), Read-only (L3), today, the ask the address names
    readonly workOrders?: readonly { readonly id: string; readonly number: string; readonly siteId: string | null }[]
    readonly closed?: boolean
    readonly canAsk?: boolean
    readonly canAskCustomer?: boolean
    readonly readOnly?: boolean
    readonly today?: string
    readonly focusAsk?: string | null
    // ---- end F-OF-201
  },
) {
  const { orderId, enabled, partyId, canShare, keep = false } = input
  const [read, setRead] = useState<OrderFilesRead | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [selected, setSelected] = useState<readonly string[]>([])
  const [busy, setBusy] = useState(false)
  const turn = useRef(0)
  const onProblem = useRef(input.onProblem)
  onProblem.current = input.onProblem
  // F-OP-125: the read this page holds (null: never read, or no longer true — read again the next time it is wanted).
  const readFor = useRef<string | null>(null)
  const wanted = useRef(enabled)
  wanted.current = enabled

  const load = useCallback(() => {
    if (!orderId) return
    const mine = ++turn.current
    readFor.current = orderId
    setProblem(null)
    readOrderFiles(api, orderId)
      .then((answer) => mine === turn.current && setRead(answer))
      .catch((error: unknown) => {
        if (mine !== turn.current) return
        readFor.current = null
        setProblem(isApiError(error) && error.kind === 'forbidden' ? 'forbidden' : 'read')
      })
  }, [api, orderId])

  // Read once, when first wanted (and for another order); kept while the page stays (`keep`), else read again each time it is wanted.
  useEffect(() => {
    if (enabled && readFor.current !== orderId) load()
    if (!enabled && !keep) readFor.current = null
  }, [enabled, orderId, load, keep])
  /** News of the order's files: read again now when shown, else the next time they are wanted. */
  const again = useCallback(() => {
    if (wanted.current) load()
    else readFor.current = null
  }, [load])

  // F-OP-127: a file is shown in the ONE viewer below; Download (a card's, the bar's, the viewer's) is asked at the click.
  const download = useCallback(
    async (fileId: string) => {
      if (!orderId) return
      try {
        const answer = await openOrderFile(api, orderId, fileId, 'download')
        const anchor = document.createElement('a')
        anchor.href = storeUrl(answer.url)
        anchor.rel = 'noopener'
        anchor.download = read?.groups.flatMap((group) => group.files).find((file) => file.id === fileId)?.name ?? ''
        document.body.appendChild(anchor)
        anchor.click()
        anchor.remove()
      } catch {
        onProblem.current?.('order.openFailed')
      }
    },
    [api, orderId, read],
  )

  // ---- F-OP-126: the previews of the cards in view (the body reports them) ----
  // F-OF-101: every listed file in the order the tab draws them (Shipments, then Invoices & credit notes; one block per source), once per read.
  const listed = useMemo(() => (read ? orderShownFilesOf(orderSectionsOf(read)) : null), [read])
  const previews = useFilePreviews({ files: listed, ask: orderId ? (fileIds) => readOrderFilePreviews(api, orderId, fileIds) : null })
  // ---- F-OP-127: the ONE viewer — ← / → over every file in display order, each fetched by the order's open route when shown ----
  const viewer = useOrderFileViewer({ files: listed, open: orderId ? (fileId, mode) => openOrderFile(api, orderId, fileId, mode) : null, onProblem: (key) => onProblem.current?.(key) })
  // ---- F-OF-103: what the reader may do — the read's `may` over THIS order's scope when it says it (B-OF-001), else the session's rights
  // (as before); "Add files…" through the ONE upload, its places the order and each line (a line's sharing with the customer waits for
  // the server to take it, B-OF-014: office only until the read's `may` is there).
  const may: OrderFilesMay = read?.may ?? { upload: input.canUpload ?? false, delete: input.canDelete ?? false, share: canShare, ask: false, askCustomer: false }
  const shareRight = may.share
  const choices = uploadChoices({ can: { share: shareRight }, party: partyId ? { id: partyId, name: '', emails: [] } : null, record: { type: 'SalesOrder', siteId: null, companyId: input.companyId ?? null } })
  const places: UploadPlace[] | undefined = orderId
    ? [
        { key: 'order', record: { type: 'SalesOrder', id: orderId }, kind: 'order', audiences: choices.audiences },
        ...(input.lines ?? []).map((line): UploadPlace => ({ key: `line:${line.id}`, record: { type: 'SalesOrderLine', id: line.id }, kind: 'line', seq: line.seq, what: line.what, audiences: read?.may ? choices.audiences : choices.audiences.filter((one) => one === 'OFFICE') })),
      ]
    : undefined
  const upload = useFileUpload(api, {
    companyId: input.companyId ?? null,
    record: orderId ? { type: 'SalesOrder', id: orderId } : null,
    siteId: null,
    partyId,
    choices,
    ...(places ? { places } : {}),
    onDone: (result) => {
      // F-OF-203: an ask's upload answers the ask with its files (the read is read again after the answer).
      if (result.ask.forAsk && result.fileIds.length > 0) void asks.answer(result.ask.forAsk.id, result.fileIds)
      load()
      input.onUploaded?.()
    },
  })
  // ---- end F-OF-103
  // ---- F-OF-201 … F-OF-203: "Waiting for files" — the band's windows, pickers and commands (use-file-asks); the same in the tab and the
  // order's thread window. "Ask for a file…" by the read's `may.ask` when S3 lands, else the session's rights — only once the read sends `asks`.
  const askCan = {
    ask: read?.asks !== undefined && (read?.may ? read.may.ask : (input.canAsk ?? false)),
    askCustomer: !!partyId && (read?.may ? read.may.askCustomer : (input.canAskCustomer ?? false)),
    share: shareRight,
    closed: input.closed ?? false,
    readOnly: input.readOnly ?? false,
  }
  const asks = useFileAsks(api, {
    orderId,
    read,
    partyId,
    companyId: input.companyId ?? null,
    lines: input.lines ?? [],
    workOrders: input.workOrders ?? [],
    can: askCan,
    today: input.today ?? new Date().toISOString().slice(0, 10),
    focus: input.focusAsk ?? null,
    reload: load,
    openForAsk: upload.openForAsk,
    openFile: (fileId) => viewer.openAt(fileId, null),
  })
  // ---- end F-OF-201

  const actions: FilesViewActions = {
    onRetry: load,
    ...(input.hrefOf ? { orderHrefOf: input.hrefOf } : {}), // F-OF-101
    onOrderVisible: previews.visible, // F-OP-126
    onOrderSelect: setSelected,
    // F-OP-127: Open shows the file in the viewer (the card gets the focus back); Download is asked at the click.
    onOrderOpen: (fileId, mode, opener) => (mode === 'preview' ? viewer.openAt(fileId, opener ?? null) : void download(fileId)),
    onViewerIndex: viewer.onIndex,
    onViewerClose: viewer.onClose,
    onViewerOpenLocked: viewer.onOpenLocked,
    onViewerRetry: viewer.onRetry, // F-OF-104 (F7-B1)
    onOrderPreviewFailed: previews.stale, // F-OF-104 (F7-B3)
    onViewerDownload: (fileId) => void download(fileId),
    // F-OP-125 (B5): a worksheet through the made-to-measure route (it records the opening on the profile), in a new tab.
    onOrderWorksheet: (sheet) => {
      void openWorksheet(api, sheet.profileId, sheet.documentId)
        .then((answer) => window.open(storeUrl(answer.download.url), '_blank', 'noopener'))
        .catch(() => onProblem.current?.('order.openFailed'))
    },
    onOrderBulk: (action, ids) => {
      if (action === 'download') {
        for (const fileId of ids) void download(fileId)
        return
      }
      if (!orderId || !partyId || !shareRight || busy) return
      const own = (read?.groups.flatMap((group) => group.files) ?? []).filter((file) => ids.includes(file.id) && isOwnFile(file, orderId))
      setBusy(true)
      listFiles(api, { type: 'SalesOrder', id: orderId })
        .then(async ({ files }) => {
          for (const file of own) {
            const now = files.find((entry) => entry.id === file.id)
            if (now) await shareWithParty(api, now, partyId)
          }
          setSelected([])
        })
        .catch(() => onProblem.current?.('order.shareFailed'))
        .finally(() => {
          setBusy(false)
          load()
        })
    },
    // ---- F-OF-103: "Add files…" — the ONE upload window (the order or one of its lines) ----
    onOrderAdd: (files) => upload.open(files),
    onOrderUploadChange: upload.change,
    onOrderUploadConfirm: upload.confirm,
    onOrderUploadCancel: upload.cancel,
    onOrderUploadDismiss: upload.dismiss,
    // ---- end F-OF-103
    ...asks.actions, // F-OF-201 … F-OF-203: the band's doors and windows
  }

  const model: OrderFilesModel = { read, problem, selected, canShare: shareRight /* F-OF-103: the read's `may` when it says it */, busy: busy || upload.busy, previews: previews.previews /* F-OP-126 */, viewer: viewer.model /* F-OP-127 */, may, upload: upload.ask, uploadOutcome: upload.outcome /* F-OF-103 */, asks: asks.state /* F-OF-201 */ }
  return { model, actions, reload: again }
}

// ---- F-OP-215 (order page plan N4; 11-dock §6.2, D2; review N-1): the dock's files line on a sales order is the order's file set — the
// ONE read of this container (the page's own, `keep: true`), handed to the dock by its host: the count is that set (the Files tab's
// count: `read.total`), the tiles its newest; "All files" opens the Files tab, a tile opens the file in the ONE viewer there.

/** What the order page hands its dock: the container's read and actions, the way to the Files tab, a file in its viewer. */
export interface OrderFilesHost {
  readonly model: OrderFilesModel
  readonly actions: FilesViewActions
  readonly reload: () => void
  /** "All files": the order's Files tab (the dock's scope kept). */
  readonly onAll: () => void
  /** A tile: the Files tab with the ONE viewer on this file. */
  readonly onOpen: (fileId: string, opener: HTMLElement | null) => void
}

const kindOf = (kind: string): FileKind => ((FILE_KINDS as readonly string[]).includes(kind) ? (kind as FileKind) : 'DOCUMENT')

/**
 * The order's file set as the files line draws it: each listed file one tile (its own series: the read lists current versions only, so
 * the line's count is `read.total`), newest first by the line's own rule; body data locked (never a picture); a file the customer sees
 * marked as theirs; the message it came with kept ("Go to message").
 */
export function stripFilesOf(read: OrderFilesRead, partyId: string | null): ThreadFile[] {
  return orderFilesOf(read).map((file): ThreadFile /* F-CP-144: typed here, the priced count is concatenated below */ => ({
    id: file.id,
    recordType: file.from.type,
    recordId: file.from.id,
    name: file.name,
    contentType: file.contentType,
    kind: kindOf(file.kind),
    sizeBytes: file.sizeBytes,
    status: 'AVAILABLE',
    quarantineReason: null,
    // F-OF-102 (F6-B2): the tile's marks follow the TRUE audiences when the read says them (a floor or link file is not "Office only").
    visibility: file.audiences ? ['OFFICE', ...file.audiences.map((one): FileAudience => (one === 'CUSTOMER' ? 'PARTNER' : one))] : file.audience === 'CUSTOMER_CAN_SEE' ? ['OFFICE', 'PARTNER'] : ['OFFICE'],
    partyId: sharedWithCustomer(file) ? partyId : null,
    createdAt: file.at,
    versionNo: file.versionNo,
    seriesId: file.id,
    previewUrl: null,
    messageId: file.inThread?.messageId ?? null,
    ...(file.bodyData ? { locked: 'MEASUREMENTS' as const } : {}),
  }))
    // ---- F-CP-144 (B-CP-023): the order's priced documents this reader may not open — the files line counts them on one line
    // ("2 priced documents — you cannot open them"), never names, previews or opens them (no id of a real file).
    .concat(
      Array.from({ length: orderPricedLeftOut(read) }, (_, index): ThreadFile => ({
        id: `priced-left-out-${index}`,
        recordType: 'SalesOrder',
        recordId: read.order.id,
        name: '',
        contentType: 'application/octet-stream',
        kind: 'DOCUMENT',
        sizeBytes: 0,
        status: 'AVAILABLE',
        quarantineReason: null,
        visibility: ['OFFICE'],
        partyId: null,
        createdAt: '',
        seriesId: `priced-left-out-${index}`,
        previewUrl: null,
        locked: 'PRICED',
      })),
    )
    // ---- end F-CP-144
}
// ---- end F-OP-215
