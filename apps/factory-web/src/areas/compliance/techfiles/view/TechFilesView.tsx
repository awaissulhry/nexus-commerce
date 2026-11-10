'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Archive, Download, FolderCheck, MoreHorizontal, PackagePlus, Plus } from 'lucide-react'
import { Banner, EmptyState, Field, Menu, MetricStrip, ProgressBar, type Metric, type MenuItemDef } from '@nexus/ui/components'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Pill, Select, Skeleton } from '@nexus/ui/primitives'
import { ANNEX_III_LAW, TECHNICAL_FILE_STATUSES, type TechnicalFileStatus } from '@nexus/factory-domain/compliance/techfiles/rules'
import { AsOf, Combobox, Modal, Textarea, useDsWords } from '../../../../lib/i18n/ds-parts'
import { isListKey } from '../../../../list-frame/model'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { LiveState } from '../../../quality/_shared/model'
import { evidenceAddress } from '../../../quality/_shared/model'
import type { FileSummary, ListAnswer, StyleOption } from '../api'
import {
  annexBar,
  archiveHeld,
  FILE_TONE,
  isFiltered,
  productionTone,
  reasonProblem,
  recordAddress,
  RETENTION_TONE,
  tileOfAddress,
  tilesOf,
  valueOf,
  type ListAddress,
  type Read,
  type TechfilesCan,
  type TileId,
} from '../model'
import { PackDialog, type PackDialogActions, type PackDialogModel } from './PackDialog'
import { KeysModal, LIST_KEYS, NoTechfilesAccess, NoticeBanner, SectionFailed, SectionHead, SectionLoading, StatePill, TechfilesMessages, useDay, useWords, type Notice } from './parts'

/** New technical file (design h.act "New technical file", `c`): one live file per style. */
export interface NewFileState {
  q: string
  styles: Read<StyleOption[]>
  styleId: string | null
  note: string
  busy: boolean
  problem: Notice | null
  /** The live file the chosen style already has (found in the list, or the API's 409): open that one. */
  existing: { id: string; number: string } | null
}

/** Archive N: one reason for every file chosen (one call each). */
export interface ArchiveManyState {
  ids: readonly string[]
  reason: string
  busy: boolean
}

export interface TechFilesModel {
  prefix: string
  can: TechfilesCan
  address: ListAddress
  list: Read<ListAnswer>
  online: boolean
  live: LiveState
  readAt: string | null
  /** Live changes waiting behind "N updates · Show" (rows never move under the cursor). */
  updates: number
  selected: readonly string[]
  notice: Notice | null
  add: NewFileState | null
  archive: ArchiveManyState | null
  pack: PackDialogModel | null
  keysOpen?: boolean
  focusRow?: number
}

export interface TechFilesActions {
  onAddress?: (patch: Partial<ListAddress>) => void
  onOpen?: (fileId: string) => void
  onRetry?: () => void
  onShowUpdates?: () => void
  onSelected?: (ids: string[]) => void
  onExport?: (ids: readonly string[] | null) => void
  onDismissNotice?: () => void
  onNewQuery?: (q: string) => void
  onNewPick?: (styleId: string) => void
  onNewNote?: (note: string) => void
  onNewCreate?: () => void
  onArchiveMany?: (ids: readonly string[] | null) => void
  onArchiveReason?: (reason: string) => void
  onArchiveApply?: () => void
  pack?: PackDialogActions
}

/**
 * SCR-120 — Compliance › Technical files (design compliance.techfiles; PRD-296, PRD-302): the band (when it was read, live or
 * not; New technical file, `c`; ⋯ Export list, the keys), the five tiles (each a saved filter of the API's own), the grid of one
 * Annex III file per certified style on the list frame — Style, Certificates, Annex III (9 of 13 with its bar), Risk
 * assessment, Test reports, Production control (batches with evidence of those made), Last change, Owner, Kept until — with
 * its verbs (Open · Build evidence pack · Evidence trail of the latest batch) and Export N / Archive N over the rows chosen. One
 * view model, nothing fetched; every word from the catalogues; the page fills the main area.
 */
export function TechFilesView({ model, actions }: { model: TechFilesModel; actions?: TechFilesActions }) {
  return (
    <TechfilesMessages>
      <Page model={model} actions={actions} />
    </TechfilesMessages>
  )
}

function Page({ model, actions }: { model: TechFilesModel; actions?: TechFilesActions | undefined }) {
  const t = useWords()
  const [keysOpen, setKeysOpen] = useState(model.keysOpen ?? false)
  const [heldSaid, setHeldSaid] = useState<string | null>(null)
  const ds = useDsWords()
  const { address, can } = model
  const answer = valueOf(model.list)
  const addHeld = !can.manage || (answer && !answer.mayCreate) ? 'held.manage' : !model.online ? 'held.offline' : null
  const dialogOpen = !!model.add || !!model.archive || !!model.pack || keysOpen

  // c: New technical file; p: Build evidence pack for the one file chosen; ? the keys.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (dialogOpen || !isListKey(event, event.target as HTMLElement | null)) return
      if (event.key === 'c') {
        event.preventDefault()
        if (addHeld) setHeldSaid(addHeld)
        else actions?.onAddress?.({ add: true })
      } else if (event.key === 'p') {
        event.preventDefault()
        if (model.selected.length !== 1) setHeldSaid('held.packOne')
        else actions?.onAddress?.({ pack: model.selected[0]! })
      } else if (event.key === '?') {
        event.preventDefault()
        setKeysOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (!can.view) {
    return (
      <div className="fw-tf">
        <NoTechfilesAccess />
      </div>
    )
  }

  const activeTile = tileOfAddress(address)
  const tileClick = (id: TileId, tile: ListAddress['tile']) => actions?.onAddress?.({ tile: activeTile === id ? null : tile })
  const metrics: Metric[] = tilesOf(answer?.tiles ?? null).map((tile): Metric => ({
    label: t(`tile.${tile.id}.label`),
    value: tile.value === null ? model.list.status === 'loading' ? <Skeleton width={40} height={24} /> : '—' : String(tile.value),
    hint: tile.second === null ? t(`tile.${tile.id}.hint`) : t(`tile.${tile.id}.hintCount`, { count: tile.second }),
    onClick: () => tileClick(tile.id, tile.tile),
    active: activeTile === tile.id,
    ...(tile.alarm ? { accent: 'var(--nds-danger)' } : {}),
  }))

  return (
    <div className="fw-tf">
      <div className="fw-tf-band" role="group" aria-label={t('band.label')}>
        <span className="fw-tf-status">
          {model.readAt ? <AsOf at={model.readAt} /> : <span className="fw-tf-muted">{t('band.reading')}</span>}
          <span className="fw-tf-muted">{t(`live.${model.live}`)}</span>
          <LawRef law={ANNEX_III_LAW} plain={t('law.annex')} labels={ds.lawRef} />
        </span>
        <span className="fw-tf-actions">
          <Button size="sm" variant="primary" aria-keyshortcuts="c" heldReason={addHeld ? t(addHeld) : null} onClick={() => actions?.onAddress?.({ add: true })}>
            <Plus size={14} aria-hidden /> {t('band.add')}
          </Button>
          <Menu
            label={<MoreHorizontal size={16} aria-hidden />}
            align="right"
            triggerProps={{ 'aria-label': t('band.more') }}
            items={[
              { id: 'export', label: t('band.export'), description: t('band.exportHint'), disabled: !answer || answer.files.length === 0, onSelect: () => actions?.onExport?.(null) },
              { id: 'keys', label: t('keys.title'), onSelect: () => setKeysOpen(true) },
            ]}
          />
        </span>
      </div>

      {heldSaid && (
        <Banner
          tone="info"
          title={t(heldSaid)}
          action={
            <Button size="sm" variant="quiet" onClick={() => setHeldSaid(null)}>
              {t('common.close')}
            </Button>
          }
        />
      )}
      {!model.online && <Banner tone="warning" title={t('offline.title')}>{t('offline.body')}</Banner>}
      <NoticeBanner notice={model.notice} onDismiss={actions?.onDismissNotice} />

      <section className="fw-tf-section" aria-labelledby="fw-tf-tiles">
        <h2 id="fw-tf-tiles" className="fw-tf-vh">
          {t('tile.title')}
        </h2>
        <MetricStrip metrics={metrics} minTileWidth={200} />
        {model.list.status === 'error' && <span className="fw-tf-muted">{t('tile.failed')}</span>}
      </section>

      <section className="fw-tf-section" aria-labelledby="fw-tf-grid">
        <FilesGrid model={model} actions={actions} onHelp={() => setKeysOpen(true)} />
      </section>

      {model.add && <NewFileDialog model={model} state={model.add} actions={actions} />}
      {model.archive && <ArchiveManyDialog model={model} state={model.archive} actions={actions} />}
      {model.pack && <PackDialog model={model.pack} actions={actions?.pack} />}
      {keysOpen && <KeysModal keys={LIST_KEYS(t)} onClose={() => setKeysOpen(false)} />}
    </div>
  )
}

function FilesGrid({ model, actions, onHelp }: { model: TechFilesModel; actions?: TechFilesActions | undefined; onHelp: () => void }) {
  const t = useWords()
  const day = useDay()
  const { address, prefix } = model
  const answer = valueOf(model.list)
  const rows = answer?.files ?? null
  const selected = model.selected
  const picked = (rows ?? []).filter((row) => selected.includes(row.id))
  const archivable = picked.filter((row) => !archiveHeld(row.status, { manage: row.may.manage && model.can.manage }, model.online))

  useEffect(() => {
    if (rows && selected.some((id) => !rows.some((row) => row.id === id))) actions?.onSelected?.(selected.filter((id) => rows.some((row) => row.id === id)))
  }, [rows, selected, actions])

  const columns = useMemo<ColDef<FileSummary>[]>(() => {
    const FileCell = ({ data }: ICellRendererParams<FileSummary>) =>
      data ? (
        <span className="fw-tf-cell">
          <Link className="fw-tf-rowlink" href={recordAddress(prefix, data.id)}>
            {data.style.code} · {data.style.name}
          </Link>
          <span className="fw-tf-muted">
            {data.number} · {t(`ppe.${data.style.ppeCategory}`)}
          </span>
        </span>
      ) : null
    const StatusCell = ({ data }: ICellRendererParams<FileSummary>) => (data ? <StatePill group="status" state={data.status} tone={FILE_TONE[data.status]} /> : null)
    const CertificatesCell = ({ data }: ICellRendererParams<FileSummary>) =>
      data ? (
        <span className="fw-tf-cell">
          <span className={data.certificates.valid === 0 ? 'fw-tf-danger-text' : undefined}>{t('cell.certificates', { valid: data.certificates.valid, all: data.certificates.all })}</span>
          <span className="fw-tf-muted">{data.certificate ? data.certificate.number : t('cell.noCertificateNamed')}</span>
        </span>
      ) : null
    const AnnexCell = ({ data }: ICellRendererParams<FileSummary>) => {
      if (!data) return null
      const bar = annexBar(data.annex)
      const words = t('cell.annex', { done: data.annex.done, outOf: data.annex.outOf })
      return (
        <span className="fw-tf-cell">
          <span className="fw-tf-row-tight">
            <span>{words}</span>
            {data.annex.missingItems > 0 && <Pill tone="danger">{t('cell.missing', { count: data.annex.missingItems })}</Pill>}
          </span>
          <ProgressBar ariaLabel={words} value={bar.percent} tone={bar.tone} height={4} />
        </span>
      )
    }
    const RiskCell = ({ data }: ICellRendererParams<FileSummary>) =>
      data ? (
        data.risk ? (
          <span className="fw-tf-cell">
            <span>{t('cell.risk', { revision: data.risk.revision, status: t(`assessment.${data.risk.status}`) })}</span>
            <span className="fw-tf-muted">{data.risk.signedAt ? t('cell.signedOn', { date: day(data.risk.signedAt) }) : t('cell.notSigned')}</span>
          </span>
        ) : (
          <span className="fw-tf-danger-text">{t('cell.noRisk')}</span>
        )
      ) : null
    const TestsCell = ({ data }: ICellRendererParams<FileSummary>) =>
      data ? (
        <span className="fw-tf-cell">
          <span>{t('cell.tests', { count: data.testReports.count })}</span>
          <span className="fw-tf-muted">{data.testReports.latestOn ? t('cell.latest', { date: day(data.testReports.latestOn) }) : t('cell.noneYet')}</span>
        </span>
      ) : null
    const ProductionCell = ({ data }: ICellRendererParams<FileSummary>) =>
      data ? (
        <span className="fw-tf-cell">
          <Pill tone={productionTone(data.production)}>{t('cell.production', { withEvidence: data.production.withEvidence, made: data.production.made })}</Pill>
          <span className="fw-tf-muted">
            {data.production.failed > 0 ? t('cell.productionFailed', { count: data.production.failed }) : data.production.missing > 0 ? t('cell.productionMissing', { count: data.production.missing }) : data.production.made === 0 ? t('cell.noBatches') : data.production.inProgress > 0 ? t('cell.productionInProgress', { count: data.production.inProgress }) : t('cell.productionOk')}
          </span>
        </span>
      ) : null
    const KeptCell = ({ data }: ICellRendererParams<FileSummary>) =>
      data ? (
        <span className="fw-tf-cell">
          <span>{data.retainUntil ? day(data.retainUntil) : t('cell.keptWhileLive')}</span>
          {data.retention === 'ENDS_WITHIN_YEAR' || data.retention === 'MAY_GO' ? <StatePill group="retention" state={data.retention} tone={RETENTION_TONE[data.retention]} dot={false} /> : null}
        </span>
      ) : null
    const MoreCell = ({ data }: ICellRendererParams<FileSummary>) => {
      if (!data) return null
      const trail = data.latestBatch?.batchNumber ? evidenceAddress(prefix, { batch: data.latestBatch.batchNumber }) : null
      const items: MenuItemDef[] = [
        { id: 'open', label: t('row.open'), href: recordAddress(prefix, data.id) },
        { id: 'tab', label: t('row.openNewTab'), href: recordAddress(prefix, data.id), target: '_blank' },
        {
          id: 'pack',
          label: t('row.pack'),
          disabled: !model.can.manage || !model.online,
          description: !model.can.manage ? t('held.manage') : !model.online ? t('held.offline') : undefined,
          onSelect: () => actions?.onAddress?.({ pack: data.id }),
        },
        trail
          ? { id: 'trail', label: t('row.trail', { batch: data.latestBatch?.batchNumber ?? '' }), href: trail, target: '_blank' }
          : { id: 'trail', label: t('row.trailNone'), disabled: true, description: t('held.noBatch') },
        { id: 'copy', label: t('row.copy'), onSelect: () => void navigator.clipboard?.writeText(data.number).catch(() => undefined) },
      ]
      return <Menu label={<MoreHorizontal size={16} aria-hidden />} align="right" triggerProps={{ 'aria-label': t('row.menu', { number: data.number }) }} items={items} />
    }
    return [
      { colId: 'style', headerName: t('col.style'), minWidth: 220, flex: 2, wrapText: true, autoHeight: true, valueGetter: (params) => (params.data ? `${params.data.style.code} ${params.data.style.name}` : ''), cellRenderer: FileCell },
      { colId: 'status', headerName: t('col.status'), minWidth: 120, flex: 0.8, valueGetter: (params) => (params.data ? t(`status.${params.data.status}`) : ''), cellRenderer: StatusCell },
      { colId: 'certificates', headerName: t('col.certificates'), minWidth: 140, flex: 1, valueGetter: (params) => params.data?.certificates.valid ?? 0, cellRenderer: CertificatesCell },
      { colId: 'annex', headerName: t('col.annex'), minWidth: 150, flex: 1.1, valueGetter: (params) => params.data?.annex.done ?? 0, cellRenderer: AnnexCell },
      { colId: 'risk', headerName: t('col.risk'), minWidth: 150, flex: 1.1, valueGetter: (params) => params.data?.risk?.revision ?? 0, cellRenderer: RiskCell },
      { colId: 'tests', headerName: t('col.tests'), minWidth: 130, flex: 0.9, valueGetter: (params) => params.data?.testReports.count ?? 0, cellRenderer: TestsCell },
      { colId: 'production', headerName: t('col.production'), minWidth: 170, flex: 1.1, valueGetter: (params) => params.data?.production.withEvidence ?? 0, cellRenderer: ProductionCell },
      { colId: 'lastChange', headerName: t('col.lastChange'), minWidth: 120, flex: 0.8, valueGetter: (params) => (params.data ? day(params.data.lastChangeAt) : '') },
      { colId: 'keeper', headerName: t('col.keeper'), minWidth: 130, flex: 0.9, valueGetter: (params) => (params.data ? (params.data.keeper?.name ?? t('cell.noKeeper')) : '') },
      { colId: 'keptUntil', headerName: t('col.keptUntil'), minWidth: 140, flex: 0.9, valueGetter: (params) => params.data?.retainUntil ?? '', cellRenderer: KeptCell },
      { colId: 'more', headerName: t('col.more'), minWidth: 72, maxWidth: 72, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
  }, [t, day, prefix, model.can.manage, model.online, actions])

  const search = <Input size="sm" type="search" value={address.q} placeholder={t('grid.search')} aria-label={t('grid.search')} onChange={(event) => actions?.onAddress?.({ q: event.target.value })} />
  const filters = (
    <Select size="sm" value={address.status ?? ''} aria-label={t('grid.filterStatus')} onChange={(event) => actions?.onAddress?.({ status: (event.target.value || null) as TechnicalFileStatus | null })}>
      <option value="">{t('grid.allStatuses')}</option>
      {TECHNICAL_FILE_STATUSES.map((status) => (
        <option key={status} value={status}>
          {t(`status.${status}`)}
        </option>
      ))}
    </Select>
  )

  const head = <SectionHead id="fw-tf-grid" title={t('grid.title')} note={t('grid.note')} />

  if (model.list.status === 'error') {
    return (
      <>
        {head}
        <SectionFailed title={t('grid.failed')} problem={model.list.problem} onRetry={actions?.onRetry} />
      </>
    )
  }
  if (!answer) {
    return (
      <>
        {head}
        <SectionLoading rows={6} />
      </>
    )
  }

  return (
    <>
      {head}
      <ListFrame<FileSummary>
        label={t('grid.label')}
        title={t('grid.title')}
        rows={rows}
        rowId={(row) => row.id}
        columns={columns}
        count={t('grid.count', { count: answer.files.length })}
        search={search}
        tools={filters}
        updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
        selection={{
          selected,
          onChange: (ids) => actions?.onSelected?.(ids),
          actions: (
            <>
              <Button size="sm" aria-label={t('bulk.export', { count: picked.length })} onClick={() => actions?.onExport?.(picked.map((row) => row.id))}>
                <Download size={13} aria-hidden /> <SelectionLabel>{t('bulk.export', { count: picked.length })}</SelectionLabel>
              </Button>
              {picked.length === 1 && (
                <Button size="sm" aria-label={t('row.pack')} heldReason={!model.can.manage ? t('held.manage') : !model.online ? t('held.offline') : null} onClick={() => actions?.onAddress?.({ pack: picked[0]!.id })}>
                  <PackagePlus size={13} aria-hidden /> <SelectionLabel>{t('row.pack')}</SelectionLabel>
                </Button>
              )}
              {model.can.manage && (
                <Button size="sm" variant="primary" aria-label={t('bulk.archive', { count: archivable.length })} heldReason={archivable.length === 0 ? t(model.online ? 'held.noneArchivable' : 'held.offline') : null} onClick={() => actions?.onArchiveMany?.(archivable.map((row) => row.id))}>
                  <Archive size={13} aria-hidden /> <SelectionLabel>{t('bulk.archive', { count: archivable.length })}</SelectionLabel>
                </Button>
              )}
            </>
          ),
        }}
        keys={LIST_KEYS(t)}
        onHelp={onHelp}
        onOpen={(row) => actions?.onOpen?.(row.id)}
        focusRow={model.focusRow}
        state={
          answer.files.length === 0 ? (
            isFiltered(address) ? (
              <EmptyState
                icon={<FolderCheck size={22} aria-hidden />}
                title={t('grid.noneFiltered')}
                description={t('grid.noneFilteredHint')}
                action={
                  <Button size="sm" onClick={() => actions?.onAddress?.({ status: null, q: '', tile: null })}>
                    {t('grid.clearFilters')}
                  </Button>
                }
              />
            ) : (
              <EmptyState
                icon={<FolderCheck size={22} aria-hidden />}
                title={t('grid.emptyTitle')}
                description={t('grid.empty')}
                action={
                  model.can.manage && answer.mayCreate ? (
                    <Button size="sm" variant="primary" onClick={() => actions?.onAddress?.({ add: true })}>
                      {t('band.add')}
                    </Button>
                  ) : undefined
                }
              />
            )
          ) : undefined
        }
        cards={{ fields: { style: { role: 'title' }, annex: { role: 'subtitle' }, status: { role: 'aside' } } }}
      />
    </>
  )
}

/** New technical file: the style (typed to find it), a note; a style that has a live file says so and opens it instead. */
function NewFileDialog({ model, state, actions }: { model: TechFilesModel; state: NewFileState; actions?: TechFilesActions | undefined }) {
  const t = useWords()
  const styles = valueOf(state.styles) ?? []
  const chosen = styles.find((style) => style.id === state.styleId) ?? null
  const held = !model.online ? t('held.offline') : state.existing ? t('held.liveFile', { number: state.existing.number }) : !state.styleId ? t('held.chooseStyle') : null
  return (
    <Modal
      open
      onClose={() => actions?.onAddress?.({ add: false })}
      title={t('new.title')}
      size="md"
      footer={
        <>
          <Button onClick={() => actions?.onAddress?.({ add: false })}>{t('common.cancel')}</Button>
          {state.existing ? (
            <Button variant="primary" asChild>
              <Link href={recordAddress(model.prefix, state.existing.id)}>{t('new.openExisting', { number: state.existing.number })}</Link>
            </Button>
          ) : (
            <Button variant="primary" heldReason={held} disabled={state.busy} onClick={() => actions?.onNewCreate?.()}>
              {t('new.create')}
            </Button>
          )}
        </>
      }
    >
      <div className="fw-tf-form">
        <p className="fw-tf-muted">{t('new.lead')}</p>
        <NoticeBanner notice={state.problem} />
        <Field label={t('new.style')} required hint={state.styles.status === 'error' ? t(state.styles.problem) : t('new.styleHint')}>
          <Combobox
            options={styles.map((style) => ({ value: style.id, label: `${style.code} · ${style.name}` }))}
            value={state.styleId ?? ''}
            placeholder={state.styles.status === 'loading' ? t('common.reading') : t('new.stylePick')}
            onChange={(value) => actions?.onNewPick?.(value)}
          />
        </Field>
        {chosen && (
          <p className="fw-tf-muted">
            {t(`ppe.${chosen.ppeCategory}`)}
            {chosen.ppeCategory === 'CATEGORY_II' || chosen.ppeCategory === 'CATEGORY_III' ? ` · ${t('new.needsCertificate')}` : ''}
          </p>
        )}
        {state.existing && <Banner tone="info" title={t('new.existing', { number: state.existing.number })} />}
        <Field label={t('new.note')} hint={t('new.noteHint')}>
          <Textarea rows={2} value={state.note} maxLength={2000} onChange={(event) => actions?.onNewNote?.(event.target.value)} />
        </Field>
        <p className="fw-tf-muted">{t('new.suggest')}</p>
      </div>
    </Modal>
  )
}

/** Archive N: one reason (3 to 500 characters); each file is kept ten years from today, the files it links the same. */
function ArchiveManyDialog({ model, state, actions }: { model: TechFilesModel; state: ArchiveManyState; actions?: TechFilesActions | undefined }) {
  const t = useWords()
  const rows = (valueOf(model.list)?.files ?? []).filter((row) => state.ids.includes(row.id))
  const problem = reasonProblem(state.reason)
  return (
    <Modal
      open
      onClose={() => actions?.onArchiveMany?.(null)}
      title={t('archive.bulkTitle', { count: rows.length })}
      size="md"
      footer={
        <>
          <Button onClick={() => actions?.onArchiveMany?.(null)}>{t('common.cancel')}</Button>
          <Button variant="danger" heldReason={problem ? t(problem) : !model.online ? t('held.offline') : null} disabled={state.busy} onClick={() => actions?.onArchiveApply?.()}>
            {t('bulk.archive', { count: rows.length })}
          </Button>
        </>
      }
    >
      <div className="fw-tf-form">
        <ul className="fw-tf-list">
          {rows.map((row) => (
            <li key={row.id}>{`${row.number} · ${row.style.code} ${row.style.name}`}</li>
          ))}
        </ul>
        <p className="fw-tf-muted">{t('archive.kept')}</p>
        <Field label={t('archive.reason')} required>
          <Textarea value={state.reason} rows={3} maxLength={500} onChange={(event) => actions?.onArchiveReason?.(event.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}
