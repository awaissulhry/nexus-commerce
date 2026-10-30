'use client'

import { useEffect, useRef, useState } from 'react'
import { Banner, Field, KeyValue, Modal } from '@nexus/ui/components'
import { Button, Input, RadioCard, Select, Spinner, Tag } from '@nexus/ui/primitives'
import { useT } from '../../../../../lib/i18n/provider'
import { newOrderHeld } from '../../new/new-model'
import type { NewOrderDialogModel, OrdersListActions } from '../list-model'

/**
 * New order (design pop:orders.new, B-W2a-50; SAL-202 manual entry): the selling company when there are several, the
 * customer (search by name, code, VAT number), the contact and the customer's PO, and the number it will get. "Create
 * draft order" opens the order's Lines on the screen — nothing is written until "Confirm order" there (the API keeps
 * no draft order). ⌘↵ creates; Esc closes.
 */
export function NewOrderDialog({ model, actions }: { model: NewOrderDialogModel; actions?: OrdersListActions }) {
  const t = useT('orders')
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
  const heldPhrase = newOrderHeld(party)
  const held = heldPhrase ? t(heldPhrase.key, heldPhrase.params ? { ...heldPhrase.params, status: t(`newOrder.partyStatus.${heldPhrase.params.status}`) } : undefined) : null
  const create = () => {
    if (!held) actions?.onNewCreate?.()
  }
  return (
    <Modal
      open
      onClose={() => actions?.onNewOrder?.(false)}
      title={t('newOrder.title')}
      size="md"
      footer={
        <>
          <span className="grow" />
          <Button onClick={() => actions?.onNewOrder?.(false)}>{t('common.cancel')}</Button>
          <Button variant="primary" heldReason={held} onClick={create} aria-keyshortcuts="Meta+Enter Control+Enter">
            {t('newOrder.create')}
          </Button>
        </>
      }
    >
      <div
        className="fw-so-dialog"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            create()
          }
        }}
      >
        <p className="fw-so-hint">{t('newOrder.body')}</p>
        {model.companies.length > 1 && (
          <Field label={t('newOrder.company')}>
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
            <Field label={t('newOrder.customer')} hint={t('newOrder.customerHint')}>
              <Input
                value={query}
                type="search"
                autoComplete="off"
                autoFocus
                placeholder={t('newOrder.customerPlaceholder')}
                onChange={(event) => {
                  typed.current = true
                  setQuery(event.target.value)
                }}
              />
            </Field>
            {model.searchProblem ? (
              <Banner tone="danger" title={t(model.searchProblem)} />
            ) : (
              <fieldset className="fw-so-choices">
                <legend className="fw-so-legend" aria-live="polite">
                  {model.results === null ? t('newOrder.searching') : model.results.length === 0 ? t('newOrder.none') : t('newOrder.found', { count: model.results.length })}
                </legend>
                {model.results === null && <Spinner size={14} />}
                {(model.results ?? []).map((row) => (
                  <RadioCard
                    key={row.id}
                    variant="row"
                    name="fw-so-customer"
                    value={row.id}
                    checked={false}
                    onChange={() => actions?.onNewPick?.(row.id)}
                    title={row.legalName}
                    description={
                      <span className="fw-so-inline">
                        <span className="fw-so-hint">{[row.tradeName, row.code, row.vatNumber, row.city].filter(Boolean).join(' · ')}</span>
                        {row.status !== 'ACTIVE' && <Tag tone="danger">{t(`newOrder.partyStatus.${row.status}`)}</Tag>}
                        {row.vies.state !== 'VALID' && row.taxMode === 'EU_B2B' && <Tag tone="warning">{t('newOrder.viesWarning')}</Tag>}
                      </span>
                    }
                  />
                ))}
              </fieldset>
            )}
            {model.partyProblem && <Banner tone="danger" title={t(model.partyProblem)} />}
          </>
        ) : (
          <>
            <div className="fw-so-card-head">
              <strong>{party.legalName}</strong>
              <Button size="sm" variant="quiet" onClick={() => actions?.onNewPick?.(null)}>
                {t('newOrder.change')}
              </Button>
            </div>
            <KeyValue
              dense
              labelCase="sentence"
              items={[
                { label: t('newOrder.code'), value: party.code },
                { label: t('newOrder.taxMode'), value: party.taxMode ? t(`newOrder.taxModes.${party.taxMode}`) : '—' },
                { label: t('newOrder.terms'), value: party.paymentTerms ?? t('newOrder.termsNone') },
              ]}
            />
            {held && <Banner tone="danger" title={held} />}
            {party.warnings.length > 0 && <Banner tone="warning" title={t('newOrder.warnings', { count: party.warnings.length })} />}
            <Field label={t('newOrder.contact')} hint={t('newOrder.contactHint')}>
              <Select autoFocus value={model.contactId} onChange={(event) => actions?.onNewField?.('contactId', event.target.value)}>
                <option value="">{t('newOrder.contactDefault')}</option>
                {contacts.map((contact) => (
                  <option key={contact.id} value={contact.id}>
                    {contact.name}
                    {contact.email ? ` · ${contact.email}` : ` · ${t('newOrder.noEmail')}`}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('newOrder.customerRef')} hint={t('newOrder.customerRefHint')}>
              <Input value={model.customerRef} onChange={(event) => actions?.onNewField?.('customerRef', event.target.value)} maxLength={100} autoComplete="off" />
            </Field>
          </>
        )}
        <p className="fw-so-hint" role="status">
          {model.number === undefined ? t('newOrder.numberLoading') : model.number === null ? t('newOrder.numberUnknown') : t('newOrder.number', { number: model.number })}
        </p>
      </div>
    </Modal>
  )
}
