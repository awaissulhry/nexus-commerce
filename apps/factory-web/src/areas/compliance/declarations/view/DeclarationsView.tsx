'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { FileText, Languages, MoreHorizontal, Plus, ScrollText } from 'lucide-react'
import { Banner, EmptyState, Menu, MetricStrip, type Metric } from '@nexus/ui/components'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Select, Skeleton } from '@nexus/ui/primitives'
import { formatPublicDocCode, publicDocCodeOf } from '@nexus/factory-domain/compliance/public-doc/code'
import { AsOf, useDsWords } from '../../../../lib/i18n/ds-parts'
import { isListKey } from '../../../../list-frame/model'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { Freshness } from '../../../quality/_shared/parts'
import type { CoverageRow } from '../api'
import {
  cellAction,
  coverageRows,
  gapsOf,
  isFiltered,
  KINDS,
  LAW,
  languageCheck,
  mayGenerate,
  mayGenerateAny,
  ORIGINS,
  pdfHref,
  recordHref,
  rowKey,
  STATUSES,
  tileChange,
  tileOf,
  TILES,
  treeRows,
  type TileId,
  type TreeRow,
} from '../model'
import type { DeclarationsPageActions, DeclarationsPageModel } from '../view-model'
import { LanguageCheckDialog, NewDeclarationDialog, TranslateDialog, UnrecordedDialog } from './dialogs'
import { CellPill, DeclarationsMessages, GateBanner, KeysModal, LanguageTag, NoAccess, PAGE_KEYS, PartFailed, PartLoading, SectionHead, StatusPill, useDay, useLanguage, useWords } from './parts'

export type { DeclarationsPageActions, DeclarationsPageModel } from '../view-model'

/**
 * SCR-052 — Compliance › Declarations & instructions (design compliance.declarations; PRD-292, PRD-293, PRD-295, PRD-298,
 * PRD-300; Reg. (EU) 2016/425 art. 15 and Annex IX, art. 8(7) and Annex II 1.4): the band (when it was read, live; New
 * declaration `c`, Language check `l`; ⋯ the batches without a recorded version, the keys), GATE-PPE-TEXTS said plainly (a
 * generated DoC or leaflet is a draft until a PPE consultant checks its template; the signed PDF on the style stays the live
 * route), the tiles (saved filters), the language coverage (style › kind × the languages the markets need; a cell opens its
 * document or adds the language), and every DoC and leaflet per style, kind, language and revision. Each part loads and fails
 * on its own; every held button says why. One view model, nothing fetched; the page fills the main area (no max-width).
 */
export function DeclarationsView({ model, actions }: { model: DeclarationsPageModel; actions?: DeclarationsPageActions }) {
  return (
    <DeclarationsMessages>
      <Page model={model} actions={actions} />
    </DeclarationsMessages>
  )
}

function Page({ model, actions }: { model: DeclarationsPageModel; actions?: DeclarationsPageActions | undefined }) {
  const t = useWords()
  const [keysOpen, setKeysOpen] = useState(model.keysOpen ?? false)
  const [heldSaid, setHeldSaid] = useState<string | null>(null)
  const coverageRef = useRef<HTMLElement | null>(null)
  const gridRef = useRef<HTMLElement | null>(null)
  const { address, can } = model
  const dialogOpen = address.add || address.check || address.unrecorded || !!model.translate || keysOpen
  const newHeld = !mayGenerateAny(can) ? t('held.generateAny') : !model.online ? t('held.offline') : null
  const goTo = (ref: { current: HTMLElement | null }) => {
    ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    ref.current?.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true })
  }

  // c: New declaration; l: Language check; ?: the keys (not in a field, a menu or a dialog).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (dialogOpen || !isListKey(event, event.target as HTMLElement | null)) return
      if (event.key === 'c') {
        event.preventDefault()
        if (newHeld) setHeldSaid(newHeld)
        else actions?.onAddress?.({ add: true })
      } else if (event.key === 'l') {
        event.preventDefault()
        actions?.onAddress?.({ check: true })
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
      <div className="fw-dc">
        <NoAccess />
      </div>
    )
  }

  const coverage = model.coverage.status === 'ready' ? model.coverage.value : null
  const active = tileOf(address)
  const onTile = (tile: TileId) => {
    actions?.onAddress?.(tileChange(tile, address))
    if (tile === 'languagesMissing') goTo(coverageRef)
    else if (tile !== 'batchesShippedWithoutVersion') goTo(gridRef)
  }
  const metrics: Metric[] = TILES.map((tile): Metric => {
    const value = coverage ? coverage.tiles[tile] : null
    return {
      label: t(`tile.${tile}.label`),
      value: value === null ? model.coverage.status === 'loading' ? <Skeleton width={40} height={24} /> : '—' : String(value),
      hint: t(`tile.${tile}.hint`),
      onClick: () => onTile(tile),
      active: active === tile,
      ...((tile === 'languagesMissing' || tile === 'batchesShippedWithoutVersion') && (value ?? 0) > 0 ? { accent: 'var(--nds-danger)' } : {}),
      ...(tile === 'drafts' && (value ?? 0) > 0 ? { accent: 'var(--nds-info)' } : {}),
    }
  })

  return (
    <div className="fw-dc">
      <div className="fw-dc-band" role="group" aria-label={t('band.label')}>
        <span className="fw-dc-status">{model.readAt ? <Freshness asOf={model.readAt} live={model.live} /> : <span className="fw-dc-muted">{t('band.reading')}</span>}</span>
        <span className="fw-dc-actions">
          <Button size="sm" variant="secondary" aria-keyshortcuts="l" onClick={() => actions?.onAddress?.({ check: true })}>
            <Languages size={14} aria-hidden /> {t('band.check')}
          </Button>
          <Button size="sm" variant="primary" aria-keyshortcuts="c" heldReason={newHeld} onClick={() => actions?.onAddress?.({ add: true })}>
            <Plus size={14} aria-hidden /> {t('band.new')}
          </Button>
          <Menu
            label={<MoreHorizontal size={16} aria-hidden />}
            align="right"
            triggerProps={{ 'aria-label': t('band.more') }}
            items={[
              { id: 'unrecorded', label: t('band.unrecorded'), onSelect: () => actions?.onAddress?.({ unrecorded: true }) },
              { id: 'export', label: t('band.export'), description: t('band.exportHint'), onSelect: () => goTo(gridRef) },
              { id: 'keys', label: t('keys.title'), onSelect: () => setKeysOpen(true) },
            ]}
          />
        </span>
      </div>

      {!model.online && <Banner tone="warning" title={t('offline.title')}>{t('offline.body')}</Banner>}
      {heldSaid && (
        <Banner
          tone="info"
          title={heldSaid}
          action={
            <Button size="sm" variant="quiet" onClick={() => setHeldSaid(null)}>
              {t('common.close')}
            </Button>
          }
        />
      )}
      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={t(model.notice.key, { ...(model.notice.params ?? {}), count: model.notice.params?.count ?? 0 })}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
              {t('common.close')}
            </Button>
          }
        >
          {model.notice.refused && model.notice.refused.length > 0 ? (
            <ul className="fw-dc-list">
              {model.notice.refused.map((entry, index) => (
                <li key={`${entry.label}-${index}`}>{t('bulk.refusedRow', { label: entry.label, why: t(entry.key) })}</li>
              ))}
            </ul>
          ) : null}
        </Banner>
      )}

      <GateBanner prefix={model.prefix} />

      <section className="fw-dc-section" aria-labelledby="fw-dc-tiles">
        <h2 id="fw-dc-tiles" className="fw-dc-vh">
          {t('tile.title')}
        </h2>
        <MetricStrip metrics={metrics} minTileWidth={190} />
        {model.coverage.status === 'error' && (
          <Banner
            tone="warning"
            title={t('tile.failed')}
            action={
              <Button size="sm" onClick={() => actions?.onRetry?.('coverage')}>
                {t('common.retry')}
              </Button>
            }
          >
            {t(model.coverage.problem)}
          </Banner>
        )}
      </section>

      <section ref={coverageRef} className="fw-dc-section fw-dc-anchor" aria-labelledby="fw-dc-coverage">
        <CoverageSection model={model} actions={actions} onHelp={() => setKeysOpen(true)} />
      </section>

      <section ref={gridRef} className="fw-dc-section fw-dc-anchor" aria-labelledby="fw-dc-grid">
        <GridSection model={model} actions={actions} onHelp={() => setKeysOpen(true)} />
      </section>

      {address.add && model.add && <NewDeclarationDialog model={model} state={model.add} actions={actions} />}
      {model.translate && <TranslateDialog state={model.translate} actions={actions} />}
      {address.check && <LanguageCheckDialog model={model} actions={actions} />}
      {address.unrecorded && model.unrecorded && <UnrecordedDialog model={model} state={model.unrecorded} actions={actions} />}
      {keysOpen && <KeysModal onClose={() => setKeysOpen(false)} />}
    </div>
  )
}

// ---- Language coverage (sec:dc-langs) ----------------------------------------------------------------------------------------

function CoverageSection({ model, actions, onHelp }: { model: DeclarationsPageModel; actions?: DeclarationsPageActions | undefined; onHelp: () => void }) {
  const t = useWords()
  const language = useLanguage()
  const { address, can } = model
  const coverage = model.coverage.status === 'ready' ? model.coverage.value : null
  const listRows = model.list.status === 'ready' ? model.list.value.declarations : []
  const rows = useMemo(() => (coverage ? coverageRows(coverage, address) : null), [coverage, address])
  const checks = useMemo(() => (coverage ? new Map(languageCheck(coverage, listRows, can).map((entry) => [entry.key, entry])) : new Map()), [coverage, listRows, can])
  const selected = model.selectedCoverage
  const picked = selected.filter((key) => checks.get(key)?.held === null)

  const columns = useMemo<ColDef<CoverageRow>[]>(() => {
    if (!coverage) return []
    const StyleCell = ({ data }: ICellRendererParams<CoverageRow>) =>
      data ? (
        <span className="fw-dc-cell">
          <Link className="fw-dc-code" href={`${model.prefix}/products/styles/${encodeURIComponent(data.style.id)}?tab=compliance`}>
            {data.style.code}
          </Link>
          <span className="fw-dc-muted">{data.style.revision === null ? data.style.name : t('coverage.styleRev', { name: data.style.name, revision: data.style.revision })}</span>
        </span>
      ) : null
    const cellColumn = (tag: string): ColDef<CoverageRow> => ({
      colId: `lang-${tag}`,
      headerName: tag.toUpperCase(),
      headerTooltip: language(tag),
      minWidth: 132,
      flex: 1,
      sortable: false,
      valueGetter: (params) => (params.data ? t(`cell.${params.data.cells.find((cell) => cell.language === tag)?.state ?? 'NOT_NEEDED'}`) : ''),
      cellRenderer: ({ data }: ICellRendererParams<CoverageRow>) => {
        if (!data) return null
        const cell = data.cells.find((entry) => entry.language === tag)
        if (!cell) return null
        const action = cellAction(data, tag, listRows, can)
        const label = t('coverage.cellLabel', { style: data.style.code, kind: t(`kindShort.${data.kind}`), language: language(tag), state: t(`cell.${cell.state}`) })
        if (action.kind === 'open')
          return (
            <Link className="fw-dc-celllink" href={recordHref(model.prefix, action.documentId)} aria-label={label}>
              <CellPill state={cell.state} revision={cell.revision} />
            </Link>
          )
        if (action.kind === 'none') return <CellPill state={cell.state} revision={cell.revision} />
        return (
          <span className="fw-dc-cellrow">
            <CellPill state={cell.state} revision={cell.revision} />
            <Button size="sm" variant="quiet" aria-label={t('coverage.addLabel', { language: language(tag), style: data.style.code })} title={t('coverage.addLabel', { language: language(tag), style: data.style.code })} heldReason={model.online ? null : t('held.offline')} onClick={() => actions?.onCell?.(data, tag)}>
              <Plus size={13} aria-hidden />
            </Button>
          </span>
        )
      },
    })
    return [
      { colId: 'style', headerName: t('coverage.col.style'), minWidth: 220, flex: 2, valueGetter: (params) => (params.data ? `${params.data.style.code} · ${params.data.style.name}` : ''), cellRenderer: StyleCell },
      { colId: 'kind', headerName: t('coverage.col.kind'), minWidth: 110, flex: 0.7, valueGetter: (params) => (params.data ? t(`kindShort.${params.data.kind}`) : ''), headerTooltip: t('coverage.col.kind') },
      ...coverage.languages.map(cellColumn),
      { colId: 'gaps', headerName: t('coverage.col.gaps'), minWidth: 110, flex: 0.7, valueGetter: (params) => (params.data ? gapsOf(params.data).length : 0), cellRenderer: ({ data }: ICellRendererParams<CoverageRow>) => (data ? (gapsOf(data).length === 0 ? <span className="fw-dc-muted">{t('coverage.none')}</span> : gapsOf(data).map((tag) => <LanguageTag key={tag} tag={tag} />)) : null) },
    ]
  }, [coverage, t, language, listRows, can, model.prefix, model.online, actions])

  const head = (
    <SectionHead id="fw-dc-coverage" title={t('coverage.title')} note={t('coverage.note')}>
      <Button size="sm" variant={address.gaps ? 'tonal' : 'secondary'} aria-pressed={address.gaps} onClick={() => actions?.onAddress?.({ gaps: !address.gaps })}>
        {t('coverage.gapsOnly')}
      </Button>
    </SectionHead>
  )
  if (model.coverage.status === 'error')
    return (
      <>
        {head}
        <PartFailed title={t('coverage.failed')} problem={model.coverage.problem} onRetry={() => actions?.onRetry?.('coverage')} />
      </>
    )
  if (!coverage || !rows)
    return (
      <>
        {head}
        <PartLoading rows={4} />
      </>
    )
  return (
    <>
      {head}
      <p className="fw-dc-muted">{t('coverage.legend')}</p>
      <ListFrame<CoverageRow>
        label={t('coverage.title')}
        listKey={null}
        rows={rows}
        rowId={rowKey}
        columns={columns}
        count={rows.length === coverage.rows.length ? t('coverage.count', { count: rows.length }) : t('coverage.countOf', { count: rows.length, total: coverage.rows.length })}
        selection={{
          selected,
          onChange: (keys) => actions?.onSelectedCoverage?.(keys),
          actions: (
            <Button size="sm" variant="primary" aria-label={t('bulk.translateGaps', { count: picked.length })} heldReason={picked.length === 0 ? t('held.noneTranslatable') : !model.online ? t('held.offline') : null} onClick={() => actions?.onTranslateGaps?.(picked)}>
              <Languages size={13} aria-hidden /> <SelectionLabel>{t('bulk.translateGaps', { count: picked.length })}</SelectionLabel>
            </Button>
          ),
        }}
        isRowSelectable={(row) => {
          const held = checks.get(rowKey(row))?.held
          return held ? t(held) : null
        }}
        keys={PAGE_KEYS(t)}
        onHelp={onHelp}
        onOpen={(row) => actions?.onAddress?.({ q: row.style.code })}
        state={
          rows.length === 0 ? (
            coverage.rows.length === 0 ? (
              <EmptyState icon={<Languages size={22} aria-hidden />} title={t('coverage.emptyTitle')} description={t('coverage.empty')} />
            ) : (
              <EmptyState
                title={t('coverage.noneFiltered')}
                description={t('coverage.noneFilteredHint')}
                action={
                  <Button size="sm" onClick={() => actions?.onAddress?.({ gaps: false, q: '', kind: null })}>
                    {t('common.clearFilters')}
                  </Button>
                }
              />
            )
          ) : undefined
        }
        cards={{ fields: { style: { role: 'title' }, kind: { role: 'subtitle' }, gaps: { role: 'aside' } } }}
      />
    </>
  )
}

// ---- Declarations (sec:dc-grid) -----------------------------------------------------------------------------------------------

function GridSection({ model, actions, onHelp }: { model: DeclarationsPageModel; actions?: DeclarationsPageActions | undefined; onHelp: () => void }) {
  const t = useWords()
  const ds = useDsWords()
  const day = useDay()
  const language = useLanguage()
  const { address, can } = model
  const answer = model.list.status === 'ready' ? model.list.value : null
  const coverage = model.coverage.status === 'ready' ? model.coverage.value : null
  const rows = useMemo(() => (answer ? treeRows(answer.declarations) : null), [answer])
  const selected = model.selected
  const picked = (rows ?? []).filter((row) => selected.includes(row.id))
  const currentOf = useMemo(() => new Map((coverage?.rows ?? []).map((row) => [row.style.id, row.style.revision])), [coverage])

  const columns = useMemo<ColDef<TreeRow>[]>(() => {
    const publicAddress = (styleId: string) => `${typeof window === 'undefined' ? '' : window.location.origin}/doc/${publicDocCodeOf(styleId)}`
    const StyleCell = ({ data }: ICellRendererParams<TreeRow>) =>
      data ? (
        <span className={data.firstOfStyle ? 'fw-dc-cell' : 'fw-dc-cell fw-dc-tree'}>
          <span className={data.firstOfStyle ? 'fw-dc-code' : 'fw-dc-muted'}>{data.style.code}</span>
          {data.firstOfStyle && <span className="fw-dc-muted">{data.style.name}</span>}
        </span>
      ) : null
    const NumberCell = ({ data }: ICellRendererParams<TreeRow>) =>
      data ? (
        <span className="fw-dc-cell">
          <Link className="fw-dc-link" href={recordHref(model.prefix, data.id)}>
            {data.number ?? t('grid.noNumber')}
          </Link>
          <span className="fw-dc-muted">{data.translationOfId ? t('grid.translation') : t('grid.original')}</span>
        </span>
      ) : null
    const OriginCell = ({ data }: ICellRendererParams<TreeRow>) =>
      data ? (
        <span className="fw-dc-cell">
          <span>{t(`origin.${data.origin}`)}</span>
          {data.draftUntilChecked && <span className="fw-dc-muted">{t('grid.draftUntilChecked')}</span>}
        </span>
      ) : null
    const TranslationCell = ({ data }: ICellRendererParams<TreeRow>) =>
      data ? (
        data.translationStatus ? (
          <span className="fw-dc-cell">
            <span>{t(`translation.${data.translationStatus}`)}</span>
            {data.translationCheckedBy ? <span className="fw-dc-muted">{t('grid.checkedBy', { name: data.translationCheckedBy.name })}</span> : data.pointsToType.length > 0 ? <span className="fw-dc-muted">{t('grid.toType', { count: data.pointsToType.length })}</span> : null}
          </span>
        ) : (
          <span className="fw-dc-muted">—</span>
        )
      ) : null
    const MoreCell = ({ data }: ICellRendererParams<TreeRow>) => {
      if (!data) return null
      const current = currentOf.get(data.styleId) ?? null
      const newRevisionHeld = !mayGenerate(can, data.kind) ? t(data.kind === 'USER_INFORMATION' ? 'held.uiGenerate' : 'held.generate') : current === null || data.revision >= current ? t('held.currentRevision') : null
      const translateHeld = !mayGenerate(can, data.kind) ? t(data.kind === 'USER_INFORMATION' ? 'held.uiGenerate' : 'held.generate') : data.origin !== 'GENERATED' ? t('held.signedTranslate') : data.translationOfId ? t('held.translateOriginal') : data.status !== 'DRAFT' ? t('held.notDraft') : null
      return (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('grid.rowMenu', { number: data.number ?? data.style.code }) }}
          items={[
            { id: 'open', label: t('grid.open'), href: recordHref(model.prefix, data.id) },
            { id: 'pdf', label: t('grid.pdf'), href: pdfHref(model.prefix, data.id), target: '_blank' },
            { id: 'revision', label: t('grid.newRevision'), disabled: !!newRevisionHeld, description: newRevisionHeld ?? undefined, onSelect: () => actions?.onAddress?.({ add: true, newStyle: data.styleId, newKind: data.kind, newLanguage: data.language }) },
            { id: 'translate', label: t('grid.translate'), disabled: !!translateHeld, description: translateHeld ?? undefined, onSelect: () => actions?.onTranslateRow?.(data.id) },
            { id: 'copy', label: t('grid.copyAddress'), description: formatPublicDocCode(publicDocCodeOf(data.styleId)), onSelect: () => actions?.onCopy?.(publicAddress(data.styleId), 'address') },
          ]}
        />
      )
    }
    return [
      { colId: 'style', headerName: t('grid.col.style'), minWidth: 170, flex: 1.3, valueGetter: (params) => params.data?.style.code ?? '', cellRenderer: StyleCell },
      { colId: 'kind', headerName: t('grid.col.kind'), minWidth: 150, flex: 1, valueGetter: (params) => (params.data ? t(`kind.${params.data.kind}`) : '') },
      { colId: 'language', headerName: t('grid.col.language'), minWidth: 110, flex: 0.7, valueGetter: (params) => (params.data ? language(params.data.language) : '') },
      { colId: 'number', headerName: t('grid.col.number'), minWidth: 190, flex: 1.4, valueGetter: (params) => params.data?.number ?? '', cellRenderer: NumberCell },
      { colId: 'revision', headerName: t('grid.col.revision'), minWidth: 90, flex: 0.5, type: 'rightAligned', valueGetter: (params) => params.data?.revision ?? null },
      { colId: 'status', headerName: t('grid.col.status'), minWidth: 130, flex: 0.8, valueGetter: (params) => (params.data ? t(`status.${params.data.status}`) : ''), cellRenderer: ({ data }: ICellRendererParams<TreeRow>) => (data ? <StatusPill status={data.status} /> : null) },
      { colId: 'origin', headerName: t('grid.col.origin'), minWidth: 160, flex: 1, valueGetter: (params) => (params.data ? t(`origin.${params.data.origin}`) : ''), cellRenderer: OriginCell },
      { colId: 'translation', headerName: t('grid.col.translation'), minWidth: 150, flex: 1, valueGetter: (params) => (params.data?.translationStatus ? t(`translation.${params.data.translationStatus}`) : ''), cellRenderer: TranslationCell },
      { colId: 'certificate', headerName: t('grid.col.certificate'), minWidth: 140, flex: 0.9, valueGetter: (params) => params.data?.certificate?.number ?? '—' },
      { colId: 'maker', headerName: t('grid.col.maker'), minWidth: 180, flex: 1.2, valueGetter: (params) => (params.data ? `${params.data.maker.name} (${t(`maker.${params.data.maker.role}`)})` : '') },
      { colId: 'standards', headerName: t('grid.col.standards'), minWidth: 160, flex: 1, valueGetter: (params) => params.data?.standards.join(', ') || '—' },
      { colId: 'signedBy', headerName: t('grid.col.signedBy'), minWidth: 200, flex: 1.2, valueGetter: (params) => (params.data ? [params.data.signedByName, params.data.signedPlace, params.data.signedOn ? day(params.data.signedOn) : null].filter(Boolean).join(' · ') || '—' : '') },
      { colId: 'batches', headerName: t('grid.col.batches'), minWidth: 130, flex: 0.8, valueGetter: (params) => (params.data ? t('grid.batchesCount', { count: params.data.batches, shipments: params.data.shipments }) : '') },
      { colId: 'public', headerName: t('grid.col.public'), minWidth: 130, flex: 0.8, valueGetter: (params) => (params.data ? (params.data.kind === 'DECLARATION_OF_CONFORMITY' && params.data.origin === 'SIGNED' && params.data.status === 'ISSUED' ? t('grid.publicLive') : t('grid.publicNot')) : '') },
      { colId: 'markets', headerName: t('grid.col.markets'), minWidth: 130, flex: 0.8, valueGetter: (params) => params.data?.marketsNeeding.join(', ') || '—' },
      { colId: 'more', headerName: t('grid.col.more'), minWidth: 72, maxWidth: 72, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
  }, [t, day, language, model.prefix, can, currentOf, actions])

  const search = <Input size="sm" type="search" value={address.q} placeholder={t('grid.search')} aria-label={t('grid.search')} onChange={(event) => actions?.onAddress?.({ q: event.target.value })} />
  const tools = (
    <span className="fw-dc-row">
      <Select size="sm" value={address.kind ?? ''} aria-label={t('grid.filterKind')} onChange={(event) => actions?.onAddress?.({ kind: (event.target.value || null) as never })}>
        <option value="">{t('grid.allKinds')}</option>
        {KINDS.map((kind) => (
          <option key={kind} value={kind}>
            {t(`kind.${kind}`)}
          </option>
        ))}
      </Select>
      <Select size="sm" value={address.status ?? ''} aria-label={t('grid.filterStatus')} onChange={(event) => actions?.onAddress?.({ status: (event.target.value || null) as never })}>
        <option value="">{t('grid.allStatuses')}</option>
        {STATUSES.map((status) => (
          <option key={status} value={status}>
            {t(`status.${status}`)}
          </option>
        ))}
      </Select>
      <Select size="sm" value={address.origin ?? ''} aria-label={t('grid.filterOrigin')} onChange={(event) => actions?.onAddress?.({ origin: (event.target.value || null) as never })}>
        <option value="">{t('grid.allOrigins')}</option>
        {ORIGINS.map((origin) => (
          <option key={origin} value={origin}>
            {t(`origin.${origin}`)}
          </option>
        ))}
      </Select>
      <Select size="sm" value={address.language ?? ''} aria-label={t('grid.filterLanguage')} onChange={(event) => actions?.onAddress?.({ language: event.target.value || null })}>
        <option value="">{t('grid.allLanguages')}</option>
        {(coverage?.languages ?? []).map((tag) => (
          <option key={tag} value={tag}>
            {language(tag)}
          </option>
        ))}
      </Select>
    </span>
  )

  const head = <SectionHead id="fw-dc-grid" title={t('grid.title')} note={<LawRef law={LAW.doc} plain={t('law.doc')} href={LAW.href} labels={ds.lawRef} />} />
  if (model.list.status === 'error')
    return (
      <>
        {head}
        <PartFailed title={t('grid.failed')} problem={model.list.problem} onRetry={() => actions?.onRetry?.('list')} />
      </>
    )
  if (!answer || !rows)
    return (
      <>
        {head}
        <PartLoading rows={6} />
      </>
    )
  return (
    <>
      {head}
      <ListFrame<TreeRow>
        label={t('grid.title')}
        title={t('grid.title')}
        listKey="compliance.declarations"
        rows={rows}
        rowId={(row) => row.id}
        columns={columns}
        count={t('grid.count', { count: rows.length })}
        search={search}
        tools={tools}
        updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
        selection={{
          selected,
          onChange: (ids) => actions?.onSelected?.(ids),
          exportSelected: true,
          actions: (
            <Button size="sm" aria-label={t('bulk.csv', { count: picked.length })} onClick={() => actions?.onExport?.(picked.map((row) => row.id))}>
              <FileText size={13} aria-hidden /> <SelectionLabel>{t('bulk.csv', { count: picked.length })}</SelectionLabel>
            </Button>
          ),
        }}
        keys={PAGE_KEYS(t)}
        onHelp={onHelp}
        onOpen={(row) => actions?.onOpen?.(row.id)}
        more={answer.more ? { label: t('grid.more'), onMore: () => undefined, held: t('grid.moreHeld') } : null}
        state={
          rows.length === 0 ? (
            isFiltered(address) ? (
              <EmptyState
                title={t('grid.noneFiltered')}
                description={t('grid.noneFilteredHint')}
                action={
                  <Button size="sm" onClick={() => actions?.onAddress?.({ kind: null, status: null, origin: null, language: null, q: '' })}>
                    {t('common.clearFilters')}
                  </Button>
                }
              />
            ) : (
              <EmptyState
                icon={<ScrollText size={22} aria-hidden />}
                title={t('grid.emptyTitle')}
                description={t('grid.empty')}
                action={
                  mayGenerateAny(can) ? (
                    <Button size="sm" variant="primary" onClick={() => actions?.onAddress?.({ add: true })}>
                      {t('band.new')}
                    </Button>
                  ) : undefined
                }
              />
            )
          ) : undefined
        }
        cards={{ fields: { number: { role: 'title' }, style: { role: 'subtitle' }, status: { role: 'aside' } } }}
      />
      {model.readAt && (
        <p className="fw-dc-muted">
          <AsOf at={model.readAt} />
        </p>
      )}
    </>
  )
}
