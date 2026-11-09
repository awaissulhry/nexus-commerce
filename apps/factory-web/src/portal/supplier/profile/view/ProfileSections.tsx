'use client'

import { useMemo } from 'react'
import { Archive, MessageCircle, MoreHorizontal, Plus, Undo2 } from 'lucide-react'
import { Banner, EmptyState, Field, KeyValue, Menu } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Pill } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { AccountCard, type CardState } from '../../../shared/account/view/AccountCard'
import { dayWriter } from '../../orders/words'
import type { ChangeRequest, SupplierProfile } from '../api'
import { changeLines, LINE_TONE, NS, REQUEST_TONE, type AddressLine, type ContactLine } from '../model'

/**
 * SCR-191's own sections (design portal.supplier.profile sec:company, sec:contacts; SCM-097): the company (legal name and
 * VAT read-only — a new tax identity is ours to record —, the website, the registered office and pickup addresses) and the
 * contacts who handle orders, invoices and quality, both on the shared list frame (select-all, x / Space, Remove N;
 * cards on a phone). A change is typed here and sent for our check with the page's one "Send changes for our check";
 * until a buyer approves it nothing changes on our side ("Waiting for our check since …"). The Admin changes; everyone
 * else reads and is told who can.
 */

type Say = (key: string, params?: Readonly<Record<string, string | number>>) => string

export interface CompanyModel {
  state: CardState
  company: SupplierProfile['company'] | null
  /** The website as typed (or as saved). */
  website: string
  websiteChanged: boolean
  websiteProblem: string | null
  addresses: readonly AddressLine[]
  selected: readonly string[]
  /** Why a change waits for everyone (a key: a preview, not the admin, offline), or null. */
  held: string | null
  admins: readonly string[]
}

export interface CompanyActions {
  onWebsite?: (value: string) => void
  onAdd?: () => void
  onEdit?: (row: AddressLine) => void
  onRemove?: (rows: readonly AddressLine[]) => void
  onUndo?: (row: AddressLine) => void
  onSelected?: (ids: string[]) => void
  onRetry?: () => void
  onAsk?: () => void
}

/** A held key in words (who sends changes). */
export function heldWords(t: Say, key: string | null, admins: readonly string[]): string | null {
  if (!key) return null
  if (key === 'held.adminChanges') return admins.length > 0 ? t('held.adminChanges', { names: admins.join(', ') }) : t('held.adminChangesNone')
  return t(key)
}

const StateCell = ({ t, state }: { t: Say; state: AddressLine['state'] }) => (state === 'CURRENT' ? null : <Pill tone={LINE_TONE[state]}>{t(`profile.line.${state}`)}</Pill>)

export function CompanyCard({ model, slow, actions }: { model: CompanyModel; slow?: boolean; actions?: CompanyActions | undefined }) {
  const t = useT(NS)
  const held = heldWords(t, model.held, model.admins)
  const company = model.company
  const columns = useMemo<ColDef<AddressLine>[]>(() => {
    const AddressCell = ({ data }: ICellRendererParams<AddressLine>) =>
      data ? (
        <span className="fw-psprof-stack">
          <span className="fw-psprof-strong">{data.name ?? data.line}</span>
          {data.name ? <span className="fw-psprof-muted">{data.line}</span> : null}
        </span>
      ) : null
    const KindsCell = ({ data }: ICellRendererParams<AddressLine>) => (data ? <span className="fw-psprof-tags">{data.kinds.map((kind) => <Pill key={kind} tone="neutral">{t(`profile.kind.${kind}`)}</Pill>)}</span> : null)
    const CheckCell = ({ data }: ICellRendererParams<AddressLine>) => (data ? <StateCell t={t} state={data.state} /> : null)
    const MoreCell = ({ data }: ICellRendererParams<AddressLine>) => {
      if (!data) return null
      const typed = data.state === 'NEW' || data.state === 'CHANGED' || data.state === 'REMOVE'
      return (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('profile.rowMenu', { name: data.name ?? data.line }) }}
          items={[
            { id: 'edit', label: t('profile.edit'), disabled: data.editHeld !== null, ...(data.editHeld ? { description: heldWords(t, data.editHeld, model.admins) ?? '' } : {}), onSelect: () => actions?.onEdit?.(data) },
            ...(typed ? [{ id: 'undo', label: data.state === 'NEW' ? t('profile.drop') : t('profile.undo'), onSelect: () => actions?.onUndo?.(data) }] : []),
            ...(data.state !== 'NEW' && data.state !== 'REMOVE' ? [{ id: 'remove', label: t('profile.remove'), tone: 'danger' as const, disabled: data.removeHeld !== null, ...(data.removeHeld ? { description: heldWords(t, data.removeHeld, model.admins) ?? '' } : {}), onSelect: () => actions?.onRemove?.([data]) }] : []),
          ]}
        />
      )
    }
    return [
      { colId: 'address', headerName: t('profile.col.address'), minWidth: 260, flex: 2, valueGetter: (params) => (params.data ? [params.data.name, params.data.line].filter(Boolean).join(' — ') : ''), cellRenderer: AddressCell, autoHeight: true },
      { colId: 'kinds', headerName: t('profile.col.kinds'), minWidth: 180, flex: 1.1, valueGetter: (params) => (params.data ? params.data.kinds.map((kind) => t(`profile.kind.${kind}`)).join(', ') : ''), cellRenderer: KindsCell, autoHeight: true },
      { colId: 'contact', headerName: t('profile.col.contact'), minWidth: 160, flex: 1, valueGetter: (params) => params.data?.contact ?? '—' },
      { colId: 'check', headerName: t('profile.col.check'), minWidth: 230, flex: 1.1, valueGetter: (params) => (params.data && params.data.state !== 'CURRENT' ? t(`profile.line.${params.data.state}`) : ''), cellRenderer: CheckCell },
      { colId: 'more', headerName: t('profile.col.more'), minWidth: 72, maxWidth: 72, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
  }, [t, actions, model.admins])
  const picked = model.addresses.filter((row) => model.selected.includes(row.id))
  return (
    <AccountCard
      id="company"
      title={t('profile.company.title')}
      description={t('profile.company.subtitle')}
      state={model.state}
      slow={slow}
      failed={t('profile.readFailed')}
      onRetry={actions?.onRetry}
      footer={
        <div className="fw-psprof-foot">
          <span className="fw-psprof-muted">{t('profile.company.taxHint')}</span>
          <Button size="sm" onClick={() => actions?.onAsk?.()}>
            <MessageCircle size={14} aria-hidden /> {t('profile.company.ask')}
          </Button>
        </div>
      }
    >
      {company ? (
        <div className="fw-psprof-company">
          {held && model.held !== 'held.offline' ? <p className="fw-psprof-muted">{held}</p> : null}
          <KeyValue
            labelCase="sentence"
            columns={2}
            items={[
              { label: t('profile.company.legalName'), value: <span className="fw-psprof-value">{company.legalName}</span> },
              ...(company.tradeName && company.tradeName !== company.legalName ? [{ label: t('profile.company.tradeName'), value: <span className="fw-psprof-value">{company.tradeName}</span> }] : []),
              { label: t('profile.company.vatNumber'), value: <span className="fw-psprof-value">{company.vatNumber ?? '—'}</span> },
              ...(company.fiscalCode ? [{ label: t('profile.company.fiscalCode'), value: <span className="fw-psprof-value">{company.fiscalCode}</span> }] : []),
            ]}
          />
          <Field label={t('profile.company.website')} hint={company.waiting ? t('profile.company.websiteWaiting') : model.websiteChanged ? t('profile.notSentYet') : t('profile.company.websiteHint')} error={model.websiteProblem ? t(model.websiteProblem) : undefined}>
            <Input value={model.website} type="url" inputMode="url" maxLength={200} placeholder="https://" disabled={held !== null || company.waiting} onChange={(event) => actions?.onWebsite?.(event.target.value)} />
          </Field>
          <div className="fw-psprof-subhead">
            <h3 className="fw-psprof-h3">{t('profile.addresses.title')}</h3>
            <Button size="sm" heldReason={held} onClick={() => actions?.onAdd?.()}>
              <Plus size={14} aria-hidden /> {t('profile.addresses.add')}
            </Button>
          </div>
          <ListFrame<AddressLine>
            label={t('profile.addresses.title')}
            listKey={null}
            rows={model.addresses}
            rowId={(row) => row.id}
            columns={columns}
            count={t('profile.addresses.count', { count: model.addresses.length })}
            selection={{
              selected: model.selected,
              onChange: (ids: string[]) => actions?.onSelected?.(ids),
              actions: (
                <Button size="sm" variant="danger-outline" aria-label={t('profile.removeN', { count: picked.length })} heldReason={picked.length === 0 ? t('held.noneChosen') : null} onClick={() => actions?.onRemove?.(picked)}>
                  <Archive size={13} aria-hidden /> <SelectionLabel>{t('profile.removeN', { count: picked.length })}</SelectionLabel>
                </Button>
              ),
            }}
            isRowSelectable={(row: AddressLine) => (row.state === 'NEW' || row.state === 'REMOVE' ? t('held.typedRow') : heldWords(t, row.removeHeld, model.admins))}
            onOpen={(row) => (row.editHeld ? undefined : actions?.onEdit?.(row))}
            state={model.addresses.length === 0 ? <EmptyState title={t('profile.addresses.empty')} description={t('profile.addresses.emptyHint')} /> : undefined}
            cards={{ fields: { address: { role: 'title' }, kinds: { role: 'subtitle' } } }}
          />
        </div>
      ) : null}
    </AccountCard>
  )
}

// ── Contacts ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
export interface ContactsModel {
  state: CardState
  rows: readonly ContactLine[]
  selected: readonly string[]
  held: string | null
  admins: readonly string[]
  /** Two contacts would share an e-mail (the API refuses it): the addresses. */
  sameEmails: readonly string[]
}

export interface ContactsActions {
  onAdd?: () => void
  onEdit?: (row: ContactLine) => void
  onRemove?: (rows: readonly ContactLine[]) => void
  onUndo?: (row: ContactLine) => void
  onSelected?: (ids: string[]) => void
  onRetry?: () => void
}

export function ContactsCard({ model, slow, actions }: { model: ContactsModel; slow?: boolean; actions?: ContactsActions | undefined }) {
  const t = useT(NS)
  const held = heldWords(t, model.held, model.admins)
  const columns = useMemo<ColDef<ContactLine>[]>(() => {
    const NameCell = ({ data }: ICellRendererParams<ContactLine>) =>
      data ? (
        <span className="fw-psprof-cell">
          <span className="fw-psprof-strong">{data.name}</span>
          <StateCell t={t} state={data.state} />
        </span>
      ) : null
    const RolesCell = ({ data }: ICellRendererParams<ContactLine>) => (data ? <span className="fw-psprof-tags">{data.roles.length > 0 ? data.roles.map((role) => <Pill key={role} tone="neutral">{t(`profile.role.${role}`)}</Pill>) : <span className="fw-psprof-muted">—</span>}</span> : null)
    const MoreCell = ({ data }: ICellRendererParams<ContactLine>) => {
      if (!data) return null
      const typed = data.state === 'NEW' || data.state === 'CHANGED' || data.state === 'REMOVE'
      return (
        <Menu
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('profile.rowMenu', { name: data.name }) }}
          items={[
            { id: 'edit', label: t('profile.edit'), disabled: data.editHeld !== null, ...(data.editHeld ? { description: heldWords(t, data.editHeld, model.admins) ?? '' } : {}), onSelect: () => actions?.onEdit?.(data) },
            ...(typed ? [{ id: 'undo', label: data.state === 'NEW' ? t('profile.drop') : t('profile.undo'), onSelect: () => actions?.onUndo?.(data) }] : []),
            ...(data.state !== 'NEW' && data.state !== 'REMOVE' ? [{ id: 'remove', label: t('profile.remove'), tone: 'danger' as const, disabled: data.removeHeld !== null, ...(data.removeHeld ? { description: heldWords(t, data.removeHeld, model.admins) ?? '' } : {}), onSelect: () => actions?.onRemove?.([data]) }] : []),
          ]}
        />
      )
    }
    return [
      { colId: 'name', headerName: t('profile.col.name'), minWidth: 200, flex: 1.3, valueGetter: (params) => params.data?.name ?? '', cellRenderer: NameCell },
      { colId: 'email', headerName: t('profile.col.email'), minWidth: 200, flex: 1.3, valueGetter: (params) => params.data?.email ?? '—' },
      { colId: 'phone', headerName: t('profile.col.phone'), minWidth: 140, flex: 0.8, valueGetter: (params) => params.data?.phone ?? '—' },
      { colId: 'roles', headerName: t('profile.col.roles'), minWidth: 220, flex: 1.4, valueGetter: (params) => (params.data ? params.data.roles.map((role) => t(`profile.role.${role}`)).join(', ') : ''), cellRenderer: RolesCell, autoHeight: true },
      { colId: 'more', headerName: t('profile.col.more'), minWidth: 72, maxWidth: 72, pinned: 'right', sortable: false, suppressHeaderMenuButton: true, suppressMovable: true, cellRenderer: MoreCell },
    ]
  }, [t, actions, model.admins])
  const picked = model.rows.filter((row) => model.selected.includes(row.id))
  return (
    <AccountCard
      id="contacts"
      title={t('profile.contacts.title')}
      description={t('profile.contacts.subtitle')}
      state={model.state}
      slow={slow}
      failed={t('profile.readFailed')}
      onRetry={actions?.onRetry}
      action={
        <Button size="sm" heldReason={held} onClick={() => actions?.onAdd?.()}>
          <Plus size={14} aria-hidden /> {t('profile.contacts.add')}
        </Button>
      }
    >
      {model.sameEmails.length > 0 ? <Banner tone="warning">{t('held.sameEmail', { emails: model.sameEmails.join(', ') })}</Banner> : null}
      <ListFrame<ContactLine>
        label={t('profile.contacts.title')}
        listKey={null}
        rows={model.rows}
        rowId={(row) => row.id}
        columns={columns}
        count={t('profile.contacts.count', { count: model.rows.length })}
        selection={{
          selected: model.selected,
          onChange: (ids: string[]) => actions?.onSelected?.(ids),
          actions: (
            <Button size="sm" variant="danger-outline" aria-label={t('profile.removeN', { count: picked.length })} heldReason={picked.length === 0 ? t('held.noneChosen') : null} onClick={() => actions?.onRemove?.(picked)}>
              <Archive size={13} aria-hidden /> <SelectionLabel>{t('profile.removeN', { count: picked.length })}</SelectionLabel>
            </Button>
          ),
        }}
        isRowSelectable={(row: ContactLine) => (row.state === 'NEW' || row.state === 'REMOVE' ? t('held.typedRow') : heldWords(t, row.removeHeld, model.admins))}
        onOpen={(row) => (row.editHeld ? undefined : actions?.onEdit?.(row))}
        state={model.state === 'ready' && model.rows.length === 0 ? <EmptyState title={t('profile.contacts.empty')} description={t('profile.contacts.emptyHint')} /> : undefined}
        cards={{ fields: { name: { role: 'title' }, roles: { role: 'subtitle' } } }}
      />
    </AccountCard>
  )
}

// ── Changes waiting for our check, and our answers ───────────────────────────────────────────────────────────────────────
export interface ChangesModel {
  pending: readonly ChangeRequest[]
  decided: readonly ChangeRequest[]
  /** Why Withdraw waits (a key), or null. */
  held: string | null
  admins: readonly string[]
}

function RequestLines({ request }: { request: ChangeRequest }) {
  const t = useT(NS)
  return (
    <ul className="fw-psprof-changes">
      {changeLines(request.changes).map((line, index) => (
        <li key={index}>
          <span>{t(line.words.key, line.words.params)}</span>
          {line.fields.map((field) => (
            <span key={field.field} className="fw-psprof-muted fw-psprof-field">
              {t('profile.change.field', { field: t(`profile.field.${field.field}`), before: field.before, after: field.after })}
            </span>
          ))}
        </li>
      ))}
    </ul>
  )
}

export function ChangesCard({ model, onWithdraw }: { model: ChangesModel; onWithdraw?: ((request: ChangeRequest) => void) | undefined }) {
  const t = useT(NS)
  const locale = useLocale()
  const day = dayWriter(locale)
  const held = heldWords(t, model.held, model.admins)
  if (model.pending.length === 0 && model.decided.length === 0) return null
  return (
    <AccountCard id="changes" title={t('profile.changes.title')} description={t('profile.changes.subtitle')} state="ready">
      <div className="fw-psprof-requests">
        {model.pending.map((request) => (
          <Banner
            key={request.requestId}
            tone="warning"
            title={t('profile.changes.waitingSince', { date: day(request.sentAt) })}
            action={
              <Button size="sm" heldReason={held} onClick={() => onWithdraw?.(request)}>
                <Undo2 size={14} aria-hidden /> {t('profile.withdraw.button')}
              </Button>
            }
          >
            <RequestLines request={request} />
            {request.sentBy ? <span className="fw-psprof-muted">{t('profile.changes.sentBy', { name: request.sentBy })}</span> : null}
          </Banner>
        ))}
        {model.decided.length > 0 ? (
          <section className="fw-psprof-answers" aria-labelledby="fw-psprof-answers">
            <h3 id="fw-psprof-answers" className="fw-psprof-h3">
              {t('profile.changes.answers')}
            </h3>
            <ul className="fw-psprof-answer-list">
              {model.decided.map((request) => (
                <li key={request.requestId} className="fw-psprof-answer">
                  <span className="fw-psprof-cell">
                    <Pill tone={REQUEST_TONE[request.state]}>{t(`profile.request.${request.state}`)}</Pill>
                    <span className="fw-psprof-muted">{request.decidedAt ? t('profile.changes.on', { date: day(request.decidedAt) }) : null}</span>
                  </span>
                  <RequestLines request={request} />
                  {request.state === 'REFUSED' && request.reason ? <span className="fw-psprof-muted">{t('profile.changes.reason', { reason: request.reason })}</span> : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </AccountCard>
  )
}
