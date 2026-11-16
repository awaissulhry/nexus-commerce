'use client'

import Link from 'next/link'
import { useId } from 'react'
import { Banner, Card, EmptyState, Field, MetricStrip, SummaryTable } from '@nexus/ui/components'
import { Button, Input, Pill, Select, Spinner, Tag } from '@nexus/ui/primitives'
import { Combobox, DateField, FileDropzone, Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useScopedT, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { dayInstant, money, type Phrase } from '../../../_shared/model'
import type { CustomerOption, Declaration } from '../api'
import {
  addHeld,
  addProblems,
  checkHeld,
  INTENT_NAMESPACES,
  NAMESPACE,
  otherYear,
  reasonProblem,
  receiptHeld,
  revokeHeld,
  STATE_FILTERS,
  STATE_TONE,
  usedPercent,
  yearsForDate,
  type AddDraft,
  type AddField,
  type IntentAbilities,
  type IntentProblem,
  type StateFilter,
} from '../model'
import '../../../_shared/finance.css'

export type DeclarationForm =
  | { kind: 'add'; draft: AddDraft; customers: { value: CustomerOption[] | null; problem: string | null }; fieldProblems: Partial<Record<AddField, string>> }
  | { kind: 'check'; file: { name: string } | null }
  | { kind: 'revoke'; reason: string }

export interface DeclarationsModel {
  can: IntentAbilities
  /** The address's prefix (`/w/<company>`): an invoice's link. */
  prefix: string
  today: string
  /** The company's declarations switch (null while it is read, or when it could not be). */
  switchOn: boolean | null
  /** null: every year. */
  year: number | null
  years: number[]
  state: StateFilter
  list: { value: Declaration[] | null; problem: string | null }
  /** The declaration open below the list. */
  selectedId: string | null
  form: DeclarationForm | null
  busy: boolean
  problem: IntentProblem | null
  notice: Phrase | null
}

export interface DeclarationsActions {
  onYear?: (year: number | null) => void
  onState?: (state: StateFilter) => void
  onSelect?: (declarationId: string | null) => void
  onRetry?: () => void
  onAdd?: () => void
  onDraft?: (patch: Partial<AddDraft>) => void
  onSubmitAdd?: () => void
  onCheck?: () => void
  onReceipt?: (file: File | null) => void
  onSubmitCheck?: () => void
  onRevoke?: () => void
  onReason?: (reason: string) => void
  onSubmitRevoke?: () => void
  onCancelForm?: () => void
  onOpenReceipt?: (fileId: string) => void
  onClose?: () => void
}

/**
 * Declarations of intent (B-W2b-GB02, G152; FIN-100; B-W2b-417's gap "declarations of intent have no screen"), opened from
 * Invoices' ⋯ (and from a declaration's own link): the company's declarations of the year — the customer, the tax
 * agency's protocol and its date, the year it covers, what was declared, used and is left (the price grain), and its state
 * (not checked yet, checked, used up, revoked) —; one opened below the list with the invoices that rest on it and the credit
 * notes that gave some back; "Check" with the receipt the agency's site printed (uploaded onto the declaration), "Revoke"
 * with why (then it changes no more), "Add declaration". While the company's declarations switch is off (the accountant's)
 * the dialog says what waits: declarations are recorded and checked, no invoice names one yet.
 */
export function DeclarationsDialog({ model, actions }: { model: DeclarationsModel; actions?: DeclarationsActions }) {
  return (
    <WithMessages namespaces={INTENT_NAMESPACES}>
      <Declarations model={model} actions={actions} />
    </WithMessages>
  )
}

function Declarations({ model, actions }: { model: DeclarationsModel; actions?: DeclarationsActions }) {
  const t = useT('finance')
  const w = useT(NAMESPACE)
  const s = useScopedT('finance')
  const locale = useLocale()
  const day = (value: string) => formatDate(dayInstant(value), { locale })
  const rows = model.list.value
  const selected = rows?.find((row) => row.id === model.selectedId) ?? null
  const add = addHeld(model.can, model.busy)
  return (
    <Modal
      open
      onClose={() => actions?.onClose?.()}
      title={w('title')}
      size="xl"
      footer={
        <>
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onClose?.()}>
            {w('close')}
          </Button>
        </>
      }
    >
      <div className="fw-fin-dialog">
        {model.problem && <Banner tone="danger" title={s(model.problem.key, model.problem.params)} />}
        {model.notice && <Banner tone="success" title={w(model.notice.key, model.notice.params)} />}
        {model.switchOn === false && (
          <Banner tone="info" title={w('switchOff.title')}>
            {w('switchOff.body')}
          </Banner>
        )}
        <div className="fw-fin-head">
          <p className="fw-fin-hint">{w('explain')}</p>
          <span className="fw-fin-actions">
            <Select size="sm" aria-label={w('filter.year')} value={model.year === null ? '' : String(model.year)} onChange={(event) => actions?.onYear?.(event.target.value === '' ? null : Number(event.target.value))}>
              <option value="">{w('filter.allYears')}</option>
              {model.years.map((year) => (
                <option key={year} value={year}>
                  {year}
                </option>
              ))}
            </Select>
            <Select size="sm" aria-label={w('filter.state')} value={model.state} onChange={(event) => actions?.onState?.(event.target.value as StateFilter)}>
              {STATE_FILTERS.map((state) => (
                <option key={state} value={state}>
                  {w(`filter.${state}`)}
                </option>
              ))}
            </Select>
            <Button size="sm" variant="primary" heldReason={add ? w(add.key) : null} onClick={() => actions?.onAdd?.()}>
              {w('add.open')}
            </Button>
          </span>
        </div>
        {model.form?.kind === 'add' && <AddForm model={model} form={model.form} actions={actions} />}
        {model.list.problem ? (
          <EmptyState
            title={w('failed')}
            description={t(model.list.problem)}
            action={
              <Button size="sm" onClick={() => actions?.onRetry?.()}>
                {t('common.retry')}
              </Button>
            }
          />
        ) : !rows ? (
          <p className="fw-fin-hint" role="status">
            <Spinner size={12} /> {w('reading')}
          </p>
        ) : rows.length === 0 ? (
          <EmptyState title={model.year === null ? w('empty.titleAll') : w('empty.title', { year: model.year })} description={w('empty.body')} />
        ) : (
          <SummaryTable
            label={w('tableLabel')}
            density="roomy"
            columns={[w('col.customer'), w('col.protocol'), w('col.year'), ...(model.can.price ? [w('col.declared'), w('col.used'), w('col.left')] : []), w('col.state'), w('col.actions')]}
            rows={rows.map((row) => {
              const percent = usedPercent(row)
              return {
                id: row.id,
                cells: [
                  <span key="c" className="fw-fin-cell">
                    <b>{row.party.legalName}</b>
                    <span className="fw-fin-cell-sub">{row.party.code}</span>
                  </span>,
                  <span key="p" className="fw-fin-cell">
                    <span className="fw-fin-code">{row.protocolNumber}</span>
                    <span className="fw-fin-cell-sub">{w('protocolOn', { date: day(row.protocolDate) })}</span>
                  </span>,
                  <span key="y" className="fw-fin-cell">
                    <span>{row.year}</span>
                    {otherYear(row, model.today) && row.state !== 'REVOKED' && <Tag tone="neutral">{w('notThisYear')}</Tag>}
                  </span>,
                  ...(model.can.price
                    ? [
                        money(row.amount, 'EUR', locale),
                        <span key="u" className="fw-fin-cell">
                          <span>{money(row.usedAmount, 'EUR', locale)}</span>
                          {percent !== null && <span className="fw-fin-cell-sub">{w('usedPercent', { percent })}</span>}
                        </span>,
                        money(row.leftAmount, 'EUR', locale),
                      ]
                    : []),
                  <Pill key="s" tone={STATE_TONE[row.state]}>
                    {w(`state.${row.state}`)}
                  </Pill>,
                  <span key="a" className="fw-fin-actions">
                    <Button size="sm" aria-pressed={row.id === model.selectedId} onClick={() => actions?.onSelect?.(row.id === model.selectedId ? null : row.id)}>
                      {row.id === model.selectedId ? w('hide') : w('open')}
                    </Button>
                  </span>,
                ],
              }
            })}
            stackOnPhone
          />
        )}
        {selected && <Record model={model} declaration={selected} actions={actions} />}
        <p className="fw-fin-hint">{w('rule')}</p>
      </div>
    </Modal>
  )
}

function Record({ model, declaration, actions }: { model: DeclarationsModel; declaration: Declaration; actions?: DeclarationsActions }) {
  const t = useT('finance')
  const w = useT(NAMESPACE)
  const locale = useLocale()
  const day = (value: string) => formatDate(dayInstant(value), { locale })
  const check = checkHeld(declaration, model.can, model.busy)
  const revoke = revokeHeld(declaration, model.can, model.busy)
  const percent = usedPercent(declaration)
  return (
    <Card padded className="fw-fin-card">
      <div className="fw-fin-card-head">
        <h3 className="fw-fin-h3">{w('record.title', { protocol: declaration.protocolNumber, customer: declaration.party.legalName })}</h3>
        <span className="fw-fin-actions">
          <Pill tone={STATE_TONE[declaration.state]}>{w(`state.${declaration.state}`)}</Pill>
          {declaration.state !== 'REVOKED' && declaration.checkedAt === null && (
            <Button size="sm" variant="primary" heldReason={check ? w(check.key) : null} onClick={() => actions?.onCheck?.()}>
              {w('check.open')}
            </Button>
          )}
          {declaration.state !== 'REVOKED' && (
            <Button size="sm" variant="danger" heldReason={revoke ? w(revoke.key) : null} onClick={() => actions?.onRevoke?.()}>
              {w('revoke.open')}
            </Button>
          )}
        </span>
      </div>
      <MetricStrip
        minTileWidth={130}
        metrics={[
          ...(model.can.price
            ? [
                { label: w('col.declared'), value: money(declaration.amount, 'EUR', locale) },
                { label: w('col.used'), value: money(declaration.usedAmount, 'EUR', locale), hint: percent !== null ? w('usedPercent', { percent }) : undefined },
                { label: w('col.left'), value: money(declaration.leftAmount, 'EUR', locale) },
              ]
            : []),
          { label: w('col.year'), value: String(declaration.year), hint: otherYear(declaration, model.today) ? w('notThisYear') : undefined },
          { label: w('record.protocolDate'), value: day(declaration.protocolDate) },
        ]}
      />
      <p className="fw-fin-hint">{w(`record.stateWords.${declaration.state}`)}</p>
      {declaration.checkedAt && (
        <p className="fw-fin-hint">
          {w('record.checkedOn', { date: formatDate(declaration.checkedAt, { locale }) })}{' '}
          {declaration.receiptFileId && (
            <Button size="sm" variant="link" onClick={() => actions?.onOpenReceipt?.(declaration.receiptFileId!)}>
              {w('record.receipt')}
            </Button>
          )}
        </p>
      )}
      {declaration.revokedAt && <p className="fw-fin-hint">{w('record.revokedOn', { date: formatDate(declaration.revokedAt, { locale }), reason: declaration.revokeReason ?? '—' })}</p>}
      {model.form?.kind === 'check' && <CheckForm model={model} form={model.form} actions={actions} />}
      {model.form?.kind === 'revoke' && <RevokeForm model={model} form={model.form} declaration={declaration} actions={actions} />}
      <h4 className="fw-fin-h3">{w('record.invoices')}</h4>
      {declaration.invoices.length === 0 ? (
        <p className="fw-fin-hint">{w('record.noInvoices')}</p>
      ) : (
        <SummaryTable
          label={w('record.invoices')}
          columns={[w('record.col.number'), w('record.col.type'), w('record.col.date'), ...(model.can.price ? [w('record.col.used')] : [])]}
          rows={declaration.invoices.map((invoice) => ({
            id: invoice.id,
            cells: [
              <Link key="n" className="fw-fin-link" href={`${model.prefix}/finance/invoices/${encodeURIComponent(invoice.id)}`}>
                {invoice.number ?? '—'}
              </Link>,
              t(`docType.${invoice.docType}`),
              invoice.issueDate ? day(invoice.issueDate) : '—',
              ...(model.can.price ? [money(invoice.intentAmount, 'EUR', locale)] : []),
            ],
          }))}
          stackOnPhone
        />
      )}
      <span className="fw-fin-actions">
        <Button size="sm" onClick={() => actions?.onSelect?.(null)}>
          {w('hide')}
        </Button>
      </span>
    </Card>
  )
}

function CheckForm({ model, form, actions }: { model: DeclarationsModel; form: Extract<DeclarationForm, { kind: 'check' }>; actions?: DeclarationsActions }) {
  const t = useT('finance')
  const w = useT(NAMESPACE)
  const held = receiptHeld(form.file, model.busy)
  return (
    <Card padded className="fw-fin-card">
      <h4 className="fw-fin-h3">{w('check.title')}</h4>
      <p className="fw-fin-hint">{w('check.explain')}</p>
      {form.file ? (
        <p className="fw-fin-hint">
          {w('check.chosen', { name: form.file.name })}{' '}
          <Button size="sm" variant="link" onClick={() => actions?.onReceipt?.(null)}>
            {w('check.change')}
          </Button>
        </p>
      ) : (
        <FileDropzone accept=".pdf,.png,.jpg,.jpeg" maxBytes={10 * 1024 * 1024} hint={w('check.dropHint')} onFiles={(files) => actions?.onReceipt?.(files[0] ?? null)} />
      )}
      <span className="fw-fin-actions">
        <Button size="sm" variant="primary" heldReason={held ? w(held.key) : null} onClick={() => actions?.onSubmitCheck?.()}>
          {model.busy ? t('common.working') : w('check.go')}
        </Button>
        <Button size="sm" onClick={() => actions?.onCancelForm?.()}>
          {t('common.cancel')}
        </Button>
      </span>
    </Card>
  )
}

function RevokeForm({ model, form, declaration, actions }: { model: DeclarationsModel; form: Extract<DeclarationForm, { kind: 'revoke' }>; declaration: Declaration; actions?: DeclarationsActions }) {
  const t = useT('finance')
  const w = useT(NAMESPACE)
  const problem = reasonProblem(form.reason)
  const held = model.busy ? w('held.busy') : problem ? w(problem.key, problem.params) : null
  return (
    <Card padded className="fw-fin-card">
      <h4 className="fw-fin-h3">{w('revoke.title', { protocol: declaration.protocolNumber })}</h4>
      <p className="fw-fin-hint">{w('revoke.explain')}</p>
      <Field label={w('revoke.reason')} required error={form.reason !== '' && problem ? w(problem.key, problem.params) : undefined}>
        <Textarea value={form.reason} maxLength={500} rows={2} onChange={(event) => actions?.onReason?.(event.target.value)} />
      </Field>
      <span className="fw-fin-actions">
        <Button size="sm" variant="danger" heldReason={held} onClick={() => actions?.onSubmitRevoke?.()}>
          {model.busy ? t('common.working') : w('revoke.go')}
        </Button>
        <Button size="sm" onClick={() => actions?.onCancelForm?.()}>
          {t('common.cancel')}
        </Button>
      </span>
    </Card>
  )
}

function AddForm({ model, form, actions }: { model: DeclarationsModel; form: Extract<DeclarationForm, { kind: 'add' }>; actions?: DeclarationsActions }) {
  const t = useT('finance')
  const w = useT(NAMESPACE)
  const locale = useLocale()
  const pickId = useId()
  const draft = form.draft
  const local = addProblems(draft, model.today)
  const shown = (field: AddField): string | undefined => {
    const key = form.fieldProblems[field] ?? (field === 'partyId' || field === 'year' || (field === 'protocolNumber' && draft.protocolNumber !== '') || (field === 'amount' && draft.amount !== '') || field === 'protocolDate' ? local[field] : undefined)
    return key ? w(key) : undefined
  }
  const held = model.busy ? w('held.busy') : Object.keys(local).length > 0 ? w('add.held.fields') : null
  const customers = form.customers.value
  return (
    <Card padded className="fw-fin-card">
      <h4 className="fw-fin-h3">{w('add.title')}</h4>
      <p className="fw-fin-hint">{w('add.explain')}</p>
      <Field label={w('add.customer')} required error={draft.partyId === null && !form.fieldProblems.partyId ? undefined : shown('partyId')} hint={form.customers.problem ? w('add.customersFailed') : customers === null ? w('add.customersReading') : customers.length === 0 ? w('add.noCustomers') : undefined}>
        <div id={pickId}>
          <Combobox options={(customers ?? []).map((row) => ({ value: row.id, label: `${row.code} · ${row.legalName}` }))} value={draft.partyId ?? undefined} onChange={(value) => actions?.onDraft?.({ partyId: value || null })} placeholder={w('add.customerSearch')} labelledBy={pickId} />
        </div>
      </Field>
      <div className="fw-fin-two">
        <Field label={w('add.protocol')} required hint={w('add.protocolHint')} error={shown('protocolNumber')}>
          <Input value={draft.protocolNumber} maxLength={30} inputMode="numeric" autoComplete="off" onChange={(event) => actions?.onDraft?.({ protocolNumber: event.target.value })} />
        </Field>
        <Field label={w('add.date')} required error={shown('protocolDate')}>
          <DateField value={draft.protocolDate} max={model.today} locale={locale === 'it' ? 'it-IT' : 'en-GB'} onChange={(value) => actions?.onDraft?.({ protocolDate: value ?? '' })} />
        </Field>
        <Field label={w('add.year')} required hint={w('add.yearHint')} error={shown('year')}>
          <Select value={draft.year === null ? '' : String(draft.year)} onChange={(event) => actions?.onDraft?.({ year: event.target.value === '' ? null : Number(event.target.value) })}>
            {yearsForDate(draft.protocolDate).map((year) => (
              <option key={year} value={year}>
                {year}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={w('add.amount')} required hint={w('add.amountHint')} error={shown('amount')}>
          <Input value={draft.amount} inputMode="decimal" autoComplete="off" onChange={(event) => actions?.onDraft?.({ amount: event.target.value })} />
        </Field>
      </div>
      <span className="fw-fin-actions">
        <Button size="sm" variant="primary" heldReason={held} onClick={() => actions?.onSubmitAdd?.()}>
          {model.busy ? t('common.working') : w('add.go')}
        </Button>
        <Button size="sm" onClick={() => actions?.onCancelForm?.()}>
          {t('common.cancel')}
        </Button>
      </span>
    </Card>
  )
}
