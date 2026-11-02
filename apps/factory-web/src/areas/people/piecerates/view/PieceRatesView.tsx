'use client'

import { useEffect, useMemo } from 'react'
import { MoreHorizontal, ShieldOff } from 'lucide-react'
import { EmptyState, Menu, MetricStrip } from '@nexus/ui/components'
import type { ColDef, ICellRendererParams } from '@nexus/ui/grid'
import { Button, Pill } from '@nexus/ui/primitives'
import { useLocale } from '../../../../lib/i18n/provider'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { isListKey } from '../../../../list-frame/model'
import { ScopeSiteChip } from '../../../../shell/scope/view/ScopeSiteChip'
import { KeysModal, LiveLine, PeoplePrivacyNote } from '../../_shared/parts'
import type { OverviewSite } from '../api'
import { dayText, everOnRow, monthText, runTarget } from '../model'
import type { PieceActions, PieceModel } from '../view-model'
import { GateDialogs } from './GateDialogs'
import { GateSection } from './GateSection'
import { HeldSection } from './HeldSection'
import { LedgerSection } from './LedgerSection'
import { PayDialogs } from './PayDialogs'
import { PeriodsSection } from './PeriodsSection'
import { PieceMessages, PieceNotice, ReadBlock, Section, usePieceWords } from './parts'
import { RateDialogs } from './RateDialogs'
import { RatesSection } from './RatesSection'
import { SchemeSection } from './SchemeSection'

/**
 * SCR-158 — People › Piece rates: the band (the switch's state, Publish rates, Run <month> pay period, ⋯), what this page shows
 * and to whom, the legal switch FIRST, the tiles, the rate table, the scheme and, only once piece pay has been on here, pay
 * periods, the earnings ledger and held scans. Rates and the scheme stay reachable with the switch off: they are two of its
 * preconditions, and neither says anything about a person. A list names nobody (Owner answer W1).
 */
export function PieceRatesView({ model, actions }: { model: PieceModel; actions?: PieceActions }) {
  return (
    <PieceMessages>
      <Page model={model} actions={actions} />
    </PieceMessages>
  )
}

function Page({ model, actions }: { model: PieceModel; actions?: PieceActions | undefined }) {
  const t = usePieceWords()
  const locale = useLocale()
  const { can, gate } = model

  // n new rate version, p publish rates (a list's own keys stay the list's).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isListKey(event, event.target as HTMLElement | null) || model.dialog || model.version || model.period || model.statement) return
      if (event.key === 'n' && can.manage && model.siteId) actions?.onNewVersion()
      else if (event.key === 'p' && can.manage && model.siteId) actions?.onPublish()
      else return
      event.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const siteName = model.scope.site?.name ?? model.scope.sites[0]?.name ?? ''
  const gateValue = gate?.status === 'ready' ? gate.value : null
  const periods = model.periods?.status === 'ready' ? model.periods.value : null
  const target = useMemo(() => (periods ? runTarget(periods, model.today) : null), [periods, model.today])
  // "Nothing yet" is said only once the switch is read: a read in progress is not a site where piece pay never ran.
  const known = model.siteId ? gate?.status === 'ready' : model.overview.status === 'ready'
  const jump = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })

  if (!can.view) {
    return <EmptyState icon={<ShieldOff size={22} aria-hidden />} title={t('noAccess.title')} description={t('noAccess.body', { permission: 'people.piecerates.view' })} />
  }

  const more = [
    ...(can.manage && model.siteId ? [{ id: 'new', label: t('band.newVersion'), onSelect: () => actions?.onNewVersion() }] : []),
    { id: 'scheme', label: t('band.schemeSettings'), onSelect: () => jump('scheme') },
    { id: 'simulate', label: t('band.simulate'), disabled: true },
    ...(model.ledger ? [{ id: 'export', label: t('band.exportEarnings'), onSelect: () => jump('ledger') }] : []),
    ...(model.siteId ? [{ id: 'sheet', label: t('band.printSheet'), href: `${model.prefix}/people/piecerates/rate-sheet?site=${encodeURIComponent(model.siteId)}`, target: '_blank' as const }] : []),
    { id: 'keys', label: t('band.keys'), onSelect: () => actions?.onHelp(true) },
  ]

  const status = !gateValue ? null : gateValue.state === 'ON' ? (
    <Pill tone="success" dot>
      {t('band.on', { day: dayText(gateValue.onFrom, locale) ?? '' })}
    </Pill>
  ) : (
    <Pill tone="neutral" dot>
      {t('band.off', { site: siteName })}
    </Pill>
  )

  return (
    <div className="fw-pp">
      <div className="fw-pp-head">
        <span className="fw-pr8-row">
          {status}
          <ScopeSiteChip model={model.scope} />
          <LiveLine asOf={model.asOf} live={model.live} />
        </span>
        <span className="fw-pp-actions">
          {can.manage && model.siteId && (
            <Button size="sm" variant="secondary" onClick={() => actions?.onPublish()}>
              {t('band.publish')}
            </Button>
          )}
          {can.managePay && target && (
            <Button size="sm" variant="primary" heldReason={model.busyRun ? t('common.working') : null} onClick={() => actions?.onRunBand()}>
              {t('band.run', { month: monthText(target.month, locale) })}
            </Button>
          )}
          <Menu label={<MoreHorizontal size={16} aria-hidden />} align="right" triggerProps={{ 'aria-label': t('band.more') }} items={more} />
        </span>
      </div>
      <PeoplePrivacyNote sight={model.sight} level={model.ever ? 'individual' : 'line'} text={t(model.ever ? 'privacy.on' : 'privacy.off')} />
      <PieceNotice notice={model.notice} onDismiss={actions?.onDismissNotice} />

      {!model.siteId ? <SitesSection model={model} actions={actions} /> : <GateSection model={model} actions={actions} />}
      <Tiles model={model} actions={actions} onJump={jump} />
      {model.siteId && <RatesSection model={model} actions={actions} />}
      <SchemeSection model={model} actions={actions} />
      {model.ever ? (
        <>
          {model.periods && <PeriodsSection model={model} actions={actions} />}
          <LedgerSection model={model} actions={actions} />
          {model.held && <HeldSection model={model} actions={actions} />}
        </>
      ) : known ? (
        <p className="fw-pr8-hint">{t('later.body')}</p>
      ) : null}

      <GateDialogs model={model} actions={actions} />
      <RateDialogs model={model} actions={actions} />
      <PayDialogs model={model} actions={actions} />
      {model.help && <KeysModal own={[{ keys: ['n'], does: t('keys.new') }, { keys: ['p'], does: t('keys.publish') }, { keys: ['j', 'k'], does: t('keys.statement') }, { keys: ['a'], does: t('keys.approve') }]} onClose={() => actions?.onHelp(false)} />}
    </div>
  )
}

/** What needs HR before the period runs. A tile about rates is a saved filter; one about people opens only once they exist. */
function Tiles({ model, actions, onJump }: { model: PieceModel; actions?: PieceActions | undefined; onJump: (id: string) => void }) {
  const t = usePieceWords()
  const overview = model.overview.status === 'ready' ? model.overview.value : null
  if (!overview) return null
  const rows = model.siteId ? overview.sites.filter((row) => row.site.id === model.siteId) : overview.sites
  const sum = (pick: (row: OverviewSite) => number) => rows.reduce((total, row) => total + pick(row), 0)
  const trial = sum((row) => row.tiles.trialEndingSoon + row.tiles.trialEnded)
  const unread = sum((row) => row.tiles.unread)
  const onRates = (tile: 'TRIAL' | 'UNREAD') => {
    actions?.onTile(model.address.tile === tile ? null : tile)
    onJump('rates')
  }
  return (
    <section aria-label={t('tiles.title')}>
      <MetricStrip
        metrics={[
          { label: t('tiles.trial'), value: String(trial), hint: t('tiles.trialHint', { ended: sum((row) => row.tiles.trialEnded) }), ...(model.siteId ? { onClick: () => onRates('TRIAL'), active: model.address.tile === 'TRIAL' } : {}) },
          { label: t('tiles.unread'), value: String(unread), hint: t('tiles.unreadHint'), ...(model.siteId ? { onClick: () => onRates('UNREAD'), active: model.address.tile === 'UNREAD' } : {}) },
          ...(model.ever && model.can.earnings
            ? [
                { label: t('tiles.held'), value: model.counts ? String(model.counts.heldOpen) : '—', hint: t('tiles.heldHint'), onClick: () => onJump('held') },
                { label: t('tiles.disputes'), value: model.counts ? String(model.counts.disputesOpen) : '—', hint: t('tiles.disputesHint'), onClick: () => onJump('periods') },
              ]
            : []),
          ...(model.reviewCount !== null ? [{ label: t('tiles.review'), value: String(model.reviewCount), hint: t(model.built.efficiency ? 'tiles.reviewHint' : 'tiles.reviewLater'), ...(model.built.efficiency ? { href: model.built.efficiency } : {}) }] : []),
        ]}
      />
    </section>
  )
}

/** All sites: each site's switch; the rate table and the gate need one site. */
function SitesSection({ model, actions }: { model: PieceModel; actions?: PieceActions | undefined }) {
  const t = usePieceWords()
  const locale = useLocale()
  const columns = useMemo<ColDef<OverviewSite>[]>(
    () => [
      {
        colId: 'site',
        headerName: t('sites.site'),
        flex: 1,
        minWidth: 200,
        valueGetter: (params) => (params.data ? `${params.data.site.code} · ${params.data.site.name}` : ''),
        cellRenderer: (params: ICellRendererParams<OverviewSite>) =>
          params.data ? (
            <button type="button" className="fw-pp-link" onClick={() => actions?.onSelectSite(params.data!.site.id)}>
              {params.data.site.code} · {params.data.site.name}
            </button>
          ) : null,
      },
      { colId: 'state', headerName: t('sites.state'), width: 240, valueGetter: (params) => (params.data ? (params.data.switch.state === 'ON' ? t('band.on', { day: dayText(params.data.switch.onFrom, locale) ?? '' }) : t(everOnRow(params.data) ? 'sites.stopped' : 'sites.never')) : '') },
      { colId: 'missing', headerName: t('sites.missing'), width: 170, type: 'numericColumn', valueGetter: (params) => (params.data?.switch.state === 'ON' ? '' : (params.data?.switch.missing ?? 0)) },
      { colId: 'drafts', headerName: t('sites.drafts'), width: 130, type: 'numericColumn', valueGetter: (params) => params.data?.tiles.drafts ?? 0 },
      { colId: 'unread', headerName: t('tiles.unread'), width: 200, type: 'numericColumn', valueGetter: (params) => params.data?.tiles.unread ?? 0 },
    ],
    [t, locale, actions],
  )
  return (
    <Section id="gate" title={t('sites.title')} hint={t('sites.hint')}>
      <ReadBlock read={model.overview} onRetry={actions?.onRetry}>
        {(overview) => (
          <ListFrame<OverviewSite>
            listKey={null}
            label={t('sites.title')}
            rows={overview.sites}
            rowId={(row) => row.site.id}
            columns={columns}
            count={t('sites.count', { count: overview.sites.length })}
            onOpen={(row) => actions?.onSelectSite(row.site.id)}
          />
        )}
      </ReadBlock>
    </Section>
  )
}
