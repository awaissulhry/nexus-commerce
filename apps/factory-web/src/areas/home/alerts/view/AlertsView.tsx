'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { AlertOctagon, AlertTriangle, BellRing, CheckCheck, ExternalLink, Info, ListChecks, MoreHorizontal } from 'lucide-react'
import { Banner, EmptyState, Menu, MetricStrip, type Metric } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, InfoTip, Input, Select, Tag } from '@nexus/ui/primitives'
import { AsOf, Modal } from '../../../../lib/i18n/ds-parts'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { isListKey, listKeys } from '../../../../list-frame/model'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { RULE_KINDS, type AlertSeverity, type RuleKind } from '@nexus/factory-domain/alerts/kinds'
import type { AlertRule } from '../../../_shared/rules/api'
import type { RuleDraft } from '../../../_shared/rules/model'
import { RuleDialog } from '../../../_shared/rules/view/RuleDialog'
import { actionHeld, ageWords, alertSentence, alertsKeys, assigneeWords, bulkRows, filtered, kindWords, selectHeld, SEVERITY_ORDER, stateWords, TILES, tileValue, type AlertRow, type AlertsControls, type AlertsViewModel } from '../model'
import { AlertPopup, AlertsDialogs } from './AlertPopup'
import { RulesSection } from './RulesSection'
import '../alerts.css'

export type { AlertsViewModel } from '../model'

/** What a control asks to open (the container turns it into an AlertsDialog with its data). */
export type AlertsDialogRequest = { readonly kind: 'assign'; readonly id: string } | { readonly kind: 'resolve'; readonly id: string } | { readonly kind: 'snooze'; readonly id: string } | { readonly kind: 'help' }

/** What the page asks of its container (Alerts.tsx). Absent in the design index: the view keeps its own state. */
export interface AlertsActions {
  onControls?: (next: Partial<AlertsControls>) => void
  onSearch?: (q: string) => void
  onMore?: () => void
  onShowUpdates?: () => void
  onSelect?: (ids: string[]) => void
  onOpen?: (id: string | null) => void
  onRetry?: () => void
  onRetryOpen?: () => void
  onRetryPeople?: () => void
  onDialog?: (request: AlertsDialogRequest | null) => void
  onDismissNotice?: () => void
  onAcknowledge?: (id: string) => void
  onBulkAcknowledge?: () => void
  onAssign?: (id: string, assigneeId: string | null) => Promise<boolean>
  onSnooze?: (id: string, until: string) => Promise<boolean>
  onResolve?: (id: string, note: string) => Promise<boolean>
  /** The Rules section: open a rule (or a new one), switch it, change its number in the list. */
  onRule?: (id: string | null) => void
  onRetryRules?: () => void
  onRuleSwitch?: (rule: AlertRule, next: boolean) => void
  onRuleNumber?: (rule: AlertRule, key: string, value: number) => void
  onRuleSave?: (draft: RuleDraft) => Promise<boolean>
  onRuleTest?: (draft: RuleDraft, ruleId: string) => void
  onRetryChoices?: () => void
  onRetryTimers?: () => void
}

const SEVERITY_ICON: Record<AlertSeverity, ReactNode> = {
  CRITICAL: <AlertOctagon size={14} aria-hidden />,
  WARNING: <AlertTriangle size={14} aria-hidden />,
  INFO: <Info size={14} aria-hidden />,
}
export const severityTone = (severity: AlertSeverity): 'danger' | 'warning' | 'info' => (severity === 'CRITICAL' ? 'danger' : severity === 'WARNING' ? 'warning' : 'info')

/**
 * SCR-234 — Home › Insights › Alerts (design home.alerts, W2a; ANA-036): the tiles Open for me · Critical · Unassigned ·
 * Acknowledged · Resolved today (each a filter of the list; pressed again it clears), the open alerts in the ONE list
 * frame — severity in words and icon, the alert in the reader's words (its popup), its record (⌘-click: a new tab while the
 * queue stays), the rule, whose it is, age, state, place — select several for Acknowledge N (all or none); the popup
 * (`?open=`): what and why, the record, its history, similar open alerts, Acknowledge (D) · Assign · Snooze · Resolve with a
 * note, J / K through the list. Then the Rules: each rule as its sentence, its number edited in place, whom it tells and
 * where, how often, last fired, fired in 7 days, on/off — a row opens the rule dialog. It draws ONE view model.
 */
export function AlertsView({ model, actions }: { model: AlertsViewModel; actions?: AlertsActions }) {
  return (
    <WithMessages namespaces={['home-alerts', 'rules', 'lists']}>
      <Alerts model={model} actions={actions} />
    </WithMessages>
  )
}

function Alerts({ model, actions }: { model: AlertsViewModel; actions?: AlertsActions }) {
  const t = useT('home-alerts')
  const r = useT('rules')
  const locale = useLocale()
  // Without a container (the design index) the view keeps its own selection and open row.
  const [ownSelected, setOwnSelected] = useState<readonly string[]>(model.selected)
  const [ownOpen, setOwnOpen] = useState<string | null>(model.open?.id ?? null)
  useEffect(() => setOwnSelected(model.selected), [model.selected])
  useEffect(() => setOwnOpen(model.open?.id ?? null), [model.open?.id])
  const selected = actions?.onSelect ? model.selected : ownSelected
  const setSelected = (ids: string[]) => (actions?.onSelect ? actions.onSelect(ids) : setOwnSelected(ids))
  const openId = actions?.onOpen ? (model.open?.id ?? null) : ownOpen
  const setOpen = (id: string | null) => (actions?.onOpen ? actions.onOpen(id) : setOwnOpen(id))
  const actionsRef = useRef(actions)
  actionsRef.current = actions
  const setOpenRef = useRef(setOpen)
  setOpenRef.current = setOpen

  const list = model.list.status === 'ready' ? model.list.data : null
  const rows = useMemo(() => list?.rows ?? [], [list])
  const held = actionHeld(model)
  const heldText = held ? t(held) : null
  const picked = bulkRows(rows, selected)
  const rulesRef = useRef<HTMLElement | null>(null)

  // d acknowledges the focused row (not in a field, a menu or a dialog).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (model.dialog !== null || openId !== null || model.ruleDialog !== null || !isListKey(event, event.target as HTMLElement | null) || event.key !== 'd') return
      const id = (document.activeElement as HTMLElement | null)?.closest('[row-id]')?.getAttribute('row-id')
      const row = id ? rows.find((entry) => entry.id === id) : undefined
      if (row && row.verbs.includes('ACKNOWLEDGE') && held === null) {
        event.preventDefault()
        actions?.onAcknowledge?.(row.id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const columns = useMemo<ColDef<AlertRow>[]>(() => {
    const SeverityCell = ({ data }: ICellRendererParams<AlertRow>) =>
      data ? (
        <span className={`fw-alerts-severity is-${severityTone(data.severity)}`}>
          {SEVERITY_ICON[data.severity]} {r(`severity.${data.severity}`)}
        </span>
      ) : null
    const AlertCell = ({ data }: ICellRendererParams<AlertRow>) =>
      data ? (
        <span className="fw-alerts-cell">
          <Link
            className="fw-alerts-title"
            href={data.href}
            onClick={(event) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
              event.preventDefault()
              setOpenRef.current(data.id)
            }}
          >
            {alertSentence(data, t, locale)}
          </Link>
          {data.forMe && <span className="fw-alerts-sub">{t('row.forMe')}</span>}
        </span>
      ) : null
    const RecordCell = ({ data }: ICellRendererParams<AlertRow>) =>
      data ? (
        <a className="fw-alerts-record" href={data.recordHref} title={t('row.openRecord', { record: data.record.label })}>
          {data.record.label} <ExternalLink size={12} aria-hidden />
        </a>
      ) : null
    return [
      { colId: 'severity', headerName: t('col.severity'), width: 130, minWidth: 115, valueGetter: (params) => (params.data ? SEVERITY_ORDER.indexOf(params.data.severity) : 0), cellRenderer: SeverityCell },
      { colId: 'alert', headerName: t('col.alert'), flex: 3, minWidth: 250, valueGetter: (params) => (params.data ? alertSentence(params.data, t, locale) : ''), cellRenderer: AlertCell },
      { colId: 'record', headerName: t('col.record'), flex: 1, minWidth: 130, valueGetter: (params) => params.data?.record.label ?? '', cellRenderer: RecordCell },
      { colId: 'rule', headerName: t('col.rule'), flex: 1.3, minWidth: 160, valueGetter: (params) => (params.data ? kindWords(params.data.ruleKind, r) : '') },
      { colId: 'assignee', headerName: t('col.assignee'), flex: 1, minWidth: 115, valueGetter: (params) => (params.data ? assigneeWords(params.data, t) : '') },
      { colId: 'age', headerName: t('col.age'), width: 100, minWidth: 90, valueGetter: (params) => (params.data ? ageWords(params.data.ageDays, t) : '') },
      { colId: 'state', headerName: t('col.state'), flex: 1, minWidth: 125, valueGetter: (params) => (params.data ? stateWords(params.data, t, locale) : '') },
      { colId: 'place', headerName: t('col.place'), flex: 1, minWidth: 125, valueGetter: (params) => (params.data ? (params.data.placeLabel ?? t('place.all')) : '') },
    ]
  }, [t, r, locale])

  if (model.access === 'refused') {
    return (
      <div className="fw-alerts">
        <EmptyState icon={<BellRing size={24} aria-hidden />} title={t('refused.title')} description={t('refused.body')} />
      </div>
    )
  }

  const openTile = list?.tiles.find((tile) => tile.tile === 'OPEN_FOR_ME')
  // ---- the band: when it was read, the live channel, the jump to the rules, ⋯ --------------------------------------------
  const band = (
    <div className="fw-alerts-band" role="group" aria-label={t('band.label')}>
      <div className="fw-alerts-status">
        {list ? <AsOf at={list.asOf} now={model.now} /> : <span className="fw-alerts-muted">{t('band.reading')}</span>}
        {list && !model.controls.tile && !filtered(model.controls) && <Tag tone="neutral">{t(list.complete ? 'band.open' : 'band.openAtLeast', { count: list.total })}</Tag>}
        <Tag tone={model.live === 'live' ? 'success' : model.live === 'offline' ? 'warning' : 'neutral'}>{t(`live.${model.live}`)}</Tag>
      </div>
      <div className="fw-alerts-actions">
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('band.more') }}
          items={[
            { id: 'noise', label: t('band.noise'), disabled: true, description: t('band.noiseLater') },
            { id: 'keys', label: t('band.keys'), onSelect: () => actions?.onDialog?.({ kind: 'help' }) },
          ]}
        />
        <Button variant="secondary" onClick={() => rulesRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
          <ListChecks size={14} aria-hidden /> {t('band.rules')}
        </Button>
      </div>
    </div>
  )

  // ---- tiles: saved filters of the list --------------------------------------------------------------------------------
  const tiles: Metric[] = TILES.map((tile): Metric => {
    const counted = list?.tiles.find((entry) => entry.tile === tile)
    const label = t(`tile.${tile}.label`)
    if (!counted) return { label, value: model.list.status === 'error' ? <span className="fw-alerts-unknown">—<InfoTip tip={t('tile.unknown')} /></span> : '—' }
    const words = tileValue(counted)
    return {
      label,
      value: counted.complete ? t(words.key, { count: words.count }) : <span className="fw-alerts-unknown">{t(words.key, { count: words.count })}<InfoTip tip={t('tile.partial')} /></span>,
      hint: t(`tile.${tile}.hint`),
      onClick: () => actions?.onControls?.({ tile: model.controls.tile === tile ? null : tile, open: null }),
      active: model.controls.tile === tile,
    }
  })

  const tools = (
    <span className="fw-alerts-tools">
      <Select size="sm" value={model.controls.severity ?? ''} aria-label={t('filter.severity')} onChange={(event) => actions?.onControls?.({ severity: (event.target.value || null) as AlertSeverity | null, open: null })}>
        <option value="">{t('filter.anySeverity')}</option>
        {SEVERITY_ORDER.map((severity) => (
          <option key={severity} value={severity}>
            {r(`severity.${severity}`)}
          </option>
        ))}
      </Select>
      <Select size="sm" value={model.controls.kind ?? ''} aria-label={t('filter.kind')} onChange={(event) => actions?.onControls?.({ kind: (event.target.value || null) as RuleKind | null, open: null })}>
        <option value="">{t('filter.anyKind')}</option>
        {RULE_KINDS.map((kind) => (
          <option key={kind} value={kind}>
            {r(`kind.${kind}`)}
          </option>
        ))}
      </Select>
    </span>
  )

  const state: ReactNode =
    model.list.status === 'error' ? (
      <EmptyState title={t('error.title')} description={t(model.list.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('retry')}</Button>} />
    ) : list && rows.length === 0 ? (
      <EmptyState
        icon={<CheckCheck size={24} aria-hidden />}
        title={t(filtered(model.controls) ? 'empty.filtered.title' : 'empty.title')}
        description={t(filtered(model.controls) ? 'empty.filtered.body' : 'empty.body')}
        action={
          filtered(model.controls) ? (
            <Button size="sm" onClick={() => actions?.onControls?.({ tile: null, severity: null, kind: null, q: '', open: null })}>
              {t('empty.clear')}
            </Button>
          ) : undefined
        }
      />
    ) : undefined

  return (
    <div className="fw-alerts">
      {band}
      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={model.notice.key.startsWith('rules:') ? r(model.notice.key.slice(6), model.notice.params) : t(model.notice.key, model.notice.params)}
          action={
            actions?.onDismissNotice ? (
              <Button size="sm" variant="quiet" onClick={actions.onDismissNotice}>
                {t('dismiss')}
              </Button>
            ) : undefined
          }
        />
      )}

      <section className="fw-alerts-section" aria-labelledby="fw-alerts-tiles">
        <h2 id="fw-alerts-tiles" className="fw-alerts-h">
          {t('tile.title')}
          {openTile && openTile.count > 0 && <span className="fw-alerts-muted"> · {t('tile.forMeNow', { count: openTile.count })}</span>}
        </h2>
        <MetricStrip metrics={tiles} minTileWidth={170} />
      </section>

      <section className="fw-alerts-section" aria-labelledby="fw-alerts-open">
        <h2 id="fw-alerts-open" className="fw-alerts-h">
          {t(model.controls.tile ? `tile.${model.controls.tile}.label` : 'table.title')}
        </h2>
        <ListFrame<AlertRow>
          label={t('table.label')}
          title={t('table.title')}
          rows={model.list.status === 'loading' ? null : rows}
          rowId={(row) => row.id}
          columns={columns}
          count={list ? t(list.complete ? 'count' : 'countAtLeast', { count: list.total }) : '—'}
          search={<Input type="search" size="sm" value={model.controls.q} onChange={(event) => actions?.onSearch?.(event.target.value)} placeholder={t('search')} aria-label={t('search')} />}
          tools={tools}
          selection={
            model.can.handle
              ? {
                  selected,
                  onChange: setSelected,
                  actions: (
                    <Button size="sm" variant="primary" aria-label={t('bulk.acknowledge', { count: picked.length })} heldReason={heldText ?? (picked.length === 0 ? t('held.noneOpen') : null)} onClick={() => actions?.onBulkAcknowledge?.()}>
                      <CheckCheck size={13} aria-hidden /> <SelectionLabel>{t('bulk.acknowledge', { count: picked.length })}</SelectionLabel>
                    </Button>
                  ),
                }
              : undefined
          }
          isRowSelectable={model.can.handle ? (row) => (selectHeld(row) ? t(selectHeld(row)!) : null) : undefined}
          updates={model.updates > 0 ? { count: model.updates, onShow: () => actions?.onShowUpdates?.() } : null}
          more={list?.more ? { label: t(list.loadingMore ? 'more.loading' : 'more.label'), onMore: () => actions?.onMore?.(), held: list.loadingMore ? t('more.loading') : null } : null}
          keys={alertsKeys(t)}
          onHelp={() => actions?.onDialog?.({ kind: 'help' })}
          onOpen={(row) => setOpen(row.id)}
          state={state}
          focusRow={model.focusRow}
        />
      </section>

      <section ref={rulesRef} id="rules" className="fw-alerts-section fw-alerts-rules" aria-labelledby="fw-alerts-rules-h">
        <RulesSection model={model} actions={actions} headingId="fw-alerts-rules-h" />
      </section>

      <AlertPopup model={model} openId={openId} rows={rows} held={held} onGo={setOpen} actions={actions} />
      <AlertsDialogs model={model} rows={rows} held={heldText} actions={actions} />

      {model.dialog?.kind === 'help' && (
        <Modal open onClose={() => actions?.onDialog?.(null)} title={t('keysTitle')} size="sm">
          <ul className="fw-alerts-keys">
            {[...listKeys(alertsKeys(t), model.can.handle), { keys: ['J', 'K'], does: t('keys.walk') }, { keys: ['Esc'], does: t('keys.close') }].map((entry) => (
              <li key={entry.keys.join('+')}>
                <b>{entry.keys.join(' ')}</b> — {entry.does.startsWith('keys.') ? <ListWords id={entry.does} /> : entry.does}
              </li>
            ))}
          </ul>
        </Modal>
      )}

      {model.ruleDialog && (
        <RuleDialog
          key={`${model.ruleDialog.mode}:${model.ruleDialog.rule?.id ?? 'new'}:${model.ruleDialog.rule?.version ?? 0}`}
          state={model.ruleDialog}
          rules={model.rules.status === 'ready' ? model.rules.data.rules : []}
          offline={model.live === 'offline'}
          busy={model.busy}
          prefix={model.prefix}
          onSave={actions?.onRuleSave}
          onTest={actions?.onRuleTest}
          onRetryChoices={actions?.onRetryChoices}
          onRetryTimers={actions?.onRetryTimers}
          onClose={() => actions?.onRule?.(null)}
        />
      )}
    </div>
  )
}

/** A key's words of the list frame's own catalogue. */
function ListWords({ id }: { id: string }) {
  const lists = useT('lists')
  return <>{lists(id)}</>
}
