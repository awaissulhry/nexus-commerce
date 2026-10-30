'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { MailCheck, MailX } from 'lucide-react'
import { Banner, EmptyState, Field, MetricStrip, Modal } from '@nexus/ui/components'
import { IdentityCell, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Pill, SegmentedControl, Tag, Textarea } from '@nexus/ui/primitives'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { OFFICE_PAGES } from '../../../../../shell/nav/office-nav'
import { leftCounts } from '../../../kit/bulk-model'
import { BulkReach, useKeysHelp, useLatest, useSelection } from '../../../kit/list'
import { PageNotice } from '../../../kit/parts'
import { BulkButton, FrameState } from '../../../shared/view/parts'
import { DELIVERY_STATES } from '@nexus/factory-domain/email-delivery/rules'
import type { BlockedAddress, DeliveryMail } from '../api'
import {
  ABOUT_FILTERS,
  blockedSelectable,
  hasComplaint,
  isState,
  linkKey,
  problemKeyOf,
  reasonProblem,
  recordHref,
  recordName,
  recordTypeKey,
  STATE_TONE,
  tileValue,
  unblockHeld,
  unblockReach,
  type DeliveryActions,
  type DeliveryModel,
} from '../model'

export type { DeliveryActions } from '../model'

/**
 * SCR-087 "Delivery log and blocked addresses" (design admin.connections sec:delivery; B-W2a-41, PLT-149), the section
 * under the mail domain: the tiles count the mail of the last 30 days by state (a tile filters the log), "Invoices" and
 * "Links" show the mail of invoices and the mail that carried a one-off link (a bounced invoice or link is never missed),
 * then the log (the list frame, read-only, newest first, "Show older") and the blocked addresses (the list frame with
 * real multi-select: Unblock N after ONE confirm with a reason; an unblocked row is the record of one and cannot be
 * ticked). Addresses are masked unless the person manages that company's mail. Draws one model; fetches nothing.
 */
export function DeliverySection({ model, actions, prefix, built = OFFICE_PAGES }: { model: DeliveryModel; actions?: DeliveryActions; prefix: string; built?: ReadonlySet<string> }) {
  const t = useT('admin-connections')
  const masked = (model.mails.items ?? []).some((mail) => !mail.fullAddresses) || (model.blocked.items ?? []).some((row) => !row.fullAddress)
  return (
    <section className="fw-adm-list-section" id="delivery" aria-labelledby="conn-delivery">
      <div className="fw-adm-head-text">
        <h2 id="conn-delivery" className="fw-adm-list-h2">
          {t('conn.delivery.title')}
        </h2>
        <p className="fw-adm-intro">{t('conn.delivery.intro')}</p>
        {masked && <p className="fw-adm-hint">{t('conn.delivery.masked')}</p>}
      </div>
      <PageNotice namespace="admin-connections" notice={model.notice} onDismiss={actions?.onDismissNotice} nameOf={(id) => (model.blocked.items ?? []).find((row) => row.id === id)?.address ?? id} />
      <MetricStrip
        metrics={DELIVERY_STATES.map((state) => ({
          label: t(`conn.delivery.tile.${state}`),
          value: tileValue(model.counts, state),
          hint: t(`conn.delivery.tileHint.${state}`),
          active: model.filter === state,
          onClick: () => actions?.onFilter?.(model.filter === state ? null : state),
        }))}
      />
      <MailLog model={model} actions={actions} prefix={prefix} built={built} />
      <BlockedList model={model} actions={actions} prefix={prefix} built={built} />
      <UnblockConfirm model={model} actions={actions} />
    </section>
  )
}

/** "Quote Q-2026-0012" as a link to its record, what kind of mail it was, and the link it carried. */
export function MessageCell({ mail, prefix, built = OFFICE_PAGES }: { mail: DeliveryMail; prefix: string; built?: ReadonlySet<string> }) {
  const t = useT('admin-connections')
  if (mail.kind === 'SIGN_IN') return <IdentityCell noImage title={t('conn.delivery.kind.SIGN_IN')} titleAttr={t('conn.delivery.kind.SIGN_IN')} sub={t('conn.delivery.person')} />
  if (mail.kind === 'DIGEST') {
    const title = t('conn.delivery.kind.DIGEST')
    return <IdentityCell noImage title={title} titleAttr={title} sub={t('conn.delivery.digestCarried', { count: mail.notifications ?? 0 })} />
  }
  const record = mail.record
  const href = recordHref(prefix, record, mail.companyId, built)
  const title = record ? recordName(record) : t('conn.delivery.kind.RECORD')
  return (
    <IdentityCell
      noImage
      title={title}
      titleAttr={title}
      {...(href ? { href } : {})}
      sub={
        <span className="fw-adm-inline">
          <span>{record ? t(recordTypeKey(record.type)) : t('conn.delivery.noRecord')}</span>
          {mail.link && <Tag tone="info">{t(linkKey(mail.link))}</Tag>}
        </span>
      }
    />
  )
}

/** The recipients as the API gives them (masked unless the person manages the company's mail); hidden copies counted. */
export function ToCell({ mail }: { mail: DeliveryMail }) {
  const t = useT('admin-connections')
  const hidden = Math.max(0, mail.recipients - mail.to.length)
  const text = mail.to.join(', ')
  return (
    <span className="fw-adm-two" title={mail.fullAddresses ? text : t('conn.delivery.maskedHint')}>
      <span className="fw-adm-ellipsis fw-adm-code">{text || '—'}</span>
      {hidden > 0 && <span className="fw-adm-hint">{t('conn.delivery.hidden', { count: hidden })}</span>}
    </span>
  )
}

/** Where the mail is, as a pill. */
export function StatePill({ mail }: { mail: Pick<DeliveryMail, 'state'> }) {
  const t = useT('admin-connections')
  return <Pill tone={STATE_TONE[mail.state]}>{t(`conn.delivery.state.${mail.state}`)}</Pill>
}

/** What went wrong, in words, and what the provider said (data, quoted). */
export function ProblemCell({ mail }: { mail: DeliveryMail }) {
  const t = useT('admin-connections')
  const key = problemKeyOf(mail)
  if (!key && !mail.problem) return <span className="fw-adm-hint">—</span>
  return (
    <span className="fw-adm-two">
      {key && <span>{t(key)}</span>}
      {mail.problem && (
        <q className="fw-adm-conn-error" title={mail.problem}>
          {mail.problem}
        </q>
      )}
    </span>
  )
}

function useMailColumns(prefix: string, built: ReadonlySet<string>): ColDef<DeliveryMail>[] {
  const t = useT('admin-connections')
  const locale = useLocale()
  return useMemo<ColDef<DeliveryMail>[]>(
    () => [
      { colId: 'message', headerName: t('conn.delivery.col.message'), flex: 1.6, minWidth: 190, cellRenderer: ({ data }: ICellRendererParams<DeliveryMail>) => (data ? <MessageCell mail={data} prefix={prefix} built={built} /> : null) },
      { colId: 'to', headerName: t('conn.delivery.col.to'), flex: 1.5, minWidth: 170, cellRenderer: ({ data }: ICellRendererParams<DeliveryMail>) => (data ? <ToCell mail={data} /> : null) },
      { colId: 'state', headerName: t('conn.delivery.col.state'), flex: 0.9, minWidth: 120, cellRenderer: ({ data }: ICellRendererParams<DeliveryMail>) => (data ? <StatePill mail={data} /> : null) },
      { colId: 'at', headerName: t('conn.delivery.col.at'), flex: 1, minWidth: 140, valueGetter: ({ data }) => (data ? formatDateTime(data.at, { locale }) : '') },
      { colId: 'problem', headerName: t('conn.delivery.col.problem'), flex: 1.7, minWidth: 180, cellRenderer: ({ data }: ICellRendererParams<DeliveryMail>) => (data ? <ProblemCell mail={data} /> : null) },
    ],
    [t, locale, prefix, built],
  )
}

/** The log: read-only, newest first; a filter in its tools; "Show older" in the footer. */
function MailLog({ model, actions, prefix, built }: { model: DeliveryModel; actions?: DeliveryActions; prefix: string; built: ReadonlySet<string> }) {
  const t = useT('admin-connections')
  const tAdmin = useT('admin')
  const columns = useMailColumns(prefix, built)
  const { onHelp, help } = useKeysHelp([], false)
  const mails = model.mails.items
  const filter = model.filter
  const clear = () => actions?.onFilter?.(null)
  const state: ReactNode = model.mails.problem && !mails ? (
    <FrameState problem={model.mails.problem} onRetry={actions?.onRetry} />
  ) : mails && mails.length === 0 ? (
    filter ? (
      <EmptyState
        title={t('conn.delivery.noneFiltered')}
        action={
          <Button size="sm" onClick={clear}>
            {tAdmin('list.clearFilter')}
          </Button>
        }
      />
    ) : (
      <EmptyState icon={<MailCheck size={20} aria-hidden />} title={t('conn.delivery.emptyTitle')} description={t('conn.delivery.emptyBody')} />
    )
  ) : undefined
  return (
    <>
      <ListFrame<DeliveryMail>
        label={t('conn.delivery.tableLabel')}
        rows={model.mails.problem && !mails ? [] : mails}
        rowId={(mail) => mail.id}
        columns={columns}
        count={mails ? t('conn.delivery.count', { count: mails.length }) : '—'}
        tools={
          <>
            {ABOUT_FILTERS.map((about) => (
              <Button key={about} size="sm" variant={filter === about ? 'primary' : 'secondary'} aria-pressed={filter === about} onClick={() => actions?.onFilter?.(filter === about ? null : about)}>
                {t(`conn.delivery.about.${about}`)}
              </Button>
            ))}
            {filter && isState(filter) && <Tag tone="info">{t('conn.delivery.filtered', { state: t(`conn.delivery.tile.${filter}`) })}</Tag>}
            {filter && (
              <Button size="sm" variant="quiet" onClick={clear}>
                {tAdmin('list.clearFilter')}
              </Button>
            )}
          </>
        }
        more={model.mails.more ? { label: t('conn.delivery.more'), onMore: () => actions?.onMore?.(), held: model.mails.loadingMore ? t('conn.delivery.loadingMore') : null } : null}
        onHelp={onHelp}
        listKey="admin.connections.delivery"
        state={state}
      />
      {model.mails.problem && mails && <Banner tone="danger" title={tAdmin(model.mails.problem)} />}
      {help}
    </>
  )
}

/** Why an address is blocked, in words, and what the provider said (data, quoted). */
export function WhyCell({ row }: { row: BlockedAddress }) {
  const t = useT('admin-connections')
  return (
    <span className="fw-adm-two">
      <span>{t(`conn.blocked.reason.${row.reason}`)}</span>
      {row.detail && (
        <q className="fw-adm-conn-error" title={row.detail}>
          {row.detail}
        </q>
      )}
    </span>
  )
}

/** The mail that blocked it, as a link to its record; "—" when none (a person stopped it) or not the person's to see. */
export function BlockedMailCell({ row, prefix, built = OFFICE_PAGES }: { row: BlockedAddress; prefix: string; built?: ReadonlySet<string> }) {
  const t = useT('admin-connections')
  const record = row.mail?.record ?? null
  if (!row.mail || !record) return <span className="fw-adm-hint">{row.mail ? t('conn.delivery.kind.RECORD') : '—'}</span>
  const href = recordHref(prefix, record, row.mail.companyId, built)
  const title = record.type === 'User' ? t('conn.delivery.kind.SIGN_IN') : recordName(record)
  return <IdentityCell noImage title={title} titleAttr={title} {...(href ? { href } : {})} sub={record.type === 'User' ? t('conn.delivery.person') : t(recordTypeKey(record.type))} />
}

/** Unblocked: when, and the reason the person gave. */
export function UnblockedCell({ row }: { row: BlockedAddress }) {
  const t = useT('admin-connections')
  const locale = useLocale()
  if (!row.unblocked) return <span className="fw-adm-hint">—</span>
  return (
    <span className="fw-adm-two">
      <span>{t('conn.blocked.unblockedOn', { at: formatDateTime(row.unblocked.at, { locale }) })}</span>
      {row.unblocked.reason && <span className="fw-adm-hint">{row.unblocked.reason}</span>}
    </span>
  )
}

function useBlockedColumns(model: Pick<DeliveryModel, 'blockedView' | 'canUnblock'>, prefix: string, built: ReadonlySet<string>, actions?: DeliveryActions): ColDef<BlockedAddress>[] {
  const t = useT('admin-connections')
  const locale = useLocale()
  const latest = useLatest(actions)
  const unblocked = model.blockedView === 'UNBLOCKED'
  const held = model.canUnblock ? null : t('conn.blocked.heldRight')
  return useMemo<ColDef<BlockedAddress>[]>(
    () => [
      {
        colId: 'address',
        headerName: t('conn.blocked.col.address'),
        flex: 1.5,
        minWidth: 180,
        cellRenderer: ({ data }: ICellRendererParams<BlockedAddress>) =>
          data ? (
            <span className="fw-adm-ellipsis fw-adm-code" title={data.fullAddress ? data.address : t('conn.delivery.maskedHint')}>
              {data.address}
            </span>
          ) : null,
      },
      { colId: 'why', headerName: t('conn.blocked.col.why'), flex: 1.8, minWidth: 200, cellRenderer: ({ data }: ICellRendererParams<BlockedAddress>) => (data ? <WhyCell row={data} /> : null) },
      { colId: 'since', headerName: t('conn.blocked.col.since'), flex: 1, minWidth: 140, valueGetter: ({ data }) => (data ? formatDateTime(data.at, { locale }) : '') },
      { colId: 'mail', headerName: t('conn.blocked.col.mail'), flex: 1.3, minWidth: 160, cellRenderer: ({ data }: ICellRendererParams<BlockedAddress>) => (data ? <BlockedMailCell row={data} prefix={prefix} built={built} /> : null) },
      unblocked
        ? { colId: 'unblocked', headerName: t('conn.blocked.col.unblocked'), flex: 1.4, minWidth: 180, cellRenderer: ({ data }: ICellRendererParams<BlockedAddress>) => (data ? <UnblockedCell row={data} /> : null) }
        : {
            colId: 'actions',
            headerName: t('conn.blocked.col.actions'),
            flex: 0.8,
            minWidth: 130,
            sortable: false,
            cellRenderer: ({ data }: ICellRendererParams<BlockedAddress>) =>
              data && !data.unblocked ? (
                <Button size="sm" variant="quiet" heldReason={held} aria-label={t('conn.blocked.unblockOne', { address: data.address })} onClick={() => latest.current?.onConfirm?.([data.id])}>
                  {t('conn.blocked.unblock')}
                </Button>
              ) : null,
          },
    ],
    [t, locale, prefix, built, unblocked, held, latest],
  )
}

/** The blocked addresses (or the unblocked ones): tick to unblock several after one confirm. */
function BlockedList({ model, actions, prefix, built }: { model: DeliveryModel; actions?: DeliveryActions; prefix: string; built: ReadonlySet<string> }) {
  const t = useT('admin-connections')
  const tAdmin = useT('admin')
  const rows = model.blocked.items
  const unblockedView = model.blockedView === 'UNBLOCKED'
  const { selected, onChange } = useSelection(model.selected, actions?.onSelect, (rows ?? []).map((row) => row.id))
  const columns = useBlockedColumns(model, prefix, built, actions)
  const { onHelp, help } = useKeysHelp([], !unblockedView)
  const picked = (rows ?? []).filter((row) => selected.includes(row.id))
  const reach = unblockReach(picked)
  const heldKey = unblockHeld(reach, model.canUnblock)
  const state: ReactNode = model.blocked.problem && !rows ? (
    <FrameState problem={model.blocked.problem} onRetry={actions?.onBlockedRetry} />
  ) : rows && rows.length === 0 ? (
    <EmptyState icon={<MailCheck size={20} aria-hidden />} title={t(unblockedView ? 'conn.blocked.noneUnblocked' : 'conn.blocked.emptyTitle')} description={unblockedView ? undefined : t('conn.blocked.emptyBody')} />
  ) : undefined
  return (
    <div className="fw-adm-list-section" aria-labelledby="conn-blocked">
      <div className="fw-adm-head-text">
        <h3 id="conn-blocked" className="fw-adm-list-h2">
          {t('conn.blocked.title')}
        </h3>
        <p className="fw-adm-intro">{t('conn.blocked.intro')}</p>
      </div>
      <ListFrame<BlockedAddress>
        label={t('conn.blocked.tableLabel')}
        rows={model.blocked.problem && !rows ? [] : rows}
        rowId={(row) => row.id}
        columns={columns}
        isRowSelectable={(row) => {
          const why = blockedSelectable(row)
          return why ? t(why) : null
        }}
        count={rows ? t(unblockedView ? 'conn.blocked.countUnblocked' : 'conn.blocked.count', { count: rows.length }) : '—'}
        tools={
          <SegmentedControl
            ariaLabel={t('conn.blocked.viewLabel')}
            size="sm"
            value={model.blockedView}
            onChange={(value) => actions?.onBlockedView?.(value === 'UNBLOCKED' ? 'UNBLOCKED' : 'BLOCKED')}
            options={[
              { value: 'BLOCKED', label: t('conn.blocked.view.BLOCKED') },
              { value: 'UNBLOCKED', label: t('conn.blocked.view.UNBLOCKED') },
            ]}
          />
        }
        {...(unblockedView
          ? {}
          : {
              selection: {
                selected,
                onChange,
                actions: (
                  <BulkButton
                    icon={<MailX size={13} aria-hidden />}
                    label={t('conn.blocked.unblockMany', { count: reach.applies.length })}
                    held={heldKey ? t(heldKey) : null}
                    onClick={() => actions?.onConfirm?.(selected)}
                  />
                ),
              },
            })}
        more={model.blocked.more ? { label: t('conn.delivery.more'), onMore: () => actions?.onBlockedMore?.(), held: model.blocked.loadingMore ? t('conn.delivery.loadingMore') : null } : null}
        onHelp={onHelp}
        listKey="admin.connections.blocked"
        state={state}
      />
      {model.blocked.problem && rows && <Banner tone="danger" title={tAdmin(model.blocked.problem)} />}
      {!model.canUnblock && !unblockedView && rows && rows.length > 0 && <p className="fw-adm-hint">{t('conn.blocked.heldRight')}</p>}
      {help}
    </div>
  )
}

/**
 * Unblock one or several addresses after ONE confirm: what changes (mail may reach them again; a later bounce blocks them
 * again), the addresses by name, the selected ones left out and why, a warning when a recipient complained, and the
 * reason (required, kept with each change).
 */
function UnblockConfirm({ model, actions }: { model: DeliveryModel; actions?: DeliveryActions }) {
  const t = useT('admin-connections')
  const tAdmin = useT('admin')
  const [reason, setReason] = useState('')
  const [touched, setTouched] = useState(false)
  const ids = model.confirm ?? null
  const key = ids ? ids.join('|') : ''
  useEffect(() => {
    setReason('')
    setTouched(false)
  }, [key])
  if (!ids) return null
  const chosen = ids.flatMap((id) => (model.blocked.items ?? []).filter((row) => row.id === id))
  const reach = unblockReach(chosen)
  const count = reach.applies.length
  const problem = reasonProblem(reason)
  const heldKey = unblockHeld(reach, model.canUnblock)
  const held = heldKey ? t(heldKey) : model.busy ? tAdmin('common.saving') : problem ? t(problem) : null
  const close = () => actions?.onConfirm?.(null)
  return (
    <Modal
      open
      onClose={close}
      title={t('conn.blocked.confirmTitle', { count })}
      size="md"
      busy={model.busy}
      footer={
        <>
          <Button onClick={close}>{tAdmin('common.cancel')}</Button>
          <Button variant="primary" heldReason={held} onClick={() => void actions?.onUnblock?.(reach.applies, reason.trim())}>
            {t('conn.blocked.confirmGo', { count })}
          </Button>
        </>
      }
    >
      <div className="fw-adm-modal-body">
        {model.dialogProblem && <Banner tone="danger" title={tAdmin(model.dialogProblem)} />}
        <p className="fw-adm-intro">{t('conn.blocked.confirmBody')}</p>
        {hasComplaint(reach.applies) && (
          <Banner tone="warning" title={t('conn.blocked.complaintTitle')}>
            {t('conn.blocked.complaintBody')}
          </Banner>
        )}
        <BulkReach label={t('conn.blocked.listLabel')} names={reach.applies.map((row) => row.address)} left={leftCounts(reach).map((entry) => ({ ...entry, words: t(entry.why, { count: entry.count }) }))} />
        <p className="fw-adm-hint">{t('conn.blocked.confirmAgain')}</p>
        <Field label={t('conn.blocked.reasonLabel')} hint={t('conn.blocked.reasonHint')} error={touched && problem ? t(problem) : undefined} required>
          <Textarea rows={2} value={reason} onBlur={() => setTouched(true)} onChange={(event) => setReason(event.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}
