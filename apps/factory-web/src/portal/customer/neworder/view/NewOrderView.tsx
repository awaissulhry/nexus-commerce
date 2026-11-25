'use client'

import type { ReactNode } from 'react'
import { AlertTriangle, Send, WifiOff } from 'lucide-react'
import { Banner, Card, SummaryTable } from '@nexus/ui/components'
import { EndState } from '@nexus/ui/components/EndState/index'
import type { SaveStatusState } from '@nexus/ui/components/SaveStatus/index'
import { Button } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../lib/i18n/ds-parts'
import type { DraftRecord, DraftRow, RequestStatus } from '../api'
import type { NewOrderPhase } from '../band'
import { draftRowWords, requestedHref, newOrderHref, type HeaderDraft, type HeaderField, type Way } from '../model'
import { useOrderingWords } from '../words'
import { DiscardDialog, NewAddressDialog, StylePickerDialog, type AddressDialogActions, type AddressDialogModel, type DiscardModel, type PickerActions, type PickerModel } from './Dialogs'
import { Loading, ReadFailed } from './parts'
import { ReorderPanel, type ReorderActions, type ReorderModel } from './ReorderPanel'
import { UploadPanel, type UploadActions, type UploadModel } from './UploadPanel'
// ---- F-CP-150 (customer page plan C5, D9–D11; 12 §2): the draft order page — the portal record frame with the draft's conversation
// docked; od-w1: its body is the ONE draft order's shared part (src/lib/order-draft), the portal adds its ways in and its own cards.
import { PortalRecordFrame } from '../../../shell/record/PortalRecordFrame'
import type { PortalDockWidth, PortalFrameMode } from '../../../shell/record/model'
import { draftKeys } from '../band'
import { closedOf, reorderHeldKey } from '../model'
import { draftTitleOf, draftViewOf, productRowsOf } from '../../../../lib/order-draft/model'
import type { SavedBy } from '../../../../lib/order-draft/schema'
import { useDraftWords } from '../../../../lib/order-draft/words'
import { DraftPage } from '../../../../lib/order-draft/view/DraftPage'
import { ContinueDrafts, useContinueLine } from '../../../../lib/order-draft/view/ContinueDrafts'
import type { FilesBoxActions, UploadRow } from '../../../../lib/order-draft/view/files'
import type { ProductsTableActions } from '../../../../lib/order-draft/view/ProductsTable'
import { OptionsWindow, PiecesWindow, RowFilesWindow, type OptionsWindowActions, type OptionsWindowModel, type PiecesWindowActions, type PiecesWindowModel, type RowFilesWindowModel } from '../../../../lib/order-draft/view/RowWindows'
import { PersonDialog, type PeopleRosterActions, type PersonDialogActions, type PersonDialogModel } from '../../../../lib/order-draft/view/PeopleRoster'
// ---- end F-CP-150
// ---- F-CP-154 (customer page plan C5; 12 §2 part 6): "Your price" — the portal's own card, a price holder only.
import { ownTotalOf, priceRowsOf, yourPriceAccess } from '../model'
import { YourPriceCell } from './parts'
// ---- end F-CP-154

/**
 * SCR-185 › New order & reorder (design portal.customer.neworder) — od-w1.2 (THE SIMPLE ORDER START R1; 10-design-r1): the start and
 * the draft order are ONE page, the shared part (src/lib/order-draft): a MAIL (Subject · Message · Attachments) and ONE products
 * table, nothing required, no Start button — the first input makes the draft (`?draft=`). The start adds "Continue a draft" under the
 * table; both add "Add from: catalogue · a past order · a sheet" (today's windows; the draft is made at the first Add). From the first
 * save the portal record frame docks the draft's conversation. The portal's own cards sit in ONE row under Still open: Send to the
 * factory (always on: nothing is required — held only for a colleague who may not order, a preview, offline) and Your price (a price
 * holder only; no card at all for anyone else). A draft no longer a draft keeps its conversation beside its end state.
 */

export interface NewOrderViewModel {
  state: 'loading' | 'error' | 'missing' | 'ready'
  phase: NewOrderPhase
  prefix: string
  /** Today in the site's zone: the earliest requested date. */
  today: string
  /** The start's "Continue a draft" (the team's drafts). */
  start: { state: 'loading' | 'error' | 'ready'; drafts: readonly DraftRow[] }
  way: Way | null
  record: DraftRecord | null
  header: HeaderDraft
  /** Field → a key of the draft part's words. */
  headerErrors: Partial<Record<HeaderField, string>>
  save: SaveStatusState
  /** Why nothing can be written now (words), or null. */
  writeHeld: string | null
  /** "Add a new address": held with the reason (words), or null. */
  addAddressHeld: string | null
  reorder: ReorderModel | null
  upload: UploadModel | null
  /** A refusal in our words (a key), or null. */
  problem: string | null
  /** The draft changed elsewhere while something was typed here. */
  stale: boolean
  notice: { lines: readonly string[]; undo: boolean } | null
  /** Send's held reason (words), or null. */
  sendHeld: string | null
  /** B-TH-304 (pick A): no office number — their PO, the lines, the pieces. */
  sent: { customerRef: string | null; lines: number; pieces: number; net: string | null; currency: string; seesPrices: boolean } | null
  closed: { status: RequestStatus; salesOrder: { id: string } | null } | null
  offlineSince: string | null
  /** "Add a product" drew a row that is not saved yet. */
  pending: boolean
  /** The styles the Product cell offers (the customer's catalogue); null while not read. */
  styles: readonly { readonly id: string; readonly code: string; readonly name: string }[] | null
  /** Rows being saved. */
  saving: readonly string[]
  dialogs: {
    picker: PickerModel | null
    address: AddressDialogModel | null
    discard: DiscardModel | null
    person?: PersonDialogModel | null
    // od-w1.2: a row's windows (Pieces, Options, Files).
    pieces?: PiecesWindowModel | null
    options?: OptionsWindowModel | null
    rowFiles?: RowFilesWindowModel | null
  }
  // ---- F-CP-150
  /** Who changed the draft meanwhile (a 409's re-read), or null. */
  staleBy?: SavedBy | null
  /** The reader's access shows orders (portal.salesOrders.view): a sent or accepted draft leads there; else who follows it. */
  seesOrders?: boolean
  /** The reader may order (portal.orderRequests.manage): Reorder a past order; else held with why (D11). */
  mayOrder?: boolean
  /** The design review: the frame's layout whatever the window (docked or narrow, the conversation open, a new count). */
  frame?: { readonly mode: PortalFrameMode; readonly viewOpen?: boolean; readonly newCount?: number; readonly width?: PortalDockWidth; readonly hidden?: boolean }
  // ---- end F-CP-150
  /** F-CP-151: the files going up now, or that did not go (their words). */
  uploads?: readonly UploadRow[]
  // ---- F-CP-154: "Your price" typed and not saved yet, and why a typed one cannot be saved (keys), by line.
  ownPrices?: Readonly<Record<string, string>>
  ownPriceProblems?: Readonly<Record<string, string>>
  // ---- end F-CP-154
}

export interface NewOrderActions {
  /** "Add from: catalogue · a past order · a sheet" (the draft is made at the first Add). */
  onWay?: (way: Way) => void
  onContinue?: (draftId: string) => void
  onRetryStart?: () => void
  onHeader?: (field: HeaderField, value: string) => void
  onHeaderLeave?: (field: HeaderField) => void
  onAddAddress?: () => void
  onSend?: () => void
  onTakePrices?: () => void
  onUndo?: () => void
  onDismissNotice?: () => void
  onReload?: () => void
  onRetry?: () => void
  onRetrySave?: () => void
  /** od-w1.2: the mail's Attachments, the products table, a row's windows, a Still open item. */
  files?: FilesBoxActions
  table?: ProductsTableActions
  pieces?: PiecesWindowActions
  options?: OptionsWindowActions
  rowFiles?: FilesBoxActions & { onClose?: () => void }
  onStillOpen?: (target: { rowId: string | null }) => void
  people?: PeopleRosterActions
  price?: { onType?: (lineId: string, text: string) => void; onLeave?: (lineId: string) => void }
  person?: PersonDialogActions
  reorder?: ReorderActions
  upload?: UploadActions
  picker?: PickerActions
  address?: AddressDialogActions
  discard?: { onConfirm?: () => void; onCancel?: () => void }
}

/**
 * `children`: the draft's conversation (PortalThread live on `PortalOrderRequest`, the design's ThreadView), docked by the portal
 * record frame beside the draft and beside a draft no longer a draft. The start and a missing draft draw none.
 */
export function NewOrderView({ model, actions, children }: { model: NewOrderViewModel; actions?: NewOrderActions; children?: ReactNode }) {
  const words = useOrderingWords()
  const { t } = words
  const dw = useDraftWords()
  const ds = useDsWords()
  const continueLine = useContinueLine()
  const offline = model.offlineSince ? <Banner tone="warning" icon={<WifiOff size={16} aria-hidden />} title={t('offline.title', { time: words.time(model.offlineSince) })} /> : null
  const seesOrders = model.seesOrders ?? true
  // F-CP-150: the draft's conversation stays beside its end state (sent, refused, withdrawn, accepted).
  const framed = (body: ReactNode) =>
    children ? (
      <PortalRecordFrame thread={children} threadLabel={t('draftPage.thread')} design={model.frame}>
        {body}
      </PortalRecordFrame>
    ) : (
      <>{body}</>
    )

  if (model.phase === 'sent' && model.sent) {
    const sent = model.sent
    return framed(
      <div className="fw-pno">
        <EndState
          title={t('sent.title')}
          // B-TH-220 (with B-TH-041): no answer-time promise. B-TH-304 (pick A): their PO, never the office's request number.
          body={sent.customerRef ? t('sent.bodyYours', { ref: sent.customerRef }) : t('sent.bodyNone')}
          next={[t('summary.notice'), t('draftPage.sentThread'), dw.t('send.later')]}
          facts={[
            { label: t('summary.lines'), value: String(sent.lines) },
            { label: t('summary.pieces'), value: words.pieces(sent.pieces) },
            ...(sent.seesPrices && sent.net ? [{ label: t('summary.net'), value: words.price(sent.net, sent.currency) ?? '—' }] : []),
          ]}
          {...(sent.customerRef ? { reference: { value: sent.customerRef, label: t('ref.yours') } } : {})}
          actions={[
            // F-CP-150: Orders only for one whose access shows them (never a door that leads nowhere).
            ...(seesOrders ? [{ label: t('sent.open'), href: requestedHref(model.prefix), variant: 'primary' as const }] : []),
            { label: t('sent.newOrder'), href: newOrderHref(model.prefix), ...(seesOrders ? {} : { variant: 'primary' as const }) },
          ]}
          labels={ds.endState}
        />
      </div>,
    )
  }

  if (model.phase === 'closed' && model.closed) {
    const closed = model.closed
    // F-CP-150: where a draft no longer a draft leads — its order, Orders, or (no orders in the access) who follows it.
    const end = closedOf(closed.status, seesOrders)
    const open = end.open === 'order' && closed.salesOrder ? `${model.prefix}/orders/${encodeURIComponent(closed.salesOrder.id)}` : end.open !== null ? requestedHref(model.prefix) : null
    return framed(
      <div className="fw-pno">
        <EndState
          tone="info"
          // B-TH-304 (pick A): never the office's request or order number; the order's own page names the customer's number.
          title={t('closed.titleNone')}
          body={t(end.body)}
          actions={[
            ...(open ? [{ label: t('sent.open'), href: open, variant: 'primary' as const }] : []),
            { label: t(end.startNew ? 'draftPage.startNew' : 'sent.newOrder'), href: newOrderHref(model.prefix), ...(open ? {} : { variant: 'primary' as const }) },
          ]}
          labels={ds.endState}
          focusOnMount={false}
        />
      </div>,
    )
  }

  if (model.state === 'missing') {
    return (
      <div className="fw-pno">
        <EndState
          tone="neutral"
          title={t('missing.title')}
          body={t('missing.body')}
          actions={[{ label: t('sent.newOrder'), href: newOrderHref(model.prefix), variant: 'primary' }]}
          labels={ds.endState}
          focusOnMount={false}
        />
      </div>
    )
  }

  if (model.phase !== 'start' && (model.state === 'loading' || (model.state === 'ready' && !model.record))) {
    return (
      <div className="fw-pno">
        <Loading rows={4} height={96} />
      </div>
    )
  }
  // ── od-w1.2: the start and the draft are ONE page, the shared part; the portal adds its ways in, its panels and its own cards. ─────
  const record = model.record
  // A draft that could not be read (the start has none to read).
  if (model.phase !== 'start' && (model.state === 'error' || !record)) {
    return (
      <div className="fw-pno">
        <ReadFailed title={t('draft.failed')} onRetry={actions?.onRetry} />
      </div>
    )
  }
  const reorderHeld = reorderHeldKey(model.mayOrder ?? true)
  const writeHeld = model.writeHeld
  // "Add from: catalogue · a past order · a sheet" (10-design-r1 § 2): today's windows; a past order held with why without orders.
  const addFrom = (
    <span className="fw-pno-addfrom">
      <span className="fw-pno-quiet">{dw.t('add.from')}</span>
      {/* od-fx10 W-19: the three ways stay together on a phone (none wraps alone). */}
      <span className="fw-pno-addways">
      {(['pick', 'reorder', 'upload'] as const).map((way, index) => {
        const held = way === 'reorder' && reorderHeld ? t(reorderHeld) : writeHeld
        return (
          <span key={way} className="fw-pno-addway">
            {index > 0 ? <span aria-hidden>·</span> : null}
            <Button size="sm" variant="quiet" heldReason={held} onClick={() => actions?.onWay?.(way)}>
              {dw.t(way === 'pick' ? 'add.catalogue' : way === 'reorder' ? 'add.pastOrder' : 'add.sheet')}
            </Button>
          </span>
        )
      })}
      </span>
    </span>
  )
  const panels = (
    <>
      {model.way === 'reorder' && model.reorder ? <ReorderPanel model={model.reorder} actions={actions?.reorder} /> : null}
      {model.way === 'upload' && model.upload ? <UploadPanel model={model.upload} actions={actions?.upload} /> : null}
    </>
  )
  const dialogs = (
    <>
      {model.dialogs.picker ? <StylePickerDialog model={model.dialogs.picker} actions={actions?.picker} /> : null}
      {model.dialogs.address ? <NewAddressDialog model={model.dialogs.address} actions={actions?.address} /> : null}
      {model.dialogs.discard ? <DiscardDialog model={model.dialogs.discard} onConfirm={actions?.discard?.onConfirm} onCancel={actions?.discard?.onCancel} /> : null}
      {/* A row's windows (their refusals already in words) and a person's window (its refusal in this page's words). */}
      {model.dialogs.pieces ? <PiecesWindow model={model.dialogs.pieces} actions={actions?.pieces} /> : null}
      {model.dialogs.options ? <OptionsWindow model={model.dialogs.options} actions={actions?.options} /> : null}
      {model.dialogs.rowFiles ? <RowFilesWindow model={model.dialogs.rowFiles} actions={actions?.rowFiles} onClose={actions?.rowFiles?.onClose} /> : null}
      {model.dialogs.person ? <PersonDialog model={{ ...model.dialogs.person, failed: model.dialogs.person.failed ? t(model.dialogs.person.failed) : null }} actions={actions?.person} /> : null}
    </>
  )
  const page = (
    <DraftPage
      kind="portal"
      model={{
        draft: record ? draftViewOf(record) : null,
        today: model.today,
        header: model.header,
        headerErrors: model.headerErrors,
        save: model.save,
        writeHeld,
        addAddressHeld: model.addAddressHeld,
        problem: model.problem ? t(model.problem) : null,
        stale: model.stale,
        staleBy: model.staleBy ?? null,
        notice: model.notice,
        offlineSince: model.offlineSince,
        pending: model.pending,
        styles: model.styles,
        saving: model.saving,
        uploads: model.uploads ?? [],
        keys: draftKeys(words),
      }}
      actions={{
        onHeader: actions?.onHeader,
        onHeaderLeave: actions?.onHeaderLeave,
        onAddAddress: actions?.onAddAddress,
        onUndo: actions?.onUndo,
        onDismissNotice: actions?.onDismissNotice,
        onReload: actions?.onReload,
        onRetrySave: actions?.onRetrySave,
        files: actions?.files,
        table: actions?.table,
        onStillOpen: (entry) => actions?.onStillOpen?.({ rowId: entry.rowId }),
      }}
      onSendKey={() => (model.sendHeld ? undefined : actions?.onSend?.())}
      slots={{
        panels,
        addFrom,
        dialogs,
        cards: record ? (
          <>
            <SendCard held={model.sendHeld} onSend={actions?.onSend} />
            {record.seesPrices && productRowsOf(record.request).length > 0 ? <PriceCard model={model} actions={actions} /> : null}
          </>
        ) : null,
        actionBar: record ? <SendButton held={model.sendHeld} onSend={actions?.onSend} /> : null,
        continueSlot:
          model.start.state === 'loading' ? (
            <Loading rows={2} height={44} label={dw.t('start.continue')} />
          ) : model.start.state === 'error' ? (
            <ReadFailed title={t('start.draftsFailed')} onRetry={actions?.onRetryStart} />
          ) : (
            <ContinueDrafts
              title={dw.t('start.continue')}
              rows={model.start.drafts.map((row) => ({
                id: row.id,
                title: row.draft?.title ?? row.subject ?? draftTitleOf({ lines: [], createdAt: row.createdAt }, dw.t, words.locale, words.day),
                line: continueLine({ openCount: row.draft?.openCount, savedAt: row.draft?.savedAt, savedBy: row.draft?.savedBy }, draftRowWords(row, t, words.day)),
              }))}
              onOpen={(id) => actions?.onContinue?.(id)}
            />
          ),
      }}
    />
  )
  // The start draws no frame (no conversation before the first save); the draft docks its conversation from the first save.
  if (model.phase === 'start' || !record) return <div className="fw-pno">{offline}{page}</div>
  return (
    <PortalRecordFrame thread={children ?? null} threadLabel={t('draftPage.thread')} design={model.frame}>
      {page}
    </PortalRecordFrame>
  )
}

/** The ONE Send button: in its card, and (od-w2.6) in the page's sticky bar on a phone. */
function SendButton({ held, onSend, className }: { held: string | null; onSend?: () => void; className?: string }) {
  const dw = useDraftWords()
  return (
    <Button variant="primary" heldReason={held} onClick={() => onSend?.()} {...(className ? { className } : {})}>
      <Send size={14} aria-hidden /> {dw.t('send.title')}
    </Button>
  )
}

/** Send to the factory (R1): always on — nothing is required; held only for a colleague who may not order (their names), a preview, offline. */
function SendCard({ held, onSend }: { held: string | null; onSend?: () => void }) {
  const dw = useDraftWords()
  return (
    <Card padded>
      <section className="fw-pno-section" aria-labelledby="od-send-title">
        <h2 id="od-send-title" className="fw-pno-h2">
          {dw.t('send.title')}
        </h2>
        <p className="fw-pno-quiet">{dw.t('send.body')}</p>
        <SendButton held={held} onSend={onSend} className="fw-od-hostgo" />
      </section>
    </Card>
  )
}

/**
 * Your price (F-CP-154; R1: one row per product): a price holder's own price per row (typed while the draft may be written, saved on
 * leaving the cell, frozen when sent); prices that changed since the draft began, with "Take today's prices". No card at all for a
 * reader without the price grain (S1-B9) — the API sends no price to them and refuses one from them (M-CP-2).
 */
function PriceCard({ model, actions }: { model: NewOrderViewModel; actions?: NewOrderActions }) {
  const words = useOrderingWords()
  const dw = useDraftWords()
  const { t } = words
  const record = model.record!
  const request = record.request
  const price = (value: string | null | undefined) => words.price(value, request.currency) ?? '—'
  // Drawn only for a price holder: edit while the draft may be written, else read.
  const access = yourPriceAccess(record.seesPrices, request.status === 'DRAFT' ? model.writeHeld : t('held.notDraft')) === 'edit' ? 'edit' : 'read'
  const rows = priceRowsOf(request, dw.t, words.locale)
  const typed = model.ownPrices ?? {}
  const own = ownTotalOf(rows, typed)
  return (
    <Card padded className="fw-od-pricecard">
      <section className="fw-pno-section" aria-labelledby="od-price-title">
        <h2 id="od-price-title" className="fw-pno-h2">
          {dw.t('price.title')}
        </h2>
            <SummaryTable
              label={dw.t('price.title')}
              density="roomy"
              stackOnPhone
              columns={[dw.t('col.product'), dw.t('price.col')]}
              align={['left', 'right']}
              widths={[undefined, '180px']}
              rows={[
                ...rows.map((row) => ({
                  id: row.id,
                  cells: [
                    // od-fx8 W-17: the product's name whole (it wraps in its cell, never cut).
                    <span key="p" className="fw-od-wrap">{`${row.seq} · ${row.label}`}</span>,
                    <YourPriceCell
                      key="yours"
                      seq={row.seq}
                      access={access}
                      saved={row.yours}
                      typed={typed[row.id]}
                      problem={model.ownPriceProblems?.[row.id] ?? null}
                      currency={request.currency}
                      onType={(text) => actions?.price?.onType?.(row.id, text)}
                      onLeave={() => actions?.price?.onLeave?.(row.id)}
                    />,
                  ],
                })),
              ]}
            />
            {/* od-fx8 W-17: the total under the table (a stacked phone card would repeat the column labels on it). */}
            <p className="fw-od-total">
              <strong>{t('draftPage.price.total')}</strong> {own.total !== null ? <strong>{price(own.total)}</strong> : <span className="fw-pno-quiet">{t('draftPage.price.missing', { count: own.missing })}</span>}
            </p>
            <p className="fw-pno-quiet">{dw.t('price.frozen')}</p>
            {request.pricesChanged > 0 ? (
              <p className="fw-pno-held">
                <AlertTriangle size={14} aria-hidden /> {t('summary.pricesChanged', { count: request.pricesChanged })}
                <Button size="sm" variant="secondary" heldReason={model.writeHeld} onClick={() => actions?.onTakePrices?.()}>
                  {t('summary.takePrices')}
                </Button>
              </p>
            ) : null}
      </section>
    </Card>
  )
}
