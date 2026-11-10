'use client'

import { useMemo, useRef } from 'react'
import Link from 'next/link'
import { Download, Layers, MoreHorizontal, RefreshCw, Search, Send, X } from 'lucide-react'
import { EmptyState, Menu, MetricStrip, type MenuItemDef } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, FilterChip, Input, Pill, Tag } from '@nexus/ui/primitives'
import { ITEM_KINDS } from '@nexus/factory-domain/product/materials/rules'
import { useT } from '../../../../../lib/i18n/provider'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { listKeys, type ListKey } from '../../../../../list-frame/model'
import { Freshness, NoAccess, NoticeBanner, PageHead } from '../../../../quality/_shared/parts'
import type { LiveState, Notice, Read } from '../../../../quality/_shared/model'
import { DEPTH_NAMESPACE, DepthMessages } from '../../substances/frame/parts'
import { ShortcutsDialog, useListWords } from '../../view/parts'
import type { PageFrame } from '../../substances/frame/views'
import type { ProfileList, ProfileRow } from '../api'
import { gapKeys, materialHref, PROFILE_STATES, tannageKey, STATE_TONE, stateOf, toAsk, type ProfilesAddress, type ProfilesCan } from '../model'

export interface ProfilesViewModel {
  readonly prefix: string
  readonly can: ProfilesCan
  readonly online: boolean
  readonly frame: PageFrame
  readonly address: ProfilesAddress
  readonly list: Read<ProfileList>
  readonly asOf: string | null
  readonly live: LiveState
  readonly updates: number
  readonly selected: readonly string[]
  readonly notice: Notice | null
  readonly busy: boolean
  readonly keysOpen: boolean
  readonly focusRow?: number
}

export interface ProfilesActions {
  onAddress?: (change: Partial<ProfilesAddress>) => void
  onRetry?: () => void
  onShowUpdates?: () => void
  onSelect?: (ids: readonly string[]) => void
  onOpen?: (row: ProfileRow) => void
  onAsk?: (rows: readonly ProfileRow[]) => void
  onEvaluate?: (rows: readonly ProfileRow[]) => void
  onExport?: (rows: readonly ProfileRow[]) => void
  onKeys?: (open: boolean) => void
  onDismissNotice?: () => void
}

const EVALUATE_MAX = 100

/**
 * Material profiles (B-W2b-267, SCR-054-profiles; design compliance.tests sec:ts-profiles): the page's frame, then every
 * active material on the ONE list frame — Material, Kind, Composition, Tannage, Origin, Supplier, Required tests (from the
 * rules), Declarations present / missing, PPE innocuousness evidence (pH, Cr VI, azo, nickel), Status (the evaluator's, with
 * what keeps it from complete in our words). A row opens the material's Compliance tab. Selected rows: Request declarations
 * (the missing kinds), Evaluate again (the evaluator decides; nothing here sets a state), CSV. Fetches nothing.
 */
export function ProfilesView({ model, actions }: { model: ProfilesViewModel; actions?: ProfilesActions }) {
  return (
    <DepthMessages>
      <Profiles model={model} actions={actions} />
    </DepthMessages>
  )
}

function Profiles({ model, actions }: { model: ProfilesViewModel; actions?: ProfilesActions }) {
  const t = useT(DEPTH_NAMESPACE)
  const q = useT('quality')
  const lists = useListWords()
  const can = model.can
  const rows = useMemo(() => model.list.value?.profiles ?? [], [model.list.value])
  const selectedRows = rows.filter((row) => model.selected.includes(row.material.id))
  const live = useRef({ model })
  live.current = { model }

  const columns = useMemo<ColDef<ProfileRow>[]>(() => {
    const MaterialCell = ({ data }: ICellRendererParams<ProfileRow>) =>
      data ? (
        <span className="fw-q-cell">
          <Link className="fw-q-name fw-q-code" href={materialHref(live.current.model.prefix, data.material.id)} tabIndex={-1}>
            {data.material.code}
          </Link>
          <span className="fw-q-hint">{data.material.name}</span>
        </span>
      ) : null
    const Confirmed = ({ text, confirmed }: { text: string | null; confirmed: boolean | null }) => (
      <span className="fw-q-cell">
        <span>{text ?? '—'}</span>
        {confirmed !== null && text && <span className="fw-q-hint">{t(confirmed ? 'profile.confirmed' : 'profile.notConfirmed')}</span>}
      </span>
    )
    const CompositionCell = ({ data }: ICellRendererParams<ProfileRow>) => (data ? <Confirmed text={data.composition} confirmed={data.compositionConfirmed} /> : null)
    const TannageCell = ({ data }: ICellRendererParams<ProfileRow>) => (data ? (data.material.kind === 'LEATHER' ? <Confirmed text={tannageKey(data.tannage) ? t(tannageKey(data.tannage)!) : data.tannage} confirmed={data.tannageConfirmed} /> : <span className="fw-q-hint">{t('profile.notLeather')}</span>) : null)
    const SupplierCell = ({ data }: ICellRendererParams<ProfileRow>) =>
      data ? (
        data.supplier ? (
          <span className="fw-q-cell">
            <span className="fw-q-code">{data.supplier.code}</span>
            <span className="fw-q-hint">{data.supplier.name}</span>
          </span>
        ) : (
          <span className="fw-q-hint">{t('profile.noSupplier')}</span>
        )
      ) : null
    const TestsCell = ({ data }: ICellRendererParams<ProfileRow>) => (data ? <span>{data.testsNeeded.length === 0 ? t('profile.noTests') : data.testsNeeded.map((test) => t(`test.${test}`)).join(', ')}</span> : null)
    const DeclarationsCell = ({ data }: ICellRendererParams<ProfileRow>) => {
      if (!data) return null
      if (data.declarations.needed.length === 0) return <span className="fw-q-hint">{t('profile.noneNeeded')}</span>
      const kinds = (list: readonly string[]) => list.map((kind) => t(`kindShort.${kind}`)).join(', ')
      const missing = data.declarations.missing.map((kind) => (data.declarations.asked.includes(kind) ? t('profile.decl.askedMark', { kind: t(`kindShort.${kind}`) }) : t(`kindShort.${kind}`))).join(', ')
      return (
        <span className="fw-q-cell">
          <span>{data.declarations.present.length > 0 ? t('profile.decl.present', { kinds: kinds(data.declarations.present) }) : t('profile.decl.nonePresent')}</span>
          <span className="fw-q-hint">{data.declarations.missing.length > 0 ? t('profile.decl.missing', { kinds: missing }) : t('profile.decl.nothingMissing')}</span>
        </span>
      )
    }
    const InnocuousCell = ({ data }: ICellRendererParams<ProfileRow>) => {
      if (!data) return null
      if (!data.innocuousness.required) return <span className="fw-q-hint">{t('profile.notPpe')}</span>
      if (data.innocuousness.parameters.length === 0) return <span className="fw-q-hint">{t('profile.inn.none')}</span>
      const of = (status: string) => data.innocuousness.parameters.filter((entry) => entry.status === status).map((entry) => t(`parameter.${entry.parameter}`)).join(', ')
      const failed = of('FAILED')
      const missing = of('MISSING')
      const head = failed ? { tone: 'danger' as const, text: t('profile.inn.failed', { parameters: failed }) } : missing ? { tone: 'warning' as const, text: t('profile.inn.missing', { parameters: missing }) } : of('FILE') ? { tone: 'info' as const, text: t('profile.inn.file') } : { tone: 'success' as const, text: t('profile.inn.proved') }
      return (
        <span className="fw-q-cell">
          <span><Tag tone={head.tone}>{head.text}</Tag></span>
          <span className="fw-q-hint">{data.innocuousness.parameters.map((entry) => t('profile.parameter', { parameter: t(`parameter.${entry.parameter}`), status: t(`parameterStatus.${entry.status}`) })).join(' · ')}</span>
        </span>
      )
    }
    const StatusCell = ({ data }: ICellRendererParams<ProfileRow>) => {
      if (!data) return null
      const state = stateOf(data)
      const gaps = gapKeys(data)
      return (
        <span className="fw-q-cell">
          <Pill tone={STATE_TONE[state]} dot>{t(`state.${state}`)}</Pill>
          {state !== 'COMPLETE' && gaps[0] && <span className="fw-q-hint">{t(gaps[0].key, gaps[0].params)}{gaps.length > 1 ? ` ${t('profile.moreGaps', { count: gaps.length - 1 })}` : ''}</span>}
        </span>
      )
    }
    const column = (colId: string, header: string, cellRenderer: ColDef<ProfileRow>['cellRenderer'], size: { flex?: number; minWidth?: number; width?: number }): ColDef<ProfileRow> => ({ colId, headerName: header, cellRenderer, sortable: false, ...size })
    return [
      column('material', t('profile.col.material'), MaterialCell, { flex: 1.6, minWidth: 180 }),
      { colId: 'kind', headerName: t('profile.col.kind'), sortable: false, flex: 0.7, minWidth: 100, valueGetter: (params) => (params.data ? t(`materialKind.${params.data.material.kind}`) : '') },
      column('composition', t('profile.col.composition'), CompositionCell, { flex: 1.4, minWidth: 160 }),
      column('tannage', t('profile.col.tannage'), TannageCell, { flex: 0.9, minWidth: 120 }),
      { colId: 'origin', headerName: t('profile.col.origin'), sortable: false, flex: 0.5, minWidth: 80, valueGetter: (params) => params.data?.originCountry ?? '—' },
      column('supplier', t('profile.col.supplier'), SupplierCell, { flex: 1.1, minWidth: 140 }),
      column('tests', t('profile.col.tests'), TestsCell, { flex: 1, minWidth: 130 }),
      column('declarations', t('profile.col.declarations'), DeclarationsCell, { flex: 1.8, minWidth: 200 }),
      column('innocuousness', t('profile.col.innocuousness'), InnocuousCell, { flex: 1.6, minWidth: 180 }),
      column('state', t('profile.col.state'), StatusCell, { flex: 1.4, minWidth: 170 }),
    ]
  }, [t])

  if (!can.view) return <NoAccess title={t('noAccess.title')} body={t('noAccess.body')} />

  const address = model.address
  const filtered = address.state !== null || address.kind !== null || address.q.trim() !== ''
  const choose = (change: Partial<ProfilesAddress>) => actions?.onAddress?.(change)
  const counts = model.list.value?.counts ?? null
  const stateItems: MenuItemDef[] = [
    { id: 'heading', heading: true, label: t('profile.stateHeading') },
    { id: 'all', label: t('profile.allStates'), checked: address.state === null, onSelect: () => choose({ state: null }) },
    ...PROFILE_STATES.map((state) => ({ id: state, label: counts ? t('profile.stateCount', { state: t(`state.${state}`), count: counts[state === 'NONE' ? 'none' : (state.toLowerCase() as 'incomplete' | 'complete' | 'blocked')] }) : t(`state.${state}`), checked: address.state === state, onSelect: () => choose({ state }) })),
  ]
  const kindItems: MenuItemDef[] = [
    { id: 'heading', heading: true, label: t('profile.kindHeading') },
    { id: 'all', label: t('profile.allKinds'), checked: address.kind === null, onSelect: () => choose({ kind: null }) },
    ...ITEM_KINDS.map((kind) => ({ id: kind, label: t(`materialKind.${kind}`), checked: address.kind === kind, onSelect: () => choose({ kind }) })),
  ]
  const chip = (key: string, label: string, onRemove: () => void) => (
    <FilterChip key={key} pressed onClick={onRemove} aria-label={t('list.removeFilter', { name: label })}>
      {label} <X size={12} aria-hidden />
    </FilterChip>
  )
  const tools = (
    <>
      <Menu label={t('profile.stateMenu', { state: address.state ? t(`state.${address.state}`) : t('profile.allStates') })} items={stateItems} />
      <Menu label={t('profile.kindMenu', { kind: address.kind ? t(`materialKind.${address.kind}`) : t('profile.allKinds') })} items={kindItems} />
      {filtered && (
        <span className="fw-q-chips" aria-label={t('list.activeFilters')}>
          {address.state && chip('state', t(`state.${address.state}`), () => choose({ state: null }))}
          {address.kind && chip('kind', t(`materialKind.${address.kind}`), () => choose({ kind: null }))}
          {address.q.trim() !== '' && chip('q', `“${address.q.trim()}”`, () => choose({ q: '' }))}
          <Button size="sm" variant="quiet" onClick={() => choose({ state: null, kind: null, q: '' })}>
            {t('list.clearAll')}
          </Button>
        </span>
      )}
    </>
  )
  const askable = selectedRows.filter((row) => toAsk(row).length > 0)
  const askHeld = !can.ask ? t('held.manage') : !model.online ? t('held.offline') : null
  const evaluateHeld = !can.edit ? t('held.substances') : !model.online ? t('held.offline') : selectedRows.length > EVALUATE_MAX ? t('held.evaluateMax', { max: EVALUATE_MAX }) : model.busy ? q('common.loading') : null
  const bulkActions = (
    <>
      <Button size="sm" heldReason={askHeld} onClick={() => actions?.onAsk?.(selectedRows)} aria-label={t('bulk.ask', { count: selectedRows.length })}>
        <Send size={13} aria-hidden /> <SelectionLabel>{t('bulk.ask', { count: selectedRows.length })}</SelectionLabel>
      </Button>
      <Button size="sm" heldReason={evaluateHeld} onClick={() => actions?.onEvaluate?.(selectedRows)} aria-label={t('bulk.evaluate', { count: selectedRows.length })}>
        <RefreshCw size={13} aria-hidden /> <SelectionLabel>{t('bulk.evaluate', { count: selectedRows.length })}</SelectionLabel>
      </Button>
      <Button size="sm" onClick={() => actions?.onExport?.(selectedRows)} aria-label={t('bulk.export', { count: selectedRows.length })}>
        <Download size={13} aria-hidden /> <SelectionLabel>{t('bulk.export', { count: selectedRows.length })}</SelectionLabel>
      </Button>
    </>
  )
  const moreItems: MenuItemDef[] = [
    { id: 'export', label: t('list.exportView'), onSelect: () => actions?.onExport?.(rows), disabled: rows.length === 0, description: rows.length === 0 ? t('list.exportNothing') : t('list.exportViewHint', { count: rows.length }) },
    { id: 'askMissing', label: t('profile.askMissing'), onSelect: () => actions?.onAsk?.(rows.filter((row) => toAsk(row).length > 0)), disabled: !!askHeld || rows.every((row) => toAsk(row).length === 0), description: askHeld ?? (rows.every((row) => toAsk(row).length === 0) ? t('profile.nothingMissing') : undefined) },
    { id: 'sep', separator: true },
    { id: 'keys', label: t('keys.title'), onSelect: () => actions?.onKeys?.(true) },
  ]
  const state = model.list.problem ? (
    <EmptyState title={t('list.failedTitle')} description={q(model.list.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{q('common.retry')}</Button>} />
  ) : model.list.value !== null && rows.length === 0 ? (
    filtered ? (
      <EmptyState title={t('list.noMatch')} action={<Button size="sm" onClick={() => choose({ state: null, kind: null, q: '' })}>{t('list.clearAll')}</Button>} />
    ) : (
      <EmptyState icon={<Layers size={24} aria-hidden />} title={t('profile.empty.title')} description={t('profile.empty.body')} />
    )
  ) : undefined
  const ownKeys: ListKey[] = [{ keys: ['1', '2', '3', '4'], does: t('keys.views') }]

  return (
    <div className="fw-q fw-mt">
      <PageHead
        intro={t('profile.intro')}
        status={<Freshness asOf={model.asOf} live={model.live} />}
        actions={
          <Button size="sm" heldReason={askHeld ?? (askable.length === 0 && selectedRows.length > 0 ? t('profile.nothingMissing') : null)} onClick={() => actions?.onAsk?.(selectedRows.length > 0 ? selectedRows : [])}>
            {t('ask.open')}
          </Button>
        }
      />
      <NoticeBanner notice={model.notice} namespace={DEPTH_NAMESPACE} onDismiss={actions?.onDismissNotice} />
      {model.frame.tiles.length > 0 && <MetricStrip metrics={[...model.frame.tiles]} />}
      {model.frame.switcher}
      <ListFrame<ProfileRow>
        label={t('profile.table')}
        listKey="compliance.tests.profiles"
        rows={model.list.problem ? [] : model.list.value ? rows : null}
        rowId={(row) => row.material.id}
        columns={columns}
        count={counts ? t('profile.count', { count: rows.length, total: counts.materials }) : t('profile.countPlain', { count: rows.length })}
        search={<Input size="sm" type="search" leadingIcon={<Search size={14} aria-hidden />} aria-label={t('profile.search')} placeholder={t('profile.search')} value={address.q} onChange={(event) => choose({ q: event.target.value })} />}
        tools={tools}
        right={<Menu align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': t('list.more') }} items={moreItems} />}
        selection={{ selected: model.selected, onChange: (ids) => actions?.onSelect?.(ids), actions: bulkActions }}
        updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
        more={model.list.value?.more ? { label: t('list.showMore', { count: 50 }), onMore: () => undefined, held: t('held.listMax', { max: 500 }) } : null}
        keys={ownKeys}
        onHelp={() => actions?.onKeys?.(true)}
        onOpen={(row) => actions?.onOpen?.(row)}
        state={state}
        focusRow={model.focusRow}
      />
      <ShortcutsDialog open={model.keysOpen} onClose={() => actions?.onKeys?.(false)} keys={listKeys(ownKeys, true).map((entry) => ({ keys: entry.keys, does: lists(entry.does) }))} />
    </div>
  )
}
