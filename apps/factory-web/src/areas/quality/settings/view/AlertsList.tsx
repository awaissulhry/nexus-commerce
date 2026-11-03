'use client'

import { useMemo, useRef, type ReactNode } from 'react'
import { BellRing, MoreHorizontal, Plus, Power, PowerOff, Sparkles, Trash2 } from 'lucide-react'
import { Banner, Card, EmptyState, Menu, type MenuItemDef } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Pill, Toggle } from '@nexus/ui/primitives'
import { EVENT_FACTS } from '@nexus/factory-domain/quality/rules/alerts'
import { formatDateTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../list-frame/model'
import type { AlertRule } from '../api'
import { bulkHeld } from '../model'
import type { RulesModel } from './RulesView'

export interface AlertsActions {
  onSelect?: (ids: readonly string[]) => void
  /** `new` or a rule's id: the rule dialog (`?rule=`). */
  onRuleOpen?: (id: string) => void
  onRuleEnabled?: (rule: AlertRule, enabled: boolean) => void
  onRuleTest?: (rule: AlertRule) => void
  onRuleRemove?: (ids: readonly string[]) => void
  onBulkEnabled?: (enabled: boolean) => void
  onStarter?: () => void
  onRetryAlerts?: () => void
  onKeys?: () => void
}

/**
 * Alerts and escalation (design qs-alerts "Who gets what and how fast"; QHS-154) in the ONE list frame: each rule as its
 * sentence (when · who · how fast · how), whose (every company, or a company: a company's own rules of an event replace
 * every company's there, said on the row), when it last fired and how often in 7 days, its switch; ⋯ Edit · Test (send to
 * me) · Remove. Selected: Switch on N · Switch off N · Remove N. Add rule, and the design's rules when some are missing. A
 * person who may not keep rules reads them; every change is held with its reason. Fetches nothing.
 */
export function AlertsList({ model, actions }: { model: RulesModel; actions?: AlertsActions }) {
  const t = useT('quality-rules')
  const locale = useLocale()
  const alerts = model.alerts.value
  const mayManage = (alerts?.mayManage ?? false) && model.live !== 'offline'
  const heldManage = !alerts ? 'held.reading' : !alerts.mayManage ? 'held.noAlertRight' : model.live === 'offline' ? 'held.offline' : null
  const latest = useRef({ actions, mayManage, heldManage })
  latest.current = { actions, mayManage, heldManage }
  const rows = alerts?.rules ?? null

  const columns = useMemo<ColDef<AlertRule>[]>(() => {
    const SentenceCell = ({ data }: ICellRendererParams<AlertRule>) =>
      data ? (
        <span className="fw-qr-cell">
          <button type="button" className="fw-qr-link" onClick={() => latest.current.actions?.onRuleOpen?.(data.id)}>
            {locale === 'it' ? data.sentence.it : data.sentence.en}
          </button>
          {EVENT_FACTS[data.event].timing === 'ESCALATION' && <span className="fw-qr-sub">{t('alerts.capaNote')}</span>}
        </span>
      ) : null
    const WhereCell = ({ data }: ICellRendererParams<AlertRule>) =>
      data ? (
        <span className="fw-qr-cell">
          <span>{data.company ? `${data.company.code} · ${data.company.name}` : t('alerts.everyCompany')}</span>
          {!data.inForce && <span className="fw-qr-sub">{t('alerts.shadowed')}</span>}
        </span>
      ) : null
    const FiredCell = ({ data }: ICellRendererParams<AlertRule>) =>
      data ? (
        <span className="fw-qr-cell">
          <span>{data.lastFiredAt ? formatDateTime(data.lastFiredAt, { locale }) : t('alerts.neverFired')}</span>
          <span className="fw-qr-sub">{t('alerts.fired7d', { count: data.fired7d })}</span>
        </span>
      ) : null
    const OnCell = ({ data }: ICellRendererParams<AlertRule>) => {
      if (!data) return null
      const held = latest.current.heldManage
      return (
        <span className="fw-qr-row">
          <Toggle size="xs" checked={data.enabled} disabled={!!held} title={held ? t(held) : undefined} aria-label={t(data.enabled ? 'alerts.switchOffOf' : 'alerts.switchOnOf', { rule: t(`event.${data.event}`) })} onChange={(next) => latest.current.actions?.onRuleEnabled?.(data, next)} />
          {data.enabled ? <span>{t('alerts.on')}</span> : <Pill tone="neutral">{t('alerts.off')}</Pill>}
        </span>
      )
    }
    const ActionsCell = ({ data }: ICellRendererParams<AlertRule>) => {
      if (!data) return null
      const held = latest.current.heldManage
      const items: MenuItemDef[] = [
        { id: 'open', label: t(held ? 'row.view' : 'row.edit'), onSelect: () => latest.current.actions?.onRuleOpen?.(data.id) },
        { id: 'test', label: t('row.test'), disabled: !!held, description: held ? t(held) : t('row.testHint'), onSelect: () => latest.current.actions?.onRuleTest?.(data) },
        { id: 'sep', separator: true },
        { id: 'remove', label: t('row.remove'), disabled: !!held, description: held ? t(held) : undefined, onSelect: () => latest.current.actions?.onRuleRemove?.([data.id]) },
      ]
      return <Menu align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': t('row.menu', { rule: t(`event.${data.event}`) }) }} items={items} />
    }
    return [
      { colId: 'event', headerName: t('col.event'), minWidth: 170, flex: 0.9, valueGetter: (params) => (params.data ? t(`event.${params.data.event}`) : ''), cellRenderer: ({ data }: ICellRendererParams<AlertRule>) => (data ? <strong>{t(`event.${data.event}`)}</strong> : null) },
      { colId: 'sentence', headerName: t('col.sentence'), minWidth: 320, flex: 3, cellRenderer: SentenceCell, wrapText: true, autoHeight: true },
      { colId: 'where', headerName: t('col.where'), minWidth: 170, flex: 1, cellRenderer: WhereCell, autoHeight: true },
      { colId: 'fired', headerName: t('col.fired'), minWidth: 170, flex: 1, cellRenderer: FiredCell, autoHeight: true },
      { colId: 'enabled', headerName: t('col.enabled'), minWidth: 130, flex: 0.6, cellRenderer: OnCell },
      { colId: 'actions', headerName: t('col.actions'), width: 72, minWidth: 72, cellRenderer: ActionsCell, suppressHeaderMenuButton: true, sortable: false },
    ]
  }, [t, locale])

  const count = model.selected.length
  const picked = (rows ?? []).filter((rule) => model.selected.includes(rule.id))
  const bulk = (
    <>
      <Button size="sm" heldReason={(() => { const held = bulkHeld(rows ?? [], model.selected, true, mayManage, model.busy !== null); return held ? t(held) : null })()} onClick={() => actions?.onBulkEnabled?.(true)} aria-label={t('bulk.on', { count })}>
        <Power size={13} aria-hidden /> <SelectionLabel>{t('bulk.on', { count })}</SelectionLabel>
      </Button>
      <Button size="sm" heldReason={(() => { const held = bulkHeld(rows ?? [], model.selected, false, mayManage, model.busy !== null); return held ? t(held) : null })()} onClick={() => actions?.onBulkEnabled?.(false)} aria-label={t('bulk.off', { count })}>
        <PowerOff size={13} aria-hidden /> <SelectionLabel>{t('bulk.off', { count })}</SelectionLabel>
      </Button>
      <Button size="sm" heldReason={heldManage ? t(heldManage) : picked.length === 0 ? t('held.pickRows') : null} onClick={() => actions?.onRuleRemove?.(model.selected)} aria-label={t('bulk.remove', { count })}>
        <Trash2 size={13} aria-hidden /> <SelectionLabel>{t('bulk.remove', { count })}</SelectionLabel>
      </Button>
    </>
  )
  const state: ReactNode = model.alerts.problem ? (
    <EmptyState
      title={t('alerts.failed')}
      description={t(model.alerts.problem)}
      action={
        <Button size="sm" onClick={() => actions?.onRetryAlerts?.()}>
          {t('common.retry')}
        </Button>
      }
    />
  ) : alerts && alerts.rules.length === 0 ? (
    <EmptyState
      icon={<BellRing size={22} aria-hidden />}
      title={t('alerts.empty.title')}
      description={t('alerts.empty.body', { count: alerts.starterMissing.length })}
      action={
        <span className="fw-qr-row">
          <Button size="sm" variant="primary" heldReason={heldManage ? t(heldManage) : !alerts.places.everywhere ? t('held.starterAll') : null} onClick={() => actions?.onStarter?.()}>
            <Sparkles size={13} aria-hidden /> {t('starter.add', { count: alerts.starterMissing.length })}
          </Button>
          <Button size="sm" heldReason={heldManage ? t(heldManage) : null} onClick={() => actions?.onRuleOpen?.('new')}>
            {t('alerts.add')}
          </Button>
        </span>
      }
    />
  ) : undefined
  const keys: ListKey[] = [{ keys: ['c'], does: t('keys.add') }]
  return (
    <Card header={t('alerts.title')} description={t('alerts.description')} headingLevel={2} className="fw-qr-card fw-qr-alerts" headerAction={
      <Button size="sm" variant="primary" heldReason={heldManage ? t(heldManage) : null} onClick={() => actions?.onRuleOpen?.('new')}>
        <Plus size={14} aria-hidden /> {t('alerts.add')}
      </Button>
    }>
      <div className="fw-qr-stack">
        {alerts && !alerts.mayManage && <p className="fw-qr-held">{t('held.noAlertRight')}</p>}
        {alerts && alerts.starterMissing.length > 0 && alerts.rules.length > 0 && (
          <Banner
            tone="info"
            title={t('starter.title', { count: alerts.starterMissing.length })}
            action={
              <Button size="sm" heldReason={heldManage ? t(heldManage) : !alerts.places.everywhere ? t('held.starterAll') : model.busy ? t('held.busy') : null} onClick={() => actions?.onStarter?.()}>
                <Sparkles size={13} aria-hidden /> {t('starter.add', { count: alerts.starterMissing.length })}
              </Button>
            }
          >
            {alerts.starterMissing.map((event) => t(`event.${event}`)).join(' · ')}
          </Banner>
        )}
        <ListFrame<AlertRule>
          label={t('alerts.table')}
          title={t('alerts.title')}
          listKey={null}
          rows={model.alerts.problem ? [] : rows}
          rowId={(row) => row.id}
          columns={columns}
          count={!alerts ? t('common.loading') : t('alerts.count', { count: alerts.rules.length })}
          selection={{ selected: model.selected, onChange: (ids) => actions?.onSelect?.(ids), actions: bulk }}
          keys={keys}
          onHelp={() => actions?.onKeys?.()}
          onOpen={(row) => actions?.onRuleOpen?.(row.id)}
          state={state}
        />
        <p className="fw-qr-hint">{t('alerts.howTold')}</p>
      </div>
    </Card>
  )
}
