'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { Archive, Download, MoreHorizontal, Plus, RotateCcw, Search } from 'lucide-react'
import { Banner, EmptyState, Field, Menu, type MenuItemDef } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Pill, Select, Spinner, Tag, TokenChip } from '@nexus/ui/primitives'
import { Modal } from '../../../../../lib/i18n/ds-parts'
import { formatTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { listKeys, type ListKey } from '../../../../../list-frame/model'
import type { RuleRow, RuleView } from '../api'
import { depthFiltered, depthSearch, NO_DEPTH_FILTERS, ruleDraftProblems, statusHeld, STATUS_VIEWS, blankRule, type DepthCan, type DepthFilters, type DepthProblem, type RuleDraft, type ScaleSizeRef, type StepRow } from '../model'
import { GradeRuleDialog, type RuleFields } from './GradeRuleDialog'
import { DepthHead, isTypingKey, KeysDialog, ProblemBanner } from './parts'

export type RuleDialog = { kind: 'new' } | { kind: 'status'; to: 'ACTIVE' | 'ARCHIVED'; ids: string[] } | { kind: 'help' }

export interface OpenRule {
  id: string
  rule: { status: 'loading' } | { status: 'ready'; value: RuleView } | { status: 'error'; problem: string }
  busy: boolean
  refused: DepthProblem | null
  /** The garment points a row may be added for (read when the pop-up opens); null not read yet. */
  points: Array<{ id: string; code: string; name: string; uom: 'CM' | 'MM' }> | null
  /** Design cases: the pop-up already changed. */
  preset?: { fields: RuleFields; rows: StepRow[] }
}

export interface RulesViewModel {
  prefix: string
  can: DepthCan
  filters: DepthFilters
  companies: Array<{ id: string; name: string }>
  companyId: string | null
  rows: { items: RuleRow[] | null; more: boolean; count: number | null; problem: string | null }
  /** The size scales (the filter and New grade rule); null not read. */
  scales: Array<{ id: string; code: string; name: string }> | null
  asOf: string | null
  updates: number
  notice: { key: string; tone: 'info' | 'success' | 'warning' | 'danger'; params?: Record<string, string | number> } | null
  busy: boolean
  dialog: RuleDialog | null
  /** New grade rule: the draft's scale sizes (read when a scale is picked), its write state. */
  newRule: { draft?: RuleDraft; sizes: ScaleSizeRef[] | null; busy: boolean; refused: DepthProblem | null } | null
  /** The Grade rule pop-up (`?open=<id>`). */
  open: OpenRule | null
  selected?: string[]
  focusRow?: number
}

export interface RulesActions {
  onFilters?: (filters: DepthFilters) => void
  onRetry?: () => void
  onMore?: () => void
  onShowUpdates?: () => void
  onDialog?: (dialog: RuleDialog | null) => void
  onOpen?: (id: string | null) => void
  onScale?: (scaleId: string) => void
  onCreate?: (draft: RuleDraft) => Promise<boolean>
  onSaveRule?: (rule: RuleView, fields: RuleFields, rows: StepRow[]) => Promise<boolean>
  onReadRule?: () => void
  onStatus?: (ids: string[], to: 'ACTIVE' | 'ARCHIVED') => Promise<boolean>
  onExport?: (ids: string[]) => void
  onDismissNotice?: () => void
}

/**
 * SCR-345 — Sizes & measurements › Grade rules (B-W2b-240; design products.sizes sec:sizes.graderules, PRD-051): the
 * reusable increments per point of measure between the sizes of a scale, on the shared list frame (rule, scale, base
 * size, points, increment format, the specs graded with it, state; Archive N / Restore N / Export N), New grade rule
 * (`c`), and a row opens the Grade rule pop-up (DetailModal, J / K). It draws the view model and fetches nothing.
 */
export function RulesView({ model, actions }: { model: RulesViewModel; actions?: RulesActions }) {
  const t = useT('products-sizes-depth')
  const locale = useLocale()
  const [query, setQuery] = useState(model.filters.q)
  useEffect(() => setQuery(model.filters.q), [model.filters.q])
  const typed = useRef(false)
  const latest = useRef({ model, actions })
  latest.current = { model, actions }
  useEffect(() => {
    if (!typed.current) return
    const timer = setTimeout(() => latest.current.actions?.onFilters?.({ ...latest.current.model.filters, q: query }), 300)
    return () => clearTimeout(timer)
  }, [query])
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  useEffect(() => setSelected(model.selected ?? []), [model.selected])
  const items = model.rows.items
  const rowsKey = items?.map((row) => row.id).join(',') ?? ''
  useEffect(() => setSelected((current) => current.filter((id) => (items ?? []).some((row) => row.id === id))), [rowsKey])
  const manage = model.can.manage
  const [help, setHelp] = useState(false)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isTypingKey(event) || model.dialog || model.open) return
      if (event.key === 'c' && manage) {
        event.preventDefault()
        actions?.onDialog?.({ kind: 'new' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const openHref = (id: string) => `${model.prefix}/products/sizes${depthSearch('rules', model.filters, { open: id })}`
  const columns = useMemo<ColDef<RuleRow>[]>(() => {
    const plain = { sortable: false, suppressHeaderMenuButton: true } as const
    const RuleCell = ({ data }: ICellRendererParams<RuleRow>) =>
      data ? (
        <span className="fw-szd-cell">
          <Link className="fw-szd-rowlink" href={openHref(data.id)} onClick={(event) => {
            event.preventDefault()
            latest.current.actions?.onOpen?.(data.id)
          }}>
            {data.code}
          </Link>
          <span className="fw-szd-sub">{data.name}</span>
        </span>
      ) : null
    const ScaleCell = ({ data }: ICellRendererParams<RuleRow>) =>
      data ? (
        <span className="fw-szd-cell">
          <Link className="fw-szd-link" href={`${latest.current.model.prefix}/products/sizes/${data.scale.id}?tab=graderules`}>
            {data.scale.code}
          </Link>
          <span className="fw-szd-sub">{data.scale.dimensions === 2 ? t('rules.twoDimensions') : data.scale.name}</span>
        </span>
      ) : null
    const PointsCell = ({ data }: ICellRendererParams<RuleRow>) =>
      data ? (
        <span className="fw-szd-cell">
          <span>{t('rules.points', { count: data.points })}</span>
          <span className="fw-szd-sub">{t('rules.steps', { count: data.steps })}</span>
        </span>
      ) : null
    const StatusCell = ({ data }: ICellRendererParams<RuleRow>) => (data ? <Pill tone={data.status === 'ACTIVE' ? 'success' : 'neutral'}>{t(`status.${data.status}`)}</Pill> : null)
    const MoreCell = ({ data }: ICellRendererParams<RuleRow>) => {
      if (!data) return null
      const held = latest.current.model.can.manage ? undefined : t('held.noManage')
      const items: MenuItemDef[] = [
        { id: 'open', label: t('rules.menu.open'), onSelect: () => latest.current.actions?.onOpen?.(data.id) },
        { id: 'tab', label: t('rules.menu.newTab'), href: openHref(data.id), target: '_blank' },
        data.status === 'ACTIVE'
          ? { id: 'archive', label: t('rules.menu.archive'), tone: 'danger', disabled: !!held, description: held, onSelect: () => latest.current.actions?.onDialog?.({ kind: 'status', to: 'ARCHIVED', ids: [data.id] }) }
          : { id: 'restore', label: t('rules.menu.restore'), disabled: !!held, description: held, onSelect: () => latest.current.actions?.onDialog?.({ kind: 'status', to: 'ACTIVE', ids: [data.id] }) },
      ]
      return <Menu label={<MoreHorizontal size={16} aria-hidden />} align="right" triggerProps={{ 'aria-label': t('rules.menu.more', { code: data.code }) }} items={items} />
    }
    return [
      { colId: 'rule', headerName: t('rules.col.rule'), field: 'code', minWidth: 200, flex: 1.4, pinned: 'left', cellRenderer: RuleCell, ...plain, sortable: true },
      { colId: 'scale', headerName: t('rules.col.scale'), minWidth: 170, flex: 1.1, valueGetter: (params) => params.data?.scale.code ?? '', cellRenderer: ScaleCell, ...plain },
      { colId: 'base', headerName: t('rules.col.base'), field: 'baseSize', minWidth: 110, flex: 0.6, ...plain },
      { colId: 'points', headerName: t('rules.col.points'), field: 'points', minWidth: 130, flex: 0.8, cellRenderer: PointsCell, ...plain },
      { colId: 'format', headerName: t('rules.col.format'), field: 'format', minWidth: 140, flex: 0.8, valueFormatter: (params) => (params.value ? t(`format.${params.value}`) : ''), ...plain },
      { colId: 'specs', headerName: t('rules.col.specs'), field: 'specs', minWidth: 130, flex: 0.7, valueFormatter: (params) => t('rules.specs', { count: Number(params.value ?? 0) }), ...plain },
      { colId: 'status', headerName: t('rules.col.status'), field: 'status', minWidth: 110, maxWidth: 130, cellRenderer: StatusCell, ...plain },
      { colId: 'more', headerName: t('rules.col.more'), minWidth: 72, maxWidth: 72, pinned: 'right', suppressMovable: true, cellRenderer: MoreCell, ...plain },
    ]
  }, [t, locale, manage, model.prefix, JSON.stringify(model.filters)])

  const picked = (items ?? []).filter((row) => selected.includes(row.id))
  const archiveHeld = statusHeld(picked, 'ARCHIVED', manage, model.busy)
  const restoreHeld = statusHeld(picked, 'ACTIVE', manage, model.busy)
  const keys: ListKey[] = [
    { keys: ['c'], does: t('rules.keys.new') },
    { keys: ['↵'], does: t('rules.keys.open') },
  ]
  const filtered = depthFiltered(model.filters)
  const scaleName = (id: string | null) => model.scales?.find((scale) => scale.id === id)?.code ?? id ?? ''
  const state =
    model.rows.problem !== null ? (
      <EmptyState
        title={t(model.rows.problem === 'problem.read.forbidden' ? 'rules.forbidden.title' : 'rules.error.title')}
        description={t(model.rows.problem === 'problem.read.forbidden' ? 'rules.forbidden.body' : model.rows.problem)}
        action={
          model.rows.problem === 'problem.read.forbidden' ? undefined : (
            <Button size="sm" onClick={() => actions?.onRetry?.()}>
              {t('common.retry')}
            </Button>
          )
        }
      />
    ) : items && items.length === 0 ? (
      filtered ? (
        <EmptyState
          title={t('rules.filteredEmpty.title')}
          description={t('rules.filteredEmpty.body')}
          action={
            <Button size="sm" onClick={() => actions?.onFilters?.(NO_DEPTH_FILTERS)}>
              {t('common.clearFilters')}
            </Button>
          }
        />
      ) : (
        <EmptyState
          title={t('rules.empty.title')}
          description={t(manage ? 'rules.empty.body' : 'rules.empty.bodyView')}
          action={
            manage ? (
              <Button size="sm" variant="primary" onClick={() => actions?.onDialog?.({ kind: 'new' })}>
                {t('rules.new')}
              </Button>
            ) : undefined
          }
        />
      )
    ) : undefined

  return (
    <div className="fw-szd">
      <DepthHead
        intro={t('rules.intro')}
        status={
          <span className="fw-szd-sub" role="status">
            {model.asOf ? t('common.updated', { time: formatTime(model.asOf, { locale }) }) : t('common.notYet')}
          </span>
        }
        actions={
          <Button size="sm" variant="primary" heldReason={manage ? null : t('held.noManage')} onClick={() => actions?.onDialog?.({ kind: 'new' })} aria-keyshortcuts="c">
            <Plus size={14} aria-hidden /> {t('rules.new')}
          </Button>
        }
      />
      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={t(model.notice.key, model.notice.params)}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
              {t('common.dismiss')}
            </Button>
          }
        />
      )}
      {filtered && (
        <div className="fw-szd-chips" aria-label={t('common.activeFilters')}>
          {model.filters.status !== 'open' && (
            <TokenChip removeLabel={t('common.removeFilter')} onRemove={() => actions?.onFilters?.({ ...model.filters, status: 'open' })}>
              {t(`statusView.${model.filters.status}`)}
            </TokenChip>
          )}
          {model.filters.scaleId && (
            <TokenChip removeLabel={t('common.removeFilter')} onRemove={() => actions?.onFilters?.({ ...model.filters, scaleId: null })}>
              {t('rules.chipScale', { scale: scaleName(model.filters.scaleId) })}
            </TokenChip>
          )}
          {model.filters.q.trim() && (
            <TokenChip removeLabel={t('common.removeFilter')} onRemove={() => actions?.onFilters?.({ ...model.filters, q: '' })}>
              {t('common.chipSearch', { q: model.filters.q.trim() })}
            </TokenChip>
          )}
          <Button size="sm" variant="quiet" onClick={() => actions?.onFilters?.(NO_DEPTH_FILTERS)}>
            {t('common.clearAll')}
          </Button>
        </div>
      )}
      <ListFrame<RuleRow>
        label={t('rules.table')}
        listKey="products.sizes.3"
        rows={state ? [] : items}
        rowId={(row) => row.id}
        columns={columns}
        count={items ? t(model.rows.more ? 'common.countMore' : 'common.count', { count: items.length, total: model.rows.count ?? items.length }) : '—'}
        search={
          <Input
            size="sm"
            type="search"
            leadingIcon={<Search size={13} aria-hidden />}
            aria-label={t('rules.search')}
            placeholder={t('rules.search')}
            value={query}
            onChange={(event) => {
              typed.current = true
              setQuery(event.target.value)
            }}
          />
        }
        tools={
          <>
            <Select size="sm" aria-label={t('rules.scaleFilter')} value={model.filters.scaleId ?? ''} onChange={(event) => actions?.onFilters?.({ ...model.filters, scaleId: event.target.value || null })}>
              <option value="">{t('rules.scaleAll')}</option>
              {model.filters.scaleId && !(model.scales ?? []).some((scale) => scale.id === model.filters.scaleId) && <option value={model.filters.scaleId}>{scaleName(model.filters.scaleId)}</option>}
              {(model.scales ?? []).map((scale) => (
                <option key={scale.id} value={scale.id}>
                  {`${scale.code} · ${scale.name}`}
                </option>
              ))}
            </Select>
            <Select size="sm" aria-label={t('common.statusFilter')} value={model.filters.status} onChange={(event) => actions?.onFilters?.({ ...model.filters, status: event.target.value as DepthFilters['status'] })}>
              {STATUS_VIEWS.map((view) => (
                <option key={view} value={view}>
                  {t(`statusView.${view}`)}
                </option>
              ))}
            </Select>
          </>
        }
        selection={{
          selected,
          onChange: setSelected,
          actions: (
            <>
              <Button size="sm" aria-label={t('rules.bulk.export', { count: picked.length })} onClick={() => actions?.onExport?.(picked.map((row) => row.id))}>
                <Download size={13} aria-hidden /> <SelectionLabel>{t('rules.bulk.export', { count: picked.length })}</SelectionLabel>
              </Button>
              <Button size="sm" aria-label={t('rules.bulk.restore', { count: picked.length })} heldReason={restoreHeld ? t(restoreHeld) : null} onClick={() => actions?.onDialog?.({ kind: 'status', to: 'ACTIVE', ids: picked.map((row) => row.id) })}>
                <RotateCcw size={13} aria-hidden /> <SelectionLabel>{t('rules.bulk.restore', { count: picked.length })}</SelectionLabel>
              </Button>
              <Button size="sm" variant="danger-outline" aria-label={t('rules.bulk.archive', { count: picked.length })} heldReason={archiveHeld ? t(archiveHeld) : null} onClick={() => actions?.onDialog?.({ kind: 'status', to: 'ARCHIVED', ids: picked.map((row) => row.id) })}>
                <Archive size={13} aria-hidden /> <SelectionLabel>{t('rules.bulk.archive', { count: picked.length })}</SelectionLabel>
              </Button>
            </>
          ),
        }}
        updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
        more={model.rows.more && items && items.length > 0 ? { label: t('common.more'), onMore: () => actions?.onMore?.() } : null}
        keys={keys}
        onHelp={() => setHelp(true)}
        onOpen={(row) => actions?.onOpen?.(row.id)}
        state={state}
        focusRow={model.focusRow}
      />
      {model.dialog?.kind === 'new' && <NewRuleDialog model={model} actions={actions} />}
      {model.dialog?.kind === 'status' && <StatusDialog rows={(items ?? []).filter((row) => (model.dialog as { ids: string[] }).ids.includes(row.id))} to={model.dialog.to} busy={model.busy} actions={actions} onDone={() => setSelected([])} />}
      {model.open && <GradeRuleDialog open={model.open} ids={(items ?? []).map((row) => row.id)} can={model.can} actions={actions} />}
      {(help || model.dialog?.kind === 'help') && (
        <KeysDialog
          keys={listKeys(keys, true)}
          onClose={() => {
            setHelp(false)
            if (model.dialog?.kind === 'help') actions?.onDialog?.(null)
          }}
        />
      )}
    </div>
  )
}

function StatusDialog({ rows, to, busy, actions, onDone }: { rows: readonly RuleRow[]; to: 'ACTIVE' | 'ARCHIVED'; busy: boolean; actions?: RulesActions; onDone: () => void }) {
  const t = useT('products-sizes-depth')
  const close = () => actions?.onDialog?.(null)
  return (
    <Modal
      open
      onClose={close}
      size="md"
      title={t(to === 'ARCHIVED' ? 'rules.status.archiveTitle' : 'rules.status.restoreTitle', { count: rows.length })}
      footer={
        <>
          <Button onClick={close}>{t('common.back')}</Button>
          <Button
            variant={to === 'ARCHIVED' ? 'danger' : 'primary'}
            heldReason={busy ? t('held.busy') : null}
            onClick={() =>
              void actions?.onStatus?.(
                rows.map((row) => row.id),
                to,
              ).then((done) => done && onDone())
            }
          >
            {t(to === 'ARCHIVED' ? 'rules.bulk.archive' : 'rules.bulk.restore', { count: rows.length })}
          </Button>
        </>
      }
    >
      <div className="fw-szd-dialog">
        <p className="fw-szd-sub">{t(to === 'ARCHIVED' ? 'rules.status.archiveBody' : 'rules.status.restoreBody')}</p>
        <ul className="fw-szd-list">
          {rows.map((row) => (
            <li key={row.id}>
              <b>{row.code}</b> · {row.name} — {t('rules.specs', { count: row.specs })}
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  )
}

/** New grade rule (design "New grade rule"): code, name, the scale, its base size, how increments count; then the pop-up. */
function NewRuleDialog({ model, actions }: { model: RulesViewModel; actions?: RulesActions }) {
  const t = useT('products-sizes-depth')
  const [draft, setDraft] = useState<RuleDraft>(() => model.newRule?.draft ?? blankRule(model.companyId, model.filters.scaleId))
  const set = (patch: Partial<RuleDraft>) => setDraft((current) => ({ ...current, ...patch }))
  const sizes = model.newRule?.sizes ?? null
  const codes = sizes?.filter((size) => size.status !== 'ARCHIVED').map((size) => size.code) ?? null
  const problems = ruleDraftProblems(draft, codes)
  const first = Object.values(problems)[0]
  const busy = model.newRule?.busy ?? false
  const refused = model.newRule?.refused ?? null
  const held = !model.can.manage ? t('held.noManage') : first ? t(first) : busy ? t('held.busy') : null
  const close = () => actions?.onDialog?.(null)
  const create = () => {
    if (!held) void actions?.onCreate?.(draft)
  }
  useEffect(() => {
    if (draft.scaleId) actions?.onScale?.(draft.scaleId)
  }, [draft.scaleId])
  useEffect(() => {
    if (codes && codes.length > 0 && !codes.includes(draft.baseSize)) set({ baseSize: codes[Math.floor((codes.length - 1) / 2)] ?? '' })
  }, [codes?.join(',')])
  const refusedAt = (field: string) => (refused?.paths.some((path) => path === field || path.startsWith(`${field}/`)) ? t('rules.problem.refusedField') : undefined)
  return (
    <Modal
      open
      onClose={close}
      size="md"
      title={t('rules.newTitle')}
      footer={
        <>
          <Button onClick={close}>{t('common.back')}</Button>
          <Button variant="primary" heldReason={held} onClick={create} aria-keyshortcuts="Meta+Enter Control+Enter">
            {t('rules.create')}
          </Button>
        </>
      }
    >
      <div
        className="fw-szd-dialog"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            create()
          }
        }}
      >
        <p className="fw-szd-sub">{t('rules.newIntro')}</p>
        {refused && <ProblemBanner problem={refused} />}
        <div className="fw-szd-form">
          {model.companies.length > 1 && (
            <Field label={t('poms.field.company')} hint={t('rules.companyHint')}>
              <Select value={draft.companyId ?? ''} onChange={(event) => set({ companyId: event.target.value || null })}>
                <option value="">{t('common.everyCompany')}</option>
                {model.companies.map((company) => (
                  <option key={company.id} value={company.id}>
                    {company.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label={t('rules.field.code')} required hint={t('rules.field.codeHint')} error={(draft.code && problems.code ? t(problems.code) : undefined) ?? refusedAt('code')}>
            <Input value={draft.code} maxLength={60} autoFocus onChange={(event) => set({ code: event.target.value.toUpperCase() })} />
          </Field>
          <Field label={t('rules.field.name')} required error={refusedAt('name')}>
            <Input value={draft.name} maxLength={200} onChange={(event) => set({ name: event.target.value })} />
          </Field>
          <Field label={t('rules.field.scale')} required error={refusedAt('sizeScaleId')}>
            <Select value={draft.scaleId} onChange={(event) => set({ scaleId: event.target.value, baseSize: '' })}>
              <option value="">{model.scales === null ? t('common.reading') : t('rules.field.scalePick')}</option>
              {(model.scales ?? []).map((scale) => (
                <option key={scale.id} value={scale.id}>
                  {`${scale.code} · ${scale.name}`}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('rules.field.base')} required hint={t('rules.field.baseHint')} error={refusedAt('baseSize')}>
            <Select value={draft.baseSize} disabled={!codes} onChange={(event) => set({ baseSize: event.target.value })}>
              {!codes && <option value="">{draft.scaleId ? t('common.reading') : t('rules.field.scaleFirst')}</option>}
              {(codes ?? []).map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </Select>
          </Field>
          <div className="fw-szd-span">
            <Field label={t('rules.field.format')} hint={t(`format.hint.${draft.format}`)}>
              <Select value={draft.format} onChange={(event) => set({ format: event.target.value as RuleDraft['format'] })}>
                <option value="RELATIVE">{t('format.RELATIVE')}</option>
                <option value="ABSOLUTE">{t('format.ABSOLUTE')}</option>
              </Select>
            </Field>
          </div>
        </div>
        {busy && (
          <p className="fw-szd-sub" role="status">
            <Spinner size={12} /> {t('common.working')}
          </p>
        )}
        <Tag tone="neutral">{t('rules.newAfter')}</Tag>
      </div>
    </Modal>
  )
}
