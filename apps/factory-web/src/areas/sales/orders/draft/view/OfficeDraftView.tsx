'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { CheckCircle2, Info, PencilLine, Plus, Shirt } from 'lucide-react'
import { Banner, Card, Field, SummaryTable } from '@nexus/ui/components'
import { EndState } from '@nexus/ui/components/EndState/index'
import type { SaveStatusState } from '@nexus/ui/components/SaveStatus/index'
import { Button, Input, Select, Skeleton, Tag } from '@nexus/ui/primitives'
import { Combobox, Modal, useDsWords } from '../../../../../lib/i18n/ds-parts'
import { useT } from '../../../../../lib/i18n/provider'
import { draftTitleOf, draftViewOf, productRowsOf, rowLabelOf, rowProductOf, type HeaderDraft, type HeaderField, type ProductRow } from '../../../../../lib/order-draft/model'
import type { DraftRecord, SavedBy } from '../../../../../lib/order-draft/schema'
import { useDraftWords } from '../../../../../lib/order-draft/words'
import { DraftPage } from '../../../../../lib/order-draft/view/DraftPage'
import { ContinueDrafts, useContinueLine } from '../../../../../lib/order-draft/view/ContinueDrafts'
import { ACCEPT, type FilesBoxActions, type UploadRow } from '../../../../../lib/order-draft/view/files'
import type { ProductsTableActions } from '../../../../../lib/order-draft/view/ProductsTable'
import { OptionsWindow, PiecesWindow, RowFilesWindow, useSizeCopy, type OptionsWindowActions, type PiecesMode, type PiecesWindowActions } from '../../../../../lib/order-draft/view/RowWindows'
import { PersonDialog, type PersonDialogActions } from '../../../../../lib/order-draft/view/PeopleRoster'
import { personProblems, draftFilesOf, customLinesOf, uploadsOpenOf, draftMailName, filesAddHeld, type PersonDraft } from '../../../../../lib/order-draft/model'
import { RecordFrame } from '../../../../_shared/record-frame/RecordFrame'
import { StyleDraftDialog } from '../../../inquiries/view/Dialogs'
import type { ScaleOption, StyleDetail } from '../../../inquiries/api'
import type { StyleDraftDraft } from '../../../inquiries/model'
import type { DraftRow } from '../../../customers/record/drafts/api'
import type { ConfirmAnswer, OfficeRead } from '../api'
import { cardAsksOf, cellsOf, confirmAsOf, confirmHeldOf, missingOf, sizesTextOf, type ConfirmEntry } from '../confirm-model'
import { SizeGridEditor } from '@nexus/ui/grid/size-grid/index'
import { INTL_LOCALE } from '../../../../../lib/i18n/locales'
// ---- owb-of5 step 1 (L3; design § 5i): the order band on the Draft / Sent page — Back that says where it goes, the picture, "number ·
// subject", ONE state chip (the base's StateChip, L9), ONE main button Confirm the order… ----
import { orderLifeOf } from '@nexus/factory-domain/sales/order-life'
import { StateChip } from '../../../../../lib/order-cells/view/StateChip'
import { useBackPlace } from '../../../../../lib/record-frame/use-back'
import type { ReadPictures } from '../../../../../lib/record-picture/cache'
import type { SaveOrderPicture } from '../../../../../lib/record-picture/api'
import type { PictureChoice } from '../../../../../lib/record-picture/order-picture'
import type { RequestBand } from '../../record/band/api'
import { BandPicture, useBackWords } from '../../record/band/view/BandParts'
import { textCardOf } from '../../record/band/model'
import { useFlowWords } from '../../record/flow-words'
// ---- end owb-of5
import './office-draft.css'

/**
 * The office's draft order page (THE SIMPLE ORDER START, od-w2.1–w2.2; R1; 10-design-r1 § 3.7 / § 4): the SAME shared page the portal
 * draws (`DraftPage kind="office"`: the office's voice), in the office's record frame with the draft's office thread (office notes
 * allowed). The start: the customer picked above the mail (one customer: the brand wall), "Continue a draft of {customer}", the quiet
 * links (Type a catalogue order now · a prospect → New request in Incoming). The host cards in ONE row under Still open: Confirm order
 * (what its window will ask, per row; a custom size makes a quote), Design work (Make style draft — today's Incoming window — and the
 * styles made), Price (the price grain only: the customer's own price per row; no cost, no margin). "Missing" lives only in the window.
 */

export interface OfficeDraftModel {
  prefix: string
  load: 'loading' | 'error' | 'missing' | 'ready'
  today: string
  customer: { id: string; code: string; name: string } | null
  start: { customers: { state: 'loading' | 'error' | 'ready'; rows: { id: string; label: string }[] }; partyId: string | null; drafts: { state: 'off' | 'loading' | 'error' | 'ready'; rows: DraftRow[] } } | null
  record: DraftRecord | null
  office: OfficeRead | null
  header: HeaderDraft
  headerErrors: Partial<Record<HeaderField, string>>
  save: SaveStatusState
  writeHeld: string | null
  problem: string | null
  stale: boolean
  staleBy: SavedBy | null
  notice: string | null
  pending: boolean
  styles: readonly { id: string; code: string; name: string }[] | null
  saving: readonly string[]
  uploads: readonly UploadRow[]
  piecesWin: { row: ProductRow; mode: PiecesMode; total: string; cells: Record<string, number>; busy: boolean; failed: string | null } | null
  optionsWin: { row: ProductRow; topic: string; typed: string; addHeld: string | null; busy: boolean; failed: string | null } | null
  filesRow: ProductRow | null
  person: { lineId: string; personId: string | null; draft: PersonDraft; showProblems: boolean; busy: boolean; failed: string | null } | null
  confirm: { entries: Record<string, ConfirmEntry>; busy: boolean; failed: string | null } | null
  details: Readonly<Record<string, StyleDetail>>
  styleWin: { draft: StyleDraftDraft; scales: { status: 'loading' } | { status: 'ready'; value: readonly ScaleOption[] } | { status: 'error'; problem: string }; busy: boolean; failed: string | null; held: string | null } | null
  done: ConfirmAnswer['made'] | null
  mayStyles: boolean
  mayConfirm: boolean
  /** owb-of5: the band of a Draft or Sent order (owb-of1's read; null: not read, or before of1 — the band reads the draft itself). */
  band?: RequestBand | null
  /** owb-of5: the band's picture — the batch read, the save door (null: this reader may not change it), the draft's files that may be it. */
  picture?: { read: ReadPictures | null; save: SaveOrderPicture | null; choices: readonly PictureChoice[] } | null
}

export interface OfficeDraftActions {
  onCustomer?: (partyId: string) => void
  onContinue?: (id: string) => void
  onHeader?: (field: HeaderField, value: string) => void
  onHeaderLeave?: (field: HeaderField) => void
  onReload?: () => void
  onRetry?: () => void
  onRetrySave?: () => void
  onDismissNotice?: () => void
  /** owb-of5: the band's picture saved (the band reads it again). */
  onPictureSaved?: () => void
  files?: FilesBoxActions
  table?: ProductsTableActions
  pieces?: PiecesWindowActions
  options?: OptionsWindowActions
  rowFiles?: FilesBoxActions & { onClose?: () => void }
  person?: PersonDialogActions
  onStillOpen?: (rowId: string | null) => void
  confirm?: { onOpen?: () => void; onStyle?: (rowId: string, styleId: string) => void; onEntry?: (rowId: string, patch: Partial<ConfirmEntry>) => void; onSend?: () => void; onClose?: () => void }
  style?: { onOpen?: () => void; onDraft?: (patch: Partial<StyleDraftDraft>) => void; onSubmit?: () => void; onClose?: () => void }
}

/** `thread`: the draft's office thread (the container's live OfficeRecordThread; a design case passes its own or none). */
export function OfficeDraftView({ model, actions, thread = null }: { model: OfficeDraftModel; actions?: OfficeDraftActions; thread?: ReactNode }) {
  const words = useDraftWords()
  const { t } = words
  const to = useT('orders')
  const ds = useDsWords()
  const continueLine = useContinueLine()
  const record = model.record
  // owb-of5 step 1: Back's place (read before any early return: a hook), its words, the flow's words.
  const backPlace = useBackPlace({ prefix: model.prefix, here: `${model.prefix}/sales/orders/new`, customer: model.customer ? { id: model.customer.id, name: model.customer.name } : null })
  const backWords = useBackWords()
  const f = useFlowWords()
  if (model.load === 'loading') return <Skeleton height={96} />
  if (model.load === 'missing' || model.load === 'error' || (model.load === 'ready' && !record && !model.start)) {
    return (
      <EndState tone="neutral" title={t('refusal.other')} actions={[{ label: to('record.back'), href: `${model.prefix}/sales/orders`, variant: 'primary' as const }]} labels={ds.endState} focusOnMount={false} />
    )
  }
  const back = <Link href={backPlace?.href ?? `${model.prefix}/sales/orders`}>{backWords(backPlace, to('record.back'))}</Link>
  const title = record ? draftTitleOf(record.request, t, words.locale, words.day) : null
  const writeHeld = model.writeHeld ?? (record || model.start?.partyId ? null : t('start.customerHeld'))
  const start = model.start
  const customerName = model.customer?.name ?? start?.customers.rows.find((row) => row.id === start.partyId)?.label ?? ''

  // After Confirm: the order (or the quote, a custom size) — its number and the way to it.
  if (model.done) {
    const quote = model.done.as === 'QUOTE'
    const href = quote ? (model.done.quoteId ? `${model.prefix}/sales/quotes/${encodeURIComponent(model.done.quoteId)}` : null) : model.done.salesOrderId ? `${model.prefix}/sales/orders/${encodeURIComponent(model.done.salesOrderId)}` : null
    return (
      <EndState
        title={t(quote ? 'cf.doneQuote' : 'cf.done', { number: model.done.number })}
        next={quote ? [t('cf.quoteNext')] : []}
        actions={href ? [{ label: t(quote ? 'cf.openQuote' : 'cf.open'), href, variant: 'primary' as const }] : []}
        labels={ds.endState}
      />
    )
  }

  // owb-of5 step 2: an order that came as text (the customer's words, a line in its own words) and a line still without a product.
  const textOrder = !!record && textCardOf(record.request) !== null && productRowsOf(record.request).some((row) => row.style === null)
  const page = (
    <DraftPage
      kind="office"
      model={{
        draft: record ? draftViewOf(record) : null,
        today: model.today,
        header: model.header,
        headerErrors: model.headerErrors,
        save: model.save,
        writeHeld,
        addAddressHeld: writeHeld,
        problem: model.problem,
        stale: model.stale,
        staleBy: model.staleBy,
        notice: model.notice ? { lines: [model.notice], undo: false } : null,
        offlineSince: null,
        pending: model.pending,
        styles: model.styles,
        saving: model.saving,
        uploads: model.uploads,
        keys: [{ keys: ['⌘', '↵'], words: t('cf.go') }],
        customer: model.customer?.name ?? null,
      }}
      actions={{
        onHeader: actions?.onHeader,
        onHeaderLeave: actions?.onHeaderLeave,
        onReload: actions?.onReload,
        onRetrySave: actions?.onRetrySave,
        onDismissNotice: actions?.onDismissNotice,
        files: actions?.files,
        table: actions?.table,
        onStillOpen: (entry) => actions?.onStillOpen?.(entry.rowId),
      }}
      onSendKey={() => (model.mayConfirm && record ? actions?.confirm?.onOpen?.() : undefined)}
      slots={{
        above: start ? (
          <Card padded>
            <div className="fw-od-section">
              <span id="od-customer" className="fw-od-label">
                {t('start.customer')}
              </span>
              {/* od-fx8 W-08: a reader (no orders.manage) starts nothing: said in words, and no customer is read. */}
              {model.writeHeld ? (
                <p className="fw-od-held">{model.writeHeld}</p>
              ) : start.customers.state === 'error' ? (
                <p className="fw-od-held">{t('refusal.other')}</p>
              ) : (
                <Combobox options={start.customers.rows.map((row) => ({ value: row.id, label: row.label }))} value={start.partyId ?? ''} labelledBy="od-customer" onChange={(value) => actions?.onCustomer?.(value)} />
              )}
              {model.writeHeld ? null : <p className="fw-od-quiet">{start.partyId ? t('start.customerHint') : t('start.customerHeld')}</p>}
            </div>
          </Card>
        ) : textOrder ? (
          // owb-of5 step 2 (design § 5g; prototype rec.js notice): ONE notice — an order that came as text: read it, pick each line's product, then confirm.
          <Banner tone="info" title={f('text.notice')} />
        ) : null,
        continueSlot: start ? (
          <ContinueDrafts
            title={t('start.continue', { customer: customerName })}
            rows={start.drafts.rows.map((row) => ({ id: row.id, title: row.draft?.title ?? t('head.untitled', { date: '' }).trim(), line: continueLine({ openCount: row.draft?.openCount, savedAt: row.draft?.lastEditedAt }, row.draft?.lastEditedBy ?? '') }))}
            onOpen={(id) => actions?.onContinue?.(id)}
            foot={
              <>
                {/* od-fx8 W-28: today's typed editor (the orders list's New order window, its customer picked) — for a writer, once the
                    customer is picked; a reader never sees it. */}
                {!model.writeHeld && start.partyId ? (
                  <Link href={`${model.prefix}/sales/orders?new=1&party=${encodeURIComponent(start.partyId)}`}>
                    <PencilLine size={14} aria-hidden /> {t('start.typed')}
                  </Link>
                ) : null}
                <span className="fw-od-quiet">
                  {t('start.prospect')} {/* od-w2.7: Incoming reads `party` as its list filter, never as New request's customer: the link opens New request alone. */}
                  <Link href={`${model.prefix}/sales/incoming?new=1`}>{t('start.request')}</Link>
                </span>
              </>
            }
          />
        ) : null,
        cards: record ? <HostCards model={model} actions={actions} record={record} /> : null,
        actionBar: record ? <ConfirmButton model={model} actions={actions} rows={productRowsOf(record.request).length} /> : null,
        dialogs: <Windows model={model} actions={actions} record={record} />,
      }}
    />
  )
  // ---- owb-of5 step 1: the band's facts — its number (Sent), its life (the band read's, else the draft's own status), its main button
  const number = model.band?.number ?? record?.request.number ?? null
  const life = model.band ? { life: model.band.life, note: null } : orderLifeOf({ request: { status: record?.request.status ?? 'DRAFT' } })
  const rowCount = record ? productRowsOf(record.request).length : 0
  // A button this reader may not use is not drawn (orders.manage: the band read's may.confirm, else the office read's); held while no row.
  const mayConfirmRight = model.band ? model.band.may.confirm : (model.office?.may.confirm ?? model.writeHeld === null)
  const confirmable = !!record && (record.request.status === 'DRAFT' || record.request.status === 'SENT') && mayConfirmRight
  const confirmHeld = model.writeHeld ?? (rowCount === 0 ? t('cf.noRows') : null)
  // ---- end owb-of5
  // od-fx8 W-20: the start has its own band, "‹ Orders · New order" (no thread before the first save).
  if (!record)
    return (
      <RecordFrame recordType="PortalOrderRequest" personId={null} threadLabel={t('thread.title')} thread={null} band={{ back, title: to('newOrder.pageTitle') }}>
        {page}
      </RecordFrame>
    )
  return (
    <RecordFrame
      recordType="PortalOrderRequest"
      personId={null}
      threadLabel={t('thread.title')}
      thread={thread}
      band={{
        back,
        // owb-of5: "number · subject" once the order has its number (Sent); a draft keeps its title.
        title: number ? `${number} · ${title ?? ''}` : t('head.title', { title: title ?? '' }),
        meta: model.customer ? <span className="fw-od-quiet">{model.customer.name}</span> : undefined,
        // owb-of5 (L9): ONE state chip — the order's life (Draft · Sent …) through the base's orderLifeOf and StateChip.
        status: <StateChip life={life.life} note={life.note} />,
        ...(model.picture
          ? {
              picture: (
                <BandPicture
                  source="portalOrder"
                  recordId={record.request.id}
                  number={number ?? title ?? ''}
                  subject={title}
                  version={model.band?.version ?? record.request.version}
                  fileId={model.band?.picture?.fileId ?? null}
                  read={model.picture.read}
                  save={model.picture.save}
                  choices={model.picture.choices}
                  onSaved={actions?.onPictureSaved}
                />
              ),
            }
          : {}),
        // owb-of5: the ONE main button — Confirm the order… (the window below; held in words while it cannot confirm).
        primary: confirmable ? (
          <Button size="sm" variant="primary" heldReason={confirmHeld} onClick={() => actions?.confirm?.onOpen?.()} aria-keyshortcuts="Meta+Enter Control+Enter">
            {f('act.confirm')}
          </Button>
        ) : undefined,
      }}
    >
      {page}
    </RecordFrame>
  )
}

/** The office's own cards: Confirm order, Design work, Price (the price grain only). */
function HostCards({ model, actions, record }: { model: OfficeDraftModel; actions?: OfficeDraftActions; record: DraftRecord }) {
  const { t } = useDraftWords()
  const say = useT('sales-inquiries')
  const rows = productRowsOf(record.request)
  const asks = cardAsksOf(record.request.stillOpen, rows, t) // od-fx8 W-05: what the ORDER still lacks (od-fx7 confirmReady)
  const custom = rows.find((row) => row.sizing === 'MADE_TO_MEASURE')
  const styles = model.office?.request.styles ?? []
  return (
    <>
      <Card padded>
        <section className="fw-od-section" aria-labelledby="od-confirm-title">
          <h2 id="od-confirm-title" className="fw-od-h2">
            {t('cf.title')}
          </h2>
          <p className="fw-od-quiet">{t('cf.body')}</p>
          <span className="fw-od-label">{t('cf.asksTitle')}</span>
          {asks.length === 0 ? (
            <p className="fw-od-quiet">
              <CheckCircle2 size={14} aria-hidden /> {t('cf.nothingAsked')}
            </p>
          ) : (
            <ul className="fw-od-notes">
              {asks.map((ask) => (
                <li key={ask.id}>
                  <strong>{ask.label}</strong>: {ask.needs.map((key) => t(key)).join(', ')}
                </li>
              ))}
            </ul>
          )}
          {custom ? (
            <p className="fw-od-quiet">
              <Info size={14} aria-hidden /> {t('cf.quote', { seq: custom.seq })}
            </p>
          ) : null}
          <p className="fw-od-quiet">
            <Info size={14} aria-hidden /> {t('cf.choices')}
          </p>
          <ConfirmButton model={model} actions={actions} rows={rows.length} className="fw-od-hostgo" variant="secondary" />
        </section>
      </Card>
      <Card padded>
        <section className="fw-od-section" aria-labelledby="od-design-title">
          <h2 id="od-design-title" className="fw-od-h2">
            {t('dw.title')}
          </h2>
          {styles.length === 0 ? (
            <p className="fw-od-quiet">{t('dw.none')}</p>
          ) : (
            <ul className="fw-od-notes">
              {styles.map((style) => (
                <li key={style.id}>
                  <Shirt size={14} aria-hidden /> {t('line.styleDraft', { code: style.code, name: style.name, status: STYLE_STATUS_WORDS.has(style.status) ? t(`dw.status.${style.status}`) : '' })}
                </li>
              ))}
            </ul>
          )}
          <p className="fw-od-quiet">{t('dw.seen')}</p>
          <span>
            {/* od-fx8 W-06 (plan 6.4 a): held ONLY by the styles right — the Production manager presses it while reading the order. */}
            <Button variant="secondary" heldReason={model.mayStyles ? null : say('held.needs', { right: say('right.product.styles.manage') })} onClick={() => actions?.style?.onOpen?.()}>
              <Plus size={14} aria-hidden /> {t('dw.make')}
            </Button>
          </span>
        </section>
      </Card>
      {record.seesPrices && rows.length > 0 ? <PriceCard record={record} rows={rows} /> : null}
    </>
  )
}

/** The ONE "Confirm order…" button (it opens the window; od-fx8 W-26: the window's final button says "as a quote"): in its card, and
 * (od-w2.6) in the page's sticky bar on a phone. */
// owb-of5: the band holds the page's ONE filled button (Confirm the order…); the host card's own door is a plain button now.
function ConfirmButton({ model, actions, rows, className, variant = 'primary' }: { model: OfficeDraftModel; actions?: OfficeDraftActions; rows: number; className?: string; variant?: 'primary' | 'secondary' }) {
  const { t } = useDraftWords()
  return (
    <Button variant={variant} heldReason={model.writeHeld ?? (rows === 0 ? t('cf.noRows') : !model.mayConfirm ? t('save.readonly') : null)} onClick={() => actions?.confirm?.onOpen?.()} {...(className ? { className } : {})}>
      {t('cf.go')}
    </Button>
  )
}

const STYLE_STATUS_WORDS: ReadonlySet<string> = new Set(['DRAFT', 'ACTIVE', 'ARCHIVED'])

/** Price (the price grain only): the customer's own price per row; a new style has no list price — it is typed at Confirm. */
function PriceCard({ record, rows }: { record: DraftRecord; rows: readonly ProductRow[] }) {
  const { t, locale } = useDraftWords()
  const own = (rowId: string): string | null => record.request.lines.find((line) => line.id === rowId)?.brandUnitPrice ?? customLinesOf(record.request).find((line) => line.id === rowId)?.brandUnitPrice ?? null
  const money = (value: string | null) => (value === null ? '—' : new Intl.NumberFormat(locale === 'it' ? 'it-IT' : 'en-GB', { style: 'currency', currency: record.request.currency }).format(Number(value)))
  return (
    <Card padded className="fw-od-pricecard">
      <section className="fw-od-section" aria-labelledby="od-price-title">
        <h2 id="od-price-title" className="fw-od-h2">
          {t('pm.title')}
        </h2>
        <SummaryTable
          label={t('pm.theirs')}
          density="roomy"
          stackOnPhone
          columns={[t('col.product'), t('pm.theirs')]}
          align={['left', 'right']}
          rows={rows.map((row) => ({ id: row.id, cells: [<span key="p" className="fw-od-wrap">{`${row.seq} · ${rowProductOf(row) ?? t('state.OPEN')}`}</span>, money(own(row.id))] }))}
        />
        <p className="fw-od-quiet">{t('pm.noList')}</p>
      </section>
    </Card>
  )
}

/** The centred windows: a row's Pieces, Options, Files; a person; the Confirm window; Make style draft. */
function Windows({ model, actions, record }: { model: OfficeDraftModel; actions?: OfficeDraftActions; record: DraftRecord | null }) {
  const { t } = useDraftWords()
  if (!record) return null
  const view = draftViewOf(record)
  const fileCap = filesAddHeld(record.request, { preview: false, offline: false, busy: false })
  const rosterLine = model.piecesWin ? (view.request.customLines?.find((line) => line.id === model.piecesWin!.row.id && line.byPerson) ?? null) : null
  const line = model.person ? customLinesOf(record.request).find((entry) => entry.id === model.person!.lineId) : undefined
  const sheets = draftFilesOf(record.request).sheets
  return (
    <>
      {model.piecesWin ? (
        <PiecesWindow
          model={{ ...model.piecesWin, roster: { draft: view, writeHeld: model.writeHeld, uploadsOpen: uploadsOpenOf(record.request), addHeld: fileCap ? t(fileCap) : null, draftName: draftMailName(record.request, t) }, rosterLine, writeHeld: model.writeHeld }}
          actions={actions?.pieces}
        />
      ) : null}
      {model.optionsWin ? <OptionsWindow model={{ ...model.optionsWin, writeHeld: model.writeHeld }} actions={actions?.options} /> : null}
      {model.filesRow ? (
        <RowFilesWindow
          model={{ row: model.filesRow, files: { files: model.filesRow.files, uploading: model.uploads.filter((row) => row.lineId === model.filesRow!.id), open: uploadsOpenOf(record.request), addHeld: model.writeHeld ?? (fileCap ? t(fileCap) : null), removeHeld: model.writeHeld, draftName: draftMailName(record.request, t), dropKey: 'mail.drop', accept: model.filesRow.sizing === 'MADE_TO_MEASURE' ? ACCEPT.SHEET : ACCEPT.REFERENCE } }}
          actions={actions?.rowFiles}
          onClose={actions?.rowFiles?.onClose}
        />
      ) : null}
      {model.person && line ? (
        <PersonDialog
          model={{ mode: model.person.personId ? 'change' : 'add', seq: line.seq, name: model.person.personId ? (line.people.find((entry) => entry.id === model.person!.personId)?.name ?? null) : null, draft: model.person.draft, problems: personProblems(model.person.draft, sheets), showProblems: model.person.showProblems, sheets, busy: model.person.busy, failed: model.person.failed }}
          actions={actions?.person}
        />
      ) : null}
      {model.confirm ? <ConfirmWindow model={model} actions={actions} record={record} /> : null}
      {model.styleWin ? (
        <StyleDraftDialog
          model={{
            subject: { key: 'dialog.subject', params: { number: draftTitleOf(record.request, t), from: model.customer?.name ?? '' } },
            customer: model.customer?.name ?? '',
            draft: model.styleWin.draft,
            scales: model.styleWin.scales,
            files: [],
            held: model.styleWin.held ? { key: model.styleWin.held } : null,
            busy: model.styleWin.busy,
            notice: model.styleWin.failed ? { key: model.styleWin.failed, tone: 'danger' } : null,
          }}
          actions={actions?.style}
        />
      ) : null}
    </>
  )
}

/** The Confirm window: one section per row — what it already has, and what the order still needs (Missing), typed here. */
function ConfirmWindow({ model, actions, record }: { model: OfficeDraftModel; actions?: OfficeDraftActions; record: DraftRecord }) {
  const { t, locale } = useDraftWords()
  const copy = useSizeCopy()
  const confirm = model.confirm!
  const rows = productRowsOf(record.request)
  const quote = confirmAsOf(rows) === 'QUOTE'
  const held = confirmHeldOf(rows, confirm.entries)
  const title = draftTitleOf(record.request, t)
  const styles = model.styles ?? []
  const travel = rows.flatMap((row) => row.choices.map((choice) => `${choice.topic}: ${choice.picked ?? t('state.OPEN')}`))
  const missing = <Tag tone="danger">{t('state.MISSING')}</Tag>
  return (
    <Modal
      open
      sheet
      size="lg"
      onClose={() => actions?.confirm?.onClose?.()}
      title={t(quote ? 'cf.windowQuote' : 'cf.window', { title })}
      footer={
        <>
          <Button variant="secondary" onClick={() => actions?.confirm?.onClose?.()} disabled={confirm.busy}>
            {t('pc.cancel')}
          </Button>
          <Button variant="primary" heldReason={model.writeHeld ?? (confirm.busy ? t('save.saving') : held ? (held.seq === 0 ? t('cf.noRows') : t('cf.heldRow', { seq: held.seq, list: held.needs.map((key) => t(key)).join(', ') })) : null)} onClick={() => actions?.confirm?.onSend?.()}>
            {quote ? t('cf.goQuote') : t('cf.title')}
          </Button>
        </>
      }
    >
      <div className="fw-od-dialog">
        {confirm.failed ? <Banner tone="danger" title={confirm.failed} /> : null}
        {quote ? <Banner tone="info" title={t('cf.quote', { seq: rows.find((row) => row.sizing === 'MADE_TO_MEASURE')!.seq })} /> : null}
        {rows.map((row) => {
          const entry = confirm.entries[row.id]
          if (!entry) return null
          const needs = missingOf(row, entry)
          const colours = entry.styleId ? (model.details[entry.styleId]?.colourways ?? []).filter((colourway) => colourway.status === 'ACTIVE') : []
          const colour = colours.find((colourway) => colourway.id === entry.colourwayId) ?? null
          const offered = colour?.offeredSizes ?? []
          return (
            <section key={row.id} className="fw-od-section fw-od-confirmrow" aria-label={rowLabelOf(row, t)}>
              <div className="fw-od-parthead">
                <strong>{rowLabelOf(row, t)}</strong>
                {row.sizing ? <Tag tone="info">{t(`siz.${row.sizing}`)}</Tag> : null}
                {needs.length === 0 ? <Tag tone="success">{t('state.DECIDED')}</Tag> : null}
              </div>
              {entry.needs ? (
                <div className="fw-od-fields">
                  <Field label={<>{t('row.style')} {!entry.styleId ? missing : null}</>}>
                    <Select value={entry.styleId ?? ''} onChange={(event) => actions?.confirm?.onStyle?.(row.id, event.target.value)}>
                      <option value="">{t('cf.pickStyle')}</option>
                      {styles.map((style) => (
                        <option key={style.id} value={style.id}>
                          {style.code} · {style.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label={<>{t('col.colour')} {!entry.colourwayId ? missing : null}</>}>
                    <Select value={entry.colourwayId ?? ''} disabled={!entry.styleId} onChange={(event) => actions?.confirm?.onEntry?.(row.id, { colourwayId: event.target.value || null })}>
                      <option value="">{t('cf.pickColour')}</option>
                      {colours.map((colourway) => (
                        <option key={colourway.id} value={colourway.id}>
                          {colourway.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label={<>{t('pc.sizesCaption')} {needs.includes('need.pieces') ? missing : null}</>} hint={row.pieces.mode === 'PEOPLE' ? t('cf.fromPeople', { count: row.pieces.people }) : entry.styleId ? undefined : t('cf.sizesAfterStyle')}>
                    {/* od-w2.5: the style's size grid once a colour with its sizes is picked; typed only when the style has no size chart. */}
                    {offered.length > 0 && colour ? (
                      <SizeGridEditor
                        layout="auto"
                        colours={[{ key: row.id, label: colour.name, offered: [...offered] }]}
                        sizes={offered.map((size) => ({ key: size, label: size }))}
                        value={{ [row.id]: cellsOf(entry.sizesText) }}
                        onChange={(next) => actions?.confirm?.onEntry?.(row.id, { sizesText: sizesTextOf(next[row.id] ?? {}) })}
                        issues={[]}
                        caption={`${t('pc.sizesCaption')} · ${rowLabelOf(row, t)}`}
                        locale={INTL_LOCALE[locale]}
                        copy={copy}
                      />
                    ) : (
                      <Input value={entry.sizesText} placeholder="48:2 50:3" disabled={entry.styleId !== null && entry.colourwayId === null} onChange={(event) => actions?.confirm?.onEntry?.(row.id, { sizesText: event.target.value })} />
                    )}
                  </Field>
                  {record.seesPrices ? (
                    <Field label={t('cf.unit')}>
                      <Input value={entry.unitPrice} inputMode="decimal" onChange={(event) => actions?.confirm?.onEntry?.(row.id, { unitPrice: event.target.value })} />
                    </Field>
                  ) : null}
                </div>
              ) : (
                <div className="fw-od-fields">
                  <p className="fw-od-quiet">
                    {t('cf.fromDraft')}: {entry.sizesText.replace(/:/g, ' × ')}
                  </p>
                  {record.seesPrices ? (
                    <Field label={`${t('cf.unit')} · ${t('cf.listPrice')}`}>
                      <Input value={entry.unitPrice} inputMode="decimal" onChange={(event) => actions?.confirm?.onEntry?.(row.id, { unitPrice: event.target.value })} />
                    </Field>
                  ) : null}
                </div>
              )}
            </section>
          )
        })}
        {travel.length > 0 ? <p className="fw-od-quiet">{t(quote ? 'cf.travelQuote' : 'cf.travel', { words: travel.join(' · ') })}</p> : null}
      </div>
    </Modal>
  )
}
