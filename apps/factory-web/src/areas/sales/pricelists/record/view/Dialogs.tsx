'use client'

import { useEffect, useRef, useState } from 'react'
import { Banner, DateField, Field, KeyValue, Modal, SummaryTable } from '@nexus/ui/components'
import { Button, CheckboxCard, Input, RadioCard, Select, Spinner, Tag } from '@nexus/ui/primitives'
import { INTL_LOCALE } from '../../../../../lib/i18n/locales'
import { useLocale } from '../../../../../lib/i18n/provider'
import { percent, unitPrice } from '../../../quotes/model'
import type { PriceListDetail } from '../../api'
import { activateCheck, alreadyPriced, dayBefore, defaultActivationDay, parseListPrice, parseRaisePct, raisePlan, sortedEntries, versionToShow } from '../../model'
import { KeysModal, say, useDay, useWords } from '../../parts'
import type { PriceListRecordActions, PriceListRecordModel, RecordDialog } from '../record-model'

/**
 * The price list record's dialogs: Activate version (design pop:pricelists.activate — the days, what it ends, held with
 * its reason in words before the click; the impact preview on open quotes is Later, SAL-177), Raise by % and Remove N
 * (each change listed now → new before it is written: a stand-in for the DS ReviewChangesModal, whose own words are
 * English only), Add a price (a style, every colourway or one, the net price), Add customers, Remove customers, Compare
 * two versions (a stand-in for the design's VersionCompare (new)) and Archive. They fetch nothing.
 */
export function RecordDialogs({ list, model, actions }: { list: PriceListDetail; model: PriceListRecordModel; actions?: PriceListRecordActions }) {
  const dialog = model.dialog
  if (!dialog) return null
  const close = () => actions?.onDialog?.(null)
  switch (dialog.kind) {
    case 'activate':
      return <ActivateDialog list={list} model={model} dialog={dialog} actions={actions} onClose={close} />
    case 'raise':
      return <RaiseDialog list={list} model={model} dialog={dialog} actions={actions} onClose={close} />
    case 'removePrices':
      return <RemovePricesDialog list={list} model={model} actions={actions} onClose={close} />
    case 'addPrice':
      return <AddPriceDialog list={list} model={model} actions={actions} onClose={close} />
    case 'addCustomers':
      return <AddCustomersDialog list={list} model={model} actions={actions} onClose={close} />
    case 'removeCustomers':
      return <RemoveCustomersDialog list={list} model={model} actions={actions} onClose={close} />
    case 'compare':
      return <CompareDialog list={list} model={model} actions={actions} onClose={close} />
    case 'archive':
      return <ArchiveDialog list={list} model={model} actions={actions} onClose={close} />
    case 'help':
      return <KeysModal own={[]} onClose={close} />
  }
}

interface DialogProps {
  list: PriceListDetail
  model: PriceListRecordModel
  actions?: PriceListRecordActions
  onClose: () => void
}

function Problem({ model }: { model: PriceListRecordModel }) {
  const t = useWords()
  return model.dialogProblem ? <Banner tone="danger" title={say(t, model.dialogProblem) ?? ''} /> : null
}

function ActivateDialog({ list, model, dialog, actions, onClose }: DialogProps & { dialog: Extract<RecordDialog, { kind: 'activate' }> }) {
  const t = useWords()
  const locale = useLocale()
  const day = useDay()
  const draft = list.versions.find((version) => version.id === list.draftVersionId) ?? null
  const validFrom = dialog.validFrom || (draft ? defaultActivationDay(draft, model.today) : model.today)
  const validTo = dialog.validTo
  const check = draft ? activateCheck(list.versions, draft.id, validFrom, validTo, model.today) : { held: { key: 'activate.held.noDraft' }, ends: null }
  const dated = check.held ? { ...check.held, params: Object.fromEntries(Object.entries(check.held.params ?? {}).map(([name, value]) => [name, name === 'today' || name === 'date' ? day(String(value)) : value])) } : null
  const held = say(t, dated) ?? (draft && draft.entries === 0 ? t('activate.held.noPrices') : model.busy ? t('held.busy') : null)
  const set = (next: Partial<{ validFrom: string; validTo: string }>) => actions?.onDialog?.({ kind: 'activate', validFrom: next.validFrom ?? validFrom, validTo: next.validTo ?? validTo })
  return (
    <Modal
      open
      onClose={onClose}
      title={t('activate.title', { revision: draft?.revision ?? 0 })}
      size="md"
      footer={
        <>
          <Button onClick={onClose}>{t('common.back')}</Button>
          <Button variant="primary" heldReason={held} onClick={() => actions?.onActivate?.({ validFrom, validTo })}>
            {model.busy ? <Spinner size={12} /> : null} {t('activate.go')}
          </Button>
        </>
      }
    >
      <div className="fw-pl-dialog">
        <p className="fw-pl-hint">{t('activate.body')}</p>
        <div className="fw-pl-fields">
          <Field label={t('activate.from')} hint={t('activate.fromHint')}>
            <DateField value={validFrom} onChange={(value) => set({ validFrom: value })} locale={INTL_LOCALE[locale]} min={model.today} />
          </Field>
          <Field label={t('activate.to')} hint={t('activate.toHint')}>
            <DateField value={validTo} onChange={(value) => set({ validTo: value })} locale={INTL_LOCALE[locale]} min={validFrom} clearable />
          </Field>
        </div>
        <KeyValue
          dense
          labelCase="sentence"
          items={[
            { label: t('activate.prices'), value: String(draft?.entries ?? 0) },
            { label: t('activate.ends'), value: check.ends ? t('activate.endsValue', { revision: check.ends.revision, date: day(check.ends.validTo) }) : t('activate.endsNone') },
            { label: t('activate.starts'), value: validTo ? t('activate.startsRange', { from: day(validFrom), to: day(validTo) }) : t('activate.startsOpen', { from: day(validFrom) }) },
          ]}
        />
        {dated && <Banner tone="warning" title={say(t, dated) ?? ''} />}
        <p className="fw-pl-hint">{t('activate.quotesKeep', { before: day(dayBefore(validFrom)) })}</p>
        <Problem model={model} />
      </div>
    </Modal>
  )
}

function RaiseDialog({ list, model, dialog, actions, onClose }: DialogProps & { dialog: Extract<RecordDialog, { kind: 'raise' }> }) {
  const t = useWords()
  const locale = useLocale()
  const entries = model.prices.answer?.entries ?? []
  const pct = parseRaisePct(dialog.pct)
  const plan = pct ? raisePlan(entries, model.selectedPrices, pct, list.currency) : []
  const held = dialog.pct.trim() === '' ? t('raise.held.pct') : pct === null ? t('raise.held.pctInvalid') : plan.length === 0 ? t('raise.held.nothing') : model.busy ? t('held.busy') : null
  const columns = [t('raise.col.row'), t('raise.col.now'), t('raise.col.next'), ...(model.can.margin && model.can.cost ? [t('raise.col.margin')] : [])]
  const rows = plan.map((row) => ({
    id: row.entry.id,
    cells: [
      `${row.entry.style.code} · ${row.entry.colourway ? row.entry.colourway.code : t('prices.everyColour')}`,
      unitPrice(row.now, list.currency, locale),
      <strong key="n">{unitPrice(row.next, list.currency, locale)}</strong>,
      ...(model.can.margin && model.can.cost ? [percent(row.marginNext, locale)] : []),
    ],
  }))
  return (
    <Modal
      open
      onClose={onClose}
      title={t('raise.title', { count: model.selectedPrices.length })}
      size="lg"
      footer={
        <>
          <Button onClick={onClose}>{t('common.back')}</Button>
          <Button variant="primary" heldReason={held} onClick={() => pct && actions?.onRaise?.(pct)}>
            {t('raise.go', { count: plan.length })}
          </Button>
        </>
      }
    >
      <div className="fw-pl-dialog">
        <Field label={t('raise.pct')} hint={t('raise.pctHint')} error={dialog.pct.trim() !== '' && pct === null ? t('raise.held.pctInvalid') : undefined}>
          <Input autoFocus inputMode="decimal" value={dialog.pct} onChange={(event) => actions?.onDialog?.({ kind: 'raise', pct: event.target.value })} />
        </Field>
        {plan.length > 0 && (
          <div className="fw-pl-table">
            <SummaryTable label={t('raise.table')} columns={columns} rows={rows} density="compact" stackOnPhone align={columns.map((_, index) => (index === 0 ? 'left' : 'right'))} />
          </div>
        )}
        <p className="fw-pl-hint">{t('raise.rounding', { currency: list.currency })}</p>
        <Problem model={model} />
      </div>
    </Modal>
  )
}

function RemovePricesDialog({ list, model, actions, onClose }: DialogProps) {
  const t = useWords()
  const locale = useLocale()
  const chosen = sortedEntries((model.prices.answer?.entries ?? []).filter((entry) => model.selectedPrices.includes(entry.id)))
  const held = chosen.length === 0 ? t('raise.held.nothing') : model.busy ? t('held.busy') : null
  return (
    <Modal
      open
      onClose={onClose}
      title={t('remove.title', { count: chosen.length })}
      size="md"
      footer={
        <>
          <Button onClick={onClose}>{t('common.back')}</Button>
          <Button variant="danger" heldReason={held} onClick={() => actions?.onRemovePrices?.()}>
            {t('prices.bulk.remove', { count: chosen.length })}
          </Button>
        </>
      }
    >
      <div className="fw-pl-dialog">
        <p className="fw-pl-hint">{t(list.baseList ? 'remove.bodyFallback' : 'remove.body', { base: list.baseList?.code ?? '' })}</p>
        <ul className="fw-pl-list">
          {chosen.map((entry) => (
            <li key={entry.id}>
              {entry.style.code} · {entry.colourway ? `${entry.colourway.code} · ${entry.colourway.name}` : t('prices.everyColour')}
              {entry.unitPrice !== undefined ? ` · ${unitPrice(entry.unitPrice, list.currency, locale)}` : ''}
            </li>
          ))}
        </ul>
        <Problem model={model} />
      </div>
    </Modal>
  )
}

function AddPriceDialog({ list, model, actions, onClose }: DialogProps) {
  const t = useWords()
  const pick = model.stylePick
  const [query, setQuery] = useState(pick.query)
  const typed = useRef(false)
  const search = useRef(actions?.onStyleQuery)
  search.current = actions?.onStyleQuery
  useEffect(() => {
    if (!typed.current) return
    const timer = setTimeout(() => search.current?.(query), 250)
    return () => clearTimeout(timer)
  }, [query])
  const version = versionToShow(list, model.versionId)
  const entries = model.prices.answer?.entries ?? []
  const style = pick.chosen
  const colourways = style ? style.colourways.filter((colourway) => colourway.status === 'ACTIVE') : []
  const price = parseListPrice(pick.price)
  const taken = style ? alreadyPriced(entries, style.id, pick.colourwayId || null) : false
  const held = !style ? t('add.held.style') : taken ? t('add.held.taken') : pick.price.trim() === '' ? t('add.held.price') : price === null ? t('add.held.priceInvalid') : model.busy ? t('held.busy') : null
  return (
    <Modal
      open
      onClose={onClose}
      title={t('add.title', { revision: version?.revision ?? 0 })}
      size="md"
      footer={
        <>
          <Button onClick={onClose}>{t('common.back')}</Button>
          <Button variant="primary" heldReason={held} onClick={() => actions?.onAddPrice?.()}>
            {t('add.go')}
          </Button>
        </>
      }
    >
      <div className="fw-pl-dialog">
        {!style ? (
          <>
            <Field label={t('add.style')} hint={t('add.styleHint')}>
              <Input
                autoFocus
                type="search"
                autoComplete="off"
                value={query}
                placeholder={t('add.stylePlaceholder')}
                onChange={(event) => {
                  typed.current = true
                  setQuery(event.target.value)
                }}
              />
            </Field>
            {pick.problem ? (
              <Banner tone="danger" title={t(pick.problem)} />
            ) : (
              <fieldset className="fw-pl-choices">
                <legend className="fw-pl-legend" aria-live="polite">
                  {pick.results === null ? t('add.searching') : pick.results.length === 0 ? t('add.none') : t('add.found', { count: pick.results.length })}
                </legend>
                {pick.results === null && <Spinner size={14} />}
                {(pick.results ?? []).map((row) => (
                  <RadioCard key={row.id} variant="row" name="fw-pl-style" value={row.id} checked={false} onChange={() => actions?.onStylePick?.(row.id)} title={`${row.code} · ${row.name}`} description={row.season ?? undefined} />
                ))}
              </fieldset>
            )}
          </>
        ) : (
          <>
            <div className="fw-pl-head">
              <strong>
                {style.code} · {style.name}
              </strong>
              <Button size="sm" variant="quiet" onClick={() => actions?.onStylePick?.(null)}>
                {t('add.change')}
              </Button>
            </div>
            <div className="fw-pl-fields">
              <Field label={t('add.colour')} hint={t('add.colourHint')}>
                <Select value={pick.colourwayId} onChange={(event) => actions?.onStyleField?.('colourwayId', event.target.value)}>
                  <option value="">{t('prices.everyColour')}</option>
                  {colourways.map((colourway) => (
                    <option key={colourway.id} value={colourway.id}>
                      {colourway.code} · {colourway.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t('add.price', { currency: list.currency })} hint={t('add.priceHint')} error={pick.price.trim() !== '' && price === null ? t('add.held.priceInvalid') : undefined}>
                <Input autoFocus inputMode="decimal" value={pick.price} onChange={(event) => actions?.onStyleField?.('price', event.target.value)} />
              </Field>
            </div>
            {taken && <Banner tone="info" title={t('add.held.taken')} />}
          </>
        )}
        <Problem model={model} />
      </div>
    </Modal>
  )
}

function AddCustomersDialog({ list, model, actions, onClose }: DialogProps) {
  const t = useWords()
  const pick = model.customerPick
  const [query, setQuery] = useState(pick.query)
  const typed = useRef(false)
  const search = useRef(actions?.onCustomerQuery)
  search.current = actions?.onCustomerQuery
  useEffect(() => {
    if (!typed.current) return
    const timer = setTimeout(() => search.current?.(query), 250)
    return () => clearTimeout(timer)
  }, [query])
  const already = new Set(list.customers.map((customer) => customer.id))
  const locale = useLocale()
  // B-W2b-16: the customers' "From": today (blank) or an earlier day, never a later one.
  const from = pick.from ?? ''
  const fromLater = from !== '' && from > model.today
  const held = pick.picked.length === 0 ? t('customers.held.pick') : fromLater ? t('customers.held.fromLater') : model.busy ? t('held.busy') : null
  return (
    <Modal
      open
      onClose={onClose}
      title={t('customers.addTitle', { code: list.code })}
      size="md"
      footer={
        <>
          <Button onClick={onClose}>{t('common.back')}</Button>
          <Button variant="primary" heldReason={held} onClick={() => actions?.onAddCustomers?.()}>
            {t('customers.addGo', { count: pick.picked.length })}
          </Button>
        </>
      }
    >
      <div className="fw-pl-dialog">
        <p className="fw-pl-hint">{t('customers.addBody', { currency: list.currency })}</p>
        <Field label={t('customers.from')} hint={t('customers.fromHint')} error={fromLater ? t('customers.held.fromLater') : undefined}>
          <DateField value={from} onChange={(day) => actions?.onCustomerFrom?.(day)} max={model.today} locale={INTL_LOCALE[locale]} ariaLabel={t('customers.from')} placeholder={t('customers.fromToday')} clearLabel={t('customers.fromToday')} />
        </Field>
        <Field label={t('customers.search')}>
          <Input
            autoFocus
            type="search"
            autoComplete="off"
            value={query}
            placeholder={t('customers.searchPlaceholder')}
            onChange={(event) => {
              typed.current = true
              setQuery(event.target.value)
            }}
          />
        </Field>
        {pick.problem ? (
          <Banner tone="danger" title={t(pick.problem)} />
        ) : (
          <fieldset className="fw-pl-choices">
            <legend className="fw-pl-legend" aria-live="polite">
              {pick.results === null ? t('add.searching') : pick.results.length === 0 ? t('customers.none') : t('customers.found', { count: pick.results.length })}
            </legend>
            {pick.results === null && <Spinner size={14} />}
            {(pick.results ?? []).map((row) => {
              const has = already.has(row.id)
              const checked = has || pick.picked.includes(row.id)
              return (
                <CheckboxCard
                  key={row.id}
                  variant="row"
                  checked={checked}
                  selected={checked}
                  disabled={has || row.status === 'ARCHIVED'}
                  onChange={() => actions?.onCustomerToggle?.(row.id)}
                  title={row.legalName}
                  description={
                    <span className="fw-pl-inline">
                      <span className="fw-pl-hint">{[row.code, row.city].filter(Boolean).join(' · ')}</span>
                      {has && <Tag tone="info">{t('customers.already')}</Tag>}
                      {row.status !== 'ACTIVE' && <Tag tone="warning">{t(`partyStatus.${row.status}`)}</Tag>}
                    </span>
                  }
                />
              )
            })}
          </fieldset>
        )}
        <Problem model={model} />
      </div>
    </Modal>
  )
}

function RemoveCustomersDialog({ list, model, actions, onClose }: DialogProps) {
  const t = useWords()
  const chosen = list.customers.filter((customer) => model.selectedCustomers.includes(customer.id))
  const held = chosen.length === 0 ? t('customers.held.pick') : model.busy ? t('held.busy') : null
  return (
    <Modal
      open
      onClose={onClose}
      title={t('customers.removeTitle', { count: chosen.length })}
      size="md"
      footer={
        <>
          <Button onClick={onClose}>{t('common.back')}</Button>
          <Button variant="danger" heldReason={held} onClick={() => actions?.onRemoveCustomers?.()}>
            {t('customers.bulk.remove', { count: chosen.length })}
          </Button>
        </>
      }
    >
      <div className="fw-pl-dialog">
        <p className="fw-pl-hint">{t('customers.removeBody')}</p>
        <ul className="fw-pl-list">
          {chosen.map((customer) => (
            <li key={customer.id}>
              {customer.code} · {customer.legalName}
            </li>
          ))}
        </ul>
        <Problem model={model} />
      </div>
    </Modal>
  )
}

function CompareDialog({ list, model, actions, onClose }: DialogProps) {
  const t = useWords()
  const locale = useLocale()
  const view = model.compare
  const versions = [...list.versions].sort((a, b) => b.revision - a.revision)
  const answer = view.answer
  const changed = answer ? answer.rows.filter((row) => row.change !== 'SAME') : []
  const columns = [t('compare.col.row'), t('compare.col.change'), ...(model.can.price ? [t('compare.col.before'), t('compare.col.after'), t('compare.col.pct')] : [])]
  const tone = { ADDED: 'success', REMOVED: 'danger', CHANGED: 'info', SAME: 'neutral' } as const
  const rows = changed.map((row) => ({
    id: `${row.styleId}:${row.colourwayId ?? '*'}`,
    cells: [
      `${row.style.code} · ${row.colourway ? row.colourway.code : t('prices.everyColour')}`,
      <Tag key="c" tone={tone[row.change]}>
        {t(`compare.change.${row.change}`)}
      </Tag>,
      ...(model.can.price ? [unitPrice(row.before, list.currency, locale), unitPrice(row.after, list.currency, locale), row.changePct ? percent(row.changePct, locale) : '—'] : []),
    ],
  }))
  const choose = (beforeId: string, afterId: string) => actions?.onCompare?.(beforeId, afterId)
  return (
    <Modal open onClose={onClose} title={t('compare.title')} size="lg" footer={<Button onClick={onClose}>{t('common.close')}</Button>}>
      <div className="fw-pl-dialog">
        <div className="fw-pl-fields">
          <Field label={t('compare.before')}>
            <Select value={view.beforeId} onChange={(event) => choose(event.target.value, view.afterId)}>
              {versions.map((version) => (
                <option key={version.id} value={version.id}>
                  {t('versions.name', { revision: version.revision })}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('compare.after')}>
            <Select value={view.afterId} onChange={(event) => choose(view.beforeId, event.target.value)}>
              {versions.map((version) => (
                <option key={version.id} value={version.id}>
                  {t('versions.name', { revision: version.revision })}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {view.beforeId === view.afterId ? (
          <Banner tone="info" title={t('compare.same')} />
        ) : view.problem ? (
          <Banner tone="danger" title={t(view.problem)} />
        ) : view.loading || !answer ? (
          <p className="fw-pl-hint" role="status">
            <Spinner size={14} /> {t('compare.loading')}
          </p>
        ) : (
          <>
            <p className="fw-pl-hint" role="status">
              {t('compare.summary', { count: answer.changed, before: answer.before.revision, after: answer.after.revision })}
            </p>
            {rows.length > 0 && (
              <div className="fw-pl-table">
                <SummaryTable label={t('compare.table')} columns={columns} rows={rows} density="compact" stackOnPhone align={columns.map((_, index) => (index < 2 ? 'left' : 'right'))} />
              </div>
            )}
          </>
        )}
        {!model.can.price && <p className="fw-pl-hint">{t('held.noPrice')}</p>}
      </div>
    </Modal>
  )
}

function ArchiveDialog({ list, model, actions, onClose }: DialogProps) {
  const t = useWords()
  return (
    <Modal
      open
      onClose={onClose}
      title={t('archive.title', { code: list.code })}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>{t('common.back')}</Button>
          <Button variant="danger" heldReason={model.busy ? t('held.busy') : null} onClick={() => actions?.onArchive?.()}>
            {t('record.archive')}
          </Button>
        </>
      }
    >
      <div className="fw-pl-dialog">
        <p className="fw-pl-hint">{t('archive.body')}</p>
        <Problem model={model} />
      </div>
    </Modal>
  )
}
