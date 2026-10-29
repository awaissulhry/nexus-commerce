'use client'

import { useMemo, type ReactNode } from 'react'
import Link from 'next/link'
import { Banner, Card, EmptyState, KeyValue } from '@nexus/ui/components'
import type { ColDef, ICellRendererParams } from '@nexus/ui/grid'
import { Button, Pill, SegmentedControl, Skeleton, Tag } from '@nexus/ui/primitives'
import { formatDateTime, formatNumber } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { useKeysHelp } from '../../../kit/list'
import { adminHref } from '../../../shared/model'
import { FrameState, RecordProblem } from '../../../shared/view/parts'
import { RecordFrame } from '../../../shared/view/RecordFrame'
import { INBOUND_STATUSES, type InboundDelivery, type IntegrationAccount, type IntegrationCall } from '../../api'
import { CALL_TONE, FAILED_CALL, INBOUND_TONE, KNOWN_REASONS, KNOWN_SETTINGS, MODE_TONE, isTestMode, nextSwitch, type ConnectionRecordModel, type ConnectionTab, type PauseConfirm } from '../../model'
import { SwitchConfirm, useStateWords } from '../../view/ConnectionsView'
import { ConnectionsMessages, ConnNotice, SecretField } from '../../view/parts'

export type { ConnectionRecordModel } from '../../model'

export interface ConnectionRecordActions {
  onConfirm?: (confirm: PauseConfirm | null) => void
  onSwitch?: (account: IntegrationAccount, pause: boolean, reason: string) => Promise<boolean>
  onFailedOnly?: (failedOnly: boolean) => void
  onMoreCalls?: () => void
  onInboundStatus?: (status: ConnectionRecordModel['inboundStatus']) => void
  onMoreInbound?: () => void
  onDock?: () => void
  onRetry?: () => void
  onRetryCalls?: () => void
  onRetryInbound?: () => void
  onDismissNotice?: () => void
}

/**
 * SCR-087 — a Connection record (design 02 admin.connections "Record: Connection"): Overview (is it working, and what
 * does it do: mode, state, last OK and error, calls 24 h, limits and the circuit in words; Test held — no ping on the
 * adapters yet; Pause / Resume), Settings & secrets (read only; secrets write-only — saved or not, never shown; Replace
 * held — no route replaces one yet), Calls (the gateway's ledger), Inbound (received webhooks, never a body) and
 * Activity (the record panels). Fetches nothing (ConnectionRecord.tsx).
 */
export function ConnectionRecordView({ model, actions, panels }: { model: ConnectionRecordModel; actions?: ConnectionRecordActions; panels?: ReactNode }) {
  return (
    <ConnectionsMessages>
      <ConnectionRecord model={model} actions={actions} panels={panels} />
    </ConnectionsMessages>
  )
}

function ConnectionRecord({ model, actions, panels }: { model: ConnectionRecordModel; actions?: ConnectionRecordActions; panels?: ReactNode }) {
  const t = useT('admin-connections')
  const tAdmin = useT('admin')
  const href = (path: string) => adminHref(model.prefix, path)
  const back = { href: href('/connections'), label: t('conn.title') }
  const stateWords = useStateWords(model.now)
  const account = model.account
  if (!account) {
    if (model.problem)
      return (
        <div className="fw-adm">
          <RecordProblem
            problem={model.problem}
            onRetry={actions?.onRetry}
            back={
              <Button size="sm" asChild>
                <Link href={back.href}>{tAdmin('record.backTo', { name: back.label })}</Link>
              </Button>
            }
          />
        </div>
      )
    return (
      <div className="fw-adm" aria-busy="true">
        <Skeleton height={36} width="40%" />
        <Skeleton height={220} />
      </div>
    )
  }
  const tabs: Array<{ id: ConnectionTab; label: string }> = [
    { id: 'overview', label: t('conn.tab.overview') },
    { id: 'settings', label: t('conn.tab.settings') },
    { id: 'calls', label: t('conn.tab.calls') },
    { id: 'inbound', label: t('conn.tab.inbound') },
    { id: 'activity', label: t('conn.tab.activity') },
  ]
  const verb = nextSwitch(account.status)
  const state = stateWords(account)
  return (
    <div className="fw-adm">
      <RecordFrame
        back={back}
        title={t(`conn.provider.${account.provider}.name`)}
        meta={[account.label, model.companyName ?? t('conn.everyCompany')].join(' · ')}
        status={
          <span className="fw-adm-tags">
            <Pill tone={MODE_TONE[account.mode]}>{t(`conn.mode.${account.mode}`)}</Pill>
            <Pill tone={state.tone}>{state.words}</Pill>
          </span>
        }
        actions={
          <>
            <Button size="sm" heldReason={t('conn.test.held')}>
              {t('conn.test.action')}
            </Button>
            {verb && (
              <Button size="sm" variant={verb === 'pause' ? 'danger-outline' : 'primary'} onClick={() => actions?.onConfirm?.({ accountId: account.id, pause: verb === 'pause' })} heldReason={model.can.manage ? null : tAdmin('held.needs', { right: t('conn.right.manage') })}>
                {t(`conn.${verb}.action`)}
              </Button>
            )}
          </>
        }
        tabs={tabs}
        active={model.tab}
        tabHref={(tab) => `${href(`/connections/${account.id}`)}?tab=${tab}`}
        dock={model.tab === 'activity' ? undefined : panels}
        dockOpen={model.dockOpen}
        onDock={actions?.onDock}
      >
        <ConnNotice notice={model.notice} onDismiss={actions?.onDismissNotice} />
        {account.status === 'PAUSED' && <Banner tone="warning" title={t('conn.pausedBanner')} />}
        {account.status === 'DISABLED' && <Banner tone="neutral" title={t('conn.disabledBanner')} />}
        {isTestMode(account.mode) && account.status !== 'DISABLED' && <Banner tone="info" title={t(`conn.modeBanner.${account.mode}`)} />}
        {model.tab === 'overview' && <OverviewTab model={model} account={account} />}
        {model.tab === 'settings' && <SettingsTab model={model} account={account} />}
        {model.tab === 'calls' && <CallsTab model={model} actions={actions} />}
        {model.tab === 'inbound' && <InboundTab model={model} account={account} actions={actions} />}
        {model.tab === 'activity' && panels}
      </RecordFrame>
      <SwitchConfirm confirm={model.confirm ?? null} account={model.confirm ? account : null} busy={!!model.busy} problem={model.dialogProblem ?? null} onClose={() => actions?.onConfirm?.(null)} onSwitch={actions?.onSwitch} />
    </div>
  )
}

function OverviewTab({ model, account }: { model: ConnectionRecordModel; account: IntegrationAccount }) {
  const t = useT('admin-connections')
  const locale = useLocale()
  const limits = account.limits
  return (
    <div className="fw-adm-stack">
      <Card header={t('conn.overview.title')} headingLevel={2} padded>
        <div className="fw-adm-stack">
          <p className="fw-adm-intro">{t(`conn.provider.${account.provider}.for`)}</p>
          <KeyValue
            columns={2}
            labelCase="sentence"
            items={[
              { label: t('conn.col.mode'), value: t(`conn.mode.${account.mode}`), hint: t(`conn.modeHint.${account.mode}`) },
              { label: t('conn.overview.lastOk'), value: account.lastOkAt ? formatDateTime(account.lastOkAt, { locale }) : t('conn.overview.never') },
              { label: t('conn.overview.lastError'), value: account.lastErrorAt ? formatDateTime(account.lastErrorAt, { locale }) : t('conn.overview.noError') },
              {
                label: t('conn.col.calls'),
                value: t('conn.callCount', { count: account.calls24h.total }),
                hint: account.calls24h.failed > 0 ? t('conn.callsFailed', { count: account.calls24h.failed }) : t('conn.overview.noFailures'),
              },
              { label: t('conn.overview.waiting'), value: account.inboundWaiting > 0 ? t('conn.waiting', { count: account.inboundWaiting }) : t('conn.overview.noneWaiting') },
            ]}
          />
          {account.lastError && (
            <div className="fw-adm-cell">
              <span className="fw-adm-hint">{t('conn.lastErrorSaid')}</span>
              <q className="fw-adm-conn-error">{account.lastError}</q>
            </div>
          )}
        </div>
      </Card>
      <Card header={t('conn.limits.title')} description={t('conn.limits.intro')} headingLevel={2} padded>
        <KeyValue
          columns={2}
          labelCase="sentence"
          items={[
            { label: t('conn.limits.rate'), value: t('conn.limits.rateValue', { perMinute: formatNumber(limits.ratePerMinute, locale), burst: formatNumber(limits.burst, locale) }) },
            { label: t('conn.limits.timeout'), value: t('conn.limits.seconds', { seconds: formatNumber(limits.timeoutMs / 1000, locale, { maximumFractionDigits: 1 }) }) },
            { label: t('conn.limits.circuit'), value: t('conn.limits.circuitValue', { seconds: formatNumber(limits.circuitCooldownSeconds, locale), failures: formatNumber(limits.circuitFailureThreshold, locale) }) },
          ]}
        />
      </Card>
      <Card header={t('conn.test.title')} headingLevel={2} padded>
        <div className="fw-adm-danger-row">
          <div>
            <span className="fw-adm-hint">{t('conn.test.body')}</span>
          </div>
          <Button size="sm" heldReason={t('conn.test.held')}>
            {t('conn.test.action')}
          </Button>
        </div>
      </Card>
      {!model.can.manage && <p className="fw-adm-hint">{t('conn.readOnly')}</p>}
    </div>
  )
}

function SettingsTab({ model, account }: { model: ConnectionRecordModel; account: IntegrationAccount }) {
  const t = useT('admin-connections')
  const locale = useLocale()
  const settings = Object.entries(account.settings)
  const known = (key: string) => (KNOWN_SETTINGS as readonly string[]).includes(key)
  return (
    <div className="fw-adm-stack">
      <Card header={t('conn.settings.title')} description={t('conn.settings.intro')} headingLevel={2} padded>
        <KeyValue
          columns={2}
          labelCase="sentence"
          items={[
            { label: t('conn.settings.label'), value: account.label },
            { label: t('conn.settings.code'), value: <span className="fw-adm-code">{account.code}</span> },
            { label: t('conn.col.company'), value: model.companyName ?? t('conn.everyCompany') },
            { label: t('conn.col.mode'), value: t(`conn.mode.${account.mode}`) },
            { label: t('conn.settings.created'), value: formatDateTime(account.createdAt, { locale }) },
            { label: t('conn.settings.changed'), value: formatDateTime(account.updatedAt, { locale }) },
            ...settings.map(([key, value]) => ({
              label: known(key) ? t(`conn.setting.${key}`) : <span className="fw-adm-code">{key}</span>,
              value: value === null || value === '' ? '—' : <span className="fw-adm-code">{String(value)}</span>,
            })),
          ]}
        />
        {settings.length === 0 && <p className="fw-adm-hint">{t('conn.settings.none')}</p>}
        {account.inboundPath && (
          <div className="fw-adm-cell">
            <span className="fw-adm-hint">{t('conn.settings.inboundPath')}</span>
            <span className="fw-adm-code">{account.inboundPath}</span>
          </div>
        )}
      </Card>
      <Card header={t('conn.secrets.title')} description={t('conn.secrets.intro')} headingLevel={2} padded>
        <div className="fw-adm-stack">
          <SecretField label={t('conn.secrets.credentials')} state={account.credentials} replaceHeld={t('conn.secret.replaceHeld')} />
          <SecretField label={t('conn.secrets.webhook')} state={account.webhookSecret} replaceHeld={t('conn.secret.replaceHeld')} />
        </div>
      </Card>
      <p className="fw-adm-hint">{t('conn.settings.later')}</p>
    </div>
  )
}

/** The call ledger's columns (one call per row, newest first). */
export function useCallColumns(): ColDef<IntegrationCall>[] {
  const t = useT('admin-connections')
  const locale = useLocale()
  return useMemo<ColDef<IntegrationCall>[]>(() => {
    const reason = (code: string | null) => (code ? ((KNOWN_REASONS as readonly string[]).includes(code) ? t(`conn.reason.${code}`) : code) : null)
    return [
      { colId: 'time', headerName: t('conn.calls.col.time'), flex: 1.1, minWidth: 160, valueGetter: ({ data }) => (data ? formatDateTime(data.startedAt, { locale }) : '') },
      { colId: 'operation', headerName: t('conn.calls.col.operation'), flex: 1.2, minWidth: 170, cellClass: 'fw-adm-code', valueGetter: ({ data }) => data?.operation ?? '' },
      {
        colId: 'state',
        headerName: t('conn.calls.col.state'),
        flex: 0.9,
        minWidth: 130,
        cellRenderer: ({ data }: ICellRendererParams<IntegrationCall>) => (data ? <Pill tone={CALL_TONE[data.status] ?? 'neutral'}>{t(`conn.callState.${data.status}`)}</Pill> : null),
      },
      { colId: 'http', headerName: t('conn.calls.col.http'), flex: 0.5, minWidth: 80, valueGetter: ({ data }) => (data ? (data.httpStatus === null ? '—' : String(data.httpStatus)) : '') },
      { colId: 'duration', headerName: t('conn.calls.col.duration'), flex: 0.7, minWidth: 100, valueGetter: ({ data }) => (data ? t('conn.calls.ms', { ms: formatNumber(data.durationMs, locale) }) : '') },
      { colId: 'tries', headerName: t('conn.calls.col.tries'), flex: 0.5, minWidth: 80, valueGetter: ({ data }) => (data ? String(data.attempts) : '') },
      {
        colId: 'summary',
        headerName: t('conn.calls.col.summary'),
        flex: 2,
        minWidth: 240,
        cellRenderer: ({ data }: ICellRendererParams<IntegrationCall>) => {
          if (!data) return null
          if (!FAILED_CALL.has(data.status)) return '—'
          const why = reason(data.reason)
          return (
            <span className="fw-adm-two">
              {why && <span>{why}</span>}
              {data.error && (
                <q className="fw-adm-conn-error" title={data.error}>
                  {data.error}
                </q>
              )}
            </span>
          )
        },
      },
    ]
  }, [t, locale])
}

function CallsTab({ model, actions }: { model: ConnectionRecordModel; actions?: ConnectionRecordActions }) {
  const t = useT('admin-connections')
  const tAdmin = useT('admin')
  const columns = useCallColumns()
  const { onHelp, help } = useKeysHelp([], false)
  const items = model.calls.items
  const state: ReactNode = model.calls.problem ? (
    <FrameState problem={model.calls.problem} onRetry={actions?.onRetryCalls} />
  ) : items && items.length === 0 ? (
    <EmptyState title={t(model.failedOnly ? 'conn.calls.noFailures' : 'conn.calls.empty')} description={t('conn.calls.emptyBody')} />
  ) : undefined
  return (
    <div className="fw-adm-stack">
      <ListFrame<IntegrationCall>
        label={t('conn.calls.tableLabel')}
        rows={model.calls.problem ? [] : items}
        rowId={(call) => call.id}
        columns={columns}
        count={items ? t('conn.calls.count', { count: items.length }) : '—'}
        tools={
          <SegmentedControl
            ariaLabel={t('conn.calls.filter')}
            size="sm"
            value={model.failedOnly ? 'failed' : 'all'}
            onChange={(value) => actions?.onFailedOnly?.(value === 'failed')}
            options={[
              { value: 'all', label: t('conn.calls.all') },
              { value: 'failed', label: t('conn.calls.failedOnly') },
            ]}
          />
        }
        more={items && items.length > 0 && model.calls.more ? { label: t('conn.showOlder'), onMore: () => actions?.onMoreCalls?.(), held: model.calls.loadingMore ? tAdmin('list.loading') : null } : null}
        onHelp={onHelp}
        state={state}
      />
      {help}
      <p className="fw-adm-hint">{t('conn.calls.privacy')}</p>
    </div>
  )
}

/** The received messages' columns (one webhook delivery per row, newest first; never its content). */
export function useInboundColumns(): ColDef<InboundDelivery>[] {
  const t = useT('admin-connections')
  const locale = useLocale()
  return useMemo<ColDef<InboundDelivery>[]>(
    () => [
      { colId: 'time', headerName: t('conn.calls.col.time'), flex: 1.1, minWidth: 160, valueGetter: ({ data }) => (data ? formatDateTime(data.receivedAt, { locale }) : '') },
      { colId: 'event', headerName: t('conn.inbound.col.event'), flex: 1.2, minWidth: 170, cellClass: 'fw-adm-code', valueGetter: ({ data }) => (data ? (data.eventType ?? '—') : '') },
      {
        colId: 'verified',
        headerName: t('conn.inbound.col.verified'),
        flex: 0.9,
        minWidth: 150,
        cellRenderer: ({ data }: ICellRendererParams<InboundDelivery>) =>
          data ? data.verified ? <Tag tone="success">{t('conn.inbound.verified')}</Tag> : <Tag tone="danger">{t('conn.inbound.notVerified')}</Tag> : null,
      },
      {
        colId: 'state',
        headerName: t('conn.calls.col.state'),
        flex: 0.9,
        minWidth: 120,
        cellRenderer: ({ data }: ICellRendererParams<InboundDelivery>) => (data ? <Pill tone={INBOUND_TONE[data.status] ?? 'neutral'}>{t(`conn.inboundState.${data.status}`)}</Pill> : null),
      },
      { colId: 'tries', headerName: t('conn.calls.col.tries'), flex: 0.5, minWidth: 80, valueGetter: ({ data }) => (data ? String(data.attempts) : '') },
      { colId: 'processed', headerName: t('conn.inbound.col.processed'), flex: 1.1, minWidth: 160, valueGetter: ({ data }) => (data ? (data.processedAt ? formatDateTime(data.processedAt, { locale }) : '—') : '') },
      {
        colId: 'error',
        headerName: t('conn.inbound.col.error'),
        flex: 1.6,
        minWidth: 220,
        cellRenderer: ({ data }: ICellRendererParams<InboundDelivery>) =>
          data ? data.error ? (
            <q className="fw-adm-conn-error fw-adm-ellipsis" title={data.error}>
              {data.error}
            </q>
          ) : '—' : null,
      },
    ],
    [t, locale],
  )
}

function InboundTab({ model, account, actions }: { model: ConnectionRecordModel; account: IntegrationAccount; actions?: ConnectionRecordActions }) {
  const t = useT('admin-connections')
  const tAdmin = useT('admin')
  const columns = useInboundColumns()
  const { onHelp, help } = useKeysHelp([], false)
  const items = model.inbound.items
  const state: ReactNode = model.inbound.problem ? (
    <FrameState problem={model.inbound.problem} onRetry={actions?.onRetryInbound} />
  ) : items && items.length === 0 ? (
    <EmptyState title={t('conn.inbound.empty')} description={t('conn.inbound.emptyBody')} />
  ) : undefined
  return (
    <div className="fw-adm-stack">
      {!account.inboundPath && <Banner tone="info" title={t('conn.inbound.none')} />}
      <ListFrame<InboundDelivery>
        label={t('conn.inbound.tableLabel')}
        rows={model.inbound.problem ? [] : items}
        rowId={(delivery) => delivery.id}
        columns={columns}
        count={items ? t('conn.inbound.count', { count: items.length }) : '—'}
        tools={
          <SegmentedControl
            ariaLabel={t('conn.inbound.filter')}
            size="sm"
            wrap
            value={model.inboundStatus ?? 'all'}
            onChange={(value) => actions?.onInboundStatus?.(value === 'all' ? null : (value as ConnectionRecordModel['inboundStatus']))}
            options={[{ value: 'all', label: t('conn.calls.all') }, ...INBOUND_STATUSES.map((status) => ({ value: status, label: t(`conn.inboundState.${status}`) }))]}
          />
        }
        more={items && items.length > 0 && model.inbound.more ? { label: t('conn.showOlder'), onMore: () => actions?.onMoreInbound?.(), held: model.inbound.loadingMore ? tAdmin('list.loading') : null } : null}
        onHelp={onHelp}
        state={state}
      />
      {help}
      <p className="fw-adm-hint">{t('conn.inbound.privacy')}</p>
    </div>
  )
}
