'use client'

import { useEffect, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent, type ReactNode } from 'react'
import Link from 'next/link' // F-OF-101: a block's door "Open on … ›" is a real link
import { AudioLines, BadgeCheck, ChevronDown, ChevronUp, Copy, Download, FileText, FolderOpen, Image as ImageIcon, Lock, LockOpen, Paperclip, MoreHorizontal, Receipt, Share2, ShieldAlert, ShieldOff, Trash2, Upload, Users } from 'lucide-react'
import { Banner, Disclosure, EmptyState, Field } from '@nexus/ui/components'
import { BulkActionBar } from '@nexus/ui/patterns'
import { Button, Checkbox, RadioCard, Select, Skeleton, Tag } from '@nexus/ui/primitives'
import { FileDropzone, Modal } from '../../../i18n/ds-parts'
import { formatDate } from '../../../i18n/format'
import { useLocale, useT } from '../../../i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { ListKeysInfo } from '../../../../list-frame/ListKeysInfo'
import type { FileAudience, FileKind } from '../../../../record-panels/model'
import { FileViewer, sizeWords } from '../../popups/view/FileViewer' // F-OP-127: the ONE viewer
import { audienceMarks, versionMark, type FileSeries, type FilesParty, type ThreadFile } from '../../files/model'
import { bulkReach, filesGroups, keepLines, rangeOf, type FilesAbilities, type MissingDocument, type UploadAsk } from '../model'
import type { UploadPlace } from '../model' // F-OF-103: "Where it goes"
// B-TH-283: the measurement-sheet tick holds an upload meant for the floor.
import { uploadAskHeld } from '../model'
// B-TH-231: "Use on another record…" and the copy's source line.
import { carriable, sourceLine } from '../../files/use-on'
import { typeKey } from '../../../../areas/search/model'
// F-SA-237: a sales order's files from its one walled read — the SAME body on the order's Files tab and in this window.
import { orderBulkReach, sourceOf, type OrderFile, type OrderFilesModel } from '../model'
// F-OF-101 (order FILES tab): the groups as the tab draws them (Shipments and Invoices apart, one block per source), the counted line.
import { orderChoosableOf, orderCountedOf, orderSectionsOf, type OrderCounted, type OrderFilesBlock } from '../model'
// F-OF-102: the TRUE chip (Office only · Customer · Floor · Link) and the reader's own held uploads.
import { chipMarksOf, heldReasonKey, type OrderHeldFile } from '../model'
// F-OP-125: the order's file cards (kind, type word, who added it, the MTM worksheets, the keys' grid step).
import { addedByOf, cardKindOf, cardStep, typeLabelOf, worksheetCardId, type OrderWorksheet } from '../model'
import type { CardPreview } from '../model' // F-OP-126
// F-CP-144: the PRICED lock — one counted line, no name, no preview, no box; the upload's tick; Mark as priced.
import { pricedLockedIn, uploadPricedHeld } from '../model'
import { previewOf, pricedMarkOf } from '../../files/model'
import '../files-view.css'
import './files-tab.css' // F-OF-101: the order files tab's groups, blocks and cards
// F-OF-201 … F-OF-203: "Waiting for files" — the band (the order's window draws it above the groups; the tab in its own section) and its windows.
import { ASKS_NS, AsksBody, AsksWindowHead, arrivedFileIds } from '../asks/view/AsksBody'
import { AskWindows } from '../asks/view/AskWindows'
// ---- F-OF-302 / F-OF-303 (order FILES tab W3): the card's ⋯ and the file windows
import { Menu, type MenuItemDef } from '@nexus/ui/components'
import { blockRefOf, isOrderOwn, orderFileActsOf, type FileActsState, type OrderFileAct } from '../model'
import { FileActWindows } from './FileActWindows'
import { ActLines, type FileActActions } from './FileActParts'
import { dayWords } from '../day' // fx5w (W-11): "29 Oct", the app's day words
import { UseOnDialog, type UseOnActions } from '../../files/view/UseOnDialog'
// ---- end F-OF-302
import type { AskDoor, AskWindow } from '../asks/asks'

export const FILES_VIEW_NS = 'record-thread-files-view'

export interface FilesViewModel {
  record: { readonly type: string; readonly id: string; readonly label: string }
  party: (FilesParty & { readonly name: string }) | null
  /** The record's files the reader may see; null while they are read. */
  files: readonly ThreadFile[] | null
  /** `read`: could not load (Try again); `forbidden`: the person may not see this record's files. */
  problem: 'read' | 'forbidden' | null
  can: FilesAbilities
  /** Why uploading is held (no files.upload, offline), in words; null when it is open. */
  uploadHeld: string | null
  /** The chosen documents (their files in force). */
  selected: readonly string[]
  /** Uploads the API or the checks refused: the file's name and the reason in words. */
  refused: readonly { readonly name: string; readonly reason: string }[]
  /** Required documents still missing before a status move. */
  missing: readonly MissingDocument[]
  /** The upload being asked (kind and audience), or null. */
  upload: UploadAsk | null
  busy?: boolean
  now: number
  timeZone?: string
  /** F-SA-237: a SalesOrder — its files from the order files read (the body below draws them instead of the record's own list). */
  order?: OrderFilesModel | null
  /** F-OF-103 (F5-B6): the last upload's files the virus scan holds (said; they open once it says clean). */
  held?: readonly string[]
  /** F-OF-303 (D4): the file window open on this record's files (the bulk "Delete N" opens Delete…, the whole document, with a reason). */
  acts?: FileActsState
}

export type BulkAction = 'download' | 'share' | 'officeOnly' | 'remove'

export interface FilesViewActions extends /* F-OF-303: the file windows (use-file-acts) */ FileActActions {
  onClose?: () => void
  onRetry?: () => void
  /** The chosen documents now (the whole choice: the view works out ranges and "all"). */
  onSelect?: (fileIds: readonly string[]) => void
  /** Opens the thread's one file viewer at this file. */
  onOpen?: (fileId: string, opener: HTMLElement | null) => void
  onBulk?: (action: BulkAction, fileIds: readonly string[]) => void
  /** Files dropped or browsed: the container asks their kind and audience (`upload`). */
  onDrop?: (files: File[]) => void
  onUploadChange?: (change: Partial<Pick<UploadAsk, 'kind' | 'audience' | 'sheet' | /* F-CP-144 */ 'priced' | /* F-OF-103 */ 'place'>>) => void
  onUploadConfirm?: () => void
  onUploadCancel?: () => void
  onDismissRefused?: () => void
  /** B-TH-231: "Use on another record…" for these files (one row's, or the chosen ones). */
  onUseOn?: (fileIds: readonly string[]) => void
  /** F-CP-144 (B-CP-014): Mark as priced (true), or take the mark off (false: a price holder's). */
  onPriced?: (fileId: string, priced: boolean) => void
  /** F-SA-237 (a sales order): open a file through the order's own route; show its message in the conversation; the bulk bar.
   *  F-OP-127: `opener` — the card that opened it (the viewer gives the focus back to it). */
  onOrderOpen?: (fileId: string, mode: 'preview' | 'download', opener?: HTMLElement | null) => void
  /** F-OP-125 (B5): open a made-to-measure worksheet (its own route records the opening). */
  onOrderWorksheet?: (sheet: OrderWorksheet) => void
  /** F-OP-126: the file cards now in view (200 px ahead): only those are asked a preview. */
  onOrderVisible?: (fileIds: readonly string[]) => void
  /** F-OP-127: the ONE viewer — walk, close, open a body-data file (recorded), Download at the click. */
  onViewerIndex?: (index: number) => void
  onViewerClose?: () => void
  onViewerOpenLocked?: (fileId: string) => void
  onViewerDownload?: (fileId: string) => void
  onOrderMessage?: (messageId: string) => void
  onOrderSelect?: (fileIds: readonly string[]) => void
  /** F-OF-303 (L7): Download N · "Who can see N…" (it replaced "Share N own") · Delete N… (D4). */
  onOrderBulk?: (action: 'download' | 'whoCanSee' | 'delete', fileIds: readonly string[]) => void
  // ---- F-OF-101 (order FILES tab): a block's door "Open on … ›" — the source record's own page (null: no door, e.g. the order's own files)
  orderHrefOf?: (record: { readonly type: string; readonly id: string; readonly label: string }) => string | null
  // ---- end F-OF-101
  // ---- F-OF-103 (order FILES tab): "Add files…" on the order's body — the tab and the order's thread window (one Add per window) ----
  /** Files dropped on Files or browsed (none: the window opens to drop them there). */
  onOrderAdd?: (files: File[]) => void
  onOrderUploadChange?: (change: Partial<Pick<UploadAsk, 'kind' | 'audience' | 'sheet' | 'priced' | 'place'>>) => void
  onOrderUploadConfirm?: () => void
  onOrderUploadCancel?: () => void
  onOrderUploadDismiss?: () => void
  // ---- end F-OF-103
  // ---- F-OF-104 (F7-B1, F7-B3): "Try again" on a file the viewer could not open; a card's picture that no longer loads is asked again
  onViewerRetry?: (fileId: string) => void
  onOrderPreviewFailed?: (fileId: string) => void
  // ---- end F-OF-104
  // ---- F-OF-201 … F-OF-203 ("Waiting for files"): the band's doors and windows (use-file-asks) ----
  onAskNew?: () => void
  onAskDoor?: (askId: string, door: AskDoor) => void
  onAskWindow?: (next: AskWindow) => void
  onAskSubmit?: () => void
  onAskClose?: () => void
  onAskRetryPicks?: () => void
  onAskDismiss?: () => void
  // ---- end F-OF-201
  // ---- F-OF-302 / F-OF-304 (W3): a card's ⋯ act on one of the order's own files; "Use on another record…" on them; the act's notice
  onOrderAct?: (act: OrderFileAct, fileId: string) => void
  orderUseOn?: UseOnActions
  onActNoticeDismiss?: () => void
  // ---- end F-OF-302
}

// ---- B-TH-280: the files in depth (B-W2b-177) in this window — the container (the docked thread) fills these slots with the depth
// parts of record-panels/files (the old record panels' Files tab went): a document's type and expiry, Versions, Mark up, What it is.
export interface FilesViewSlots {
  /** Above the list: what a depth action did, a documents read that failed, how to add what a move needs, the party's documents. */
  readonly top?: ReactNode
  /** Beside a document's audience marks: its document type and expiry. */
  readonly tags?: (fileId: string) => ReactNode
  /** Beside "Use on another record…": the document's own actions (Versions, Mark up, What it is). */
  readonly rowActions?: (fileId: string) => ReactNode
  /** The pop-ups those actions open, drawn after the window (DS Modals stack over it). */
  readonly overlays?: ReactNode
}
// ---- end B-TH-280

const KIND_ICON: Readonly<Record<FileKind, ReactNode>> = {
  PHOTO: <ImageIcon size={18} aria-hidden />,
  DOCUMENT: <FileText size={18} aria-hidden />,
  CERTIFICATE: <BadgeCheck size={18} aria-hidden />,
  FISCAL_ARCHIVE: <Receipt size={18} aria-hidden />,
  AUDIO: <AudioLines size={18} aria-hidden />,
  ATTACHMENT: <Paperclip size={18} aria-hidden />,
}

/**
 * The Files view (B-TH-299, T9; picture 9 drawn to the approved pictures' look): all files of ONE record in a centred window
 * up to 1160 px (the DS Modal "detail": a full-screen sheet on a phone) — groups, versions (the one in force, Restore),
 * real multi-select (a box per file, the header box, shift-click) with a counted bulk bar (Download · Share with <customer>
 * · Make office only · Delete; a legal hold refuses Delete), the upload (kind and audience asked once; the audience starts
 * on Office), retention, legal hold and quarantine read-only, "Missing before Shipped". Keys: ↑ / ↓ between files, x
 * chooses, Enter opens. Draws one view model, fetches nothing.
 */
export function FilesView({ model, actions, slots }: { model: FilesViewModel; actions?: FilesViewActions; /* B-TH-280 */ slots?: FilesViewSlots }) {
  return (
    <WithMessages namespaces={[FILES_VIEW_NS, 'record-thread-files', 'lists', /* B-TH-231 */ 'search', /* B-CP-014 */ 'record-files', /* F-OF-201: the order's window draws the band */ ASKS_NS]}>
      <View model={model} actions={actions} slots={slots} />
    </WithMessages>
  )
}

function View({ model, actions, slots }: { model: FilesViewModel; actions?: FilesViewActions | undefined; slots?: FilesViewSlots | undefined }) {
  const t = useT(FILES_VIEW_NS)
  const locale = useLocale()
  const place = { locale, ...(model.timeZone ? { timeZone: model.timeZone } : {}) }
  const listRef = useRef<HTMLDivElement>(null)
  const [anchor, setAnchor] = useState<string | null>(null)
  const useOnWords = useT('record-thread-files')

  const groups = model.files ? filesGroups(model.files, model.record) : []
  const order = groups.flatMap((group) => group.series.map((one) => one.latest.id))
  const latest = new Map(groups.flatMap((group) => group.series.map((one) => [one.latest.id, one.latest] as const)))
  const chosen = model.selected.filter((fileId) => latest.has(fileId)).map((fileId) => latest.get(fileId)!)
  const reach = bulkReach(chosen, model.party, model.can)
  // B-TH-231: the chosen files a carry may take (available, not a sheet locked for this reader).
  const carry = model.can.upload && actions?.onUseOn ? carriable(chosen).map((file) => file.id) : []
  const allChosen = order.length > 0 && chosen.length === order.length
  // F-CP-144: the record's priced documents this reader may not open — never in a group, counted on one line.
  const pricedLocked = model.files ? pricedLockedIn(model.files, model.record) : 0

  const choose = (fileId: string, on: boolean, range: boolean) => {
    const ids = range ? rangeOf(order, anchor, fileId) : [fileId]
    const next = on ? [...new Set([...model.selected, ...ids])] : model.selected.filter((one) => !ids.includes(one))
    setAnchor(fileId)
    actions?.onSelect?.(next.filter((one) => latest.has(one)))
  }

  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    if (target.closest('input, select, textarea')) return
    const rows = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('button[data-row]') ?? [])]
    const at = rows.indexOf(target.closest('button[data-row]') as HTMLButtonElement)
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (rows.length === 0) return
      event.preventDefault()
      rows[Math.max(0, Math.min(rows.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus()
    } else if (event.key.toLowerCase() === 'x' && at >= 0) {
      event.preventDefault()
      const fileId = rows[at]!.dataset.row!
      choose(fileId, !model.selected.includes(fileId), event.shiftKey)
    }
  }

  const title = t('title', { record: model.record.label })
  return (
    <>
      <Modal
        open
        onClose={() => actions?.onClose?.()}
        size="detail"
        title={title}
        subtitle={model.order ? (model.order.read ? t('subtitle', { count: model.order.read.total }) : undefined) /* F-SA-237 */ : model.files ? t('subtitle', { count: order.length }) : undefined}
        footer={
          <>
            {/* Owner rule 2026-10-29: the keys live in ONE information icon in the footer, never above the list. */}
            <ListKeysInfo keys={[{ keys: ['↑', '↓'], does: t('keys.move') }, { keys: ['x'], does: t('keys.choose') }, { keys: ['Shift', 'click'], does: t('keys.range') }, { keys: ['Enter'], does: t('keys.open') }]} />
            <span className="grow" />
            <Button onClick={() => actions?.onClose?.()}>{t('close')}</Button>
          </>
        }
      >
        <div className="fw-rtv">
          {model.missing.map((missing) => (
            <Banner key={missing.id} tone={missing.level === 'BLOCK' ? 'danger' : 'warning'} title={t(missing.level === 'BLOCK' ? 'missing.block' : 'missing.warn', { document: missing.document, status: missing.before })} />
          ))}
          {model.refused.length > 0 && (
            <Banner
              tone="danger"
              title={t('refused.title', { count: model.refused.length })}
              action={actions?.onDismissRefused ? <Button size="sm" variant="quiet" onClick={actions.onDismissRefused}>{t('refused.dismiss')}</Button> : undefined}
            >
              <ul className="fw-rtv-refused">
                {model.refused.map((one) => (
                  <li key={one.name}>
                    <strong>{one.name}</strong>: {one.reason}
                  </li>
                ))}
              </ul>
            </Banner>
          )}
          {(model.held?.length ?? 0) > 0 && <HeldUploads names={model.held ?? []} onDismiss={actions?.onDismissRefused} /* F-OF-103 (F5-B6) */ />}
          {slots?.top /* B-TH-280 */}

          {model.problem === 'forbidden' ? (
            <EmptyState icon={<Lock size={22} aria-hidden />} title={t('forbidden.title')} description={t('forbidden.body')} />
          ) : model.problem === 'read' ? (
            <Banner tone="danger" title={t('problem.read')} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('problem.retry')}</Button>} />
          ) : (
            <>
              {/* F-OF-103: a SalesOrder's window draws no own drop area — the order's body has its one "Add files…" (one Add per window). */}
              {model.order ? null : model.can.upload && !model.uploadHeld ? (
                <FileDropzone multiple onFiles={(files) => actions?.onDrop?.(files)} hint={t('upload.hint')} />
              ) : (
                <p className="fw-rtv-held">
                  <Lock size={14} aria-hidden /> {model.uploadHeld ?? t('upload.noRight')}
                </p>
              )}
              {model.order ? (
                <OrderFilesView model={model.order} party={model.party} actions={actions} place="window" />
              ) : model.files === null ? (
                <div className="fw-rtv-loading" role="status" aria-label={t('loading')}>
                  {[0, 1, 2].map((row) => (
                    <Skeleton key={row} height={44} />
                  ))}
                </div>
              ) : order.length === 0 && pricedLocked === 0 ? (
                <EmptyState icon={<FolderOpen size={22} aria-hidden />} title={t('empty.title')} description={t(model.can.upload ? 'empty.bodyUpload' : 'empty.body')} />
              ) : (
                <>
                  {pricedLocked > 0 && <PricedLockLine count={pricedLocked} /* F-CP-144 */ />}
                  {order.length > 0 && (
                  <>
                  <div className="fw-rtv-tools">
                    <Checkbox
                      label={allChosen ? t('select.none', { count: order.length }) : t('select.all', { count: order.length })}
                      checked={allChosen}
                      onChange={(event) => actions?.onSelect?.(event.target.checked ? order : [])}
                    />
                  </div>
                  {chosen.length > 0 && (
                    <BulkActionBar count={chosen.length} noun={t('bulk.noun', { count: chosen.length }) /* F-OF-102 (P0-B4): "1 file" */} onClear={() => actions?.onSelect?.([])}>
                      <Button size="sm" heldReason={reach.download.length === 0 ? t('bulk.noneDownload') : null} onClick={() => actions?.onBulk?.('download', reach.download)}>
                        <Download size={14} aria-hidden /> {t('bulk.download', { count: reach.download.length })}
                      </Button>
                      {/* F-OF-102 (F6-B5): a door the reader has no right to is hidden; held with words only by what is chosen. */}
                      {model.party && model.can.share && (
                        <Button size="sm" heldReason={reach.share.length === 0 ? t('bulk.allShared', { party: model.party.name }) : null} onClick={() => actions?.onBulk?.('share', reach.share)}>
                          <Share2 size={14} aria-hidden /> {t('bulk.share', { party: model.party.name, count: reach.share.length })}
                        </Button>
                      )}
                      {model.can.share && (
                        <Button size="sm" heldReason={reach.officeOnly.length === 0 ? t('bulk.allOffice') : null} onClick={() => actions?.onBulk?.('officeOnly', reach.officeOnly)}>
                          <ShieldOff size={14} aria-hidden /> {t('bulk.officeOnly', { count: reach.officeOnly.length })}
                        </Button>
                      )}
                      {model.can.delete && (
                        <Button size="sm" variant="danger" heldReason={reach.remove.length === 0 ? t('bulk.allHeld') : null} onClick={() => actions?.onBulk?.('remove', reach.remove)}>
                          <Trash2 size={14} aria-hidden /> {t('bulk.remove', { count: reach.remove.length })}
                        </Button>
                      )}
                      {model.can.upload && actions?.onUseOn && (
                        <Button size="sm" heldReason={carry.length === 0 ? t('bulk.noneDownload') : null} onClick={() => actions.onUseOn?.(carry)}>
                          <Copy size={14} aria-hidden /> {useOnWords('useOn.bulk', { count: carry.length })}
                        </Button>
                      )}
                      {reach.onHold > 0 && <span className="fw-rtv-muted">{t('bulk.onHold', { count: reach.onHold })}</span>}
                    </BulkActionBar>
                  )}
                  <div ref={listRef} className="fw-rtv-groups" onKeyDown={keys}>
                    {groups.map((group) => (
                      <section key={group.key} className="fw-rtv-group" aria-label={groupWords(group.group, model.party, t)}>
                        <h3 className="fw-rtv-group-title">
                          {groupWords(group.group, model.party, t)} <span className="fw-rtv-muted">{group.series.length}</span>
                        </h3>
                        <ul className="fw-rtv-rows">
                          {group.series.map((one) => (
                            <Row key={one.key} series={one} model={model} actions={actions} slots={slots} place={place} chosen={model.selected.includes(one.latest.id)} onChoose={(on, range) => choose(one.latest.id, on, range)} />
                          ))}
                        </ul>
                      </section>
                    ))}
                  </div>
                  </>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </Modal>
      {model.upload && <UploadDialog ask={model.upload} party={model.party} busy={model.busy ?? false} onChange={actions?.onUploadChange} onConfirm={actions?.onUploadConfirm} onCancel={actions?.onUploadCancel} />}
      {!model.order && <FileActWindows state={model.acts} actions={actions} /* F-OF-303: the order's body draws its own */ />}
      {slots?.overlays /* B-TH-280 */}
    </>
  )
}

// ---- F-CP-144 (customer page plan C4; design 11-money §4.5; B-CP-014): the PRICED lock card — the record's priced documents this
// reader may not open, as ONE counted line: no name, no preview, nothing to choose, open or attach ("2 priced documents — you cannot
// open them · Only people who see prices open it.").
function PricedLockLine({ count }: { count: number }) {
  const words = useT('record-files')
  return (
    <p className="fw-rtv-held" role="note">
      <Lock size={14} aria-hidden /> <span>{words('priced.lockedCount', { count })}</span> <span className="fw-rtv-muted">{words('priced.lockedWhy')}</span>
    </p>
  )
}
// ---- end F-CP-144

function groupWords(group: ReturnType<typeof filesGroups>[number]['group'], party: FilesParty | null, t: (key: string) => string): string {
  if (group.by === 'kind') return t(`group.kind.${group.kind}`)
  if (group.origin === 'party') return t(`group.origin.party.${party?.role ?? 'customer'}`)
  return t(`group.origin.${group.origin}`)
}

function Row({ series, model, actions, slots, place, chosen, onChoose }: { series: FileSeries; model: FilesViewModel; actions?: FilesViewActions | undefined; slots?: FilesViewSlots | undefined; place: { locale: 'it' | 'en'; timeZone?: string }; chosen: boolean; onChoose: (on: boolean, range: boolean) => void }) {
  const t = useT(FILES_VIEW_NS)
  const fileWords = useT('record-thread-files')
  const searchWords = useT('search')
  const pricedWords = useT('record-files') // B-CP-014
  const file = series.latest
  const version = versionMark(series)
  // B-TH-231: a copy says where it came from; a sheet locked for this reader is named as such, never by its own name.
  // B-CP-014: a priced document locked for this reader names its lock, and no source (its origin is blank for them too).
  const source = file.locked === 'PRICED' ? null : sourceLine(file)
  const name = file.locked === 'PRICED' ? pricedWords('priced.locked') : file.locked ? fileWords('locked.sheet') : file.name
  const { marks, more } = audienceMarks(file, model.party)
  const held = file.status === 'QUARANTINED'
  const lines = keepLines(file, model.now)
  // B-TH-280: a sheet locked for this reader has no depth actions (they cannot open it).
  const rowActions = file.locked ? null : (slots?.rowActions?.(file.id) ?? null)
  // F-CP-144: Mark as priced (anyone who reaches the record), or take the mark off (the file opens for this reader: they see prices).
  const mark = actions?.onPriced ? pricedMarkOf(file, { mark: model.can.mark ?? false }) : null
  return (
    <li className={`fw-rtv-row${chosen ? ' is-chosen' : ''}`}>
      <span
        className="fw-rtv-check"
        onClickCapture={(event) => {
          if ((event.target as HTMLElement).tagName === 'INPUT' && event.shiftKey) {
            event.preventDefault()
            onChoose(!chosen, true)
          }
        }}
      >
        <Checkbox label={<span className="nds-vh">{t('select.one', { name })}</span>} checked={chosen} onChange={(event) => onChoose(event.target.checked, false)} />
      </span>
      <span className={`fw-rtv-pic${held ? ' is-held' : ''}`} aria-hidden>
        {/* F-CP-144: never a preview of a locked file. */}
        {previewOf(file) && !held ? <img src={previewOf(file)!} alt="" /> : held || file.locked ? <Lock size={18} /> : KIND_ICON[file.kind]}
      </span>
      <span className="fw-rtv-main">
        <button type="button" className="fw-rtv-name" data-row={file.id} onClick={(event) => actions?.onOpen?.(file.id, event.currentTarget)}>
          {file.locked && <Lock size={13} aria-hidden />} {name}
        </button>
        <span className="fw-rtv-meta">
          {fileWords(`kind.${file.kind}`)} · {sizeWords(file.sizeBytes, place.locale)} · {formatDate(file.createdAt, place)}
          {version && <> · {t('version.inForce', { n: version })}</>}
        </span>
        {source && <span className="fw-rtv-meta">{fileWords(source.key, source.params ? { ...source.params, type: file.source ? searchWords(typeKey(file.source.recordType)) : '' } : undefined)}</span>}
        {/* B-TH-283 (B-TH-083): a measurement sheet — who may not open it reads why; who may, that each opening is recorded. */}
        {file.locked && <span className="fw-rtv-meta">{file.locked === 'PRICED' ? pricedWords('priced.lockedWhy') /* B-CP-014 */ : fileWords('locked.sheetWhy')}</span>}
        {file.sheet && <span className="fw-rtv-meta">{fileWords('sheet.recorded')}</span>}
        <span className="fw-rtv-marks">
          {marks.map((mark) => (
            <Tag key={mark} tone={mark === 'otherParty' ? 'danger' : mark === 'office' ? 'neutral' : mark === 'floor' ? 'warning' : 'info'}>
              {fileWords(`audience.${mark}`)}
            </Tag>
          ))}
          {more > 0 && <Tag tone="neutral">{`+${more}`}</Tag>}
          {slots?.tags?.(file.id) /* B-TH-280: its document type and expiry */}
          {lines.map((line) => (
            <Tag key={line.key} tone={line.tone}>
              {t(line.key, line.params?.date ? { date: formatDate(String(line.params.date), place) } : undefined)}
            </Tag>
          ))}
        </span>
        {/* F-CP-144: a priced document this reader opens says so. */}
        {file.priced && <span className="fw-rtv-meta">{pricedWords('priced.isPriced')}</span>}
        {((model.can.upload && actions?.onUseOn && carriable([file]).length > 0) || rowActions || mark) && (
          <span className="fw-rtv-row-actions">
            {model.can.upload && actions?.onUseOn && carriable([file]).length > 0 && (
              <Button size="sm" variant="quiet" heldReason={model.uploadHeld} aria-label={fileWords('useOn.actionFor', { name })} onClick={() => actions.onUseOn?.([file.id])}>
                <Copy size={14} aria-hidden /> {fileWords('useOn.action')}
              </Button>
            )}
            {rowActions /* B-TH-280: Versions, Mark up, What it is */}
            {/* F-CP-144 (B-CP-014): Mark as priced / Take the price mark off. */}
            {mark && (
              <Button size="sm" variant="quiet" title={pricedWords(mark === 'mark' ? 'priced.tickHint' : 'priced.unmarkHint')} aria-label={pricedWords(mark === 'mark' ? 'priced.markFor' : 'priced.unmarkFor', { name })} heldReason={model.busy ? t('upload.busy') : null} onClick={() => actions?.onPriced?.(file.id, mark === 'mark')}>
                {mark === 'mark' ? <Lock size={14} aria-hidden /> : <LockOpen size={14} aria-hidden />} {pricedWords(mark === 'mark' ? 'priced.mark' : 'priced.unmark')}
              </Button>
            )}
          </span>
        )}
        {series.earlier.length > 0 && (
          <Disclosure className="fw-rtv-versions" summary={t('version.earlier', { count: series.earlier.length })}>
            <ul className="fw-rtv-version-list">
              {series.earlier.map((earlier, index) => (
                <li key={earlier.id}>
                  <span>
                    {t('version.line', { n: earlier.versionNo ?? series.earlier.length - index, date: formatDate(earlier.createdAt, place) })}
                    {earlier.supersededAt && <span className="fw-rtv-muted"> · {t('version.replaced', { date: formatDate(earlier.supersededAt, place) })}</span>}
                  </span>
                  <span className="fw-rtv-version-actions">
                    <Button size="sm" variant="quiet" onClick={(event) => actions?.onOpen?.(earlier.id, event.currentTarget)}>
                      {t('version.open')}
                    </Button>
                    {/* F-OF-301 (F5-B11): Restore lives only inside Versions… (one path per job: it asks to confirm and says what it makes). */}
                  </span>
                </li>
              ))}
            </ul>
          </Disclosure>
        )}
      </span>
    </li>
  )
}

const AUDIENCE_WORD: Readonly<Record<FileAudience, string>> = { OFFICE: 'upload.audience.OFFICE', FLOOR: 'upload.audience.FLOOR', PARTNER: 'upload.audience.PARTNER', LINK: 'upload.audience.LINK' }

/**
 * "Add 2 files": the kind and the audience asked once, in the system's words; the audience starts on Office. F-OF-103 (13-backend §7 row 1:
 * exported, the ONE upload window): on an order it asks "Where it goes" (the order · Line {seq} · …) and offers no "Fiscal copy" (a fiscal
 * paper is made at its home); opened by "Add files…" it has its own drop area (`onAdd`), and waits for a file before Add.
 */
export function UploadDialog({ ask, party, busy, onChange, onConfirm, onCancel, onAdd, subtitle }: { ask: UploadAsk; party: { readonly name: string } | null; busy: boolean; onChange?: ((change: Partial<Pick<UploadAsk, 'kind' | 'audience' | 'sheet' | 'priced' | 'place'>>) => void) | undefined; onConfirm?: (() => void) | undefined; onCancel?: (() => void) | undefined; onAdd?: ((files: File[]) => void) | undefined; /* fx5w (W-05): "SEED-SO-0002 · Files" */ subtitle?: string | undefined }) {
  const t = useT(FILES_VIEW_NS)
  const fileWords = useT('record-thread-files')
  const pricedWords = useT('record-files') // F-CP-144
  const pricedHeld = uploadPricedHeld(ask) // F-CP-144
  const locale = useLocale()
  const audiences = ask.audiences.filter((audience) => audience !== 'PARTNER' || party !== null)
  const count = ask.files.length
  const placeWords = (place: UploadPlace) => (place.kind === 'order' ? t('upload.place.order') : place.kind === 'workOrder' ? (place.what ?? '') /* F-OF-203 */ : place.what ? t('upload.place.lineOf', { seq: place.seq ?? 0, what: place.what }) : t('upload.place.line', { seq: place.seq ?? 0 }))
  const askWords = useT('file-asks') // F-OF-203: an ask's upload says who asks what
  const forAsk = ask.forAsk ?? null
  return (
    <Modal
      open
      onClose={() => onCancel?.()}
      size="md"
      title={count === 0 ? t('upload.titleAdd') : t('upload.title', { count })}
      {...(subtitle ? { subtitle } : {})}
      footer={
        <>
          <Button onClick={() => onCancel?.()}>{t('upload.cancel')}</Button>
          <Button variant="primary" heldReason={busy ? t('upload.busy') : count === 0 ? t('upload.noneYet') /* F-OF-103 */ : uploadAskHeld(ask) ? t(uploadAskHeld(ask)!) : pricedHeld ? pricedWords(pricedHeld) /* F-CP-144 */ : null} onClick={() => onConfirm?.()}>
            {forAsk ? askWords('upload.send') /* F-OF-203 */ : count === 0 ? t('upload.titleAdd') : t('upload.confirm', { count })}
          </Button>
        </>
      }
    >
      <div className="fw-rtv-upload">
        {/* F-OF-203: "Upload for this ask" — the asker's words on top (a priced ask without the price grain: no words), when, where it lands. */}
        {forAsk && (
          <div className="fw-of-forask" role="note">
            <p className="fw-of-forask-words">{forAsk.words !== null ? askWords('upload.asks', { name: forAsk.by, words: forAsk.words }) : askWords('upload.asksPriced', { name: forAsk.by })}</p>
            <p className="fw-rtv-muted">{askWords('upload.due', { date: dayWords(forAsk.dueOn, locale) /* fx5w (W-11) */, target: forAsk.target })}</p>
          </div>
        )}
        {/* F-OF-103: opened by "Add files…", the window takes the files itself (drop or browse); more join the ones chosen. */}
        {/* fx5w (W-05): on an order the sizes it takes and the virus check, said before a file is chosen. */}
        {onAdd && <FileDropzone multiple onFiles={(files) => onAdd(files)} hint={ask.places ? t('upload.hintOrder') : t('upload.hint')} />}
        {count > 0 && (
          <ul className="fw-rtv-upload-files">
            {ask.files.map((file, index) => (
              <li key={`${index}:${file.name}`}>
                {file.name} <span className="fw-rtv-muted">{sizeWords(file.sizeBytes, locale)}</span>
              </li>
            ))}
          </ul>
        )}
        {/* F-OF-103 (10-design §7): where it goes — the order or one of its lines. */}
        {ask.places && ask.places.length > 0 && !forAsk && (
          <Field label={t('upload.where')}>
            <Select value={ask.place ?? ask.places[0]!.key} onChange={(event) => onChange?.({ place: event.target.value })}>
              {ask.places.map((place) => (
                <option key={place.key} value={place.key}>
                  {placeWords(place)}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label={t('upload.kind')}>
          <Select value={ask.kind} onChange={(event) => onChange?.({ kind: event.target.value as FileKind })}>
            {ask.kinds.map((kind) => (
              <option key={kind} value={kind}>
                {fileWords(`kind.${kind}`)}
              </option>
            ))}
          </Select>
        </Field>
        {ask.places && !forAsk && <p className="fw-rtv-muted">{t('upload.noFiscal') /* F-OF-103 (F5-B1) */}</p>}
        {/* B-TH-283 (B-TH-083): the measurement-sheet tick, at upload. */}
        <Checkbox
          label={
            <span>
              {t('upload.sheet')} <span className="fw-rtv-muted">· {t('upload.sheetHint')}</span>
            </span>
          }
          checked={ask.sheet ?? false}
          onChange={(event) => onChange?.({ sheet: event.target.checked })}
        />
        {/* F-CP-144 (B-CP-014): "This file shows prices" — a customer's PO, a price list: then only people who see prices open it. */}
        <Checkbox
          label={
            <span>
              {pricedWords('priced.tick')} <span className="fw-rtv-muted">· {pricedWords('priced.tickHint')}</span>
            </span>
          }
          checked={ask.priced ?? false}
          onChange={(event) => onChange?.({ priced: event.target.checked })}
        />
        {pricedHeld && <p className="fw-rtv-held">{pricedWords(pricedHeld)}</p>}
        <fieldset className="fw-rtv-fieldset">
          <legend className="fw-rtv-legend">{t('upload.who')}</legend>
          {audiences.map((audience) => (
            <RadioCard
              key={audience}
              name="fw-rtv-audience"
              checked={ask.audience === audience}
              selected={ask.audience === audience}
              onChange={() => onChange?.({ audience })}
              title={t(AUDIENCE_WORD[audience], { party: party?.name ?? '' })}
              description={t(`${AUDIENCE_WORD[audience]}Body`, { party: party?.name ?? '' })}
            />
          ))}
        </fieldset>
        {/* fx5w (W-05; 10-design §7 Add files): What happens · The customer · What never changes — as every file window says them. */}
        {ask.places && !forAsk && <ActLines problem={null} happens={t('upload.happens')} customer={t('upload.customer')} never={t('upload.never')} />}
      </div>
    </Modal>
  )
}

/** F-OF-103 (F5-B6): the files the virus scan holds after an upload — said once, with why; they open once the scan says clean. */
function HeldUploads({ names, onDismiss }: { names: readonly string[]; onDismiss?: (() => void) | undefined }) {
  const t = useT(FILES_VIEW_NS)
  return (
    <Banner tone="warning" title={t('upload.heldTitle', { count: names.length })} action={onDismiss ? <Button size="sm" variant="quiet" onClick={onDismiss}>{t('refused.dismiss')}</Button> : undefined}>
      <p className="fw-rtv-muted">{t('keep.scanPending')}</p>
      <ul className="fw-rtv-refused">
        {names.map((name, index) => (
          <li key={`${index}:${name}`}>{name}</li>
        ))}
      </ul>
    </Banner>
  )
}

/** F-OF-103: the refused files of the last upload, with why (F5-B7: the API's words) — the order's body says them as the window does. */
function RefusedUploads({ refused, onDismiss }: { refused: readonly { readonly name: string; readonly reason: string }[]; onDismiss?: (() => void) | undefined }) {
  const t = useT(FILES_VIEW_NS)
  return (
    <Banner tone="danger" title={t('refused.title', { count: refused.length })} action={onDismiss ? <Button size="sm" variant="quiet" onClick={onDismiss}>{t('refused.dismiss')}</Button> : undefined}>
      <ul className="fw-rtv-refused">
        {refused.map((one, index) => (
          <li key={`${index}:${one.name}`}>
            <strong>{one.name}</strong>: {one.reason}
          </li>
        ))}
      </ul>
    </Banner>
  )
}

/** F-OF-103: files dropped anywhere on Files go to "Add files…" (the window asks where they go and what they are). */
function dropOn(onFiles: ((files: File[]) => void) | null) {
  if (!onFiles) return {}
  return {
    onDragOver: (event: DragEvent<HTMLElement>) => {
      if (event.dataTransfer?.types?.includes('Files')) event.preventDefault()
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      const files = [...(event.dataTransfer?.files ?? [])]
      if (files.length === 0) return
      event.preventDefault()
      onFiles(files)
    },
  }
}

// ── F-SA-237 (sales page plan N9, picks P14, R7) ──────────────────────────────────────────────────────────────────────────────

/** F-OF-101: the catalogues the order files body speaks (the tab's head, menu and ⓘ draw inside the same ones). */
export const ORDER_FILES_NS: readonly string[] = [FILES_VIEW_NS, 'record-thread-files', 'lists', /* F-CP-144 */ 'record-files', /* F-OF-201 */ ASKS_NS, /* F-OF-302: Use on…, an act's notice */ 'search', 'record-thread']

/**
 * The order files body on its own (the order's Files tab mounts it; this window mounts it for a SalesOrder). F-OP-125: `place` — the
 * tab (its keys in the Files section's ⓘ, F-OF-101) or the thread's Files window (narrower cards; its keys are the window's footer).
 */
export function OrderFilesBody({ model, party, actions, place = 'tab' }: { model: OrderFilesModel; party: { readonly name: string } | null; actions?: FilesViewActions; place?: 'tab' | 'window' }) {
  return (
    <WithMessages namespaces={ORDER_FILES_NS}>
      <OrderFilesView model={model} party={party} actions={actions} place={place} />
    </WithMessages>
  )
}

/**
 * A sales order's files by where they come from (Order & thread · Lines & artwork · Customer's tech pack · Requests · Production ·
 * Quality · Shipments · Invoices & credit notes · Returns & complaints). F-OP-125 (order page N7 "files like Gmail"): each file is a
 * CARD — its preview, the name (it opens the ONE viewer), "PDF · 1.2 MB · 12 Nov", "added by <name>" (office only; the floor never by a
 * worker), chips; a box to choose it; Download and Open in the conversation. F-OF-101 (order FILES tab, 10-design §5): the groups flow
 * side by side (a one-file group never leaves a wide empty box), each group made on another page holds one block per source with its
 * door "Open on … ›" (Production by work order, one block per shipment, invoice, case); an annulled or replaced paper folds under
 * "Show N older" with its words; the files the reader may not open are counted ONCE, with the reasons, never named. Keys: ← / → / ↑ / ↓
 * between cards (↑ / ↓ by one grid row), x chooses, Enter opens.
 */
function OrderFilesView({ model, party, actions, place = 'window' }: { model: OrderFilesModel; party: { readonly name: string } | null; actions?: FilesViewActions | undefined; place?: 'tab' | 'window' }) {
  const t = useT(FILES_VIEW_NS)
  const askT = useT(ASKS_NS) // F-OF-201
  const fileWords = useT('record-thread-files')
  const locale = useLocale()
  const listRef = useRef<HTMLDivElement>(null)
  // ---- F-OP-126 (R-14): the file cards in view, 200 px ahead (an IntersectionObserver); only those are asked a preview ----
  const onVisible = actions?.onOrderVisible
  const report = useRef(onVisible)
  report.current = onVisible
  const shown = !!model.read && !model.problem
  useEffect(() => {
    const list = listRef.current
    if (!shown || !list || typeof IntersectionObserver === 'undefined' || !report.current) return
    const inView = new Set<string>()
    const order = () => [...list.querySelectorAll<HTMLElement>('li[data-card-id]')].map((card) => card.dataset.cardId!).filter((id) => inView.has(id))
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.cardId!
          if (entry.isIntersecting) inView.add(id)
          else inView.delete(id)
        }
        report.current?.(order())
      },
      { rootMargin: '200px' },
    )
    for (const card of list.querySelectorAll<HTMLElement>('li[data-card-id]')) observer.observe(card)
    return () => observer.disconnect()
  }, [shown, model.read])
  // ---- end F-OP-126
  if (model.problem) return <Banner tone="danger" title={t('problem.read')} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('problem.retry')}</Button>} />
  if (!model.read) {
    return (
      <div className="fw-rtv-loading" role="status" aria-label={t('loading')}>
        {[0, 1, 2].map((row) => (
          <Skeleton key={row} height={44} />
        ))}
      </div>
    )
  }
  const read = model.read
  const customer = model.face === 'customer' // F-SA-238: the portal's face of the same body
  // F-OF-101: the tab's groups (Shipments and Invoices & credit notes apart, one block per source), the walk, the counted line.
  const sections = orderSectionsOf(read, customer ? 'customer' : 'office')
  const choosable = customer ? [] : orderChoosableOf(sections)
  const ids = new Set(choosable.map((file) => file.id))
  const counted = customer ? null : orderCountedOf(read, sections)
  const chosen = choosable.filter((file) => model.selected.includes(file.id))
  const reach = orderBulkReach(chosen, read.order.id, { may: model.may, readOnly: !!model.readOnly, now: Date.now() }) // F-OF-303
  const allChosen = choosable.length > 0 && chosen.length === choosable.length
  const choose = (fileId: string, on: boolean) => actions?.onOrderSelect?.(on ? [...new Set([...model.selected, fileId])] : model.selected.filter((one) => one !== fileId))
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    if (target.closest('input, select, textarea')) return
    const cards = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('button[data-row]') ?? [])]
    const current = target.closest('button[data-row]') as HTMLButtonElement | null
    const at = current ? cards.indexOf(current) : -1
    const arrow = ARROWS.find((key) => key === event.key)
    if (arrow) {
      if (cards.length === 0) return
      event.preventDefault()
      const next = at < 0 ? 0 : cardStep(at, cards.length, arrow, columnsOf(current))
      if (next !== null) cards[next]?.focus()
    } else if (event.key.toLowerCase() === 'x' && at >= 0) {
      const fileId = cards[at]!.dataset.row!
      if (customer || !ids.has(fileId)) return
      event.preventDefault()
      choose(fileId, !model.selected.includes(fileId))
    }
  }
  const empty = sections.length === 0 && (!counted || (counted.locked === 0 && counted.checking === 0))
  const words = { t, fileWords, locale, askT }
  // F-OF-103: "Add files…" — hidden without the right (the read's `may`, else the session's); files dropped on Files go to it too.
  const mayUpload = !customer && !!model.may?.upload && !!actions?.onOrderAdd
  const outcome = customer ? null : (model.uploadOutcome ?? null)
  const toCheck = customer ? new Set<string>() : arrivedFileIds(read.asks) // F-OF-201: files that came for an ask, still to check
  return (
    <div className={`fw-rtv-order${place === 'window' ? ' is-window' : ''} fw-of-body`} {...dropOn(mayUpload ? (files) => actions?.onOrderAdd?.(files) : null)}>
      {/* F-OF-103: the order's thread window has no head of its own — its one Add is here (the tab's sits in the Files head). */}
      {place === 'window' && mayUpload && (
        <div className="fw-of-wbar">
          <Button size="sm" onClick={() => actions?.onOrderAdd?.([])}>
            <Upload size={14} aria-hidden /> {t('files.add')}
          </Button>
        </div>
      )}
      {/* F-OF-201: the order's thread window draws "Waiting for files" above the files (the tab draws it in its own section). */}
      {place === 'window' && !customer && model.asks && read.asks && (
        <section className="fw-of-asks-w" aria-label={askT('band.title')}>
          <AsksWindowHead read={read} state={model.asks} onAsk={actions?.onAskNew} />
          <AsksBody read={read} state={model.asks} actions={actions} customer={party?.name ?? null} />
        </section>
      )}
      {outcome && outcome.refused.length > 0 && <RefusedUploads refused={outcome.refused} onDismiss={actions?.onOrderUploadDismiss} />}
      {outcome && outcome.held.length > 0 && <HeldUploads names={outcome.held} onDismiss={actions?.onOrderUploadDismiss} />}
      {!customer && model.acts?.notice && <ActNoticeLine notice={model.acts.notice} onDismiss={actions?.onActNoticeDismiss} /* F-OF-304: one notice */ />}
      {counted && <CountedLine counted={counted} />}
      {read.truncated && <p className="fw-rtv-muted">{t('order.truncated', { count: read.total })}</p>}
      {empty ? (
        // P0-B6: the tab's head already says "No files yet" (one line, no box); the window and the portal say it here.
        place === 'tab' && !customer ? null : <EmptyState icon={<FolderOpen size={22} aria-hidden />} title={t(customer ? 'order.empty.customer' : 'order.empty.title')} description={mayUpload ? t('order.empty.add') : undefined} />
      ) : (
        <>
          {place === 'window' && choosable.length > 0 && !customer && (
            <div className="fw-rtv-tools">
              {/* F-OF-102 (P0-B5): one Clear only — the bar's; the box says "Choose all" (unticking it clears too). */}
              <Checkbox label={t('select.all', { count: choosable.length })} checked={allChosen} onChange={(event) => actions?.onOrderSelect?.(event.target.checked ? choosable.map((file) => file.id) : [])} />
            </div>
          )}
          {chosen.length > 0 && !customer && (
            // F-OF-102 (P0-B4): "1 file chosen" / "3 files chosen"; one Clear, in the reader's language.
            <BulkActionBar count={chosen.length} noun={t('bulk.chosen', { count: chosen.length })}>
              <Button size="sm" onClick={() => actions?.onOrderBulk?.('download', reach.download)}>
                <Download size={14} aria-hidden /> {t('bulk.download', { count: reach.download.length })}
              </Button>
              {/* F-OF-303 (L7): "Who can see N…" — the order's own files and its lines' (it shares or takes back); hidden without the right,
                  held with words only by what is chosen. Delete N… (D4) in the bar's ⋯: the whole documents, with a reason. */}
              {reach.canWho && (
                <Button size="sm" heldReason={reach.who.length === 0 ? t('acts.held.noneOwn') : model.busy ? t('upload.busy') : null} onClick={() => actions?.onOrderBulk?.('whoCanSee', reach.who)}>
                  <Users size={14} aria-hidden /> {t('acts.bulk.who', { count: reach.who.length })}
                </Button>
              )}
              {reach.canDelete && (
                <Menu
                  align="right"
                  label={<MoreHorizontal size={16} aria-hidden />}
                  triggerProps={{ 'aria-label': t('acts.bulk.more'), className: 'nds-btn sm icon' }}
                  items={[{ id: 'delete', label: t('acts.bulk.delete', { count: reach.remove.length }), tone: 'danger', disabled: reach.remove.length === 0, description: reach.remove.length === 0 ? t('acts.held.noneDelete') : undefined, onSelect: reach.remove.length === 0 ? undefined : () => actions?.onOrderBulk?.('delete', reach.remove) }]}
                />
              )}
              <Button size="sm" variant="quiet" onClick={() => actions?.onOrderSelect?.([])}>
                {t('bulk.clear')}
              </Button>
            </BulkActionBar>
          )}
          <div ref={listRef} className="fw-of-groups" onKeyDown={keys}>
            {sections.map((section) => {
              const title = section.words ? (locale === 'it' ? section.words.it : section.words.en) : t(`order.group.${section.key}`)
              const widest = Math.max(1, ...section.blocks.map((block) => Math.min(4, block.files.length)), Math.min(4, section.worksheets.length))
              const extras = [
                ...section.worksheets.map((sheet) => <WorksheetCard key={sheet.documentId} sheet={sheet} actions={actions} words={words} />),
                ...section.held.map((held) => <HeldCard key={held.id} held={held} words={words} />), // F-OF-102: the reader's own, held by the scan
              ]
              const last = section.blocks[section.blocks.length - 1]
              const extrasInLast = !!last && last.head === null
              return (
                // F-OF-101: one anchor per group on the tab (#files-ORDER …); the window draws none (the tab may be open beside it).
                <section key={section.key} id={place === 'tab' ? `files-${section.key}` : undefined} className="fw-of-group" style={{ ['--fw-of-n' as string]: String(widest) } as CSSProperties} aria-label={title}>
                  <div className="fw-of-group-h">
                    <h3>
                      {title} <span className="fw-of-n">{section.count}</span>
                    </h3>
                    {/* F-OF-102 (F7-B10): everyone else's files the virus scan holds, counted — never named, never opened. */}
                    {section.checking > 0 && (
                      <span className="fw-of-mu">
                        <ShieldAlert size={12} aria-hidden /> {t('group.checking', { count: section.checking })}
                      </span>
                    )}
                  </div>
                  {section.blocks.map((block) => (
                    <OrderBlock key={block.key} block={block} orderId={read.order.id} customer={customer} model={model} actions={actions} words={words} extras={block === last && extrasInLast ? extras : []} onChoose={choose} toCheck={toCheck} />
                  ))}
                  {!extrasInLast && extras.length > 0 && <ul className="fw-rtv-cards fw-of-cards">{extras}</ul>}
                </section>
              )
            })}
          </div>
        </>
      )}
      {/* F-OP-127: the ONE viewer of these files — ← / → over every file in display order; body data only when asked; Esc back to the card. */}
      {model.viewer && (
        <FileViewer
          walk="all"
          files={model.viewer.files}
          index={model.viewer.index}
          onIndex={(index) => actions?.onViewerIndex?.(index)}
          onClose={() => actions?.onViewerClose?.()}
          onOpenLocked={actions?.onViewerOpenLocked}
          onDownload={actions?.onViewerDownload}
          onRetry={actions?.onViewerRetry /* F-OF-104 */}
          onGoToMessage={actions?.onOrderMessage ? (messageId) => {
            actions.onViewerClose?.()
            actions.onOrderMessage?.(messageId)
          } : undefined}
          returnFocusTo={model.viewer.returnTo}
        />
      )}
      {/* F-OF-103: "Add files…" — the ONE upload window (the order or one of its lines; no "Fiscal copy" here). */}
      {model.upload && !customer && <UploadDialog ask={model.upload} party={party} busy={model.busy ?? false} onChange={actions?.onOrderUploadChange} onConfirm={actions?.onOrderUploadConfirm} onCancel={actions?.onOrderUploadCancel} onAdd={actions?.onOrderAdd} subtitle={t('upload.subtitle', { record: read.order.number })} />}
      {/* F-OF-202 / F-OF-203: the band's windows — drawn once by the body, the same for the tab and the order's thread window. */}
      {model.asks && !customer && <AskWindows read={read} state={model.asks} actions={actions} customer={party?.name ?? null} orderLabel={read.order.number} />}
      {/* F-OF-303: the file windows (Who can see…, Rename…, Delete…, New version…, Mark as priced?) and "Use on another record…" — drawn once. */}
      {!customer && <FileActWindows state={model.acts} actions={actions} />}
      {!customer && model.useOn && actions?.orderUseOn && <UseOnDialog model={model.useOn} actions={actions.orderUseOn} />}
    </div>
  )
}

const ARROWS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'] as const

/** How many cards one grid row holds where this card sits (↑ / ↓ move by it). */
function columnsOf(card: HTMLElement | null): number {
  const list = card?.closest('ul')
  if (!list) return 1
  const tops = [...list.children].map((child) => (child as HTMLElement).offsetTop)
  return Math.max(1, tops.filter((top) => top === tops[0]).length)
}

type CardWords = { t: (key: string, params?: Record<string, string | number>) => string; fileWords: (key: string, params?: Record<string, string | number>) => string; locale: 'it' | 'en'; /* F-OF-201 */ askT: (key: string, params?: Record<string, string | number>) => string }

/**
 * F-OF-101 (P0-B1, P0-B2): the files the reader may not open, said ONCE under the Files head with the reasons — "3 files you cannot open:
 * 2 priced · 1 outside your role" — and the files the virus scan holds; never named, never "+ 1" under a group.
 */
function CountedLine({ counted }: { counted: OrderCounted }) {
  const t = useT(FILES_VIEW_NS)
  if (counted.locked === 0 && counted.checking === 0) return null
  const reasons = [counted.priced > 0 ? t('counted.priced', { count: counted.priced }) : null, counted.sheets > 0 ? t('counted.sheets', { count: counted.sheets }) : null, counted.role > 0 ? t('counted.role', { count: counted.role }) : null].filter((part): part is string => part !== null)
  return (
    <p className="fw-of-counted" role="note">
      <Lock size={12} aria-hidden />
      <span>
        {counted.locked > 0 && <b>{`${t('order.leftOut', { count: counted.locked })}:`}</b>}
        {[counted.locked > 0 ? ` ${reasons.join(' · ')}` : '', counted.checking > 0 ? `${counted.locked > 0 ? ' · ' : ''}${t('held.checking', { count: counted.checking })}` : ''].join('')}
      </span>
    </p>
  )
}

/** F-OF-101: one source of a group — its head and door "Open on … ›" (the record's own page keeps its commands), its cards, its folded papers. */
function OrderBlock({ block, orderId, customer, model, actions, words, extras, onChoose, toCheck }: { block: OrderFilesBlock; orderId: string; customer: boolean; model: OrderFilesModel; actions?: FilesViewActions | undefined; words: CardWords; extras: readonly ReactNode[]; onChoose: (fileId: string, on: boolean) => void; /* F-OF-201 */ toCheck: ReadonlySet<string> }) {
  const { t } = words
  const [open, setOpen] = useState(false)
  const door = block.head?.door ?? null
  const href = door ? (actions?.orderHrefOf?.(door) ?? null) : null
  // F-OF-302: each card's ⋯ acts for this reader (the order's own files; none for the customer's face).
  const actsOf = (file: OrderFile) => (customer ? [] : orderFileActsOf(file, { orderId, may: model.may, readOnly: !!model.readOnly, now: Date.now(), versions: !!model.versionsHere }))
  const card = (file: OrderFile, older: boolean) => <OrderCard key={file.id} file={file} orderId={orderId} customer={customer} older={older} chosen={model.selected.includes(file.id)} onChoose={(on) => onChoose(file.id, on)} actions={actions} words={words} preview={model.previews?.[file.id]} toCheck={toCheck.has(file.id)} acts={actsOf(file)} />
  return (
    <div className="fw-of-block">
      {block.head && (block.head.label || href) && (
        <div className="fw-of-block-h">
          {block.head.label && <b>{block.head.label}</b>}
          {/* fx5w (W-12, fx5s): a shipment's block — "Shipped 12 Nov · DDT 144/2026", each part only when the read gives it. */}
          {block.head.shipment?.shippedOn && <span className="fw-rtv-muted">· {t('order.block.shipped', { date: dayWords(block.head.shipment.shippedOn, words.locale) })}</span>}
          {block.head.shipment?.ddtNumber && <span className="fw-rtv-muted">· {t('order.block.ddt', { number: block.head.shipment.ddtNumber })}</span>}
          <span className="fw-of-sp" />
          {href && door && (
            <Link className="fw-of-door" href={href} prefetch={false}>
              {door.type.startsWith('OrderChangeRequest') ? t('order.openOnChanges') : t('order.openOn', { record: door.label })}
            </Link>
          )}
        </div>
      )}
      {(block.files.length > 0 || extras.length > 0) && (
        <ul className="fw-rtv-cards fw-of-cards">
          {block.files.map((file) => card(file, false))}
          {extras}
        </ul>
      )}
      {block.older.length > 0 && (
        <>
          <Button size="sm" variant="link" className="fw-of-older" aria-expanded={open} onClick={() => setOpen((now) => !now)}>
            {open ? <ChevronUp size={14} aria-hidden /> : <ChevronDown size={14} aria-hidden />} {t(open ? 'order.older.hide' : 'order.older.show', { count: block.older.length })}
          </Button>
          {open && <ul className="fw-rtv-cards fw-of-cards">{block.older.map((file) => card(file, true))}</ul>}
        </>
      )}
    </div>
  )
}

const FILE_KINDS: readonly string[] = ['PHOTO', 'DOCUMENT', 'CERTIFICATE', 'FISCAL_ARCHIVE', 'AUDIO', 'ATTACHMENT']

/**
 * One file's card (F-OP-125): the preview area, the name, its facts, its chips, its box and its actions. F-OF-101: the name is plain
 * text that opens the ONE viewer (P0-B12: not a navigation); from 300 px of its own room the card turns sideways (preview left, words
 * right); its versions, a fiscal copy kept until …, a legal hold, an annulled or replaced paper and the tech pack's mark are said.
 */
function OrderCard({ file, orderId, customer, older, chosen, onChoose, actions, words, preview, toCheck = false, acts = [] }: { file: OrderFile; orderId: string; customer: boolean; older: boolean; chosen: boolean; onChoose: (on: boolean) => void; actions?: FilesViewActions | undefined; words: CardWords; /* F-OP-126 */ preview?: CardPreview | undefined; /* F-OF-201 */ toCheck?: boolean; /* F-OF-302 */ acts?: ReturnType<typeof orderFileActsOf> }) {
  const { t, fileWords, locale } = words
  const openRef = useRef<HTMLButtonElement>(null)
  const source = sourceOf(file, orderId)
  const kind = FILE_KINDS.includes(file.kind) ? (file.kind as FileKind) : 'ATTACHMENT'
  const card = cardKindOf(file)
  const type = file.documentWords ? (locale === 'it' ? file.documentWords.it : file.documentWords.en) : typeLabelOf(file) || fileWords(`kind.${kind}`)
  const added = customer ? null : addedByOf(file)
  const earlier = (file.versions ?? 0) - 1 // F-OF-101 (B-OF-001): the versions kept besides the one in force
  return (
    <li className={`fw-rtv-card fw-of-card${chosen ? ' is-chosen' : ''}${older ? ' is-older' : ''}${toCheck ? ' is-asked' : ''}`} data-card-id={file.id}>
      {!customer && !older && (
        <span className="fw-rtv-card-check">
          <Checkbox label={<span className="nds-vh">{t('select.one', { name: file.name })}</span>} checked={chosen} onChange={(event) => onChoose(event.target.checked)} />
        </span>
      )}
      <div className="fw-of-card-in">
        {/* The preview opens the viewer through the card's one open button (the focus comes back to it). */}
        <span className={`fw-rtv-card-preview${card === 'LOCKED' ? ' is-locked' : preview?.kind === 'page' ? ' is-page' : ''}`} aria-hidden={card === 'LOCKED' ? undefined : true} onClick={() => openRef.current?.click()}>
          {card === 'LOCKED' ? (
            <>
              <Lock size={20} aria-hidden />
              <span>{t('card.bodyData')}</span>
            </>
          ) : preview?.kind === 'picture' || preview?.kind === 'page' ? (
            // F-OP-126: the small preview, or PDF page 1 drawn here (never the original, never an iframe). F-OF-104: a picture kept while
            // the page stays; one that no longer loads (drawn again after its address expired) is asked again.
            <img src={preview.src} alt="" loading="lazy" decoding="async" onError={preview.kind === 'picture' ? () => actions?.onOrderPreviewFailed?.(file.id) : undefined} />
          ) : preview?.kind === 'largePdf' ? (
            <>
              {KIND_ICON[kind]}
              <span className="fw-rtv-card-note">{t('card.largePdf')}</span>
            </>
          ) : (
            KIND_ICON[kind]
          )}
        </span>
        <div className="fw-of-card-bd">
          <button ref={openRef} type="button" className="fw-rtv-card-open" data-row={file.id} title={file.name} onClick={(event) => actions?.onOrderOpen?.(file.id, 'preview', event.currentTarget)}>
            <span className="fw-rtv-card-name">{file.name}</span>
          </button>
          <span className="fw-rtv-card-meta">
            {[type, sizeWords(file.sizeBytes, locale), dayWords(file.at, locale) /* fx5w (W-11) */].filter(Boolean).join(' · ')}
            {file.versionNo > 1 && <> · {t('version.inForce', { n: file.versionNo })}</>}
            {!customer && earlier > 0 && <> · {t('version.earlier', { count: earlier })}</>}
          </span>
          {added && <span className="fw-rtv-card-meta">{t(added.key, added.params)}</span>}
          <span className="fw-rtv-marks">
            {/* F-SA-238: the customer reads where it sits by its own numbers only (none: no chip), never who else can see it. */}
            {customer ? file.from.label && source.key === 'order.source.from' && <Tag tone="neutral">{t(source.key, source.params)}</Tag> : <Tag tone="neutral">{t(source.key, source.params)}</Tag>}
            {/* F-OF-102 (F6-B2, P0-B13): the TRUE chip in the dock's words — a floor or link file is no longer "Office only". */}
            {!customer &&
              chipMarksOf(file).map((mark) => (
                <Tag key={mark} tone={mark === 'customer' ? 'info' : 'neutral'}>
                  {fileWords(`audience.${mark}`)}
                </Tag>
              ))}
            {file.bodyData && <Tag tone="warning">{fileWords('sheet.recorded')}</Tag>}
            {/* F-OF-101 (B-OF-001, B-OF-003): a fiscal copy and how long it is kept, a legal hold, a paper kept by law — said, never acted on here. */}
            {!customer && file.fiscal && <Tag tone="neutral">{fileWords('kind.FISCAL_ARCHIVE')}</Tag>}
            {!customer && file.kept?.retainUntil && <Tag tone="neutral">{t('keep.until', { date: dayWords(file.kept.retainUntil, locale) })}</Tag>}
            {!customer && file.kept?.legalHold && <Tag tone="warning">{t('keep.legalHold')}</Tag>}
            {!customer && file.from.state && <Tag tone="warning">{t(`order.state.${file.from.state}`)}</Tag>}
            {/* F-OF-101 (F2-B1): the tech pack's version in force is newer than the one the request named. */}
            {!customer && file.techPack?.newer && (
              <>
                <Tag tone="neutral">{t('order.techPack.named', { n: file.techPack.named })}</Tag>
                <Tag tone="warning">{t('order.techPack.newer')}</Tag>
              </>
            )}
            {/* F-OF-201: a file that came for an ask, still to check (the card is ringed). */}
            {!customer && toCheck && <Tag tone="success">{words.askT('file.forAsk')}</Tag>}
            {file.alsoOn.map((other) => (
              <Tag key={`${other.type}:${other.id}`} tone="neutral">
                {t('order.alsoOn', { record: other.label })}
              </Tag>
            ))}
            {file.alsoOnOther > 0 && <Tag tone="neutral">{t('order.alsoOnOther', { count: file.alsoOnOther })}</Tag>}
          </span>
          {(!customer || file.inThread) && (
            <span className="fw-rtv-card-actions">
              {!customer && (
                // owb-of6 step 4 (design § 5p point 1): the office card's download shows when the card is pointed at or focused, always on
                // a touch screen (files-tab.css .fw-of-dl); the portal's face has no such button and stays as it is.
                <Button size="sm" variant="quiet" className="fw-of-dl" aria-label={t('card.downloadOf', { name: file.name })} onClick={() => actions?.onOrderOpen?.(file.id, 'download')}>
                  <Download size={14} aria-hidden /> <span className="fw-of-dl-word">{t('card.download') /* fx5w (W-13): an icon at S; the name stays for screen readers */}</span>
                </Button>
              )}
              {/* F-OF-302 (10-design §5): the office's card is [Download] [⋯] — Open in the conversation moved into the ⋯; the customer keeps it. */}
              {customer && file.inThread && actions?.onOrderMessage && (
                <Button size="sm" variant="quiet" onClick={() => actions.onOrderMessage?.(file.inThread!.messageId)}>
                  {t('order.inThread')}
                </Button>
              )}
              {!customer && <CardMenu file={file} orderId={orderId} acts={acts} actions={actions} words={words} />}
            </span>
          )}
        </div>
      </div>
    </li>
  )
}

// ---- F-OF-302 (10-design §5 "Card ⋯"): the card's ⋯ — on the order's own files their acts (a right missing hides one; a state holds it
// with words, keyboard reachable, never run), then Open in the conversation; on any other file Open in the conversation and Open on its
// home ›. Nothing to offer: no ⋯ (never an empty menu).
const ACT_LABEL: Readonly<Record<OrderFileAct, { readonly ns: 'view' | 'priced' | 'useOn'; readonly key: string }>> = Object.freeze({
  newVersion: { ns: 'view', key: 'acts.menu.newVersion' },
  versions: { ns: 'view', key: 'acts.menu.versions' },
  whoCanSee: { ns: 'view', key: 'acts.menu.whoCanSee' },
  markPriced: { ns: 'priced', key: 'priced.mark' },
  unmarkPriced: { ns: 'priced', key: 'priced.unmark' },
  rename: { ns: 'view', key: 'acts.menu.rename' },
  useOn: { ns: 'useOn', key: 'useOn.action' },
  delete: { ns: 'view', key: 'acts.menu.delete' },
})

function CardMenu({ file, orderId, acts, actions, words }: { file: OrderFile; orderId: string; acts: ReturnType<typeof orderFileActsOf>; actions?: FilesViewActions | undefined; words: CardWords }) {
  const { t, fileWords, locale } = words
  const priced = useT('record-files')
  const items: MenuItemDef[] = acts.map(({ act, held, params }) => {
    const label = ACT_LABEL[act]
    const text = label.ns === 'priced' ? priced(label.key) : label.ns === 'useOn' ? fileWords(label.key) : t(label.key)
    const heldWords = held ? t(held, params?.date ? { date: dayWords(params.date, locale) } : params) : null
    return { id: act, label: text, ...(act === 'delete' ? { tone: 'danger' as const } : {}), disabled: heldWords !== null, description: heldWords ?? undefined, onSelect: heldWords ? undefined : () => actions?.onOrderAct?.(act, file.id) }
  })
  if (file.inThread && actions?.onOrderMessage) items.push({ id: 'in-thread', label: t('order.inThread'), onSelect: () => actions.onOrderMessage?.(file.inThread!.messageId) })
  const home = blockRefOf(file) // B-OF-003: a DDT's paper opens on the shipment it travels with
  const href = !isOrderOwn(file, orderId) ? (actions?.orderHrefOf?.(home) ?? null) : null
  if (href) items.push({ id: 'open-on', label: home.type.startsWith('OrderChangeRequest') ? t('order.openOnChanges') : t('order.openOn', { record: home.label }), href })
  if (items.length === 0) return null
  return <Menu align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': t('acts.menu.label', { name: file.name }), className: 'nds-btn quiet sm icon' }} items={items} />
}

/** F-OF-304: what the last act did — ONE notice on the body (its own words; Dismiss clears it, the next act replaces it). */
function ActNoticeLine({ notice, onDismiss }: { notice: NonNullable<FileActsState['notice']>; onDismiss?: (() => void) | undefined }) {
  const t = useT(notice.ns)
  const view = useT(FILES_VIEW_NS)
  return <Banner tone={notice.tone} title={t(notice.key, notice.params)} action={onDismiss ? <Button size="sm" variant="quiet" onClick={onDismiss}>{view('refused.dismiss')}</Button> : undefined} />
}
// ---- end F-OF-302

/**
 * F-OF-102 (B-OF-002; F7-B10, F5-B6): one of the reader's OWN uploads the virus scan still holds — its name, when, "added by you" and why
 * in words; never opened, never downloaded, never chosen (a floor photo being checked is only counted in its group's head).
 */
function HeldCard({ held, words }: { held: OrderHeldFile; words: CardWords }) {
  const { t, locale } = words
  return (
    <li className="fw-rtv-card fw-of-card is-held" data-held-id={held.id}>
      <div className="fw-of-card-in">
        <span className="fw-rtv-card-preview fw-of-checking" aria-hidden>
          <ShieldAlert size={20} aria-hidden />
          <span>{t('card.checking')}</span>
        </span>
        <div className="fw-of-card-bd">
          <span className="fw-of-card-title">{held.name}</span>
          <span className="fw-rtv-card-meta">{[typeLabelOf({ name: held.name, contentType: '' }), dayWords(held.at, locale), t('card.addedByYou')].filter(Boolean).join(' · ')}</span>
          <span className="fw-rtv-card-meta">{t(heldReasonKey(held))}</span>
        </div>
      </div>
    </li>
  )
}

/** F-OP-125 (B5): a made-to-measure line's worksheet — body data: a lock card; Open records the opening (the made-to-measure route). */
function WorksheetCard({ sheet, actions, words }: { sheet: OrderWorksheet; actions?: FilesViewActions | undefined; words: CardWords }) {
  const { t, fileWords, locale } = words
  const name = t('card.worksheet', { line: sheet.line.seq, version: sheet.version })
  return (
    <li className="fw-rtv-card fw-of-card">
      <div className="fw-of-card-in">
        <span className="fw-rtv-card-preview is-locked">
          <Lock size={20} aria-hidden />
          <span>{t('card.bodyData')}</span>
        </span>
        <div className="fw-of-card-bd">
          <button type="button" className="fw-rtv-card-open" data-row={worksheetCardId(sheet)} title={name} onClick={() => actions?.onOrderWorksheet?.(sheet)}>
            <span className="fw-rtv-card-name">{name}</span>
          </button>
          <span className="fw-rtv-card-meta">{[sheet.number, sheet.language.toUpperCase(), dayWords(sheet.createdAt, locale)].filter(Boolean).join(' · ')}</span>
          <span className="fw-rtv-marks">
            <Tag tone="warning">{fileWords('sheet.recorded')}</Tag>
          </span>
        </div>
      </div>
    </li>
  )
}
// ── end F-SA-237
