'use client'

import { useMemo, useRef } from 'react'
import { Download, FlaskConical, MoreHorizontal, Plus, Power, Search, X } from 'lucide-react'
import { Banner, EmptyState, Menu, MetricStrip, type MenuItemDef } from '@nexus/ui/components'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, FilterChip, Input, Pill, SegmentedControl, Tag } from '@nexus/ui/primitives'
import { SUBSTANCE_LISTS } from '@nexus/factory-domain/compliance/substances/rules'
import { useDsWords } from '../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { listKeys, type ListKey } from '../../../../../list-frame/model'
import { Freshness, NoAccess, NoticeBanner, PageHead } from '../../../../quality/_shared/parts'
import { ShortcutsDialog, useListWords } from '../../view/parts'
import type { Substance, SubstanceRule, TestPlan } from '../api'
import { DEPTH_NAMESPACE, DepthMessages } from '../frame/parts'
import { limitOf, newestOf, PARTS, ruleSwitchHeld, rulesOf, sourceKeys, type Held, type SubstancesAddress, type SubstancesPart } from '../model'
import type { SubstancesViewModel } from '../view-model'
import { SubstanceDialogs, type SubstanceDialogActions } from './dialogs'

export interface SubstancesActions extends SubstanceDialogActions {
  onAddress?: (change: Partial<SubstancesAddress>) => void
  onRetry?: () => void
  onShowUpdates?: () => void
  onSelect?: (ids: readonly string[]) => void
  onExport?: (part: SubstancesPart, ids: readonly string[] | null) => void
  onStarter?: (open: boolean) => void
  onKeys?: (open: boolean) => void
  onDismissNotice?: () => void
}

type Words = (key: string, params?: Record<string, string | number>) => string
const said = (t: Words, reason: Held | null): string | null => (reason ? t(reason.key, reason.params as Record<string, string | number> | undefined) : null)

/**
 * The Substance list (B-W2b-267, SCR-054-substances; design compliance.tests sec:ts-rsl and the ⋯ items "Restricted substance
 * list (W2b)", "Test plan rules (W2b)"): the page's frame, then one part at a time (`?part=`) — Substances (Substance, CAS,
 * Limit, Material scope, Test method, Source, Version; the Candidate List's newest version above it; empty: Load the starter
 * list), Rules (each with its law, what proves it and its switch: an OFF rule says why — CMR and PFAS load off, Owner 11-09 Q5
 * A) and Test plan rules (what each lot must be tested for, how often; New, Edit, Switch, Archive). Each on the ONE list
 * frame with CSV N. Fetches nothing.
 */
export function SubstancesView({ model, actions }: { model: SubstancesViewModel; actions?: SubstancesActions }) {
  return (
    <DepthMessages>
      <Substances model={model} actions={actions} />
    </DepthMessages>
  )
}

function Substances({ model, actions }: { model: SubstancesViewModel; actions?: SubstancesActions }) {
  const t = useT(DEPTH_NAMESPACE)
  const lists = useListWords()
  const can = model.can
  const address = model.address
  if (!can.view) return <NoAccess title={t('noAccess.title')} body={t('noAccess.body')} />
  const part = address.part
  const choose = (change: Partial<SubstancesAddress>) => actions?.onAddress?.(change)
  const manageHeld = !can.manage ? t('held.substances') : !model.online ? t('held.offline') : null
  const ownKeys: ListKey[] = [{ keys: ['1', '2', '3', '4'], does: t('keys.views') }]
  const primary =
    part === 'plans' ? (
      <Button size="sm" variant="primary" heldReason={manageHeld} onClick={() => choose({ plan: 'new' })}>
        <Plus size={14} aria-hidden /> {t('plan.new')}
      </Button>
    ) : part === 'substances' ? (
      <Button size="sm" heldReason={manageHeld} onClick={() => choose({ version: true })}>
        {t('version.new')}
      </Button>
    ) : null
  return (
    <div className="fw-q fw-mt">
      <PageHead intro={t(`rsl.intro.${part}`)} status={<Freshness asOf={model.asOf} live={model.live} />} actions={primary} />
      <NoticeBanner notice={model.notice} namespace={DEPTH_NAMESPACE} onDismiss={actions?.onDismissNotice} />
      {model.frame.tiles.length > 0 && <MetricStrip metrics={[...model.frame.tiles]} />}
      {model.frame.switcher}
      <div className="fw-mt-parts">
        <SegmentedControl ariaLabel={t('rsl.parts')} options={PARTS.map((value) => ({ value, label: t(`rsl.part.${value}`) }))} value={part} onChange={(value) => choose({ part: value as SubstancesPart, switchId: null, plan: null, q: '', list: null })} />
      </div>
      {part === 'substances' && <SubstancesPartView model={model} actions={actions} ownKeys={ownKeys} />}
      {part === 'rules' && <RulesPartView model={model} actions={actions} ownKeys={ownKeys} />}
      {part === 'plans' && <PlansPartView model={model} actions={actions} ownKeys={ownKeys} />}
      <SubstanceDialogs model={model} actions={actions} />
      <ShortcutsDialog open={model.keysOpen} onClose={() => actions?.onKeys?.(false)} keys={listKeys(ownKeys, true).map((entry) => ({ keys: entry.keys, does: lists(entry.does) }))} />
    </div>
  )
}

type PartProps = { model: SubstancesViewModel; actions?: SubstancesActions; ownKeys: ListKey[] }

function useBulk(model: SubstancesViewModel, actions: SubstancesActions | undefined, part: SubstancesPart) {
  const t = useT(DEPTH_NAMESPACE)
  return (
    <Button size="sm" onClick={() => actions?.onExport?.(part, model.selected)} aria-label={t('bulk.export', { count: model.selected.length })}>
      <Download size={13} aria-hidden /> <SelectionLabel>{t('bulk.export', { count: model.selected.length })}</SelectionLabel>
    </Button>
  )
}

function failedState(t: Words, q: Words, problem: string, onRetry?: () => void) {
  return <EmptyState title={t('list.failedTitle')} description={q(problem)} action={<Button size="sm" onClick={() => onRetry?.()}>{q('common.retry')}</Button>} />
}

function SubstancesPartView({ model, actions, ownKeys }: PartProps) {
  const t = useT(DEPTH_NAMESPACE)
  const q = useT('quality')
  const locale = useLocale()
  const address = model.address
  const rows = useMemo(() => model.substances.value?.substances ?? [], [model.substances.value])
  const bulk = useBulk(model, actions, 'substances')
  const choose = (change: Partial<SubstancesAddress>) => actions?.onAddress?.(change)
  const columns = useMemo<ColDef<Substance>[]>(() => {
    const NameCell = ({ data }: ICellRendererParams<Substance>) =>
      data ? (
        <span className="fw-q-cell">
          <span className="fw-q-name">{data.nameI18n[locale] ?? data.name}</span>
          {data.groupCode && <span className="fw-q-hint">{t('rsl.group', { group: data.groupCode })}</span>}
          {data.status === 'ARCHIVED' && <Tag tone="neutral">{t('rsl.archived')}</Tag>}
        </span>
      ) : null
    const CasCell = ({ data }: ICellRendererParams<Substance>) =>
      data ? (
        <span className="fw-q-cell">
          <span className="fw-q-code">{data.casNumber ?? '—'}</span>
          {data.ecNumber && <span className="fw-q-hint">{t('rsl.ec', { ec: data.ecNumber })}</span>}
        </span>
      ) : null
    const LimitCell = ({ data }: ICellRendererParams<Substance>) =>
      data ? (
        <span className="fw-q-cell">
          {rulesOf(data).length === 0 && <span className="fw-q-hint">{t('rsl.noRule')}</span>}
          {rulesOf(data).map((rule) => {
            const limit = limitOf(rule, locale)
            return (
              <span key={rule.id} className="fw-q-cell-row">
                <span>{t(limit.key, limit.params)}</span>
                <span className="fw-q-hint">{rule.key}</span>
                {!rule.switchedOn && <Tag tone="neutral">{t('switch.off')}</Tag>}
              </span>
            )
          })}
        </span>
      ) : null
    const SourceCell = ({ data }: ICellRendererParams<Substance>) => (data ? <span>{sourceKeys(data).map((source) => t(source.key, source.params)).join(' · ') || '—'}</span> : null)
    const column = (colId: string, header: string, cellRenderer: ColDef<Substance>['cellRenderer'], size: { flex?: number; minWidth?: number; width?: number }): ColDef<Substance> => ({ colId, headerName: header, cellRenderer, sortable: false, ...size })
    return [
      column('substance', t('rsl.col.substance'), NameCell, { flex: 2, minWidth: 200 }),
      column('cas', t('rsl.col.cas'), CasCell, { flex: 0.9, minWidth: 120 }),
      column('limit', t('rsl.col.limit'), LimitCell, { flex: 1.8, minWidth: 200 }),
      { colId: 'unit', headerName: t('rsl.col.unit'), sortable: false, flex: 0.7, minWidth: 90, valueGetter: (params) => [...new Set((params.data?.rules ?? []).flatMap((rule) => (rule.limitUnit ? [t(`unit.${rule.limitUnit}`)] : [])))].join(', ') || '—' },
      { colId: 'scope', headerName: t('rsl.col.scope'), sortable: false, flex: 1.3, minWidth: 140, valueGetter: (params) => { const kinds = [...new Set((params.data?.rules ?? []).flatMap((rule) => rule.materialKinds))]; return kinds.length === 0 ? t('rsl.everyMaterial') : kinds.map((kind) => t(`materialKind.${kind}`)).join(', ') } },
      { colId: 'method', headerName: t('rsl.col.method'), sortable: false, flex: 1.2, minWidth: 140, valueGetter: (params) => [...new Set((params.data?.rules ?? []).flatMap((rule) => (rule.testMethod ? [rule.testMethod] : [])))].join('; ') || '—' },
      column('source', t('rsl.col.source'), SourceCell, { flex: 1.4, minWidth: 160 }),
      { colId: 'version', headerName: t('rsl.col.version'), sortable: false, flex: 0.8, minWidth: 110, valueGetter: (params) => (params.data?.svhcListVersion ? formatDate(params.data.svhcListVersion.publishedOn, { locale }) : '—') },
    ]
  }, [t, locale])

  const versions = model.versions.value?.versions ?? []
  const newest = newestOf(versions)
  const filtered = address.list !== null || address.q.trim() !== '' || address.all
  const starterHeld = !model.can.manage ? t('held.substances') : !model.online ? t('held.offline') : null
  const listItems: MenuItemDef[] = [
    { id: 'heading', heading: true, label: t('rsl.listHeading') },
    { id: 'all', label: t('rsl.allLists'), checked: address.list === null, onSelect: () => choose({ list: null }) },
    ...SUBSTANCE_LISTS.map((list) => ({ id: list, label: t(`list.${list}`), checked: address.list === list, onSelect: () => choose({ list }) })),
    { id: 'sep', separator: true },
    { id: 'archived', label: t('rsl.showArchived'), checked: address.all, onSelect: () => choose({ all: !address.all }) },
  ]
  const moreItems: MenuItemDef[] = [
    { id: 'starter', label: t('rsl.starter'), onSelect: () => actions?.onStarter?.(true), disabled: !!starterHeld, description: starterHeld ?? t('rsl.starterHint') },
    model.can.imports ? { id: 'import', label: t('rsl.import'), href: `${model.prefix}/admin/import?importer=compliance.substances`, description: t('rsl.importHint') } : { id: 'import', label: t('rsl.import'), disabled: true, description: t('held.imports') },
    { id: 'export', label: t('list.exportView'), onSelect: () => actions?.onExport?.('substances', null), disabled: rows.length === 0, description: rows.length === 0 ? t('list.exportNothing') : t('list.exportViewHint', { count: rows.length }) },
    { id: 'sep', separator: true },
    { id: 'keys', label: t('keys.title'), onSelect: () => actions?.onKeys?.(true) },
  ]
  const chip = (key: string, label: string, onRemove: () => void) => (
    <FilterChip key={key} pressed onClick={onRemove} aria-label={t('list.removeFilter', { name: label })}>
      {label} <X size={12} aria-hidden />
    </FilterChip>
  )
  const state = model.substances.problem ? (
    failedState(t, q, model.substances.problem, actions?.onRetry)
  ) : model.substances.value !== null && rows.length === 0 ? (
    filtered ? (
      <EmptyState title={t('list.noMatch')} action={<Button size="sm" onClick={() => choose({ list: null, q: '', all: false })}>{t('list.clearAll')}</Button>} />
    ) : (
      <EmptyState icon={<FlaskConical size={24} aria-hidden />} title={t('rsl.empty.title')} description={t('rsl.empty.body')} action={<Button variant="primary" heldReason={starterHeld} onClick={() => actions?.onStarter?.(true)}>{t('rsl.starter')}</Button>} />
    )
  ) : undefined
  return (
    <>
      {model.versions.problem ? (
        <Banner tone="warning" title={t('version.failed')} />
      ) : newest ? (
        <Banner tone="info" title={t('version.newest', { day: formatDate(newest.publishedOn, { locale }), count: newest.entryCount })}>
          {newest.grewBy !== null && newest.grewBy > 0 ? t('version.grew', { count: newest.grewBy }) : t('version.same')}
        </Banner>
      ) : model.versions.value ? (
        <Banner tone="warning" title={t('version.none')} />
      ) : null}
      <ListFrame<Substance>
        label={t('rsl.table')}
        listKey="compliance.tests.substances"
        rows={model.substances.problem ? [] : model.substances.value ? rows : null}
        rowId={(row) => row.id}
        columns={columns}
        count={t('rsl.count', { count: rows.length })}
        search={<Input size="sm" type="search" leadingIcon={<Search size={14} aria-hidden />} aria-label={t('rsl.search')} placeholder={t('rsl.search')} value={address.q} onChange={(event) => choose({ q: event.target.value })} />}
        tools={
          <>
            <Menu label={t('rsl.listMenu', { list: address.list ? t(`list.${address.list}`) : t('rsl.allLists') })} items={listItems} />
            {filtered && (
              <span className="fw-q-chips" aria-label={t('list.activeFilters')}>
                {address.list && chip('list', t(`list.${address.list}`), () => choose({ list: null }))}
                {address.all && chip('all', t('rsl.showArchived'), () => choose({ all: false }))}
                {address.q.trim() !== '' && chip('q', `“${address.q.trim()}”`, () => choose({ q: '' }))}
              </span>
            )}
          </>
        }
        right={<Menu align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': t('list.more') }} items={moreItems} />}
        selection={{ selected: model.selected, onChange: (ids) => actions?.onSelect?.(ids), actions: bulk }}
        updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
        more={model.substances.value?.more ? { label: t('list.showMore', { count: 50 }), onMore: () => undefined, held: t('held.listMax', { max: 2000 }) } : null}
        keys={ownKeys}
        onHelp={() => actions?.onKeys?.(true)}
        state={state}
      />
    </>
  )
}

function RulesPartView({ model, actions, ownKeys }: PartProps) {
  const t = useT(DEPTH_NAMESPACE)
  const q = useT('quality')
  const ds = useDsWords()
  const locale = useLocale()
  const address = model.address
  const rows = useMemo(() => model.rules.value?.rules ?? [], [model.rules.value])
  const bulk = useBulk(model, actions, 'rules')
  const live = useRef({ model, actions })
  live.current = { model, actions }
  const columns = useMemo<ColDef<SubstanceRule>[]>(() => {
    const RuleCell = ({ data }: ICellRendererParams<SubstanceRule>) =>
      data ? (
        <span className="fw-q-cell">
          <span className="fw-q-code">{data.key}</span>
          <span className="fw-q-hint">{t(`ruleCode.${data.code}`)}</span>
        </span>
      ) : null
    const WhatCell = ({ data }: ICellRendererParams<SubstanceRule>) =>
      data ? (
        <span className="fw-q-cell">
          <span>{data.substance ? `${data.substance.name}${data.substance.casNumber ? ` (${data.substance.casNumber})` : ''}` : data.substanceGroup ? t('rules.group', { group: data.substanceGroup, count: data.members }) : '—'}</span>
          {data.customer && <span className="fw-q-hint">{t('rules.brand', { brand: data.customer.name })}</span>}
        </span>
      ) : null
    const LimitCell = ({ data }: ICellRendererParams<SubstanceRule>) => {
      if (!data) return null
      const limit = limitOf(data, locale)
      return <span>{t(limit.key, limit.params)}</span>
    }
    const LawCell = ({ data }: ICellRendererParams<SubstanceRule>) => (data ? <LawRef law={data.legalReference} plain={t(`ruleCodeWhat.${data.code}`)} href={data.legalUrl} labels={ds.lawRef} /> : null)
    const SwitchCell = ({ data }: ICellRendererParams<SubstanceRule>) =>
      data ? (
        <span className="fw-q-cell" title={data.switchedBy && data.switchedAt ? t('switch.by', { name: data.switchedBy.name, day: formatDate(data.switchedAt, { locale }) }) : undefined}>
          <span>
            <Pill tone={data.switchedOn ? 'success' : 'neutral'} dot>{t(data.switchedOn ? 'switch.on' : 'switch.off')}</Pill>
          </span>
          {!data.switchedOn && data.offReason ? (
            <span className="fw-q-hint" title={data.offReason}>{data.offReason}</span>
          ) : data.switchedBy && data.switchedAt ? (
            <span className="fw-q-hint">{t('switch.by', { name: data.switchedBy.name, day: formatDate(data.switchedAt, { locale }) })}</span>
          ) : null}
        </span>
      ) : null
    const ActionsCell = ({ data }: ICellRendererParams<SubstanceRule>) => {
      if (!data) return null
      const { model: now, actions: act } = live.current
      const held = said(t, ruleSwitchHeld(data, now.can, now.online))
      const items: MenuItemDef[] = [held ? { id: 'switch', label: t(data.switchedOn ? 'switch.turnOff' : 'switch.turnOn'), disabled: true, description: held } : { id: 'switch', label: t(data.switchedOn ? 'switch.turnOff' : 'switch.turnOn'), onSelect: () => act?.onAddress?.({ switchId: data.id }) }]
      return <Menu align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': t('rules.menu', { key: data.key }) }} items={items} />
    }
    const column = (colId: string, header: string, cellRenderer: ColDef<SubstanceRule>['cellRenderer'], size: { flex?: number; minWidth?: number; width?: number }): ColDef<SubstanceRule> => ({ colId, headerName: header, cellRenderer, sortable: false, ...size })
    return [
      column('rule', t('rules.col.rule'), RuleCell, { flex: 1.1, minWidth: 140 }),
      column('what', t('rules.col.what'), WhatCell, { flex: 1.6, minWidth: 180 }),
      column('limit', t('rules.col.limit'), LimitCell, { flex: 1.1, minWidth: 140 }),
      { colId: 'scope', headerName: t('rules.col.scope'), sortable: false, flex: 1.3, minWidth: 150, valueGetter: (params) => { const data = params.data; if (!data) return ''; const kinds = data.materialKinds.length === 0 ? t('rsl.everyMaterial') : data.materialKinds.map((kind) => t(`materialKind.${kind}`)).join(', '); return data.marketCodes.length > 0 ? `${kinds} · ${data.marketCodes.join(', ')}` : kinds } },
      { colId: 'proof', headerName: t('rules.col.proof'), sortable: false, flex: 1.1, minWidth: 140, valueGetter: (params) => (params.data ? t(`evidence.${params.data.evidence}`, { test: params.data.test ? t(`test.${params.data.test}`) : '—', kind: t(`kindShort.${params.data.declaration}`) }) : '') },
      column('law', t('rules.col.law'), LawCell, { flex: 1.3, minWidth: 170 }),
      column('switch', t('rules.col.switch'), SwitchCell, { flex: 1.6, minWidth: 180 }),
      { ...column('actions', t('decl.col.actions'), ActionsCell, { width: 72, minWidth: 72 }), suppressHeaderMenuButton: true },
    ]
  }, [t, locale, ds.lawRef])
  const choose = (change: Partial<SubstancesAddress>) => actions?.onAddress?.(change)
  const offRules = rows.filter((rule) => !rule.switchedOn)
  return (
    <>
      {offRules.length > 0 && (
        <Banner tone="info" title={t('rules.offBanner', { count: offRules.length })}>
          {offRules.map((rule) => rule.key).join(', ')}
        </Banner>
      )}
      <ListFrame<SubstanceRule>
        label={t('rules.table')}
        listKey="compliance.tests.rules"
        rows={model.rules.problem ? [] : model.rules.value ? rows : null}
        rowId={(row) => row.id}
        columns={columns}
        count={t('rules.count', { count: rows.length })}
        search={<Input size="sm" type="search" leadingIcon={<Search size={14} aria-hidden />} aria-label={t('rules.search')} placeholder={t('rules.search')} value={address.q} onChange={(event) => choose({ q: event.target.value })} />}
        tools={
          <FilterChip pressed={address.all} onClick={() => choose({ all: !address.all })}>
            {t('rsl.showArchived')}
          </FilterChip>
        }
        right={<Menu align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': t('list.more') }} items={[{ id: 'export', label: t('list.exportView'), onSelect: () => actions?.onExport?.('rules', null), disabled: rows.length === 0 }, { id: 'sep', separator: true }, { id: 'keys', label: t('keys.title'), onSelect: () => actions?.onKeys?.(true) }]} />}
        selection={{ selected: model.selected, onChange: (ids) => actions?.onSelect?.(ids), actions: bulk }}
        updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
        keys={ownKeys}
        onHelp={() => actions?.onKeys?.(true)}
        state={model.rules.problem ? failedState(t, q, model.rules.problem, actions?.onRetry) : model.rules.value && rows.length === 0 ? <EmptyState title={t('rules.empty')} /> : undefined}
      />
    </>
  )
}

function PlansPartView({ model, actions, ownKeys }: PartProps) {
  const t = useT(DEPTH_NAMESPACE)
  const q = useT('quality')
  const address = model.address
  const rows = useMemo(() => model.plans.value?.plans ?? [], [model.plans.value])
  const bulk = useBulk(model, actions, 'plans')
  const live = useRef({ model, actions })
  live.current = { model, actions }
  const columns = useMemo<ColDef<TestPlan>[]>(() => {
    const TestCell = ({ data }: ICellRendererParams<TestPlan>) =>
      data ? (
        <span className="fw-q-cell">
          <span className="fw-q-name">{t(`test.${data.test}`)}</span>
          {data.method && <span className="fw-q-hint">{data.method}</span>}
        </span>
      ) : null
    const WhatCell = ({ data }: ICellRendererParams<TestPlan>) =>
      data ? (
        <span className="fw-q-cell">
          <span>{data.item ? `${data.item.code} · ${data.item.name}` : t('plan.everyKind', { kind: t(`materialKind.${data.itemKind ?? 'LEATHER'}`) })}</span>
          {data.status === 'ARCHIVED' && <Tag tone="neutral">{t('rsl.archived')}</Tag>}
        </span>
      ) : null
    const RuleCell = ({ data }: ICellRendererParams<TestPlan>) =>
      data ? (
        data.substanceRule ? (
          <span className="fw-q-cell">
            <span className="fw-q-code">{data.substanceRule.key}</span>
            {!data.substanceRule.switchedOn && <span className="fw-q-hint">{t('plan.ruleOff')}</span>}
          </span>
        ) : (
          <span className="fw-q-hint">{t('plan.anyRule')}</span>
        )
      ) : null
    const SwitchCell = ({ data }: ICellRendererParams<TestPlan>) =>
      data ? (
        <span className="fw-q-cell">
          <Pill tone={data.switchedOn ? 'success' : 'neutral'} dot>{t(data.switchedOn ? 'switch.on' : 'switch.off')}</Pill>
          {!data.switchedOn && data.offReason && <span className="fw-q-hint" title={data.offReason}>{data.offReason}</span>}
        </span>
      ) : null
    const ActionsCell = ({ data }: ICellRendererParams<TestPlan>) => {
      if (!data) return null
      const { model: now, actions: act } = live.current
      const held = said(t, ruleSwitchHeld({ status: 'ACTIVE' }, now.can, now.online))
      const archivedHeld = data.status !== 'ACTIVE' ? t('held.archived') : null
      const verb = (id: string, label: string, reason: string | null, onSelect: () => void): MenuItemDef => (reason ? { id, label, disabled: true, description: reason } : { id, label, onSelect })
      const items: MenuItemDef[] = [
        verb('edit', t('plan.edit'), held ?? archivedHeld, () => act?.onAddress?.({ plan: data.id })),
        verb('switch', t(data.switchedOn ? 'switch.turnOff' : 'switch.turnOn'), held ?? archivedHeld, () => act?.onAddress?.({ switchId: data.id })),
        verb('archive', t(data.status === 'ACTIVE' ? 'plan.archive' : 'plan.restore'), held, () => act?.onArchivePlan?.(data)),
      ]
      return <Menu align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': t('plan.menu', { test: t(`test.${data.test}`) }) }} items={items} />
    }
    const column = (colId: string, header: string, cellRenderer: ColDef<TestPlan>['cellRenderer'], size: { flex?: number; minWidth?: number; width?: number }): ColDef<TestPlan> => ({ colId, headerName: header, cellRenderer, sortable: false, ...size })
    return [
      column('test', t('plan.col.test'), TestCell, { flex: 1.2, minWidth: 150 }),
      column('what', t('plan.col.what'), WhatCell, { flex: 1.6, minWidth: 180 }),
      { colId: 'frequency', headerName: t('plan.col.frequency'), sortable: false, flex: 1.3, minWidth: 150, valueGetter: (params) => (params.data ? t(`frequency.${params.data.frequency}`) : '') },
      { colId: 'market', headerName: t('plan.col.market'), sortable: false, flex: 0.7, minWidth: 90, valueGetter: (params) => params.data?.marketCode ?? t('plan.everyMarket') },
      column('rule', t('plan.col.rule'), RuleCell, { flex: 1, minWidth: 130 }),
      column('switch', t('rules.col.switch'), SwitchCell, { flex: 1.5, minWidth: 170 }),
      { colId: 'note', headerName: t('plan.col.note'), sortable: false, flex: 1.2, minWidth: 140, valueGetter: (params) => params.data?.note ?? '—' },
      { ...column('actions', t('decl.col.actions'), ActionsCell, { width: 72, minWidth: 72 }), suppressHeaderMenuButton: true },
    ]
  }, [t])
  const choose = (change: Partial<SubstancesAddress>) => actions?.onAddress?.(change)
  const manageHeld = !model.can.manage ? t('held.substances') : !model.online ? t('held.offline') : null
  return (
    <>
      <p className="fw-q-hint">{t('plan.lead')}</p>
      <ListFrame<TestPlan>
        label={t('plan.table')}
        listKey="compliance.tests.plans"
        rows={model.plans.problem ? [] : model.plans.value ? rows : null}
        rowId={(row) => row.id}
        columns={columns}
        count={t('plan.count', { count: rows.length })}
        tools={
          <FilterChip pressed={address.all} onClick={() => choose({ all: !address.all })}>
            {t('rsl.showArchived')}
          </FilterChip>
        }
        right={<Menu align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': t('list.more') }} items={[{ id: 'export', label: t('list.exportView'), onSelect: () => actions?.onExport?.('plans', null), disabled: rows.length === 0 }, { id: 'sep', separator: true }, { id: 'keys', label: t('keys.title'), onSelect: () => actions?.onKeys?.(true) }]} />}
        selection={{ selected: model.selected, onChange: (ids) => actions?.onSelect?.(ids), actions: bulk }}
        updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
        keys={ownKeys}
        onHelp={() => actions?.onKeys?.(true)}
        onOpen={(row) => !manageHeld && row.status === 'ACTIVE' && choose({ plan: row.id })}
        state={
          model.plans.problem ? (
            failedState(t, q, model.plans.problem, actions?.onRetry)
          ) : model.plans.value && rows.length === 0 ? (
            <EmptyState icon={<Power size={24} aria-hidden />} title={t('plan.empty.title')} description={t('plan.empty.body')} action={<Button variant="primary" heldReason={manageHeld} onClick={() => choose({ plan: 'new' })}>{t('plan.new')}</Button>} />
          ) : undefined
        }
      />
    </>
  )
}
