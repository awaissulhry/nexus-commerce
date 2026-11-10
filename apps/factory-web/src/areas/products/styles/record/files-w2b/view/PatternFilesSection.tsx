'use client'

import { useMemo, useState } from 'react'
import { Download, FileStack, Lock, MoreHorizontal, Plus, Trash2, WifiOff } from 'lucide-react'
import { Banner, Card, EmptyState, Field, Menu, type MenuItemDef } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Checkbox, Input, Select, Skeleton, Spinner, Tag } from '@nexus/ui/primitives'
import { formatOfName, PATTERN_FILE_KINDS, type PatternFileFormat, type PatternFileKind } from '@nexus/factory-domain/product/images/rules'
import { FileDropzone, Modal } from '../../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { ListFrame } from '../../../../../../list-frame/ListFrame'
import { WithMessages } from '../../../../../../record-panels/i18n'
import type { PatternFilesView, PatternFileView } from '../api'
import { FORMAT_CHOICES, kindsOpen, NO_PATTERNS, noteToSend, PATTERN_NOTE_MAX, patternsHeld, rowHeld, rowOf, sizesWords, type PatternFields, type PatternsActions, type PatternsModel } from '../patterns-model'
import '../../gallery/gallery.css'

const NS = 'products-gallery'

/**
 * SCR-304-patterns — Style › Files & patterns › Pattern files per revision and size range (B-W2b-236; PRD-218; design
 * products.styles rec:Style style.files.files "Pattern files per revision and size range (Lectra, Gerber, DXF-AAMA; W2b)"):
 * the pattern, marker and CAD files of the revision in view, each with its format, the sizes it is for, a note and its
 * versions (the files platform's series), on the shared list frame (select, x, shift range; with rows selected: Remove N,
 * each frozen row saying why; ⋯ Download, New version…, Versions…, Details…, Remove…). A file is sent in parts (a DXF, an
 * HP-GL plot or a PDF). A PATTERN or CAD file is the revision's specification: frozen once it is released (a marker can still
 * be added). It draws the view model and fetches nothing (use-pattern-files.ts loads it).
 */
export function PatternFilesSection({ model, actions }: { model?: PatternsModel; actions?: PatternsActions }) {
  return (
    <WithMessages namespaces={[NS]}>
      <Section model={model ?? NO_PATTERNS} actions={actions} />
    </WithMessages>
  )
}

function Section({ model, actions }: { model: PatternsModel; actions?: PatternsActions }) {
  const t = useT(NS)
  const part = model.part
  if (part.status === 'ready') return <Ready view={part.value} model={model} actions={actions} />
  if (part.status === 'error') {
    return (
      <Card header={t('patterns.title')} headingLevel={2}>
        <Banner
          tone="danger"
          title={t('patterns.failed')}
          action={
            <Button size="sm" onClick={() => actions?.onRetry?.()}>
              {t('gallery.retry')}
            </Button>
          }
        >
          {t(part.problem)}
        </Banner>
      </Card>
    )
  }
  if (part.status === 'idle') return <Card header={t('patterns.title')} headingLevel={2} description={t('patterns.noRevision')} />
  return (
    <Card header={t('patterns.title')} headingLevel={2} aria-busy="true">
      <p className="fw-gal-hint" role="status">
        <Spinner size={14} /> {t('patterns.loading')}
      </p>
      {Array.from({ length: 3 }, (_, index) => (
        <Skeleton key={index} height={22} />
      ))}
    </Card>
  )
}

function Ready({ view, model, actions }: { view: PatternFilesView; model: PatternsModel; actions?: PatternsActions }) {
  const t = useT(NS)
  const locale = useLocale()
  const uploadHeld = patternsHeld(model, view, 'upload')
  const editHeld = patternsHeld(model, view, 'edit')
  const open = kindsOpen(view)
  const addHeld = uploadHeld ?? (open.length === 0 ? 'patterns.held.frozen' : null)
  const range = view.style.sizes
  const picked = view.files.filter((row) => model.selected.includes(row.id))
  const frozenPicked = picked.filter((row) => row.frozen).length

  const columns = useMemo<ColDef<PatternFileView>[]>(() => {
    const FileCell = ({ data }: ICellRendererParams<PatternFileView>) =>
      data ? (
        <span className="fw-gal-cell">
          <span className="fw-gal-caption" title={data.file.name}>
            {data.file.name}
          </span>
          <span className="fw-gal-hint">
            {data.frozen && <Lock size={11} aria-hidden />} {t('patterns.version', { version: data.file.versionNo, count: data.versions.length })}
          </span>
        </span>
      ) : null
    const KindCell = ({ data }: ICellRendererParams<PatternFileView>) => (data ? <Tag tone={data.kind === 'PATTERN' || data.kind === 'CAD' ? 'info' : 'neutral'}>{t(`patterns.kind.${data.kind}`)}</Tag> : null)
    const SizesCell = ({ data }: ICellRendererParams<PatternFileView>) => {
      if (!data) return null
      const words = sizesWords(data, range)
      return <span>{t(words.key, words.params)}</span>
    }
    const MoreCell = ({ data }: ICellRendererParams<PatternFileView>) => {
      if (!data) return null
      const held = rowHeld(model, view, data)
      const why = held ? t(held, { revision: view.revision.revision }) : model.busy ? t('gallery.held.busy') : undefined
      const items: MenuItemDef[] = [
        { id: 'download', label: t('patterns.menu.download'), onSelect: () => actions?.onDownload?.(data.id) },
        { id: 'versions', label: t('patterns.menu.versions', { count: data.versions.length }), onSelect: () => actions?.onDialog?.({ kind: 'versions', id: data.id }) },
        { id: 'version', label: t('patterns.menu.newVersion'), disabled: !!why || !!uploadHeld, description: why ?? (uploadHeld ? t(uploadHeld) : undefined), onSelect: () => actions?.onDialog?.({ kind: 'version', id: data.id }) },
        { id: 'edit', label: t('patterns.menu.edit'), disabled: !!why, description: why, onSelect: () => actions?.onDialog?.({ kind: 'edit', id: data.id }) },
        { id: 'remove', label: t('patterns.menu.remove'), tone: 'danger', disabled: !!why, description: why, onSelect: () => actions?.onDialog?.({ kind: 'remove', ids: [data.id] }) },
      ]
      return <Menu label={<MoreHorizontal size={16} aria-hidden />} align="right" items={items} triggerProps={{ 'aria-label': t('patterns.menu.label', { name: data.file.name }) }} />
    }
    return [
      { colId: 'file', headerName: t('patterns.col.file'), field: 'id', minWidth: 220, flex: 2, cellRenderer: FileCell },
      { colId: 'kind', headerName: t('patterns.col.kind'), field: 'kind', minWidth: 120, flex: 1, cellRenderer: KindCell },
      { colId: 'format', headerName: t('patterns.col.format'), field: 'format', minWidth: 120, flex: 1, valueFormatter: (params) => t(`patterns.format.${(params.value as string | null) ?? 'OTHER'}`) },
      { colId: 'sizes', headerName: t('patterns.col.sizes'), field: 'sizes', cellDataType: false, minWidth: 140, flex: 1, cellRenderer: SizesCell },
      { colId: 'note', headerName: t('patterns.col.note'), field: 'note', minWidth: 160, flex: 2, valueFormatter: (params) => (params.value as string | null) ?? '—' },
      { colId: 'updated', headerName: t('patterns.col.updated'), field: 'updatedAt', minWidth: 110, flex: 1, valueFormatter: (params) => (params.value ? formatDate(params.value as string, { locale }) : '—') },
      { colId: 'more', headerName: t('patterns.col.more'), minWidth: 72, maxWidth: 72, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
  }, [t, locale, range, model, view, actions, uploadHeld])

  const addButton = (
    <Button size="sm" variant="primary" heldReason={addHeld ? t(addHeld, { revision: view.revision.revision }) : model.busy ? t('gallery.held.busy') : null} onClick={() => actions?.onDialog?.({ kind: 'add' })}>
      <Plus size={14} aria-hidden /> {t('patterns.add.button')}
    </Button>
  )
  const bulk = (
    <Button
      size="sm"
      variant="danger-outline"
      aria-label={t('patterns.bulk.remove', { count: picked.length })}
      heldReason={editHeld ? t(editHeld) : frozenPicked > 0 ? t('patterns.bulk.frozen', { count: frozenPicked, revision: view.revision.revision }) : null}
      onClick={() => actions?.onDialog?.({ kind: 'remove', ids: picked.map((row) => row.id) })}
    >
      <Trash2 size={13} aria-hidden /> <SelectionLabel>{t('patterns.bulk.remove', { count: picked.length })}</SelectionLabel>
    </Button>
  )
  return (
    <Card header={t('patterns.title')} headingLevel={2} description={t('patterns.intro', { revision: view.revision.revision, status: t(`patterns.revisionStatus.${view.revision.status}`) })} headerAction={addButton}>
      <div className="fw-gal-stack">
        {editHeld && editHeld !== 'patterns.held.offline' && <Banner tone="info" title={t(editHeld.replace('patterns.held.', 'patterns.banner.'))} />}
        {!editHeld && open.length < PATTERN_FILE_KINDS.length && <Banner tone="info" title={t('patterns.frozenKinds', { revision: view.revision.revision })} />}
        {model.offline && (
          <Banner
            tone="warning"
            title={
              <span className="fw-gal-inline">
                <WifiOff size={14} aria-hidden /> {t('patterns.held.offline')}
              </span>
            }
          />
        )}
        {model.notice && (
          <Banner
            tone={model.notice.tone}
            title={t(model.notice.key, model.notice.params)}
            action={
              <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
                {t('gallery.dismiss')}
              </Button>
            }
          />
        )}
        <ListFrame<PatternFileView>
          label={t('patterns.table')}
          listKey={null}
          rows={view.files}
          rowId={(row) => row.id}
          columns={columns}
          count={t('patterns.count', { count: view.files.length })}
          selection={{ selected: model.selected, onChange: (ids) => actions?.onSelect?.([...ids]), actions: bulk }}
          isRowSelectable={(row) => {
            const held = rowHeld(model, view, row)
            return held ? t(held, { revision: view.revision.revision }) : null
          }}
          onOpen={(row) => actions?.onDialog?.({ kind: 'versions', id: row.id })}
          state={view.files.length === 0 ? <EmptyState icon={<FileStack size={24} aria-hidden />} title={t('patterns.empty.title')} description={t('patterns.empty.body')} action={addHeld ? undefined : addButton} /> : undefined}
        />
      </div>
      <PatternDialogs view={view} model={model} actions={actions} />
    </Card>
  )
}

function PatternDialogs({ view, model, actions }: { view: PatternFilesView; model: PatternsModel; actions?: PatternsActions }) {
  const dialog = model.dialog
  if (!dialog) return null
  const close = () => actions?.onDialog?.(null)
  if (dialog.kind === 'add') return <FieldsDialog view={view} model={model} actions={actions} onClose={close} />
  if (dialog.kind === 'remove') return <RemoveDialog view={view} ids={dialog.ids} model={model} actions={actions} onClose={close} />
  const row = rowOf(view, dialog.id)
  if (!row) return null
  if (dialog.kind === 'edit') return <FieldsDialog view={view} model={model} actions={actions} row={row} onClose={close} />
  if (dialog.kind === 'version') return <VersionDialog row={row} model={model} actions={actions} onClose={close} />
  return <VersionsDialog row={row} actions={actions} onClose={close} />
}

function SizesField({ range, sizes, onChange }: { range: readonly string[]; sizes: string[]; onChange: (sizes: string[]) => void }) {
  const t = useT(NS)
  return (
    <Field label={t('patterns.field.sizes')} hint={t(sizes.length === 0 ? 'patterns.field.sizesAll' : 'patterns.field.sizesSome', { count: sizes.length })}>
      <div className="fw-gal-tags" role="group" aria-label={t('patterns.field.sizes')}>
        {range.map((size) => (
          <Checkbox key={size} label={size} checked={sizes.includes(size)} onChange={(event) => onChange(event.target.checked ? [...sizes, size] : sizes.filter((entry) => entry !== size))} />
        ))}
      </div>
    </Field>
  )
}

function FieldsDialog({ view, model, actions, row, onClose }: { view: PatternFilesView; model: PatternsModel; actions?: PatternsActions; row?: PatternFileView; onClose: () => void }) {
  const t = useT(NS)
  const open = kindsOpen(view)
  const [kind, setKind] = useState<PatternFileKind>(row?.kind ?? open[0] ?? 'MARKER')
  const [format, setFormat] = useState<PatternFileFormat | ''>(row ? (row.format ?? '') : '')
  const [sizes, setSizes] = useState<string[]>(row ? [...row.sizes] : [])
  const [note, setNote] = useState(row?.note ?? '')
  const [file, setFile] = useState<File | null>(null)
  const typed = noteToSend(note)
  const sending = model.sending.state === 'sending'
  const kinds = row ? PATTERN_FILE_KINDS.filter((entry) => entry === row.kind || open.includes(entry)) : open
  const fields: PatternFields = { kind, format: format === '' ? null : format, sizes, note: typed.note }
  const held = typed.problem ? t(typed.problem, { max: PATTERN_NOTE_MAX }) : !row && !file ? t('patterns.add.pickFirst') : sending || model.busy ? t('gallery.held.busy') : null
  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={row ? t('patterns.edit.title') : t('patterns.add.title', { revision: view.revision.revision })}
      subtitle={row ? row.file.name : t('patterns.add.subtitle')}
      footer={
        <>
          <Button size="sm" variant="quiet" onClick={onClose}>
            {t('gallery.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={held} onClick={() => (row ? actions?.onSave?.(row.id, fields) : file && actions?.onAdd?.(file, fields))}>
            {row ? t('patterns.edit.save') : t('patterns.add.send')}
          </Button>
        </>
      }
    >
      <div className="fw-gal-stack">
        {!row && (
          <>
            <FileDropzone
              accept=".dxf,.plt,.hpgl,.pdf"
              maxBytes={200 * 1024 * 1024}
              disabled={sending}
              hint={t('patterns.add.hint')}
              onFiles={(files) => {
                const picked = files[0] ?? null
                setFile(picked)
                // The format its name suggests (a DXF is most likely the AAMA exchange), unless one was chosen.
                if (picked && format === '') setFormat(formatOfName(picked.name) ?? '')
              }}
            />
            {file && <p className="fw-gal-hint">{t('patterns.add.picked', { name: file.name })}</p>}
          </>
        )}
        <div className="fw-gal-two">
          <Field label={t('patterns.field.kind')} hint={t(`patterns.kindHint.${kind}`)}>
            <Select size="sm" value={kind} onChange={(event) => setKind(event.target.value as PatternFileKind)}>
              {kinds.map((entry) => (
                <option key={entry} value={entry}>
                  {t(`patterns.kind.${entry}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('patterns.field.format')}>
            <Select size="sm" value={format} onChange={(event) => setFormat(event.target.value as PatternFileFormat | '')}>
              {FORMAT_CHOICES.map((entry) => (
                <option key={entry || 'OTHER'} value={entry}>
                  {t(`patterns.format.${entry || 'OTHER'}`)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <SizesField range={view.style.sizes} sizes={sizes} onChange={setSizes} />
        <Field label={t('patterns.field.note')} hint={t('patterns.field.noteHint', { max: PATTERN_NOTE_MAX })} error={typed.problem ? t(typed.problem, { max: PATTERN_NOTE_MAX }) : undefined}>
          <Input size="sm" value={note} maxLength={PATTERN_NOTE_MAX + 1} onChange={(event) => setNote(event.target.value)} />
        </Field>
        {model.sending.state !== 'idle' && (
          <p className="fw-gal-hint" role="status">
            {sending && <Spinner size={12} />} {t(model.sending.state === 'failed' ? (model.sending.problem ?? 'patterns.add.failed') : 'patterns.add.sending')}
          </p>
        )}
      </div>
    </Modal>
  )
}

function VersionDialog({ row, model, actions, onClose }: { row: PatternFileView; model: PatternsModel; actions?: PatternsActions; onClose: () => void }) {
  const t = useT(NS)
  const [file, setFile] = useState<File | null>(null)
  const sending = model.sending.state === 'sending'
  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      title={t('patterns.newVersion.title', { version: row.file.versionNo + 1 })}
      subtitle={row.file.name}
      footer={
        <>
          <Button size="sm" variant="quiet" onClick={onClose}>
            {t('gallery.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={!file ? t('patterns.add.pickFirst') : sending || model.busy ? t('gallery.held.busy') : null} onClick={() => file && actions?.onNewVersion?.(row.id, file)}>
            {t('patterns.newVersion.send')}
          </Button>
        </>
      }
    >
      <div className="fw-gal-stack">
        <p className="fw-gal-hint">{t('patterns.newVersion.body')}</p>
        <FileDropzone accept=".dxf,.plt,.hpgl,.pdf" maxBytes={200 * 1024 * 1024} disabled={sending} hint={t('patterns.add.hint')} onFiles={(files) => setFile(files[0] ?? null)} />
        {file && <p className="fw-gal-hint">{t('patterns.add.picked', { name: file.name })}</p>}
        {model.sending.state !== 'idle' && (
          <p className="fw-gal-hint" role="status">
            {sending && <Spinner size={12} />} {t(model.sending.state === 'failed' ? (model.sending.problem ?? 'patterns.add.failed') : 'patterns.add.sending')}
          </p>
        )}
      </div>
    </Modal>
  )
}

function VersionsDialog({ row, actions, onClose }: { row: PatternFileView; actions?: PatternsActions; onClose: () => void }) {
  const t = useT(NS)
  const locale = useLocale()
  return (
    <Modal open onClose={onClose} size="md" title={t('patterns.versions.title', { name: row.file.name })} subtitle={t('patterns.versions.subtitle', { count: row.versions.length })}>
      <ol className="fw-gal-unused">
        {row.versions.map((version) => (
          <li key={version.fileId} className="fw-gal-row">
            <span className="fw-gal-cell">
              <span className="fw-gal-caption">
                {t('patterns.versions.item', { version: version.versionNo, name: version.name })} {version.current && <Tag tone="success">{t('patterns.versions.current')}</Tag>}
              </span>
              <span className="fw-gal-hint">{formatDate(version.createdAt, { locale })}</span>
            </span>
            <Button size="sm" heldReason={version.status !== 'AVAILABLE' ? t('patterns.versions.notAvailable') : null} onClick={() => actions?.onDownload?.(row.id, version.fileId)}>
              <Download size={13} aria-hidden /> {t('patterns.menu.download')}
            </Button>
          </li>
        ))}
      </ol>
    </Modal>
  )
}

function RemoveDialog({ view, ids, model, actions, onClose }: { view: PatternFilesView; ids: string[]; model: PatternsModel; actions?: PatternsActions; onClose: () => void }) {
  const t = useT(NS)
  const rows = view.files.filter((row) => ids.includes(row.id))
  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title={t('patterns.remove.title', { count: rows.length })}
      footer={
        <>
          <Button size="sm" variant="quiet" onClick={onClose}>
            {t('gallery.cancel')}
          </Button>
          <Button size="sm" variant="danger" heldReason={model.busy ? t('gallery.held.busy') : null} onClick={() => actions?.onRemove?.(rows.map((row) => row.id))}>
            {t('patterns.remove.confirm', { count: rows.length })}
          </Button>
        </>
      }
    >
      <div className="fw-gal-stack">
        <ul className="fw-gal-files">
          {rows.map((row) => (
            <li key={row.id}>{row.file.name}</li>
          ))}
        </ul>
        <p>{t('patterns.remove.body')}</p>
      </div>
    </Modal>
  )
}
