'use client'

import { useMemo, useRef, type ReactNode } from 'react'
import { CalendarClock, MoreHorizontal, UserMinus, UserPlus } from 'lucide-react'
import { Banner, EmptyState, Field, Menu, type MenuItemDef } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Pill, SegmentedControl, Select, Toggle } from '@nexus/ui/primitives'
import { DateField, StepUpModal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { DialogFrame } from '../../../_shared/parts'
import type { Download, Firm } from '../api'
import { changeHeld, endHeld, inviteHeld, NS, rowHeld, STATUS_TONE, type AccountantRow, type InviteDraft } from '../model'
import '../accountant-access.css'

/**
 * Finance › Close › Accounting export: Accountant access (B-W2b-201; design finance.accounting "Portal › Accountant",
 * FIN-158, PLT-022). The company's accounting firm reads the numbered batches, the period's e-invoices and the registers in
 * its own guest portal — files only, read-only, until the day finance sets; every download recorded. Here: who has access
 * (the shared list frame: select-all, shift range, x / Space, "End access N"), Give access…, ⋯ Change the end…, End
 * access…, and the newest downloads. Every change asks a fresh authenticator code. No money here.
 */

export interface AccountantAccessModel {
  state: 'loading' | 'error' | 'ready'
  companyName: string
  firms: readonly Firm[]
  rows: readonly AccountantRow[] | null
  showLeft: boolean
  downloads: readonly Download[] | null
  may: boolean
  selected: readonly string[]
  /** The act running (a row id or `invite`), or null. */
  busy: string | null
  notice: { key: string; params?: Readonly<Record<string, string | number>>; tone: 'success' | 'danger' | 'info' } | null
  invite: { draft: InviteDraft; problems: Readonly<Record<string, string>>; problem: string | null; busy: boolean; today: string } | null
  change: { row: AccountantRow; until: string; problem: string | null; busy: boolean; today: string } | null
  end: { rows: readonly AccountantRow[]; reason: string; problem: string | null; busy: boolean } | null
  stepUp: { open: boolean; busy: boolean; problem: string | null }
  keysOpen?: boolean
}

export interface AccountantAccessActions {
  onRetry?: () => void
  onShowLeft?: (show: boolean) => void
  onSelect?: (ids: string[]) => void
  onOpenInvite?: () => void
  onInvite?: (draft: Partial<InviteDraft>) => void
  onSendInvite?: () => void
  onOpenChange?: (row: AccountantRow) => void
  onChangeUntil?: (until: string) => void
  onSendChange?: () => void
  onOpenEnd?: (rows: readonly AccountantRow[]) => void
  onEndReason?: (reason: string) => void
  onSendEnd?: () => void
  onClose?: () => void
  onDismissNotice?: () => void
  onStepUpSubmit?: (code: string) => void
  onStepUpCancel?: () => void
  onHelp?: () => void
}

export function AccountantAccessView({ model, actions }: { model: AccountantAccessModel; actions?: AccountantAccessActions }) {
  return (
    <WithMessages namespaces={[NS, 'finance', 'lists', 'ds-words']}>
      <AccessSection model={model} actions={actions} />
    </WithMessages>
  )
}

function AccessSection({ model, actions }: { model: AccountantAccessModel; actions?: AccountantAccessActions }) {
  const t = useT(NS)
  const tf = useT('finance')
  const locale = useLocale()
  const latest = useRef({ model, actions })
  latest.current = { model, actions }
  const columns = useMemo((): ColDef<AccountantRow>[] => {
    const Person = ({ data }: ICellRendererParams<AccountantRow>) =>
      data ? (
        <span className="fw-acca-two">
          <span className="fw-acca-ellipsis">{data.displayName}</span>
          <span className="fw-acca-sub fw-acca-ellipsis">{data.email}</span>
        </span>
      ) : null
    const Status = ({ data }: ICellRendererParams<AccountantRow>) =>
      data ? (
        <span className="fw-acca-line">
          <Pill tone={STATUS_TONE[data.status]}>{t(`office.status.${data.status}`)}</Pill>
          {data.status === 'INVITED' && data.invitationExpiresAt ? <span className="fw-acca-sub">{t('office.row.invitedUntil', { date: formatDateTime(data.invitationExpiresAt, { locale }) })}</span> : null}
        </span>
      ) : null
    const Ends = ({ data }: ICellRendererParams<AccountantRow>) =>
      data ? (
        <span className="fw-acca-line">
          <span>{data.accessUntil ? formatDateTime(data.accessUntil, { locale }) : '—'}</span>
          {data.ended ? <Pill tone="neutral">{t('office.row.ended')}</Pill> : data.endsSoon ? <Pill tone="warning">{t('office.row.endsSoon')}</Pill> : null}
        </span>
      ) : null
    const More = ({ data }: ICellRendererParams<AccountantRow>) => {
      if (!data) return null
      const now = latest.current
      const changeHold = changeHeld(data, now.model.may)
      const endHold = endHeld(data, now.model.may)
      const items: MenuItemDef[] = [
        { id: 'change', label: t('office.row.change'), disabled: changeHold !== null, description: changeHold ? t(changeHold) : undefined, onSelect: () => now.actions?.onOpenChange?.(data) },
        { id: 'end', label: t('office.row.end'), disabled: endHold !== null, description: endHold ? t(endHold) : undefined, onSelect: () => now.actions?.onOpenEnd?.([data]) },
      ]
      return <Menu align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': t('office.row.menu', { name: data.displayName }) }} items={items} />
    }
    return [
      { colId: 'person', headerName: t('office.col.person'), flex: 1.3, minWidth: 220, sortable: false, cellRenderer: Person, valueGetter: ({ data }) => data?.displayName ?? '' },
      { colId: 'firm', headerName: t('office.col.firm'), flex: 1, minWidth: 170, sortable: false, valueGetter: ({ data }) => data?.firmName ?? '' },
      { colId: 'status', headerName: t('office.col.status'), flex: 1, minWidth: 190, sortable: false, cellRenderer: Status, valueGetter: ({ data }) => (data ? t(`office.status.${data.status}`) : '') },
      { colId: 'ends', headerName: t('office.col.ends'), flex: 1, minWidth: 200, sortable: false, cellRenderer: Ends, valueGetter: ({ data }) => (data?.accessUntil ? formatDateTime(data.accessUntil, { locale }) : '') },
      { colId: 'signIn', headerName: t('office.col.lastSignIn'), flex: 0.9, minWidth: 160, sortable: false, valueGetter: ({ data }) => (data?.lastSignInAt ? formatDateTime(data.lastSignInAt, { locale }) : t('office.row.never')) },
      { colId: 'more', headerName: t('office.col.actions'), width: 72, minWidth: 72, maxWidth: 72, sortable: false, pinned: 'right', suppressHeaderMenuButton: true, cellRenderer: More },
    ]
  }, [t, locale])

  const downloadColumns = useMemo(
    (): ColDef<Download & { id: string }>[] => [
      { colId: 'at', headerName: t('office.downloads.at'), flex: 0.8, minWidth: 160, sortable: false, valueGetter: ({ data }) => (data ? formatDateTime(data.at, { locale }) : '') },
      { colId: 'who', headerName: t('office.downloads.who'), flex: 1, minWidth: 180, sortable: false, valueGetter: ({ data }) => (data ? [data.person, data.firm].filter(Boolean).join(' · ') : '') },
      { colId: 'what', headerName: t('office.downloads.what'), flex: 1.4, minWidth: 220, sortable: false, valueGetter: ({ data }) => (data ? (data.what === 'ZIP' ? t('office.downloads.zip', { count: data.files, name: data.name ?? '' }) : (data.name ?? '')) : '') },
      { colId: 'period', headerName: t('office.downloads.period'), flex: 0.6, minWidth: 120, sortable: false, valueGetter: ({ data }) => data?.period ?? '' },
    ],
    [t, locale],
  )

  const hold = inviteHeld(model.state === 'ready' ? { firms: model.firms, may: { manage: model.may } } : null)
  const chosen = (model.rows ?? []).filter((row) => model.selected.includes(row.id))
  const endAllHeld = !model.may ? t('office.held.noManage') : chosen.length === 0 ? t('office.held.choose') : chosen.some((row) => endHeld(row, true)) ? t('office.held.someLeft') : model.busy ? t('office.held.busy') : null
  const state: ReactNode =
    model.state === 'error' ? (
      <EmptyState title={t('office.failed')} description={t('office.failedBody')} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('state.retry')}</Button>} />
    ) : model.rows && model.rows.length === 0 ? (
      <EmptyState icon={<UserPlus size={24} aria-hidden />} title={t('office.empty')} description={model.firms.length === 0 ? t('office.noFirm') : t('office.emptyBody')} />
    ) : undefined

  return (
    <section className="fw-acca" aria-labelledby="fw-acca-title">
      <div className="fw-acca-head">
        <div className="fw-acca-headtext">
          <h2 id="fw-acca-title" className="fw-acca-h2">
            {t('office.title')}
          </h2>
          <p className="fw-acca-sub">{t('office.hint', { company: model.companyName })}</p>
        </div>
        <Button size="sm" heldReason={hold ? t(hold) : model.busy ? t('office.held.busy') : null} onClick={() => actions?.onOpenInvite?.()}>
          <UserPlus size={14} aria-hidden /> {t('office.give')}
        </Button>
      </div>
      {model.notice ? <Banner tone={model.notice.tone} title={t(model.notice.key, model.notice.params)} action={<Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>{t('notice.hide')}</Button>} /> : null}
      <ListFrame<AccountantRow>
        label={t('office.listLabel')}
        title={t('office.title')}
        listKey={null}
        rows={model.state === 'error' ? [] : model.rows}
        rowId={(row) => row.id}
        columns={columns}
        count={model.rows && model.state !== 'error' ? t('office.count', { count: model.rows.length }) : ''}
        tools={
          <label className="fw-acca-toggle">
            <Toggle size="sm" checked={model.showLeft} onChange={(next) => actions?.onShowLeft?.(next)} aria-label={t('office.showLeft')} />
            <span>{t('office.showLeft')}</span>
          </label>
        }
        selection={{
          selected: model.selected,
          onChange: (ids) => actions?.onSelect?.(ids),
          actions: (
            <Button size="sm" heldReason={endAllHeld} onClick={() => actions?.onOpenEnd?.(chosen)} aria-label={t('office.bulkEnd', { count: chosen.length })}>
              <UserMinus size={13} aria-hidden /> <SelectionLabel>{t('office.bulkEnd', { count: chosen.length })}</SelectionLabel>
            </Button>
          ),
        }}
        isRowSelectable={(row) => {
          const key = rowHeld(row)
          return key ? t(key) : null
        }}
        keys={[{ keys: ['Enter'], does: t('office.keys.change') }]}
        onHelp={actions?.onHelp}
        onOpen={(row) => {
          if (!changeHeld(row, model.may)) actions?.onOpenChange?.(row)
        }}
        state={state}
        cards={{}}
        keysOpen={model.keysOpen}
      />
      <div className="fw-acca-head">
        <div className="fw-acca-headtext">
          <h3 className="fw-acca-h3">{t('office.downloads.title')}</h3>
          <p className="fw-acca-sub">{t('office.downloads.hint')}</p>
        </div>
      </div>
      <ListFrame<Download & { id: string }>
        label={t('office.downloads.title')}
        title={t('office.downloads.title')}
        listKey={null}
        rows={model.downloads ? model.downloads.map((row, index) => ({ ...row, id: `${row.at}-${index}` })) : null}
        rowId={(row) => row.id}
        columns={downloadColumns}
        count={model.downloads ? t('office.downloads.count', { count: model.downloads.length }) : ''}
        state={model.downloads && model.downloads.length === 0 ? <EmptyState icon={<CalendarClock size={24} aria-hidden />} title={t('office.downloads.empty')} /> : undefined}
        cards={{}}
        onHelp={actions?.onHelp}
      />

      {model.invite ? <InviteDialog model={model} actions={actions} /> : null}
      {model.change ? (
        <DialogFrame
          title={t('office.change.title', { name: model.change.row.displayName })}
          held={model.change.busy ? t('office.held.busy') : !model.change.until ? t('office.invite.problem.until') : model.change.until < model.change.today ? t('office.invite.problem.past') : null}
          go={() => actions?.onSendChange?.()}
          goLabel={t('office.change.go')}
          onClose={() => actions?.onClose?.()}
          problem={model.change.problem ? { key: `${NS}:${model.change.problem}` } : null}
        >
          <p className="fw-acca-sub">{t('office.change.body')}</p>
          <Field label={t('office.invite.until')} required>
            <DateField value={model.change.until} min={model.change.today} locale={locale === 'it' ? 'it-IT' : 'en-GB'} ariaLabel={t('office.invite.until')} placeholder={t('office.invite.datePlaceholder')} clearLabel={t('office.invite.dateClear')} onChange={(value) => actions?.onChangeUntil?.(value ?? '')} />
          </Field>
        </DialogFrame>
      ) : null}
      {model.end ? (
        <DialogFrame
          title={t('office.end.title', { count: model.end.rows.length, name: model.end.rows[0]?.displayName ?? '' })}
          held={model.end.busy ? t('office.held.busy') : null}
          go={() => actions?.onSendEnd?.()}
          goLabel={t('office.end.go', { count: model.end.rows.length })}
          tone="danger"
          onClose={() => actions?.onClose?.()}
          problem={model.end.problem ? { key: `${NS}:${model.end.problem}` } : null}
        >
          <p className="fw-acca-sub">{t('office.end.body')}</p>
          <Field label={t('office.end.reason')}>
            <Textarea value={model.end.reason} maxLength={500} rows={2} onChange={(event) => actions?.onEndReason?.(event.target.value)} />
          </Field>
        </DialogFrame>
      ) : null}
      <StepUpModal
        open={model.stepUp.open}
        title={tf('stepUp.title')}
        sentence={t('office.stepUp')}
        busy={model.stepUp.busy}
        error={model.stepUp.problem ? tf(model.stepUp.problem) : null}
        onSubmit={(code) => actions?.onStepUpSubmit?.(code)}
        onClose={() => actions?.onStepUpCancel?.()}
        confirmLabel={tf('stepUp.confirm')}
      />
    </section>
  )
}

function InviteDialog({ model, actions }: { model: AccountantAccessModel; actions?: AccountantAccessActions }) {
  const t = useT(NS)
  const locale = useLocale()
  const invite = model.invite!
  const first = Object.values(invite.problems)[0]
  const firm = model.firms.find((entry) => entry.party.id === invite.draft.partyId)
  return (
    <DialogFrame
      title={t('office.invite.title')}
      held={invite.busy ? t('office.held.busy') : first ? t(first) : null}
      go={() => actions?.onSendInvite?.()}
      goLabel={t('office.invite.go')}
      onClose={() => actions?.onClose?.()}
      problem={invite.problem ? { key: `${NS}:${invite.problem}` } : null}
    >
      <p className="fw-acca-sub">{t('office.invite.body')}</p>
      <Field label={t('office.invite.firm')} required>
        <Select size="sm" value={invite.draft.partyId} onChange={(event) => actions?.onInvite?.({ partyId: event.target.value })} aria-label={t('office.invite.firm')}>
          <option value="">{t('office.invite.chooseFirm')}</option>
          {model.firms.map((entry) => (
            <option key={entry.party.id} value={entry.party.id}>
              {entry.party.name}
            </option>
          ))}
        </Select>
      </Field>
      {firm?.party.everyCompany ? <Banner tone="warning" title={t('office.invite.everyCompany', { firm: firm.party.name })} /> : null}
      <Field label={t('office.invite.name')} required>
        <Input size="sm" value={invite.draft.displayName} maxLength={120} autoComplete="off" onChange={(event) => actions?.onInvite?.({ displayName: event.target.value })} />
      </Field>
      <Field label={t('office.invite.email')} required>
        <Input size="sm" type="email" value={invite.draft.email} maxLength={254} autoComplete="off" onChange={(event) => actions?.onInvite?.({ email: event.target.value })} />
      </Field>
      <Field label={t('office.invite.language')}>
        <SegmentedControl
          size="sm"
          ariaLabel={t('office.invite.language')}
          value={invite.draft.locale}
          onChange={(value) => actions?.onInvite?.({ locale: value === 'en' ? 'en' : 'it' })}
          options={[
            { value: 'it', label: t('office.invite.it') },
            { value: 'en', label: t('office.invite.en') },
          ]}
        />
      </Field>
      <Field label={t('office.invite.until')} required>
        <DateField value={invite.draft.until} min={invite.today} locale={locale === 'it' ? 'it-IT' : 'en-GB'} ariaLabel={t('office.invite.until')} placeholder={t('office.invite.datePlaceholder')} clearLabel={t('office.invite.dateClear')} onChange={(value) => actions?.onInvite?.({ until: value ?? '' })} />
      </Field>
      <p className="fw-acca-sub">{t('office.invite.what')}</p>
    </DialogFrame>
  )
}
