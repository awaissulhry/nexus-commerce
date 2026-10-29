'use client'

import { useEffect, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { MoreHorizontal, Search } from 'lucide-react'
import { Banner, Card, Field, Menu, MetricStrip, Modal, SummaryTable } from '@nexus/ui/components'
import { Button, Input, Pill, Tag, Textarea } from '@nexus/ui/primitives'
import { formatDateTime, formatTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { adminHref, pageOf } from '../../shared/model'
import { dash, ListState, ListTable, PageHead } from '../../shared/view/parts'
import type { IntegrationAccount, IntegrationProvider } from '../api'
import { MailDomainSection, type MailDomainActions } from '../mail/view/MailDomainSection'
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
  tileMatch,
  type ConnectionsViewModel,
  type ConnectionTile,
  type PauseConfirm,
} from '../model'
import { ConnectionsMessages, ConnNotice, ConnStepUp } from './parts'

export type { ConnectionsViewModel } from '../model'

export interface ConnectionsActions {
  onTile?: (tile: ConnectionTile | null) => void
  onQuery?: (query: string) => void
  onPage?: (page: number) => void
  onRetry?: () => void
  onConnect?: (open: boolean) => void
  onConfirm?: (confirm: PauseConfirm | null) => void
  onSwitch?: (account: IntegrationAccount, pause: boolean, reason: string) => Promise<boolean>
  onDismissNotice?: () => void
  onStepUp?: (code: string) => void
  onStepUpClose?: () => void
  mail?: MailDomainActions
}

/**
 * SCR-087 — Admin › Connections & API (design 02 admin.connections; PLT-139, PLT-195, PLT-197, PLT-011): every rented
 * service in one list, said for an owner — what it is for, whether it works, in which mode (Fake and Test reach nobody:
 * the page says so on top) — with a "Not connected" row for each service nobody connected; the mail domain (SCR-015,
 * `#mail`); where the data lives, from what the connections themselves say. Pause and resume after a confirm. Connecting
 * a service is held in words (no route adds one yet). `c` opens the catalogue. Fetches nothing (ConnectionsPage.tsx).
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

function Connections({ model, actions }: { model: ConnectionsViewModel; actions?: ConnectionsActions }) {
  const t = useT('admin-connections')
  const tAdmin = useT('admin')
  const href = (path: string) => adminHref(model.prefix, path)
  const stateWords = useStateWords(model.now)
  const providerName = (provider: IntegrationProvider) => t(`conn.provider.${provider}.name`)
  const companyName = (id: string | null) => (id === null ? t('conn.everyCompany') : (model.companies?.find((company) => company.id === id)?.name ?? null))

  // c: connect a service (when no field has the focus and no dialog is open), as the design's keyboard says.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.metaKey || event.ctrlKey || event.altKey || model.connect || model.confirm || model.mail?.add) return
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
  const rows = accounts ? serviceRows(accounts, model.companies, model.tile, model.query, providerName) : []
  const paged = pageOf(rows, model.page)
  const confirming = model.confirm ? (accounts ?? []).find((account) => account.id === model.confirm!.accountId) ?? null : null
  const manageHeld = model.can.manage ? null : tAdmin('held.needs', { right: t('conn.right.manage') })

  const table: Array<{ id: string; cells: ReactNode[] }> = paged.rows.map((row) => {
    if (row.kind === 'missing') {
      return {
        id: row.id,
        cells: [
          <span key="service" className="fw-adm-cell">
            <span className="fw-adm-name">{providerName(row.provider)}</span>
            <Tag>{t('conn.notConnected')}</Tag>
          </span>,
          t(`conn.provider.${row.provider}.for`),
          dash(companyName(row.companyId)),
          '—',
          <span key="state" className="fw-adm-hint">
            {t('conn.notConnectedHint')}
          </span>,
          '—',
          '—',
          <Button key="connect" size="sm" variant="quiet" onClick={() => actions?.onConnect?.(true)}>
            {t('conn.connect.row')}
          </Button>,
        ],
      }
    }
    const account = row.account
    const state = stateWords(account)
    const region = account.settings.region
    return {
      id: row.id,
      cells: [
        <span key="service" className="fw-adm-cell">
          <Link className="fw-adm-name" href={href(`/connections/${account.id}`)}>
            {providerName(account.provider)}
          </Link>
          <span className="fw-adm-hint">
            {account.label} · <span className="fw-adm-code">{account.code}</span>
          </span>
        </span>,
        t(`conn.provider.${account.provider}.for`),
        dash(companyName(account.companyId)),
        <Pill key="mode" tone={MODE_TONE[account.mode]}>
          {t(`conn.mode.${account.mode}`)}
        </Pill>,
        <span key="state" className="fw-adm-cell">
          <Pill tone={state.tone}>{state.words}</Pill>
          {state.key === 'failing' && account.lastError && (
            <>
              <span className="fw-adm-hint">{t('conn.lastErrorSaid')}</span>
              <q className="fw-adm-conn-error">{account.lastError}</q>
            </>
          )}
        </span>,
        <span key="calls" className="fw-adm-cell">
          <span>{t('conn.callCount', { count: account.calls24h.total })}</span>
          {account.calls24h.failed > 0 && <Tag tone="danger">{t('conn.callsFailed', { count: account.calls24h.failed })}</Tag>}
          {account.inboundWaiting > 0 && <Tag tone="info">{t('conn.waiting', { count: account.inboundWaiting })}</Tag>}
        </span>,
        typeof region === 'string' && region ? <span className="fw-adm-code">{region}</span> : '—',
        <Menu
          key="more"
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
                    disabled: !model.can.manage,
                    description: manageHeld ?? undefined,
                    onSelect: () => actions?.onConfirm?.({ accountId: account.id, pause: account.status === 'ACTIVE' }),
                  },
                ]
              : []),
          ]}
        />,
      ],
    }
  })

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
      <ConnNotice notice={model.notice} onDismiss={actions?.onDismissNotice} />
      <MetricStrip
        metrics={CONNECTION_TILES.map((tile) => ({
          label: t(`conn.tile.${tile}`),
          value: accounts ? String(live.filter((account) => tileMatch(tile, account)).length) : '—',
          hint: t(`conn.tileHint.${tile}`),
          active: model.tile === tile,
          onClick: () => actions?.onTile?.(model.tile === tile ? null : tile),
        }))}
      />
      <div className="fw-adm-toolbar">
        <span className="fw-adm-toolbar-search">
          <Input size="sm" fieldClassName="fw-adm-fill" type="search" leadingIcon={<Search size={14} aria-hidden />} aria-label={t('conn.search')} placeholder={t('conn.search')} value={model.query} onChange={(event) => actions?.onQuery?.(event.target.value)} />
        </span>
        {model.tile && (
          <span className="fw-adm-tags">
            <Tag tone="info">{t('conn.filtered', { tile: t(`conn.tile.${model.tile}`) })}</Tag>
            <Button size="sm" variant="quiet" onClick={() => actions?.onTile?.(null)}>
              {tAdmin('list.clearFilter')}
            </Button>
          </span>
        )}
      </div>
      {model.accounts.problem || accounts === null ? (
        <ListState problem={model.accounts.problem} loading={accounts === null} onRetry={actions?.onRetry} />
      ) : rows.length === 0 && live.length > 0 ? (
        <ListState
          loading={false}
          empty={{
            title: tAdmin('list.noMatch'),
            action: (
              <Button
                size="sm"
                onClick={() => {
                  actions?.onQuery?.('')
                  actions?.onTile?.(null)
                }}
              >
                {tAdmin('list.clearFilters')}
              </Button>
            ),
          }}
        />
      ) : (
        <>
          {live.length === 0 && <Banner tone="info" title={t('conn.empty.title')}>{t('conn.empty.body')}</Banner>}
          {rows.length > 0 && (
            <ListTable
              label={t('conn.tableLabel')}
              columns={[t('conn.col.service'), t('conn.col.for'), t('conn.col.company'), t('conn.col.mode'), t('conn.col.state'), t('conn.col.calls'), t('conn.col.region'), tAdmin('common.actions')]}
              widths={['15%', '19%', '12%', '7%', '17%', '11%', '8%', '11%']}
              rows={table}
              page={paged.page}
              pageCount={paged.pageCount}
              onPage={actions?.onPage}
              count={tAdmin('list.count', { shown: paged.rows.length, total: rows.length })}
            />
          )}
        </>
      )}
      {model.mail ? <MailDomainSection model={model.mail} actions={actions?.mail} prefix={model.prefix} /> : <Banner tone="info" title={t('mail.noRight')} />}
      <Residency model={model} />
      <p className="fw-adm-hint">{t('conn.later')}</p>
      <ConnectModal open={!!model.connect} accounts={live} onClose={() => actions?.onConnect?.(false)} />
      <SwitchConfirm confirm={model.confirm ?? null} account={confirming} busy={!!model.busy} problem={model.dialogProblem ?? null} onClose={() => actions?.onConfirm?.(null)} onSwitch={actions?.onSwitch} />
      <ConnStepUp model={model.stepUp} onSubmit={actions?.onStepUp} onClose={actions?.onStepUpClose} />
    </div>
  )
}

/** Where your data lives: only what the connections' own settings name (never a guessed region). */
function Residency({ model }: { model: ConnectionsViewModel }) {
  const t = useT('admin-connections')
  const accounts = model.accounts.items
  if (!accounts) return null
  const rows = residencyRows(accounts)
  return (
    <Card header={t('conn.residency.title')} description={t('conn.residency.intro')} headingLevel={2} padded>
      {rows.length === 0 ? (
        <p className="fw-adm-hint">{t('conn.residency.none')}</p>
      ) : (
        <SummaryTable
          label={t('conn.residency.title')}
          columns={[t('conn.col.service'), t('conn.residency.account'), t('conn.col.region'), t('conn.col.mode')]}
          align={['left', 'left', 'left', 'left']}
          stackOnPhone
          rows={rows.map((row) => ({
            id: row.id,
            cells: [t(`conn.provider.${row.provider}.name`), row.label, row.region ? <span className="fw-adm-code">{row.region}</span> : t('conn.residency.unknown'), t(`conn.mode.${row.mode}`)],
          }))}
        />
      )}
      <p className="fw-adm-hint">{t('conn.residency.later')}</p>
    </Card>
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
