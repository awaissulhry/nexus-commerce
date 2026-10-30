'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { MoreHorizontal, Pause, Play, Search } from 'lucide-react'
import { Banner, EmptyState, Field, Menu, MetricStrip, Modal } from '@nexus/ui/components'
import { IdentityCell, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Pill, Tag, Textarea } from '@nexus/ui/primitives'
import { formatDateTime, formatNumber, formatTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../list-frame/model'
import { bulkHeld, leftCounts } from '../../kit/bulk-model'
import { BulkReach, useKeysHelp, useLatest, useSelection } from '../../kit/list'
import { PageNotice } from '../../kit/parts'
import { adminHref } from '../../shared/model'
import { BulkButton, FrameState, PageHead } from '../../shared/view/parts'
import type { IntegrationAccount, IntegrationProvider } from '../api'
import { MailDomainSection, type MailDomainActions } from '../mail/view/MailDomainSection'
import { DeliverySection, type DeliveryActions } from '../delivery/view/DeliverySection'
import {
  accountState,
  CONNECTION_TILES,
  isTestMode,
  LATER_SERVICES,
  MODE_TONE,
  PROVIDER_ORDER,
  residencyRows,
  sameDay,
  serviceRows,
  switchReach,
  tileMatch,
  type BulkSwitch,
  type CompanyChoice,
  type ConnectionsViewModel,
  type ConnectionTile,
  type PauseConfirm,
  type ServiceRow,
} from '../model'
import { ConnectionsMessages, ConnStepUp } from './parts'

export type { ConnectionsViewModel } from '../model'

export interface ConnectionsActions {
  onTile?: (tile: ConnectionTile | null) => void
  onQuery?: (query: string) => void
  onRetry?: () => void
  onConnect?: (open: boolean) => void
  onConfirm?: (confirm: PauseConfirm | null) => void
  onSwitch?: (account: IntegrationAccount, pause: boolean, reason: string) => Promise<boolean>
  /** Enter on a connected service: its record. */
  onOpen?: (account: IntegrationAccount) => void
  /** The rows ticked in the services list. */
  onSelect?: (ids: string[]) => void
  /** Opens (rows) or closes (null) the bulk pause or resume confirm. */
  onBulk?: (bulk: BulkSwitch | null) => void
  /** Pauses or resumes these accounts, one call each; one notice says what was done. */
  onBulkGo?: (accounts: readonly IntegrationAccount[], pause: boolean, reason: string) => Promise<void> | void
  onDismissNotice?: () => void
  onStepUp?: (code: string) => void
  onStepUpClose?: () => void
  mail?: MailDomainActions
  /** The delivery log and blocked addresses (B-W2a-41). */
  delivery?: DeliveryActions
}

/**
 * SCR-087 — Admin › Connections & API (design 02 admin.connections; PLT-139, PLT-195, PLT-197, PLT-011): every rented
 * service in one list, said for an owner — what it is for, whether it works, in which mode (Fake and Test reach nobody:
 * the page says so on top) — with a "Not connected" row for each service nobody connected; tick services to pause or
 * resume several at once (after one confirm); the mail domain (SCR-015, `#mail`); where the data lives, from what the
 * connections themselves say. Both lists are the Office's list frame (Owner rule 2026-10-29). Connecting a service is
 * held in words (no route adds one yet). `c` opens the catalogue. Fetches nothing (ConnectionsPage.tsx).
 */
export function ConnectionsView({ model, actions }: { model: ConnectionsViewModel; actions?: ConnectionsActions }) {
  return (
    <ConnectionsMessages>
      <Connections model={model} actions={actions} />
    </ConnectionsMessages>
  )
}

/** "Working · last OK 10:41", "Failing since 09:12", "Paused", "Not called yet". */
export function useStateWords(now: string) {
  const t = useT('admin-connections')
  const locale = useLocale()
  return (account: Pick<IntegrationAccount, 'status' | 'lastOkAt' | 'lastErrorAt'>) => {
    const state = accountState(account)
    const at = 'at' in state ? (sameDay(state.at, now) ? formatTime(state.at, { locale }) : formatDateTime(state.at, { locale })) : ''
    return { tone: state.tone, words: t(`conn.state.${state.key}`, { at }), key: state.key }
  }
}

/** A row of the services list: the service (a link to its record) with its label and code, or "Not connected". */
export function ServiceCell({ row, prefix }: { row: ServiceRow; prefix: string }) {
  const t = useT('admin-connections')
  const name = t(`conn.provider.${row.kind === 'account' ? row.account.provider : row.provider}.name`)
  if (row.kind === 'missing') return <IdentityCell noImage title={name} titleAttr={name} sub={<Tag>{t('conn.notConnected')}</Tag>} />
  return (
    <IdentityCell
      noImage
      title={name}
      titleAttr={name}
      href={adminHref(prefix, `/connections/${row.account.id}`)}
      sub={
        <span className="fw-adm-ellipsis">
          {row.account.label} · <span className="fw-adm-code">{row.account.code}</span>
        </span>
      }
    />
  )
}

/** Whether a service works: its state in words, and the last error as the service said it (data, quoted). */
export function StateCell({ row, now }: { row: ServiceRow; now: string }) {
  const t = useT('admin-connections')
  const stateWords = useStateWords(now)
  if (row.kind === 'missing') return <span className="fw-adm-hint">{t('conn.notConnectedHint')}</span>
  const account = row.account
  const state = stateWords(account)
  return (
    <span className="fw-adm-two">
      <span>
        <Pill tone={state.tone}>{state.words}</Pill>
      </span>
      {state.key === 'failing' && account.lastError && (
        <q className="fw-adm-conn-error" title={account.lastError}>
          {account.lastError}
        </q>
      )}
    </span>
  )
}

/** Calls in the last 24 hours (the column says so: the number alone), how many failed, the received messages waiting. */
export function CallsCell({ account }: { account: IntegrationAccount }) {
  const t = useT('admin-connections')
  const locale = useLocale()
  return (
    <span className="fw-adm-inline" title={t('conn.callCount', { count: account.calls24h.total })}>
      <span>{formatNumber(account.calls24h.total, locale)}</span>
      {account.calls24h.failed > 0 && <Tag tone="danger">{t('conn.callsFailed', { count: account.calls24h.failed })}</Tag>}
      {account.inboundWaiting > 0 && <Tag tone="info">{t('conn.waiting', { count: account.inboundWaiting })}</Tag>}
    </span>
  )
}

/** The services list's columns. `onConnect` opens the catalogue from a "Not connected" row; `onConfirm` asks to pause or resume one. */
export function useServiceColumns(model: Pick<ConnectionsViewModel, 'prefix' | 'now' | 'companies' | 'can'>, actions?: Pick<ConnectionsActions, 'onConnect' | 'onConfirm'>): ColDef<ServiceRow>[] {
  const t = useT('admin-connections')
  const tAdmin = useT('admin')
  const { prefix, now, companies, can } = model
  const latest = useLatest(actions)
  return useMemo<ColDef<ServiceRow>[]>(() => {
    const onConnect = (open: boolean) => latest.current?.onConnect?.(open)
    const onConfirm = (confirm: PauseConfirm) => latest.current?.onConfirm?.(confirm)
    const companyName = (id: string | null) => (id === null ? t('conn.everyCompany') : (companies?.find((company: CompanyChoice) => company.id === id)?.name ?? '—'))
    const provider = (row: ServiceRow): IntegrationProvider => (row.kind === 'account' ? row.account.provider : row.provider)
    const manageHeld = can.manage ? null : tAdmin('held.needs', { right: t('conn.right.manage') })
    const href = (path: string) => adminHref(prefix, path)
    return [
      { colId: 'service', headerName: t('conn.col.service'), flex: 1.6, minWidth: 180, cellRenderer: ({ data }: ICellRendererParams<ServiceRow>) => (data ? <ServiceCell row={data} prefix={prefix} /> : null) },
      { colId: 'for', headerName: t('conn.col.for'), flex: 1.8, minWidth: 165, valueGetter: ({ data }) => (data ? t(`conn.provider.${provider(data)}.for`) : ''), tooltipValueGetter: ({ value }) => value as string },
      { colId: 'company', headerName: t('conn.col.company'), flex: 1.2, minWidth: 140, valueGetter: ({ data }) => (data ? companyName(data.kind === 'account' ? data.account.companyId : data.companyId) : '') },
      {
        colId: 'mode',
        headerName: t('conn.col.mode'),
        flex: 0.8,
        minWidth: 120,
        cellRenderer: ({ data }: ICellRendererParams<ServiceRow>) =>
          data?.kind === 'account' ? <Pill tone={MODE_TONE[data.account.mode]}>{t(`conn.mode.${data.account.mode}`)}</Pill> : data ? '—' : null,
      },
      { colId: 'state', headerName: t('conn.col.state'), flex: 1.6, minWidth: 185, cellRenderer: ({ data }: ICellRendererParams<ServiceRow>) => (data ? <StateCell row={data} now={now} /> : null) },
      { colId: 'calls', headerName: t('conn.col.calls'), flex: 1, minWidth: 150, cellRenderer: ({ data }: ICellRendererParams<ServiceRow>) => (data?.kind === 'account' ? <CallsCell account={data.account} /> : data ? '—' : null) },
      {
        colId: 'region',
        headerName: t('conn.col.region'),
        flex: 0.8,
        minWidth: 115,
        cellRenderer: ({ data }: ICellRendererParams<ServiceRow>) => {
          if (!data) return null
          const region = data.kind === 'account' ? data.account.settings.region : null
          return typeof region === 'string' && region ? <span className="fw-adm-code">{region}</span> : '—'
        },
      },
      {
        colId: 'actions',
        headerName: tAdmin('common.actions'),
        flex: 0.9,
        minWidth: 150,
        sortable: false,
        cellRenderer: ({ data }: ICellRendererParams<ServiceRow>) => {
          if (!data) return null
          if (data.kind === 'missing')
            return (
              <Button size="sm" variant="quiet" onClick={() => onConnect(true)}>
                {t('conn.connect.row')}
              </Button>
            )
          const account = data.account
          return (
            <Menu
              align="right"
              label={<MoreHorizontal size={16} aria-hidden />}
              triggerProps={{ 'aria-label': tAdmin('common.moreFor', { name: account.label }) }}
              items={[
                { id: 'open', label: t('conn.open'), href: href(`/connections/${account.id}`) },
                { id: 'calls', label: t('conn.tab.calls'), href: `${href(`/connections/${account.id}`)}?tab=calls` },
                ...(account.status === 'ACTIVE' || account.status === 'PAUSED'
                  ? [
                      {
                        id: 'switch',
                        label: account.status === 'ACTIVE' ? t('conn.pause.action') : t('conn.resume.action'),
                        disabled: !can.manage,
                        description: manageHeld ?? undefined,
                        onSelect: () => onConfirm({ accountId: account.id, pause: account.status === 'ACTIVE' }),
                      },
                    ]
                  : []),
              ]}
            />
          )
        },
      },
    ]
  }, [t, tAdmin, prefix, now, companies, can.manage, latest])
}

/** The page's own key, listed in the list's footer icon. */
function usePageKeys(): ListKey[] {
  const t = useT('admin-connections')
  return [{ keys: ['c'], does: t('conn.keys.connect') }]
}

function Connections({ model, actions }: { model: ConnectionsViewModel; actions?: ConnectionsActions }) {
  const t = useT('admin-connections')
  const tAdmin = useT('admin')
  const providerName = (provider: IntegrationProvider) => t(`conn.provider.${provider}.name`)

  // c: connect a service (when no field has the focus and no dialog is open), as the design's keyboard says.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.metaKey || event.ctrlKey || event.altKey || model.connect || model.confirm || model.bulk || model.mail?.add || model.delivery?.confirm) return
      if (target && (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]') || target.isContentEditable)) return
      if (event.key !== 'c') return
      event.preventDefault()
      actions?.onConnect?.(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const accounts = model.accounts.items
  const live = (accounts ?? []).filter((account) => account.status !== 'DISABLED')
  const testing = live.filter((account) => isTestMode(account.mode))
  // serviceRows reads the provider names through `t`; the rows change with the accounts, companies and filters.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const rows = useMemo(() => (accounts ? serviceRows(accounts, model.companies, model.tile, model.query, providerName) : []), [accounts, model.companies, model.tile, model.query, t])
  const { selected, onChange } = useSelection(model.selected, actions?.onSelect, rows.map((row) => row.id))
  const columns = useServiceColumns(model, actions)
  const own = usePageKeys()
  const { onHelp, help } = useKeysHelp(own, true)
  const confirming = model.confirm ? (accounts ?? []).find((account) => account.id === model.confirm!.accountId) ?? null : null
  const picked = rows.filter((row) => selected.includes(row.id))
  const pauseReach = switchReach(picked, true)
  const resumeReach = switchReach(picked, false)
  const pauseHeld = bulkHeld(pauseReach, model.can.manage, { right: 'held.needs', none: 'conn.bulk.noneToPause' })
  const resumeHeld = bulkHeld(resumeReach, model.can.manage, { right: 'held.needs', none: 'conn.bulk.noneToResume' })
  const heldWords = (key: string | null) => (key === null ? null : key === 'held.needs' ? tAdmin('held.needs', { right: t('conn.right.manage') }) : t(key))

  const state: ReactNode = model.accounts.problem ? (
    <FrameState problem={model.accounts.problem} onRetry={actions?.onRetry} />
  ) : accounts && rows.length === 0 ? (
    <EmptyState
      title={tAdmin('list.noMatch')}
      action={
        <Button
          size="sm"
          onClick={() => {
            actions?.onQuery?.('')
            actions?.onTile?.(null)
          }}
        >
          {tAdmin('list.clearFilters')}
        </Button>
      }
    />
  ) : undefined

  return (
    <div className="fw-adm">
      <PageHead
        intro={t('conn.intro')}
        asOf={model.asOf}
        actions={
          <Button size="sm" variant="primary" onClick={() => actions?.onConnect?.(true)}>
            {t('conn.connect.open')}
          </Button>
        }
      />
      {testing.length > 0 && (
        <Banner tone="warning" title={t('conn.testMode.title', { count: testing.length })}>
          {t('conn.testMode.body', { services: testing.map((account) => account.label).join(', ') })}
        </Banner>
      )}
      <PageNotice namespace="admin-connections" notice={model.notice} onDismiss={actions?.onDismissNotice} nameOf={(id) => (accounts ?? []).find((account) => account.id === id)?.label ?? id} />
      <MetricStrip
        metrics={CONNECTION_TILES.map((tile) => ({
          label: t(`conn.tile.${tile}`),
          value: accounts ? String(live.filter((account) => tileMatch(tile, account)).length) : '—',
          hint: t(`conn.tileHint.${tile}`),
          active: model.tile === tile,
          onClick: () => actions?.onTile?.(model.tile === tile ? null : tile),
        }))}
      />
      {accounts && live.length === 0 && <Banner tone="info" title={t('conn.empty.title')}>{t('conn.empty.body')}</Banner>}
      <ListFrame<ServiceRow>
        label={t('conn.tableLabel')}
        rows={model.accounts.problem ? [] : accounts === null ? null : rows}
        rowId={(row) => row.id}
        columns={columns}
        isRowSelectable={(row) => (row.kind === 'missing' ? t('conn.bulk.noSelect') : null)}
        count={accounts ? t('conn.count', { count: rows.length }) : '—'}
        search={
          <Input
            size="sm"
            type="search"
            leadingIcon={<Search size={14} aria-hidden />}
            aria-label={t('conn.search')}
            placeholder={t('conn.search')}
            value={model.query}
            onChange={(event) => actions?.onQuery?.(event.target.value)}
          />
        }
        tools={
          model.tile ? (
            <>
              <Tag tone="info">{t('conn.filtered', { tile: t(`conn.tile.${model.tile}`) })}</Tag>
              <Button size="sm" variant="quiet" onClick={() => actions?.onTile?.(null)}>
                {tAdmin('list.clearFilter')}
              </Button>
            </>
          ) : undefined
        }
        selection={{
          selected,
          onChange,
          actions: (
            <>
              <BulkButton
                icon={<Pause size={13} aria-hidden />}
                label={t('conn.bulk.pause', { count: pauseReach.applies.length })}
                held={heldWords(pauseHeld)}
                tone="danger-outline"
                onClick={() => actions?.onBulk?.({ pause: true, ids: selected })}
              />
              <BulkButton
                icon={<Play size={13} aria-hidden />}
                label={t('conn.bulk.resume', { count: resumeReach.applies.length })}
                held={heldWords(resumeHeld)}
                onClick={() => actions?.onBulk?.({ pause: false, ids: selected })}
              />
            </>
          ),
        }}
        keys={own}
        onHelp={onHelp}
        onOpen={(row) => (row.kind === 'account' ? actions?.onOpen?.(row.account) : actions?.onConnect?.(true))}
        state={state}
      />
      {help}
      {model.mail ? <MailDomainSection model={model.mail} actions={actions?.mail} prefix={model.prefix} /> : <Banner tone="info" title={t('mail.noRight')} />}
      {model.delivery && <DeliverySection model={model.delivery} actions={actions?.delivery} prefix={model.prefix} />}
      <Residency model={model} />
      <p className="fw-adm-hint">{t('conn.later')}</p>
      <ConnectModal open={!!model.connect} accounts={live} onClose={() => actions?.onConnect?.(false)} />
      <SwitchConfirm confirm={model.confirm ?? null} account={confirming} busy={!!model.busy} problem={model.dialogProblem ?? null} onClose={() => actions?.onConfirm?.(null)} onSwitch={actions?.onSwitch} />
      <BulkSwitchConfirm model={model} rows={rows} actions={actions} />
      <ConnStepUp model={model.stepUp} onSubmit={actions?.onStepUp} onClose={actions?.onStepUpClose} />
    </div>
  )
}

type ResidencyRow = ReturnType<typeof residencyRows>[number]

/** "Where your data lives" columns: the service, the connection, the region its settings name (never a guessed one), the mode. */
export function useResidencyColumns(): ColDef<ResidencyRow>[] {
  const t = useT('admin-connections')
  return useMemo<ColDef<ResidencyRow>[]>(
    () => [
      { colId: 'service', headerName: t('conn.col.service'), flex: 1, minWidth: 160, cellClass: 'fw-adm-name', valueGetter: ({ data }) => (data ? t(`conn.provider.${data.provider}.name`) : '') },
      { colId: 'account', headerName: t('conn.residency.account'), flex: 1.4, minWidth: 200, valueGetter: ({ data }) => data?.label ?? '' },
      {
        colId: 'region',
        headerName: t('conn.col.region'),
        flex: 1,
        minWidth: 140,
        cellRenderer: ({ data }: ICellRendererParams<ResidencyRow>) => (data ? data.region ? <span className="fw-adm-code">{data.region}</span> : <span className="fw-adm-hint">{t('conn.residency.unknown')}</span> : null),
      },
      { colId: 'mode', headerName: t('conn.col.mode'), flex: 0.8, minWidth: 120, valueGetter: ({ data }) => (data ? t(`conn.mode.${data.mode}`) : '') },
    ],
    [t],
  )
}

/** Where your data lives: only what the connections' own settings name (never a guessed region). A read-only list. */
function Residency({ model }: { model: ConnectionsViewModel }) {
  const t = useT('admin-connections')
  const columns = useResidencyColumns()
  const { onHelp, help } = useKeysHelp([], false)
  const accounts = model.accounts.items
  if (!accounts) return null
  const rows = residencyRows(accounts)
  return (
    <section className="fw-adm-list-section" aria-labelledby="conn-residency">
      <div className="fw-adm-head-text">
        <h2 id="conn-residency" className="fw-adm-list-h2">
          {t('conn.residency.title')}
        </h2>
        <p className="fw-adm-intro">{t('conn.residency.intro')}</p>
      </div>
      <ListFrame<ResidencyRow>
        label={t('conn.residency.title')}
        rows={rows}
        rowId={(row) => row.id}
        columns={columns}
        count={t('conn.count', { count: rows.length })}
        onHelp={onHelp}
        rowKind="text"
        state={rows.length === 0 ? <EmptyState title={t('conn.residency.none')} /> : undefined}
      />
      {help}
      <p className="fw-adm-hint">{t('conn.residency.later')}</p>
    </section>
  )
}

/**
 * Pause or resume several services after ONE confirm (bulk; each is one call with its version): what changes, the
 * services it applies to, the selected ones it leaves out and why, and a reason kept with each change.
 */
function BulkSwitchConfirm({ model, rows, actions }: { model: ConnectionsViewModel; rows: readonly ServiceRow[]; actions?: ConnectionsActions }) {
  const t = useT('admin-connections')
  const tAdmin = useT('admin')
  const [reason, setReason] = useState('')
  const bulk = model.bulk ?? null
  const key = bulk ? `${bulk.pause}|${bulk.ids.join('|')}` : ''
  useEffect(() => setReason(''), [key])
  if (!bulk) return null
  const verb = bulk.pause ? 'pause' : 'resume'
  const chosen = bulk.ids.flatMap((id) => rows.filter((row) => row.id === id))
  const reach = switchReach(chosen, bulk.pause)
  const count = reach.applies.length
  const short = reason.trim().length > 0 && reason.trim().length < 3
  const held = !model.can.manage ? tAdmin('held.needs', { right: t('conn.right.manage') }) : count === 0 ? t(bulk.pause ? 'conn.bulk.noneToPause' : 'conn.bulk.noneToResume') : model.busy ? tAdmin('common.saving') : short ? t('conn.reasonShort') : null
  const close = () => actions?.onBulk?.(null)
  return (
    <Modal
      open
      onClose={close}
      title={t(`conn.bulk.${verb}Title`, { count })}
      size="md"
      busy={model.busy}
      footer={
        <>
          <Button onClick={close}>{tAdmin('common.cancel')}</Button>
          <Button variant={bulk.pause ? 'danger' : 'primary'} heldReason={held} onClick={() => void actions?.onBulkGo?.(reach.applies.map((row) => row.account), bulk.pause, reason.trim())}>
            {t(`conn.bulk.${verb}Go`, { count })}
          </Button>
        </>
      }
    >
      <div className="fw-adm-modal-body">
        {model.dialogProblem && <Banner tone="danger" title={tAdmin(model.dialogProblem)} />}
        <p className="fw-adm-intro">{t(`conn.bulk.${verb}Body`)}</p>
        <BulkReach
          label={t('conn.bulk.listLabel')}
          names={reach.applies.map((row) => `${t(`conn.provider.${row.account.provider}.name`)} — ${row.account.label}`)}
          left={leftCounts(reach).map((entry) => ({ ...entry, words: t(entry.why, { count: entry.count }) }))}
        />
        <p className="fw-adm-hint">{t(`conn.bulk.${verb}Undo`)}</p>
        <Field label={tAdmin('common.reason')} hint={t('conn.bulk.reasonHint')} error={short ? t('conn.reasonShort') : undefined}>
          <Textarea rows={2} value={reason} onChange={(event) => setReason(event.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}

/** The "Connect a service" catalogue (design `connect`): what each service is for, which are connected, and — honestly — that adding one is not possible from this page yet. */
export function ConnectModal({ open, accounts, onClose }: { open: boolean; accounts: readonly IntegrationAccount[]; onClose: () => void }) {
  const t = useT('admin-connections')
  const tAdmin = useT('admin')
  if (!open) return null
  return (
    <Modal open onClose={onClose} title={t('conn.connect.title')} subtitle={t('conn.connect.subtitle')} size="xl" footer={<Button onClick={onClose}>{tAdmin('common.close')}</Button>}>
      <div className="fw-adm-modal-body">
        <Banner tone="info" title={t('conn.connect.heldTitle')}>
          {t('conn.connect.heldBody')}
        </Banner>
        <div className="fw-adm-conn-catalogue" role="list" aria-label={t('conn.connect.listLabel')}>
          {PROVIDER_ORDER.map((provider) => {
            const count = accounts.filter((account) => account.provider === provider).length
            return (
              <div key={provider} className="fw-adm-conn-service" role="listitem">
                <span className="fw-adm-name">{t(`conn.provider.${provider}.name`)}</span>
                <span className="fw-adm-hint">{t(`conn.provider.${provider}.for`)}</span>
                <span className="fw-adm-tags">{count > 0 ? <Pill tone="success">{t('conn.connect.connected', { count })}</Pill> : <Tag>{t('conn.notConnected')}</Tag>}</span>
                <span className="fw-adm-hint">{t(`conn.provider.${provider}.how`)}</span>
              </div>
            )
          })}
          {LATER_SERVICES.map((service) => (
            <div key={service} className="fw-adm-conn-service" role="listitem">
              <span className="fw-adm-name">{t(`conn.laterService.${service}`)}</span>
              <span className="fw-adm-tags">
                <Tag>{t('conn.connect.later')}</Tag>
              </span>
            </div>
          ))}
        </div>
        <Button size="sm" variant="primary" heldReason={t('conn.connect.held')}>
          {t('conn.connect.go')}
        </Button>
      </div>
    </Modal>
  )
}

/** Pause or resume one account, after a confirm that says what changes (the design's `Pause / resume (confirm)`). */
export function SwitchConfirm({
  confirm,
  account,
  busy,
  problem,
  onClose,
  onSwitch,
}: {
  confirm: PauseConfirm | null
  account: IntegrationAccount | null
  busy: boolean
  problem: string | null
  onClose: () => void
  onSwitch?: (account: IntegrationAccount, pause: boolean, reason: string) => Promise<boolean>
}) {
  const t = useT('admin-connections')
  const tAdmin = useT('admin')
  const [reason, setReason] = useState('')
  useEffect(() => setReason(''), [confirm?.accountId, confirm?.pause])
  if (!confirm || !account) return null
  const verb = confirm.pause ? 'pause' : 'resume'
  const name = t(`conn.provider.${account.provider}.name`)
  const short = reason.trim().length > 0 && reason.trim().length < 3
  return (
    <Modal
      open
      onClose={onClose}
      title={t(`conn.${verb}.title`, { name: account.label })}
      size="sm"
      busy={busy}
      footer={
        <>
          <Button onClick={onClose}>{tAdmin('common.cancel')}</Button>
          <Button variant={confirm.pause ? 'danger' : 'primary'} heldReason={busy ? tAdmin('common.saving') : short ? t('conn.reasonShort') : null} onClick={() => void onSwitch?.(account, confirm.pause, reason.trim())}>
            {t(`conn.${verb}.go`)}
          </Button>
        </>
      }
    >
      <div className="fw-adm-modal-body">
        {problem && <Banner tone="danger" title={tAdmin(problem)} />}
        <p className="fw-adm-intro">{t(`conn.${verb}.body`, { service: name })}</p>
        <p className="fw-adm-hint">{t(`conn.${verb}.undo`)}</p>
        <Field label={tAdmin('common.reason')} hint={tAdmin('common.reasonHint')} error={short ? t('conn.reasonShort') : undefined}>
          <Textarea rows={2} value={reason} onChange={(event) => setReason(event.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}
