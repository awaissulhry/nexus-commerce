'use client'

import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { AudioLines, BadgeCheck, Copy, Download, FileText, FolderOpen, Image as ImageIcon, Lock, Paperclip, Receipt, RotateCcw, Share2, ShieldOff, Trash2 } from 'lucide-react'
import { Banner, Disclosure, EmptyState, Field } from '@nexus/ui/components'
import { BulkActionBar } from '@nexus/ui/patterns'
import { Button, Checkbox, RadioCard, Select, Skeleton, Tag } from '@nexus/ui/primitives'
import { FileDropzone, Modal } from '../../../i18n/ds-parts'
import { formatDate } from '../../../i18n/format'
import { useLocale, useT } from '../../../i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { ListKeysInfo } from '../../../../list-frame/ListKeysInfo'
import type { FileAudience, FileKind } from '../../../../record-panels/model'
import { sizeWords } from '../../popups/view/FileViewer'
import { audienceMarks, versionMark, type FileSeries, type FilesParty, type ThreadFile } from '../../files/model'
import { bulkReach, filesGroups, keepLines, rangeOf, type FilesAbilities, type MissingDocument, type UploadAsk } from '../model'
// B-TH-283: the measurement-sheet tick holds an upload meant for the floor.
import { uploadAskHeld } from '../model'
// B-TH-231: "Use on another record…" and the copy's source line.
import { carriable, sourceLine } from '../../files/use-on'
import { typeKey } from '../../../../areas/search/model'
import '../files-view.css'

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
}

export type BulkAction = 'download' | 'share' | 'officeOnly' | 'remove'

export interface FilesViewActions {
  onClose?: () => void
  onRetry?: () => void
  /** The chosen documents now (the whole choice: the view works out ranges and "all"). */
  onSelect?: (fileIds: readonly string[]) => void
  /** Opens the thread's one file viewer at this file. */
  onOpen?: (fileId: string, opener: HTMLElement | null) => void
  onRestore?: (fileId: string) => void
  onBulk?: (action: BulkAction, fileIds: readonly string[]) => void
  /** Files dropped or browsed: the container asks their kind and audience (`upload`). */
  onDrop?: (files: File[]) => void
  onUploadChange?: (change: Partial<Pick<UploadAsk, 'kind' | 'audience' | 'sheet'>>) => void
  onUploadConfirm?: () => void
  onUploadCancel?: () => void
  onDismissRefused?: () => void
  /** B-TH-231: "Use on another record…" for these files (one row's, or the chosen ones). */
  onUseOn?: (fileIds: readonly string[]) => void
}

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
export function FilesView({ model, actions }: { model: FilesViewModel; actions?: FilesViewActions }) {
  return (
    <WithMessages namespaces={[FILES_VIEW_NS, 'record-thread-files', 'lists', /* B-TH-231 */ 'search']}>
      <View model={model} actions={actions} />
    </WithMessages>
  )
}

function View({ model, actions }: { model: FilesViewModel; actions?: FilesViewActions | undefined }) {
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
        subtitle={model.files ? t('subtitle', { count: order.length }) : undefined}
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

          {model.problem === 'forbidden' ? (
            <EmptyState icon={<Lock size={22} aria-hidden />} title={t('forbidden.title')} description={t('forbidden.body')} />
          ) : model.problem === 'read' ? (
            <Banner tone="danger" title={t('problem.read')} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('problem.retry')}</Button>} />
          ) : (
            <>
              {model.can.upload && !model.uploadHeld ? (
                <FileDropzone multiple onFiles={(files) => actions?.onDrop?.(files)} hint={t('upload.hint')} />
              ) : (
                <p className="fw-rtv-held">
                  <Lock size={14} aria-hidden /> {model.uploadHeld ?? t('upload.noRight')}
                </p>
              )}
              {model.files === null ? (
                <div className="fw-rtv-loading" role="status" aria-label={t('loading')}>
                  {[0, 1, 2].map((row) => (
                    <Skeleton key={row} height={44} />
                  ))}
                </div>
              ) : order.length === 0 ? (
                <EmptyState icon={<FolderOpen size={22} aria-hidden />} title={t('empty.title')} description={t(model.can.upload ? 'empty.bodyUpload' : 'empty.body')} />
              ) : (
                <>
                  <div className="fw-rtv-tools">
                    <Checkbox
                      label={allChosen ? t('select.none', { count: order.length }) : t('select.all', { count: order.length })}
                      checked={allChosen}
                      onChange={(event) => actions?.onSelect?.(event.target.checked ? order : [])}
                    />
                  </div>
                  {chosen.length > 0 && (
                    <BulkActionBar count={chosen.length} noun={t('bulk.noun')} onClear={() => actions?.onSelect?.([])}>
                      <Button size="sm" heldReason={reach.download.length === 0 ? t('bulk.noneDownload') : null} onClick={() => actions?.onBulk?.('download', reach.download)}>
                        <Download size={14} aria-hidden /> {t('bulk.download', { count: reach.download.length })}
                      </Button>
                      {model.party && (
                        <Button size="sm" heldReason={!model.can.share ? t('bulk.noShareRight') : reach.share.length === 0 ? t('bulk.allShared', { party: model.party.name }) : null} onClick={() => actions?.onBulk?.('share', reach.share)}>
                          <Share2 size={14} aria-hidden /> {t('bulk.share', { party: model.party.name, count: reach.share.length })}
                        </Button>
                      )}
                      <Button size="sm" heldReason={!model.can.share ? t('bulk.noShareRight') : reach.officeOnly.length === 0 ? t('bulk.allOffice') : null} onClick={() => actions?.onBulk?.('officeOnly', reach.officeOnly)}>
                        <ShieldOff size={14} aria-hidden /> {t('bulk.officeOnly', { count: reach.officeOnly.length })}
                      </Button>
                      <Button size="sm" variant="danger" heldReason={!model.can.delete ? t('bulk.noDeleteRight') : reach.remove.length === 0 ? t('bulk.allHeld') : null} onClick={() => actions?.onBulk?.('remove', reach.remove)}>
                        <Trash2 size={14} aria-hidden /> {t('bulk.remove', { count: reach.remove.length })}
                      </Button>
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
                            <Row key={one.key} series={one} model={model} actions={actions} place={place} chosen={model.selected.includes(one.latest.id)} onChoose={(on, range) => choose(one.latest.id, on, range)} />
                          ))}
                        </ul>
                      </section>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </Modal>
      {model.upload && <UploadDialog ask={model.upload} party={model.party} busy={model.busy ?? false} actions={actions} />}
    </>
  )
}

function groupWords(group: ReturnType<typeof filesGroups>[number]['group'], party: FilesParty | null, t: (key: string) => string): string {
  if (group.by === 'kind') return t(`group.kind.${group.kind}`)
  if (group.origin === 'party') return t(`group.origin.party.${party?.role ?? 'customer'}`)
  return t(`group.origin.${group.origin}`)
}

function Row({ series, model, actions, place, chosen, onChoose }: { series: FileSeries; model: FilesViewModel; actions?: FilesViewActions | undefined; place: { locale: 'it' | 'en'; timeZone?: string }; chosen: boolean; onChoose: (on: boolean, range: boolean) => void }) {
  const t = useT(FILES_VIEW_NS)
  const fileWords = useT('record-thread-files')
  const searchWords = useT('search')
  const file = series.latest
  const version = versionMark(series)
  // B-TH-231: a copy says where it came from; a sheet locked for this reader is named as such, never by its own name.
  const source = sourceLine(file)
  const name = file.locked ? fileWords('locked.sheet') : file.name
  const { marks, more } = audienceMarks(file, model.party)
  const held = file.status === 'QUARANTINED'
  const lines = keepLines(file, model.now)
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
        {file.previewUrl && !held ? <img src={file.previewUrl} alt="" /> : held ? <Lock size={18} /> : KIND_ICON[file.kind]}
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
        {file.locked && <span className="fw-rtv-meta">{fileWords('locked.sheetWhy')}</span>}
        {file.sheet && <span className="fw-rtv-meta">{fileWords('sheet.recorded')}</span>}
        <span className="fw-rtv-marks">
          {marks.map((mark) => (
            <Tag key={mark} tone={mark === 'otherParty' ? 'danger' : mark === 'office' ? 'neutral' : mark === 'floor' ? 'warning' : 'info'}>
              {fileWords(`audience.${mark}`)}
            </Tag>
          ))}
          {more > 0 && <Tag tone="neutral">{`+${more}`}</Tag>}
          {lines.map((line) => (
            <Tag key={line.key} tone={line.tone}>
              {t(line.key, line.params?.date ? { date: formatDate(String(line.params.date), place) } : undefined)}
            </Tag>
          ))}
        </span>
        {model.can.upload && actions?.onUseOn && carriable([file]).length > 0 && (
          <span className="fw-rtv-row-actions">
            <Button size="sm" variant="quiet" heldReason={model.uploadHeld} aria-label={fileWords('useOn.actionFor', { name })} onClick={() => actions.onUseOn?.([file.id])}>
              <Copy size={14} aria-hidden /> {fileWords('useOn.action')}
            </Button>
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
                    {model.can.upload && (
                      <Button size="sm" variant="quiet" heldReason={model.uploadHeld} onClick={() => actions?.onRestore?.(earlier.id)}>
                        <RotateCcw size={14} aria-hidden /> {t('version.restore')}
                      </Button>
                    )}
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

/** "Add 2 files": the kind and the audience asked once, in the system's words; the audience starts on Office. */
function UploadDialog({ ask, party, busy, actions }: { ask: UploadAsk; party: FilesViewModel['party']; busy: boolean; actions?: FilesViewActions | undefined }) {
  const t = useT(FILES_VIEW_NS)
  const fileWords = useT('record-thread-files')
  const locale = useLocale()
  const audiences = ask.audiences.filter((audience) => audience !== 'PARTNER' || party !== null)
  return (
    <Modal
      open
      onClose={() => actions?.onUploadCancel?.()}
      size="md"
      title={t('upload.title', { count: ask.files.length })}
      footer={
        <>
          <Button onClick={() => actions?.onUploadCancel?.()}>{t('upload.cancel')}</Button>
          <Button variant="primary" heldReason={busy ? t('upload.busy') : uploadAskHeld(ask) ? t(uploadAskHeld(ask)!) : null} onClick={() => actions?.onUploadConfirm?.()}>
            {t('upload.confirm', { count: ask.files.length })}
          </Button>
        </>
      }
    >
      <div className="fw-rtv-upload">
        <ul className="fw-rtv-upload-files">
          {ask.files.map((file) => (
            <li key={file.name}>
              {file.name} <span className="fw-rtv-muted">{sizeWords(file.sizeBytes, locale)}</span>
            </li>
          ))}
        </ul>
        <Field label={t('upload.kind')}>
          <Select value={ask.kind} onChange={(event) => actions?.onUploadChange?.({ kind: event.target.value as FileKind })}>
            {ask.kinds.map((kind) => (
              <option key={kind} value={kind}>
                {fileWords(`kind.${kind}`)}
              </option>
            ))}
          </Select>
        </Field>
        {/* B-TH-283 (B-TH-083): the measurement-sheet tick, at upload. */}
        <Checkbox
          label={
            <span>
              {t('upload.sheet')} <span className="fw-rtv-muted">· {t('upload.sheetHint')}</span>
            </span>
          }
          checked={ask.sheet ?? false}
          onChange={(event) => actions?.onUploadChange?.({ sheet: event.target.checked })}
        />
        <fieldset className="fw-rtv-fieldset">
          <legend className="fw-rtv-legend">{t('upload.who')}</legend>
          {audiences.map((audience) => (
            <RadioCard
              key={audience}
              name="fw-rtv-audience"
              checked={ask.audience === audience}
              selected={ask.audience === audience}
              onChange={() => actions?.onUploadChange?.({ audience })}
              title={t(AUDIENCE_WORD[audience], { party: party?.name ?? '' })}
              description={t(`${AUDIENCE_WORD[audience]}Body`, { party: party?.name ?? '' })}
            />
          ))}
        </fieldset>
      </div>
    </Modal>
  )
}
