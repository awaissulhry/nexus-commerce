'use client'

import type { ReactNode } from 'react'
import { Eye, PencilLine, RefreshCw, WifiOff } from 'lucide-react'
import { holdsSend } from '@nexus/factory-domain/sales/portal-ordering/rules'
import { Banner, Field } from '@nexus/ui/components'
import { SaveStatus, type SaveStatusState } from '@nexus/ui/components/SaveStatus/index'
import { Button, Input, Select } from '@nexus/ui/primitives'
import { DateField, useDsWords } from '../../i18n/ds-parts'
import { ListKeysInfo } from '../../../list-frame/ListKeysInfo'
import { draftBannerOf, draftFilesOf, draftMailName, filesAddHeld, problemWords, productRowsOf, savedByWords, shipToOptions, stillOpenEntries, uploadsOpenOf, type DraftView, type HeaderDraft, type HeaderField, type StillOpenEntry } from '../model'
import type { SavedBy } from '../schema'
import { DraftDoorProvider, useDraftWords, type DraftDoor } from '../words'
import { ACCEPT, type FilesBoxActions, type UploadRow } from './files'
import { OrderMail } from './OrderMail'
import type { ProductsTableActions } from './ProductsTable'
import { StillOpen } from './StillOpen'
// owb-po3.1: the ONE lines table (lib/order-lines) replaces the products table's columns; the office's actions keep working (adapter).
import { Card } from '@nexus/ui/components'
import { Tag } from '@nexus/ui/primitives'
import { lineRowsOfDraft, ownColumnsOfRecord, type LinePrices, type LineRow, type ModelStyle, type NewDesignKind } from '../../order-lines/model'
import { OrderLinesTable, type OrderLinesActions } from '../../order-lines/view/OrderLinesTable'
import '../order-draft.css'

/**
 * The ONE draft order's page (THE SIMPLE ORDER START R1; 10-design-r1 § 1–§ 4) — the same part in both doors, from the start to Send /
 * Confirm: ONE banner by weight, the head's meta line, the MAIL (Subject · Message · Attachments), the PRODUCTS table, Date and
 * delivery, Still open (information only) and the host's own cards in ONE row under it, the keys in ONE information icon at the foot.
 * The start is the same page before its first save (`draft` null): the mail and an empty table, nothing required, no Start button —
 * the first input makes the draft; the host adds what continues a draft under it (`continueSlot`). No frame, no band, no thread, no
 * price: each host draws its frame around it, gives its commands through `actions`, its own cards through `cards` (money lives only
 * there), its windows through `dialogs`. `kind` picks the door's whole word set.
 */

export interface DraftPageModel {
  /** The draft without a single price (`draftViewOf`); null = the start, before its first save. */
  draft: DraftView | null
  /** Today in the site's zone: the earliest requested date. */
  today: string
  header: HeaderDraft
  /** Field → a key of the part's words. */
  headerErrors: Partial<Record<HeaderField, string>>
  save: SaveStatusState
  /** Why nothing can be written now (words), or null. */
  writeHeld: string | null
  /** "Add a new address": held with the reason (words), or null. */
  addAddressHeld: string | null
  /** A refusal in the host's words, or null. */
  problem: string | null
  /** The draft changed elsewhere while something was typed here. */
  stale: boolean
  /** Who changed it meanwhile (a colleague by name; any office save is "the factory" on the portal), or null. */
  staleBy?: SavedBy | null
  notice: { lines: readonly string[]; undo: boolean } | null
  offlineSince: string | null
  /** "Add a product" drew a row that is not saved yet. */
  pending: boolean
  /** The styles the Model cell offers (the customer's catalogue; `ownLabel` absent = Your designs); null while not read. */
  styles: readonly { readonly id: string; readonly code: string; readonly name: string; readonly ownLabel?: boolean; readonly colours?: ModelStyle['colours'] }[] | null
  /** owb-po3: "A new design: …" kinds (absent: the draft's made-to-measure garment types). */
  kinds?: readonly NewDesignKind[]
  /** owb-po3: money for the Your price column (a host with the price grain); absent or null: no column, no price key. */
  prices?: LinePrices | null
  /** owb-po3: the "Columns · n…" door (the host opens "Columns of your own"). */
  columnsDoor?: boolean
  /** owb-po3: a line's refusal said on leaving its field (line id → words). */
  lineRefusals?: Readonly<Record<string, string>>
  /** Rows being saved. */
  saving: readonly string[]
  /** The files going up now, or that did not go (their words). */
  uploads: readonly UploadRow[]
  /** The keys of the page (the ONE information icon at the foot). */
  keys: readonly { keys: string[]; words: string }[]
  /** od-fx8 W-09: the office's customer name ("Saved 11:20 by Bianca Brand (Seed Racing)"); the portal passes none. */
  customer?: string | null
}

export interface DraftPageActions {
  onHeader?: (field: HeaderField, value: string) => void
  onHeaderLeave?: (field: HeaderField) => void
  onAddAddress?: () => void
  onUndo?: () => void
  onDismissNotice?: () => void
  onReload?: () => void
  onRetrySave?: () => void
  /** The mail's Attachments (the draft's own files). */
  files?: FilesBoxActions
  /** The office's products-table actions (kept): mapped onto the ONE lines table when `lines` is not given. */
  table?: ProductsTableActions
  /** owb-po3: the ONE lines table's own actions (they win over `table`). */
  lines?: OrderLinesActions
  /** A Still open item: the focus moves to its row (or the date card). */
  onStillOpen?: (entry: StillOpenEntry) => void
}

export interface DraftPageSlots {
  /** The office's customer picker, above the mail (the start). */
  above?: ReactNode
  /** The host's panels between the mail and the table (the portal's past orders and sheet). */
  panels?: ReactNode
  /** Under the table, beside "Add a product" (the portal's "Add from: catalogue · a past order · a sheet"). */
  addFrom?: ReactNode
  /** The start: "Continue a draft" under the table. */
  continueSlot?: ReactNode
  /** The host's own cards (Send · Your price / Confirm · Design work · Price), in ONE row under Still open. */
  cards?: ReactNode
  /** od-w2.6: on a phone the host's Send / Confirm sits in a sticky bar at the foot (its card's own button hides there). */
  actionBar?: ReactNode
  dialogs?: ReactNode
}

export function DraftPage({ kind, model, actions, slots, onSendKey }: { kind: DraftDoor; model: DraftPageModel; actions?: DraftPageActions; slots?: DraftPageSlots; onSendKey?: () => void }) {
  return (
    <DraftDoorProvider door={kind}>
      <DraftBody model={model} actions={actions} slots={slots} onSendKey={onSendKey} />
      {slots?.dialogs}
    </DraftDoorProvider>
  )
}

function DraftBody({ model, actions, slots, onSendKey }: { model: DraftPageModel; actions?: DraftPageActions; slots?: DraftPageSlots; onSendKey?: () => void }) {
  const words = useDraftWords()
  const { t, door } = words
  const ds = useDsWords()
  const request = model.draft?.request ?? null
  const banner = draftBannerOf({ offline: model.offlineSince !== null, stale: model.stale, refused: model.problem !== null, notice: model.notice !== null, problems: 0 })
  const rows = request ? productRowsOf(request, words.locale) : []
  const files = request ? draftFilesOf(request) : null
  const capKey = request ? filesAddHeld(request, { preview: false, offline: false, busy: false }) : null
  const own = files ? [...files.logos, ...files.references].filter((file) => file.lineId === null) : []
  const entries = request ? stillOpenEntries(request.stillOpen, rows, t) : []
  // od-fx12: only an INVALID value is said (the domain's holdsSend) — a missing one (NO_LINES: "Add at least one line.") never shows:
  // nothing is required (R1).
  const headerProblems = request ? request.problems.filter((problem) => problem.lineId === null && holdsSend(problem.code)) : []
  const saved = model.save.kind === 'saving' || model.save.kind === 'failed'
  return (
    <div
      className="fw-od fw-od-draft"
      onKeyDown={(event) => {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && onSendKey) {
          event.preventDefault()
          onSendKey()
        }
      }}
    >
      {/* ONE banner, by weight. */}
      {banner === 'offline' && model.offlineSince ? <Banner tone="warning" icon={<WifiOff size={16} aria-hidden />} title={t('offline.title', { time: words.time(model.offlineSince) })} /> : null}
      {banner === 'stale' ? (
        <Banner
          tone="warning"
          title={t('draft.stale')}
          action={
            <Button size="sm" onClick={() => actions?.onReload?.()}>
              <RefreshCw size={14} aria-hidden /> {t('draft.reload')}
            </Button>
          }
        >
          {model.staleBy ? <p>{model.staleBy.who === 'FACTORY' && door === 'portal' ? t('save.changedByFactory') : t('draftPage.changedBy', { name: model.staleBy.name ?? '' })}</p> : null}
        </Banner>
      ) : null}
      {banner === 'refused' && model.problem ? <Banner tone="danger" title={model.problem} /> : null}
      {banner === 'notice' && model.notice ? (
        <Banner
          tone="success"
          title={model.notice.lines[0]}
          action={
            <span className="fw-od-buttons">
              {model.notice.undo ? (
                <Button size="sm" variant="secondary" heldReason={model.writeHeld} onClick={() => actions?.onUndo?.()}>
                  {t('notice.undo')}
                </Button>
              ) : null}
              <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
                {t('notice.hide')}
              </Button>
            </span>
          }
        >
          {model.notice.lines.length > 1 ? (
            <ul className="fw-od-notes">
              {model.notice.lines.slice(1).map((line, index) => (
                <li key={index}>{line}</li>
              ))}
            </ul>
          ) : null}
        </Banner>
      ) : null}
      {/* The head's meta line: who reads it (portal), the design started (portal), when and by whom it was saved. */}
      <div className="fw-od-draftmeta">
        {door === 'portal' && request ? (
          <span className="fw-od-shared">
            <Eye size={14} aria-hidden /> {t('head.shared')}
            {request.designStarted ? (
              <strong className="fw-od-design">
                <PencilLine size={14} aria-hidden /> {t('head.design')}
              </strong>
            ) : null}
          </span>
        ) : (
          <span />
        )}
        {saved ? (
          <SaveStatus state={model.save} formatTime={words.time} labels={ds.saveStatus} onRetry={actions?.onRetrySave} retryHeld={model.writeHeld} />
        ) : (
          <span className="fw-od-quiet" role="status">
            {request ? savedByWords(request, t, { time: words.time, day: words.day, today: model.today, door, customer: model.customer ?? null }) : t('save.notYet')}
          </span>
        )}
      </div>
      {slots?.above}
      <OrderMail
        model={{
          start: request === null,
          header: model.header,
          headerErrors: model.headerErrors,
          writeHeld: model.writeHeld,
          attachments: {
            files: own,
            logos: files ? files.logos.map((file) => file.id) : [],
            uploading: model.uploads.filter((row) => !row.lineId),
            open: request ? uploadsOpenOf(request) : true,
            addHeld: model.writeHeld ?? (capKey ? t(capKey) : null),
            removeHeld: model.writeHeld,
            draftName: request ? draftMailName(request, t) : '',
            dropKey: 'mail.drop',
            accept: ACCEPT.REFERENCE,
          },
        }}
        actions={{ onHeader: actions?.onHeader, onHeaderLeave: actions?.onHeaderLeave, files: actions?.files }}
      />
      {slots?.panels}
      <LinesCard model={model} request={request} actions={actions} below={slots?.addFrom} door={door} />
      {request ? (
        <>
          <DateCard model={model} actions={actions} problems={headerProblems.map((problem) => problemWords(problem, [], { t, price: () => null, locale: words.locale }))} />
          <StillOpen entries={entries} openCount={request.stillOpen?.openCount ?? entries.length} noProducts={rows.length === 0} onGo={actions?.onStillOpen} />
          {slots?.cards ? <div className="fw-od-hostrow">{slots.cards}</div> : null}
          {/* review G3: the page's keys in ONE information icon at its foot, never as hints above the cards. */}
          <div className="fw-od-draftfoot">
            <ListKeysInfo keys={model.keys.map((entry) => ({ keys: entry.keys, does: entry.words }))} />
          </div>
          {slots?.actionBar ? <div className="fw-od-actionbar">{slots.actionBar}</div> : null}
        </>
      ) : (
        slots?.continueSlot
      )}
    </div>
  )
}

/** Date and delivery: the date wanted, their PO, ship-to with "Add a new address" — each saved on leaving the field. */
function DateCard({ model, actions, problems }: { model: DraftPageModel; actions?: DraftPageActions; problems: readonly string[] }) {
  const { t } = useDraftWords()
  const options = shipToOptions(model.draft?.addresses ?? [], model.header.shipToAddressId || null)
  const chosen = options.find((option) => option.id === model.header.shipToAddressId)
  const error = (field: HeaderField) => (model.headerErrors[field] ? t(model.headerErrors[field]!) : undefined)
  const held = model.writeHeld !== null
  return (
    <Card padded>
      <section className="fw-od-section" id="od-date" tabIndex={-1} aria-labelledby="od-date-title">
        <h2 id="od-date-title" className="fw-od-h2">
          {t('date.title')}
        </h2>
        <div className="fw-od-fields">
          <Field label={t('row.date')} error={error('requestedDate')}>
            <DateField
              value={model.header.requestedDate}
              min={model.today}
              clearable
              disabled={held}
              onChange={(value) => {
                actions?.onHeader?.('requestedDate', value)
                actions?.onHeaderLeave?.('requestedDate')
              }}
            />
          </Field>
          <Field label={t('date.ref')} error={error('customerRef')}>
            <Input value={model.header.customerRef} maxLength={100} disabled={held} onChange={(event) => actions?.onHeader?.('customerRef', event.target.value)} onBlur={() => actions?.onHeaderLeave?.('customerRef')} />
          </Field>
          <Field
            label={t('row.shipTo')}
            hint={chosen?.state === 'WAITING' ? t('head.shipToWaiting') : chosen?.state === 'ARCHIVED' ? t('head.shipToGone') : options.length === 0 ? t('head.shipToNone') : undefined}
            error={error('shipToAddressId')}
          >
            <div className="fw-od-shipto">
              <Select
                value={model.header.shipToAddressId}
                disabled={held}
                onChange={(event) => {
                  actions?.onHeader?.('shipToAddressId', event.target.value)
                  actions?.onHeaderLeave?.('shipToAddressId')
                }}
              >
                <option value="">{t('head.shipToChoose')}</option>
                {options.map((option) => (
                  <option key={option.id} value={option.id}>
                    {[option.name, option.line].filter(Boolean).join(' — ')}
                    {option.isDefault ? ` (${t('head.default')})` : option.state === 'WAITING' ? ` (${t('head.waiting')})` : option.state === 'ARCHIVED' ? ` (${t('head.archived')})` : ''}
                  </option>
                ))}
              </Select>
              <Button variant="secondary" heldReason={model.addAddressHeld} onClick={() => actions?.onAddAddress?.()}>
                {t('head.addAddress')}
              </Button>
            </div>
          </Field>
        </div>
        {problems.length > 0 ? (
          <ul className="fw-od-notes">
            {problems.map((words, index) => (
              <li key={index} className="fw-od-note is-danger">
                {words}
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </Card>
  )
}

/** The draft's ONE lines table (owb-po3): its rows, its mode, the office's products-table actions mapped onto it when no `lines`. */
function LinesCard({ model, request, actions, below, door }: { model: DraftPageModel; request: DraftView['request'] | null; actions?: DraftPageActions; below?: ReactNode; door: DraftDoor }) {
  const { t, locale } = useDraftWords()
  const styles: ModelStyle[] = (model.styles ?? []).map((style) => ({ id: style.id, code: style.code, name: style.name, ownLabel: style.ownLabel ?? true, ...(style.colours ? { colours: style.colours } : {}) }))
  const kinds: NewDesignKind[] = model.kinds ? [...model.kinds] : (request?.madeToMeasure?.garmentTypes ?? []).map((type) => ({ code: type.code, words: type.words[locale] }))
  const typed = actions?.lines?.onPieces !== undefined
  const rows: LineRow[] = request ? lineRowsOfDraft(request, { styles, kinds }).map((row) => (typed ? row : { ...row, pieces: { ...row.pieces, typed: false } })) : []
  const lines = actions?.lines ?? linesFromTable(actions?.table, rows, kinds)
  const count = rows.length
  return (
    <Card padded>
      <section className="fw-od-section" id="od-products" tabIndex={-1} aria-labelledby="od-products-title">
        <div className="fw-od-parthead">
          <h2 id="od-products-title" className="fw-od-h2">
            {t('tbl.title')}
          </h2>
          {count > 0 ? <Tag tone="neutral">{count === 1 ? t('tbl.count_one', { n: count }) : t('tbl.count_other', { n: count })}</Tag> : null}
        </div>
        <OrderLinesTable
          model={{
            rows,
            mode: !request || request.status === 'DRAFT' ? 'draft' : 'sent',
            columns: ownColumnsOfRecord(request?.ownColumns),
            styles,
            kinds,
            prices: model.prices ?? null,
            pending: model.pending,
            removed: request?.removedLines ?? [],
            writeHeld: model.writeHeld,
            saving: model.saving,
            columnsDoor: model.columnsDoor ?? false,
            refusals: model.lineRefusals,
            door,
          }}
          actions={lines}
          foot={below}
        />
      </section>
    </Card>
  )
}

/** The office's products-table actions on the ONE table (until S2 wires `lines`): a model is a style or the customer's words. */
export function linesFromTable(table: ProductsTableActions | undefined, rows: readonly LineRow[], kinds: readonly NewDesignKind[]): OrderLinesActions | undefined {
  if (!table) return undefined
  return {
    onModel: (rowId, choice) =>
      choice.kind === 'STYLE' ? table.onProduct?.(rowId, { styleId: choice.styleId }) : table.onProduct?.(rowId, { words: choice.kind === 'NEW' ? (kinds.find((kind) => kind.code === choice.garmentType)?.words ?? choice.garmentType) : '' }),
    onMaterial: (rowId, value) => {
      const row = rows.find((entry) => entry.id === rowId)
      if (row?.material.how === 'COLOURWAY' && value !== '') table.onColour?.(rowId, { colourwayId: value })
      else table.onOptions?.(rowId)
    },
    onAddMaterial: (rowId) => table.onOptions?.(rowId),
    onSizes: (rowId) => table.onPieces?.(rowId),
    onTakeOut: (rowId) => table.onRemove?.(rowId),
    onAdd: () => table.onAdd?.(),
    onDropPending: () => table.onDropPending?.(),
  }
}
