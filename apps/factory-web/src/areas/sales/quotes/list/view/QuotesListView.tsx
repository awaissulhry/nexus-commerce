'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { FileText, MoreHorizontal, Plus, RefreshCw, Search } from 'lucide-react'
import { Banner, Card, EmptyState, Field, KeyValue, Menu, MetricStrip, Modal, SummaryTable } from '@nexus/ui/components'
import { Button, FilterChip, InfoTip, Input, Pill, RadioCard, Select, Skeleton, Spinner, Tag, TokenChip } from '@nexus/ui/primitives'
import { formatDate, formatTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { previewHref, QUOTE_STATUSES, type QuoteListRow, type QuoteStatus } from '../../api'
import { activeFilterCount, APPROVAL_TONE, isExpiring, money, NO_FILTERS, percent, QUOTE_TILES, STATUS_TONE, tileOfFilters } from '../../model'
import type { NewQuoteModel, QuotesListActions, QuotesListViewModel } from '../list-model'
import '../../quotes.css'

export type { QuotesListViewModel, QuotesListActions } from '../list-model'

/**
 * SCR-034 — Quotes (Sales; design sales.quotes, 00 §2.1 list frame): the saved-filter tiles (each puts its chips in the
 * filter row: one filter model you can see), the toolbar (search by number or customer reference, status, only mine;
 * the time it was read; live changes wait behind "n updates · Show" so rows never move under the cursor), the list
 * (a stacked card list on a phone) with each number a real link, and the New quote dialog (customer, contact, the
 * number it will get). Money follows the person's grains. Keys: c new quote, / search. It fetches nothing.
 */
export function QuotesListView({ model, actions }: { model: QuotesListViewModel; actions?: QuotesListActions }) {
  return (
    <WithMessages namespaces={['sales']}>
      <QuotesList model={model} actions={actions} />
    </WithMessages>
  )
}

function QuotesList({ model, actions }: { model: QuotesListViewModel; actions?: QuotesListActions }) {
  const t = useT('sales')
  const locale = useLocale()
  const search = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState(model.filters.q)
  useEffect(() => setQuery(model.filters.q), [model.filters.q])
  const typed = useRef(false)
  const latest = useRef({ model, actions })
  latest.current = { model, actions }
  useEffect(() => {
    if (!typed.current) return
    const timer = setTimeout(() => latest.current.actions?.onFilters?.({ ...latest.current.model.filters, q: query }), 300)
    return () => clearTimeout(timer)
  }, [query])

  // c: a new quote; /: the search (00 §3.17) — never while typing or inside a dialog.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.metaKey || event.ctrlKey || event.altKey || model.newQuote) return
      if (target && (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]') || target.isContentEditable)) return
      if (event.key === 'c' && model.can.manage) {
        event.preventDefault()
        actions?.onNewQuote?.(true)
      } else if (event.key === '/') {
        event.preventDefault()
        search.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const pressed = tileOfFilters(model.filters)
  const items = model.rows.items
  const shown = items ? items.filter((row) => !model.filters.expiring || isExpiring(row, model.today)) : null
  const filtered = activeFilterCount(model.filters) > 0

  const columns = [
    t('list.col.number'),
    t('list.col.customer'),
    t('list.col.status'),
    t('list.col.units'),
    ...(model.grains.price ? [t('list.col.net'), t('list.col.gross')] : []),
    ...(model.grains.margin ? [t('list.col.margin')] : []),
    t('list.col.approval'),
    t('list.col.validUntil'),
    t('list.col.updated'),
    t('list.col.more'),
  ]
  const recordHref = (row: QuoteListRow) => `${model.prefix}/sales/quotes/${row.id}`
  const rows = (shown ?? []).map((row) => {
    return {
      id: row.id,
      cells: [
        <span key="n">
          <Link className="fw-ql-link" href={recordHref(row)}>
            {row.number}
          </Link>
          <span className="fw-ql-row-sub">{t('record.versionChip', { revision: row.revision })}</span>
        </span>,
        <span key="c" className="fw-q-cell">
          {row.partyName}
          {row.customerRef && <span className="fw-ql-row-sub">{t('list.ref', { ref: row.customerRef })}</span>}
        </span>,
        <Pill key="s" tone={STATUS_TONE[row.status]}>
          {t(`status.${row.status}`)}
        </Pill>,
        t('list.units', { units: row.units, lines: row.lineCount }),
        ...(model.grains.price ? [money(row.netAmount, row.currency, locale), money(row.grossAmount, row.currency, locale)] : []),
        ...(model.grains.margin
          ? [
              <span key="m" className="fw-q-inline">
                {percent(row.marginPct, locale)}
                {row.marginFloorBreached ? <Tag tone="warning">{t('lines.belowFloor')}</Tag> : null}
              </span>,
            ]
          : []),
        row.approval ? (
          <Pill key="a" tone={APPROVAL_TONE[row.approval]}>
            {t(`approvalStatus.${row.approval}`)}
          </Pill>
        ) : (
          '—'
        ),
        row.validUntil ? (
          <span key="v" className="fw-q-inline">
            {formatDate(`${row.validUntil}T12:00:00Z`, { locale })}
            {isExpiring(row, model.today) && <Tag tone="warning">{t('list.expiringSoon')}</Tag>}
          </span>
        ) : (
          '—'
        ),
        formatDate(row.updatedAt, { locale }),
        <Menu
          key="x"
          label={<MoreHorizontal size={16} aria-hidden />}
          align="right"
          triggerProps={{ 'aria-label': t('list.rowMenu', { number: row.number }) }}
          items={[
            { id: 'open', label: t('list.open'), href: recordHref(row) },
            { id: 'tab', label: t('list.openNewTab'), href: recordHref(row), target: '_blank' },
            { id: 'pdf', label: t('action.previewPdf'), icon: <FileText size={14} aria-hidden />, href: previewHref(row.id, 'it'), target: '_blank' },
          ]}
        />,
      ],
    }
  })

  return (
    <div className="fw-ql">
      <div className="fw-ql-head">
        <div className="fw-ql-head-text">
          <p className="fw-q-hint">{t('list.intro')}</p>
          <span className="fw-ql-count" role="status">
            {model.asOf ? t('list.updated', { time: formatTime(model.asOf, { locale }) }) : t('list.notYet')}
          </span>
        </div>
        <span className="fw-q-actions">
          {model.updates > 0 && (
            <Button size="sm" onClick={() => actions?.onShowUpdates?.()}>
              <RefreshCw size={14} aria-hidden /> {t('list.updates', { count: model.updates })}
            </Button>
          )}
          <Button size="sm" variant="primary" heldReason={model.can.manage ? null : t('held.noManage')} onClick={() => actions?.onNewQuote?.(true)} aria-keyshortcuts="c">
            <Plus size={14} aria-hidden /> {t('list.new')}
          </Button>
        </span>
      </div>

      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={t(model.notice.key, model.notice.params)}
          action={
            actions?.onDismissNotice ? (
              <Button size="sm" variant="quiet" onClick={actions.onDismissNotice}>
                {t('common.dismiss')}
              </Button>
            ) : undefined
          }
        />
      )}

      <MetricStrip
        metrics={QUOTE_TILES.map((tile) => {
          const count = model.tiles[tile]
          const value = count.count === null ? '—' : count.more ? t('list.tileMore', { count: count.count }) : String(count.count)
          return {
            label: t(`list.tile.${tile}`),
            value,
            hint: tile === 'accepted' && model.grains.price && count.value !== undefined && count.value !== null ? money(count.value, 'EUR', locale) : undefined,
            onClick: () => actions?.onTile?.(tile),
            active: pressed === tile,
          }
        })}
      />

      <div className="fw-ql-toolbar">
        <span className="fw-ql-search">
          <Input
            ref={search}
            size="sm"
            fieldClassName="fw-ql-fill"
            type="search"
            leadingIcon={<Search size={14} aria-hidden />}
            aria-label={t('list.search')}
            placeholder={t('list.search')}
            aria-keyshortcuts="/"
            value={query}
            onChange={(event) => {
              typed.current = true
              setQuery(event.target.value)
            }}
          />
        </span>
        <Select size="sm" aria-label={t('list.statusFilter')} value={model.filters.status ?? ''} onChange={(event) => actions?.onFilters?.({ ...model.filters, status: (event.target.value || null) as QuoteStatus | null, expiring: event.target.value === 'SENT' ? model.filters.expiring : false })}>
          <option value="">{t('list.allStatuses')}</option>
          {QUOTE_STATUSES.map((status) => (
            <option key={status} value={status}>
              {t(`status.${status}`)}
            </option>
          ))}
        </Select>
        <FilterChip pressed={model.filters.mine} onClick={() => actions?.onFilters?.({ ...model.filters, mine: !model.filters.mine })}>
          {t('list.onlyMine')}
        </FilterChip>
      </div>
      {filtered && (
        <div className="fw-ql-chips" aria-label={t('list.activeFilters')}>
          {model.filters.status && (
            <TokenChip removeLabel={t('list.removeFilter')} onRemove={() => actions?.onFilters?.({ ...model.filters, status: null, expiring: false })}>
              {t('list.chip.status', { status: t(`status.${model.filters.status}`) })}
            </TokenChip>
          )}
          {model.filters.mine && (
            <TokenChip removeLabel={t('list.removeFilter')} onRemove={() => actions?.onFilters?.({ ...model.filters, mine: false })}>
              {t('list.onlyMine')}
            </TokenChip>
          )}
          {model.filters.expiring && (
            <TokenChip removeLabel={t('list.removeFilter')} onRemove={() => actions?.onFilters?.({ ...model.filters, expiring: false })}>
              {t('list.chip.expiring')}
            </TokenChip>
          )}
          {model.filters.q.trim() && (
            <TokenChip removeLabel={t('list.removeFilter')} onRemove={() => actions?.onFilters?.({ ...model.filters, q: '' })}>
              {t('list.chip.search', { q: model.filters.q.trim() })}
            </TokenChip>
          )}
          <Button size="sm" variant="quiet" onClick={() => actions?.onFilters?.(NO_FILTERS)}>
            {t('list.clearAll')}
          </Button>
        </div>
      )}

      {model.rows.problem ? (
        <Card padded>
          <EmptyState
            title={t('list.failed')}
            description={t(model.rows.problem)}
            action={
              <Button size="sm" onClick={() => actions?.onRetry?.()}>
                {t('common.retry')}
              </Button>
            }
          />
        </Card>
      ) : shown === null ? (
        <Card padded aria-busy="true">
          <p className="fw-q-hint" role="status">
            <Spinner size={14} /> {t('list.loading')}
          </p>
          <div className="fw-q-skeleton">
            {Array.from({ length: 6 }, (_, index) => (
              <Skeleton key={index} height={22} />
            ))}
          </div>
        </Card>
      ) : shown.length === 0 ? (
        <Card padded>
          {filtered ? (
            <EmptyState
              title={t('list.noMatch.title')}
              description={t('list.noMatch.body')}
              action={
                <Button size="sm" onClick={() => actions?.onFilters?.(NO_FILTERS)}>
                  {t('list.clearAll')}
                </Button>
              }
            />
          ) : (
            <EmptyState
              title={t('list.empty.title')}
              description={t(model.can.manage ? 'list.empty.body' : 'list.empty.bodyView')}
              action={
                model.can.manage ? (
                  <Button size="sm" variant="primary" onClick={() => actions?.onNewQuote?.(true)}>
                    {t('list.new')}
                  </Button>
                ) : undefined
              }
            />
          )}
        </Card>
      ) : (
        <Card>
          <p className="fw-ql-count fw-q-padded" role="status">
            {t(model.rows.more ? 'list.countMore' : 'list.count', { count: shown.length })}
          </p>
          <div className="fw-q-table">
            <SummaryTable label={t('list.tableLabel')} columns={columns} rows={rows} density="roomy" stackOnPhone />
          </div>
          {!model.grains.margin && <p className="fw-q-hint fw-q-padded">{t('list.noMarginNote')}</p>}
          <div className="fw-q-tablefoot">
            <InfoTip tip={t('list.keys')} size={14} />
          </div>
        </Card>
      )}
      {model.rows.more && shown && shown.length > 0 && (
        <div className="fw-ql-more">
          <Button size="sm" onClick={() => actions?.onMore?.()}>
            {t('list.more')}
          </Button>
        </div>
      )}

      {model.newQuote && <NewQuoteDialog model={model.newQuote} actions={actions} />}
    </div>
  )
}

function NewQuoteDialog({ model, actions }: { model: NewQuoteModel; actions?: QuotesListActions }) {
  const t = useT('sales')
  const [query, setQuery] = useState('')
  const typed = useRef(false)
  const search = useRef(actions?.onNewSearch)
  search.current = actions?.onNewSearch
  useEffect(() => {
    if (!typed.current) return
    const timer = setTimeout(() => search.current?.(query), 250)
    return () => clearTimeout(timer)
  }, [query])
  const party = model.party
  const contacts = party?.contacts.filter((contact) => contact.status === 'ACTIVE') ?? []
  const blocked = party && party.status !== 'ACTIVE' ? t('newQuote.held.party', { status: t(`partyStatus.${party.status}`) }) : null
  const noIdentity = party && !party.taxIdentities.some((identity) => identity.current) ? t('newQuote.held.identity') : null
  const held = !party ? t('newQuote.held.customer') : blocked ?? noIdentity ?? (model.busy ? t('held.busy') : null)
  const create = () => {
    if (!held) actions?.onCreate?.()
  }
  return (
    <Modal
      open
      onClose={() => actions?.onNewQuote?.(false)}
      title={t('newQuote.title')}
      size="md"
      footer={
        <>
          <Button onClick={() => actions?.onNewQuote?.(false)}>{t('common.back')}</Button>
          <Button variant="primary" heldReason={held} onClick={create} aria-keyshortcuts="Meta+Enter Control+Enter">
            {t('newQuote.create')}
          </Button>
        </>
      }
    >
      <div
        className="fw-q-dialog"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            create()
          }
        }}
      >
        {model.companies.length > 1 && (
          <Field label={t('newQuote.company')}>
            <Select value={model.companyId} onChange={(event) => actions?.onNewCompany?.(event.target.value)}>
              {model.companies.map((company) => (
                <option key={company.id} value={company.id}>
                  {company.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {!party ? (
          <>
            <Field label={t('newQuote.customer')} hint={t('newQuote.customerHint')}>
              <Input
                value={query}
                type="search"
                autoComplete="off"
                placeholder={t('newQuote.customerPlaceholder')}
                onChange={(event) => {
                  typed.current = true
                  setQuery(event.target.value)
                }}
              />
            </Field>
            {model.searchProblem ? (
              <Banner tone="danger" title={t(model.searchProblem)} />
            ) : (
              <fieldset className="fw-q-choices">
                <legend className="fw-q-legend" aria-live="polite">
                  {model.results === null ? t('newQuote.searching') : model.results.length === 0 ? t('newQuote.none') : t('newQuote.found', { count: model.results.length })}
                </legend>
                {model.results === null && <Spinner size={14} />}
                {(model.results ?? []).map((row) => (
                  <RadioCard
                    key={row.id}
                    variant="row"
                    name="fw-q-customer"
                    value={row.id}
                    checked={false}
                    onChange={() => actions?.onNewPick?.(row.id)}
                    title={row.legalName}
                    description={
                      <span className="fw-q-tags">
                        <span className="fw-q-hint">{[row.tradeName, row.code, row.vatNumber, row.city].filter(Boolean).join(' · ')}</span>
                        {row.status !== 'ACTIVE' && <Tag tone="danger">{t(`partyStatus.${row.status}`)}</Tag>}
                        {row.vies.state !== 'VALID' && row.taxMode === 'EU_B2B' && <Tag tone="warning">{t('newQuote.viesWarning')}</Tag>}
                      </span>
                    }
                  />
                ))}
              </fieldset>
            )}
          </>
        ) : (
          <>
            <div className="fw-q-chosen-head">
              <strong>{party.legalName}</strong>
              <Button size="sm" variant="quiet" onClick={() => actions?.onNewPick?.(null)}>
                {t('newQuote.change')}
              </Button>
            </div>
            <KeyValue
              dense
              labelCase="sentence"
              items={[
                { label: t('newQuote.code'), value: party.code },
                { label: t('newQuote.taxMode'), value: party.taxMode ? t(`taxMode.${party.taxMode}`) : '—' },
                { label: t('newQuote.vies'), value: t(`vies.${party.vies.state}`) },
              ]}
            />
            {blocked && <Banner tone="danger" title={blocked} />}
            {noIdentity && <Banner tone="danger" title={noIdentity} />}
            {party.warnings.length > 0 && <Banner tone="warning" title={t('newQuote.warnings', { count: party.warnings.length })} />}
            <Field label={t('newQuote.contact')} hint={t('newQuote.contactHint')}>
              {/* The customer list is gone once one is picked: the focus moves on to the contact, not to the page. */}
              <Select autoFocus value={model.contactId} onChange={(event) => actions?.onNewField?.('contactId', event.target.value)}>
                <option value="">{t('newQuote.contactDefault')}</option>
                {contacts.map((contact) => (
                  <option key={contact.id} value={contact.id}>
                    {contact.name}
                    {contact.email ? ` · ${contact.email}` : ` · ${t('terms.noEmail')}`}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('terms.customerRef')} hint={t('terms.customerRefHint')}>
              <Input value={model.customerRef} onChange={(event) => actions?.onNewField?.('customerRef', event.target.value)} maxLength={100} />
            </Field>
          </>
        )}
        <p className="fw-q-hint" role="status">
          {model.number === undefined ? t('newQuote.numberLoading') : model.number === null ? t('newQuote.numberUnknown') : t('newQuote.number', { number: model.number })}
        </p>
        {model.problem && party && <Banner tone="danger" title={t(model.problem)} />}
      </div>
    </Modal>
  )
}
