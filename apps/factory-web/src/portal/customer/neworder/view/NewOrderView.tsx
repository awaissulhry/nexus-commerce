'use client'

import type { ReactNode } from 'react'
import { AlertTriangle, ClipboardList, Eye, FileSpreadsheet, History, Lock, RefreshCw, Shirt, WifiOff } from 'lucide-react'
import { Banner, Card, Field, PressableRow, SummaryTable, type MenuItemDef } from '@nexus/ui/components'
import { EndState } from '@nexus/ui/components/EndState/index'
import { SaveStatus, type SaveStatusState } from '@nexus/ui/components/SaveStatus/index'
import { Button, Input, RadioCard, Select } from '@nexus/ui/primitives'
import { DateField, Textarea, useDsWords } from '../../../../lib/i18n/ds-parts'
import type { DraftRecord, DraftRow, RequestStatus } from '../api'
import type { NewOrderPhase } from '../band'
import { draftRowWords, problemPlace, problemWords, requestedHref, shipToOptions, WAYS, newOrderHref, type HeaderDraft, type HeaderField, type Way } from '../model'
import { useOrderingWords } from '../words'
import { DiscardDialog, NewAddressDialog, StylePickerDialog, type AddressDialogActions, type AddressDialogModel, type DiscardModel, type PickerActions, type PickerModel } from './Dialogs'
import { LinesSection, type LinesActions } from './LinesSection'
import { Loading, ReadFailed } from './parts'
import { ReorderPanel, type ReorderActions, type ReorderModel } from './ReorderPanel'
import { UploadPanel, type UploadActions, type UploadModel } from './UploadPanel'
// ---- F-CP-150 (customer page plan C5, D9–D11; 12 §2; picture 22): the draft order page — the portal record frame with the draft's
// conversation docked, the checklist strip, the seven part cards, ONE banner, the keys in one information icon at the foot.
import { ListKeysInfo } from '../../../../list-frame/ListKeysInfo'
import { PortalRecordFrame } from '../../../shell/record/PortalRecordFrame'
import type { PortalDockWidth, PortalFrameMode } from '../../../shell/record/model'
import { draftKeys } from '../band'
import { closedOf, draftBannerOf, draftChips, reorderHeldKey, savedWords, type DraftChip, type DraftPart } from '../model'
import { DraftChecklist, PartHeading } from './DraftChecklist'
// ---- end F-CP-150
// ---- F-CP-151 (B-CP-072; D14): the draft's files cards — logos, references, measurement sheets; the e-mail way on live.
import type { DraftFilePart } from '../api'
import { draftFilesOf, draftMailName, filesAddHeld, LATER_PART_OF, laterToggleOf, uploadsOpenOf } from '../model'
import { DraftFilesCard, type DraftFilesActions, type DraftFilesModel, type UploadRow } from './DraftFiles'
// ---- end F-CP-151
import { wordsHref } from '../request-model' // F-CP-152: "Just write it in words"
// ---- F-CP-154 (customer page plan C5; 12 §2 parts 1, 4, 6): lines of every kind, the People and sizes roster, "Your price".
import { NotebookPen, Ruler } from 'lucide-react'
import { mtmHeldKey, ownTotalOf, priceRowsOf, yourPriceAccess, type AddKind } from '../model'
import { CustomLineDialog, type CustomLineDialogActions, type CustomLineDialogModel } from './LinesSection'
import { PeopleRoster, PersonDialog, type PeopleRosterActions, type PersonDialogActions, type PersonDialogModel } from './PeopleRoster'
import { YourPriceCell } from './parts'
// ---- end F-CP-154

/**
 * SCR-185 › New order & reorder (design portal.customer.neworder): sec:start "How do you want to order?" (the ways in, one
 * draft; the drafts to continue) and the draft order page. F-CP-150 (customer page plan C5, D9–D11; 12 §2; picture 22): the
 * ONE draft order — the portal record frame with the draft's conversation docked (from 1280 px; narrower behind "Messages (2
 * new)"), ONE banner, "The factory can read this draft. Work starts only when you send it." with when it was saved, the
 * checklist of seven parts as chips (a click scrolls to the part), then the part cards: 1 What you need (the lines, "Add a line
 * ▾"), 4 People and sizes (each line's pieces; the roster comes with F-CP-154), 5 Date and delivery (their PO, the date wanted,
 * ship-to with "Add a new address") beside 7 Notes, 6 Your price (our list prices and the net for a price holder; "Prices are not
 * part of your access" for anyone else). Logos and References come with F-CP-151. Send and Discard… live in the band, held with
 * words (a Designer reads who may send it). The keys in one information icon at the foot. A draft no longer a draft (sent,
 * refused, withdrawn, accepted) keeps its conversation beside its end state. The pop-ups: Add styles, New delivery address,
 * Discard this draft?
 */

export interface NewOrderViewModel {
  state: 'loading' | 'error' | 'missing' | 'ready'
  phase: NewOrderPhase
  prefix: string
  /** Today in the site's zone: the earliest requested date. */
  today: string
  start: { state: 'loading' | 'error' | 'ready'; drafts: readonly DraftRow[]; choosing: Way | null; held: string | null; /** F-CP-154: "Describe it" is making the draft. */ describing?: boolean }
  way: Way | null
  record: DraftRecord | null
  header: HeaderDraft
  /** Field → a key. */
  headerErrors: Partial<Record<HeaderField, string>>
  save: SaveStatusState
  cells: Readonly<Record<string, Readonly<Record<string, number>>>>
  notes: Readonly<Record<string, string>>
  saving: readonly string[]
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
  /** The problems are listed (after Show me, or a send that was held). */
  showProblems: boolean
  /** B-TH-304 (pick A): no office number — their PO, the lines, the pieces. */
  sent: { customerRef: string | null; lines: number; pieces: number; net: string | null; currency: string; seesPrices: boolean } | null
  closed: { status: RequestStatus; salesOrder: { id: string } | null } | null
  offlineSince: string | null
  dialogs: {
    picker: PickerModel | null
    address: AddressDialogModel | null
    discard: DiscardModel | null
    // F-CP-154: a described or made-to-measure line's window; a person's window.
    customLine?: CustomLineDialogModel | null
    person?: PersonDialogModel | null
  }
  // ---- F-CP-150
  /** The colleague who changed the draft meanwhile (a 409's re-read names them once B-CP-075 says who), or null. */
  staleBy?: string | null
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
  onWay?: (way: Way) => void
  onContinue?: (draftId: string) => void
  onRetryStart?: () => void
  onHeader?: (field: HeaderField, value: string) => void
  onHeaderLeave?: (field: HeaderField) => void
  onAddAddress?: () => void
  onShowMe?: () => void
  onSend?: () => void
  onTakePrices?: () => void
  onUndo?: () => void
  onDismissNotice?: () => void
  onReload?: () => void
  onRetry?: () => void
  onRetrySave?: () => void
  /** F-CP-150: a chip of the checklist — scroll to its part and focus it. */
  onChip?: (target: string) => void
  /** F-CP-151: a part's files — add, take out, "Sending later". */
  files?: DraftFilesActions
  lines?: LinesActions
  // ---- F-CP-154: "Describe it" / "Made to measure" (a new line in the customer's own words), the roster, "Your price", their windows.
  onAddKind?: (kind: AddKind) => void
  people?: PeopleRosterActions
  price?: { onType?: (lineId: string, text: string) => void; onLeave?: (lineId: string) => void }
  customLine?: CustomLineDialogActions
  person?: PersonDialogActions
  // ---- end F-CP-154
  reorder?: ReorderActions
  upload?: UploadActions
  picker?: PickerActions
  address?: AddressDialogActions
  discard?: { onConfirm?: () => void; onCancel?: () => void }
}

const WAY_ICON: Readonly<Record<Way, ReactNode>> = { pick: <Shirt size={18} aria-hidden />, reorder: <History size={18} aria-hidden />, upload: <FileSpreadsheet size={18} aria-hidden /> }

/**
 * `children`: the draft's conversation (PortalThread live on `PortalOrderRequest`, the design's ThreadView), docked by the portal
 * record frame beside the draft and beside a draft no longer a draft. The start and a missing draft draw none.
 */
export function NewOrderView({ model, actions, children }: { model: NewOrderViewModel; actions?: NewOrderActions; children?: ReactNode }) {
  const words = useOrderingWords()
  const { t } = words
  const ds = useDsWords()
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
          next={[t('summary.notice'), t('draftPage.sentThread')]}
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

  if (model.phase === 'start') {
    return (
      <div className="fw-pno">
        {offline}
        <StartSection model={model} actions={actions} />
      </div>
    )
  }

  if (model.state === 'loading' || (model.state === 'ready' && !model.record)) {
    return (
      <div className="fw-pno">
        <Loading rows={4} height={96} />
      </div>
    )
  }
  if (model.state === 'error' || !model.record) {
    return (
      <div className="fw-pno">
        <ReadFailed title={t('draft.failed')} onRetry={actions?.onRetry} />
      </div>
    )
  }

  // ── F-CP-150: the draft order page ──────────────────────────────────────────────────────────────────────────────────────
  const record = model.record
  const request = record.request
  const chips = draftChips(record)
  const chip = (part: DraftPart): DraftChip => chips.find((entry) => entry.part === part)!
  const reorderHeld = reorderHeldKey(model.mayOrder ?? true)
  // F-CP-154: "Describe it" and "Made to measure" first (made to measure held with words only where the office switched it off).
  const mtmHeld = mtmHeldKey(request)
  const addKinds: MenuItemDef[] = [
    { id: 'described', label: t('draftPage.addDescribed'), icon: <NotebookPen size={14} aria-hidden />, disabled: model.writeHeld !== null, description: model.writeHeld ?? undefined, onSelect: () => actions?.onAddKind?.('described') },
    { id: 'mtm', label: t('draftPage.addMtm'), icon: <Ruler size={14} aria-hidden />, disabled: (model.writeHeld ?? (mtmHeld ? t(mtmHeld) : null)) !== null, description: model.writeHeld ?? (mtmHeld ? t(mtmHeld) : undefined), onSelect: () => actions?.onAddKind?.('mtm') },
  ]
  const addLine: MenuItemDef[] = [
    ...addKinds,
    ...WAYS.map((way) => {
      const held = way === 'reorder' && reorderHeld ? t(reorderHeld) : model.writeHeld
      return { id: way, label: t(`start.way.${way}`), disabled: held !== null, description: held ?? undefined, onSelect: () => actions?.onWay?.(way) }
    }),
  ]
  const kind = draftBannerOf({ offline: model.offlineSince !== null, stale: model.stale, refused: model.problem !== null, notice: model.notice !== null, problems: request.problems.length })
  const kit = { t, price: (value: string | null | undefined) => words.price(value, request.currency), locale: words.locale }
  // F-CP-151: each part's files, where they may go up (else the e-mail way), the cap and "Sending later".
  const files = draftFilesOf(request)
  const capKey = filesAddHeld(request, { preview: false, offline: false, busy: false })
  const filesModel = (part: DraftFilePart): DraftFilesModel => {
    const later = laterToggleOf(request, LATER_PART_OF[part])
    return {
      part,
      files: part === 'LOGO' ? files.logos : part === 'REFERENCE' ? files.references : files.sheets,
      lines: request.lines,
      uploading: model.uploads ?? [],
      open: uploadsOpenOf(request),
      addHeld: model.writeHeld ?? (capKey ? t(capKey) : null),
      removeHeld: model.writeHeld,
      later: later ? { on: later.on, held: model.writeHeld } : null,
      draftName: draftMailName(request, t),
    }
  }
  return (
    <PortalRecordFrame thread={children ?? null} threadLabel={t('draftPage.thread')} design={model.frame}>
      <div
        className="fw-pno fw-pno-draft"
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            if (!model.sendHeld) actions?.onSend?.()
          }
        }}
      >
        {/* ONE banner, by weight. */}
        {kind === 'offline' ? offline : null}
        {kind === 'stale' ? (
          <Banner
            tone="warning"
            title={t('draft.stale')}
            action={
              <Button size="sm" onClick={() => actions?.onReload?.()}>
                <RefreshCw size={14} aria-hidden /> {t('draft.reload')}
              </Button>
            }
          >
            {model.staleBy ? <p>{t('draftPage.changedBy', { name: model.staleBy })}</p> : null}
          </Banner>
        ) : null}
        {kind === 'refused' && model.problem ? <Banner tone="danger" title={t(model.problem)} /> : null}
        {kind === 'notice' && model.notice ? (
          <Banner
            tone="success"
            title={model.notice.lines[0]}
            action={
              <span className="fw-pno-buttons">
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
              <ul className="fw-pno-notes">
                {model.notice.lines.slice(1).map((line, index) => (
                  <li key={index}>{line}</li>
                ))}
              </ul>
            ) : null}
          </Banner>
        ) : null}
        {kind === 'problems' ? (
          <Banner
            tone="warning"
            icon={<AlertTriangle size={16} aria-hidden />}
            title={t('draftPage.problems', { count: request.problems.length })}
            action={
              <Button size="sm" variant="secondary" onClick={() => actions?.onShowMe?.()}>
                {t('summary.showMe')}
              </Button>
            }
          >
            {model.showProblems ? (
              <ul className="fw-pno-notes">
                {request.problems.map((problem, index) => (
                  <li key={index} className="fw-pno-note is-danger">
                    <a href={`#${problemPlace(problem)}`}>{problemWords(problem, request.lines, kit, request.customLines ?? [])}</a>
                  </li>
                ))}
              </ul>
            ) : null}
          </Banner>
        ) : null}
        <div className="fw-pno-draftmeta">
          <span className="fw-pno-shared">
            <Eye size={14} aria-hidden /> {t('draftPage.shared')}
          </span>
          {model.save.kind === 'saving' || model.save.kind === 'failed' ? (
            <SaveStatus state={model.save} formatTime={words.time} labels={ds.saveStatus} onRetry={actions?.onRetrySave} retryHeld={model.writeHeld} />
          ) : (
            <span className="fw-pno-quiet" role="status">
              {savedWords(request, t, words.time)}
            </span>
          )}
        </div>
        <DraftChecklist chips={chips} onChip={actions?.onChip} />
        {model.way === 'reorder' && model.reorder ? <ReorderPanel model={model.reorder} actions={actions?.reorder} /> : null}
        {model.way === 'upload' && model.upload ? <UploadPanel model={model.upload} actions={actions?.upload} /> : null}
        <Card padded>
          <LinesSection model={{ record, cells: model.cells, notes: model.notes, saving: model.saving, writeHeld: model.writeHeld, chip: chip('NEED'), addLine }} actions={actions?.lines} />
        </Card>
        {/* F-CP-151: 2 Logos beside 3 References; the measurement sheets inside 4 People and sizes. */}
        <div className="fw-pno-pair">
          <DraftFilesCard chip={chip('LOGOS')} model={filesModel('LOGO')} actions={actions?.files} />
          <DraftFilesCard chip={chip('REFERENCES')} model={filesModel('REFERENCE')} actions={actions?.files} />
        </div>
        <PeopleCard chip={chip('PEOPLE')} record={record} sheets={filesModel('SHEET')} writeHeld={model.writeHeld} actions={{ ...actions?.files, ...actions?.people }} />
        <div className="fw-pno-pair">
          <DateCard model={model} actions={actions} chip={chip('DATE')} />
          <NotesCard model={model} actions={actions} chip={chip('NOTES')} />
        </div>
        <PriceCard model={model} actions={actions} chip={chip('PRICE')} />
        {/* review G3: the page's keys in ONE information icon at its foot, never as hints above the cards. */}
        <div className="fw-pno-draftfoot">
          <ListKeysInfo keys={draftKeys(words).map((entry) => ({ keys: entry.keys, does: entry.words }))} />
        </div>
      </div>
      {model.dialogs.picker ? <StylePickerDialog model={model.dialogs.picker} actions={actions?.picker} /> : null}
      {model.dialogs.address ? <NewAddressDialog model={model.dialogs.address} actions={actions?.address} /> : null}
      {model.dialogs.discard ? <DiscardDialog model={model.dialogs.discard} onConfirm={actions?.discard?.onConfirm} onCancel={actions?.discard?.onCancel} /> : null}
      {/* F-CP-154: a described or made-to-measure line's window; a person's window. */}
      {model.dialogs.customLine ? <CustomLineDialog model={model.dialogs.customLine} actions={actions?.customLine} /> : null}
      {model.dialogs.person ? <PersonDialog model={model.dialogs.person} actions={actions?.person} /> : null}
    </PortalRecordFrame>
  )
}

function StartSection({ model, actions }: { model: NewOrderViewModel; actions?: NewOrderActions }) {
  const words = useOrderingWords()
  const { t } = words
  // F-CP-152 (12 §2 Doors): the draft order's start — Pick styles, Reorder a past order (held with why for an access without
  // orders), Upload a sheet; "Just write it in words" leads to the request like an e-mail (for who may order); the drafts to
  // continue. ("Describe it" comes with the described lines, F-CP-154.)
  const reorderHeld = reorderHeldKey(model.mayOrder ?? true)
  const wordsLink = (model.mayOrder ?? true) ? wordsHref(model.prefix) : null
  return (
    <Card padded>
      <section className="fw-pno-section" aria-labelledby="start-title">
        <h2 id="start-title" className="fw-pno-h2">
          {t('start.title')}
        </h2>
        <fieldset className="fw-pno-ways" disabled={model.start.held !== null}>
          <legend className="fw-pno-quiet">{t('start.intro')}</legend>
          {/* F-CP-154 (12 §2 Doors): "Describe it" first — the new draft opens with its "Describe what you need" window. */}
          <RadioCard
            name="way"
            value="describe"
            checked={false}
            selected={false}
            onChange={() => actions?.onAddKind?.('described')}
            title={
              <span className="fw-pno-waytitle">
                <NotebookPen size={18} aria-hidden /> {t('draftPage.start.describe')}
              </span>
            }
            description={model.start.describing ? t('state.saving') : t('draftPage.start.describeHint')}
          />
          {WAYS.map((way) => {
            const held = way === 'reorder' && reorderHeld ? t(reorderHeld) : null
            return (
              <RadioCard
                key={way}
                name="way"
                value={way}
                checked={model.way === way}
                selected={model.way === way}
                onChange={() => (held ? undefined : actions?.onWay?.(way))}
                title={
                  <span className="fw-pno-waytitle">
                    {WAY_ICON[way]} {t(`start.way.${way}`)}
                  </span>
                }
                description={model.start.choosing === way ? t('state.saving') : (held ?? t(`start.wayHint.${way}`))}
              />
            )
          })}
        </fieldset>
        {model.start.held ? <p className="fw-pno-held">{model.start.held}</p> : null}
        {wordsLink ? (
          <p className="fw-pno-quiet">
            <a href={wordsLink}>{t('draftPage.start.words')}</a>
          </p>
        ) : null}
        {model.start.state === 'loading' ? (
          <Loading rows={2} height={44} label={t('start.drafts')} />
        ) : model.start.state === 'error' ? (
          <ReadFailed title={t('start.draftsFailed')} onRetry={actions?.onRetryStart} />
        ) : model.start.drafts.length > 0 ? (
          <div className="fw-pno-stack">
            <h3 className="fw-pno-h3">{t('start.drafts')}</h3>
            <ul className="fw-pno-drafts">
              {model.start.drafts.map((row) => (
                <li key={row.id}>
                  <PressableRow leading={<ClipboardList size={16} aria-hidden />} label={draftRowWords(row, t, words.day)} onClick={() => actions?.onContinue?.(row.id)} />
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>
    </Card>
  )
}

// ── F-CP-150: the part cards ──────────────────────────────────────────────────────────────────────────────────────────────

/**
 * 4 People and sizes: each line's pieces as the draft holds them, the privacy line (review G6), each by-person line's roster (name,
 * number, Size · Measurement sheet · Sending later; "People: in the attached sheet" when a sheet on the line stands for it — F-CP-154),
 * then the draft's measurement sheets.
 */
function PeopleCard({ chip, record, sheets, writeHeld, actions }: { chip: DraftChip; record: DraftRecord; sheets: DraftFilesModel; writeHeld: string | null; actions?: PeopleRosterActions }) {
  return (
    <Card padded>
      <section className="fw-pno-section" id={chip.target} tabIndex={-1} aria-labelledby="part-people-title">
        <PartHeading chip={chip} id="part-people-title" />
        <PeopleRoster model={{ record, writeHeld, sheets }} actions={actions} />
      </section>
    </Card>
  )
}

/** 5 Date and delivery: their PO, the date wanted, ship-to with "Add a new address" — each saved on leaving the field. */
function DateCard({ model, actions, chip }: { model: NewOrderViewModel; actions?: NewOrderActions; chip: DraftChip }) {
  const words = useOrderingWords()
  const { t } = words
  const record = model.record!
  const options = shipToOptions(record.addresses, model.header.shipToAddressId || null)
  const chosen = options.find((option) => option.id === model.header.shipToAddressId)
  const error = (field: HeaderField) => (model.headerErrors[field] ? t(model.headerErrors[field]!) : undefined)
  const held = model.writeHeld !== null
  return (
    <Card padded>
      <section className="fw-pno-section" id={chip.target} tabIndex={-1} aria-labelledby="head-title">
        <PartHeading chip={chip} id="head-title" />
        <div className="fw-pno-fields">
          <Field label={t('head.date')} hint={t('head.dateHint')} error={error('requestedDate')}>
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
          <Field label={t('head.ref')} hint={t('head.refHint')} error={error('customerRef')}>
            <Input value={model.header.customerRef} maxLength={100} disabled={held} onChange={(event) => actions?.onHeader?.('customerRef', event.target.value)} onBlur={() => actions?.onHeaderLeave?.('customerRef')} />
          </Field>
          <div className="fw-pno-field-wide">
            <Field
              label={t('head.shipTo')}
              hint={chosen?.state === 'WAITING' ? t('head.shipToWaiting') : chosen?.state === 'ARCHIVED' ? t('head.shipToGone') : options.length === 0 ? t('head.shipToNone') : t('head.shipToHint')}
              error={error('shipToAddressId')}
            >
              <div className="fw-pno-shipto">
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
        </div>
      </section>
    </Card>
  )
}

/** 7 Notes: their note to us (saved on leaving the field). */
function NotesCard({ model, actions, chip }: { model: NewOrderViewModel; actions?: NewOrderActions; chip: DraftChip }) {
  const { t } = useOrderingWords()
  const error = model.headerErrors.note ? t(model.headerErrors.note) : undefined
  return (
    <Card padded>
      <section className="fw-pno-section" id={chip.target} tabIndex={-1} aria-labelledby="part-notes-title">
        <PartHeading chip={chip} id="part-notes-title" />
        <Field label={t('head.note')} hint={t('head.noteHint')} error={error}>
          <Textarea value={model.header.note} rows={4} maxLength={4000} disabled={model.writeHeld !== null} onChange={(event) => actions?.onHeader?.('note', event.target.value)} onBlur={() => actions?.onHeaderLeave?.('note')} />
        </Field>
      </section>
    </Card>
  )
}

/**
 * 6 Your price: for a price holder (the customer's Buyer, Finance, Admin) every line by seq with its pieces, our list price beside it on
 * catalogue lines, and the ONE "Your price (without VAT)" cell (F-CP-154; saved on leaving it; frozen when sent); the total row carries
 * our net and their total (when every line has their price, else how many lines lack it); prices that changed since the draft began,
 * with "Take today's prices". Anyone else: "Prices are not part of your access" — no amount, no total, no count of priced lines (the
 * API sends none and refuses one, M-CP-2).
 */
function PriceCard({ model, actions, chip }: { model: NewOrderViewModel; actions?: NewOrderActions; chip: DraftChip }) {
  const words = useOrderingWords()
  const { t } = words
  const record = model.record!
  const request = record.request
  const price = (value: string | null | undefined) => words.price(value, request.currency) ?? '—'
  // F-CP-154: the customer's own price per line, typed by a price holder while the draft may be written.
  const access = yourPriceAccess(record.seesPrices, request.status === 'DRAFT' ? model.writeHeld : t('held.notDraft'))
  const rows = priceRowsOf(request, t, words.locale)
  const typed = model.ownPrices ?? {}
  const own = ownTotalOf(rows, typed)
  return (
    <Card padded>
      <section className="fw-pno-section" id={chip.target} tabIndex={-1} aria-labelledby="part-price-title">
        <PartHeading chip={chip} id="part-price-title" />
        {access !== 'none' ? (
          <>
            <SummaryTable
              label={t('draftPage.part.PRICE')}
              density="roomy"
              stackOnPhone
              columns={[t('draftPage.price.line'), t('summary.pieces'), t('draftPage.price.ours'), t('draftPage.price.yours')]}
              align={['left', 'right', 'right', 'right']}
              widths={['40%', undefined, undefined, '200px']}
              rows={[
                ...rows.map((row) => ({
                  id: row.id,
                  cells: [
                    `${row.seq} · ${row.label}`,
                    words.pieces(row.pieces),
                    row.kind === 'CATALOGUE' ? price(row.ours) : '—',
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
                {
                  id: 'total',
                  cells: [
                    <strong key="l">{t('draftPage.price.total')}</strong>,
                    <strong key="p">{words.pieces(request.summary.pieces)}</strong>,
                    <strong key="o">{price(request.summary.net)}</strong>,
                    own.total !== null ? <strong key="y">{price(own.total)}</strong> : <span key="y" className="fw-pno-quiet">{t('draftPage.price.missing', { count: own.missing })}</span>,
                  ],
                },
              ]}
            />
            <p className="fw-pno-quiet">
              {t('summary.netHint')} {t('draftPage.price.frozen')}
            </p>
            {request.pricesChanged > 0 ? (
              <p className="fw-pno-held">
                <AlertTriangle size={14} aria-hidden /> {t('summary.pricesChanged', { count: request.pricesChanged })}
                <Button size="sm" variant="secondary" heldReason={model.writeHeld} onClick={() => actions?.onTakePrices?.()}>
                  {t('summary.takePrices')}
                </Button>
              </p>
            ) : null}
          </>
        ) : (
          <p className="fw-pno-locked">
            <Lock size={14} aria-hidden /> {t('prices.none')}
          </p>
        )}
      </section>
    </Card>
  )
}
