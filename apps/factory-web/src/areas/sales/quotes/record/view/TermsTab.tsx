'use client'

import { useEffect, useMemo, useState } from 'react'
import { Banner, Card, Field, KeyValue } from '@nexus/ui/components'
import { Input, RadioCard, Select, Toggle } from '@nexus/ui/primitives'
import { DateField, EditModeBar } from '../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../lib/i18n/format'
import { INTL_LOCALE } from '../../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { PartyAddress, QuoteDetail } from '../../api'
import { addressChoices, isEditable, money, percent, termsDraftOf, termsPatch, termsProblems, type TermsDraft } from '../../model'
import type { QuoteRecordActions, QuoteRecordViewModel } from '../record-model'

const addressLine = (address: PartyAddress) => [address.name, address.line1, `${address.postalCode} ${address.city}${address.province ? ` (${address.province})` : ''}`, address.country].filter(Boolean).join(', ')

/**
 * Terms & delivery (design `quote.terms.*`): who it goes to and where, VAT and language, validity and firm offer,
 * delivery, payment and deposit, the consumer's statements. A form: explicit save with the EditModeBar (⌘S, Discard, a
 * held Save with its reason); Draft only — afterwards the same facts as text with the reason above.
 */
export function TermsTab({ quote, model, actions }: { quote: QuoteDetail; model: QuoteRecordViewModel; actions?: QuoteRecordActions }) {
  const t = useT('sales')
  const locale = useLocale()
  const editable = isEditable(quote, model.can)
  const before = useMemo(() => termsDraftOf(quote), [quote])
  const [draft, setDraft] = useState<TermsDraft>(before)
  useEffect(() => setDraft(before), [before])
  const patch = termsPatch(before, draft)
  const count = Object.keys(patch).length
  const problems = termsProblems(draft, model.today)
  const problemCount = Object.keys(problems).length
  const [saving, setSaving] = useState(false)
  const set = <K extends keyof TermsDraft>(key: K, value: TermsDraft[K]) => setDraft((current) => ({ ...current, [key]: value }))
  const party = model.party.value
  const contacts = party?.contacts.filter((contact) => contact.status === 'ACTIVE') ?? []
  const identity = party?.taxIdentities.find((entry) => entry.current) ?? null
  const current = quote.current
  const dateLocale = INTL_LOCALE[locale]
  const libraryItems = model.library?.items ?? []
  const libraryChoices = current.paymentTermsId && !libraryItems.some((row) => row.id === current.paymentTermsId) ? [{ id: current.paymentTermsId, code: '', name: current.paymentTerms ?? '—' }, ...libraryItems] : libraryItems
  const chosenTerms = libraryItems.find((row) => row.id === draft.paymentTermsId) ?? null
  const save = () => {
    if (count === 0 || problemCount > 0 || saving) return
    setSaving(true)
    void (actions?.onTermsSave?.(patch) ?? Promise.resolve(false)).finally(() => setSaving(false))
  }

  const text = (value: string | null | undefined) => (value && value.trim() !== '' ? value : '—')
  const addressText = (id: string) => {
    const address = party?.addresses.find((entry) => entry.id === id)
    return address ? addressLine(address) : id ? t('terms.addressUnknown') : '—'
  }

  return (
    <div className="fw-q-stack">
      {model.party.problem && <Banner tone="warning" title={t(model.party.problem)} />}
      <div className="fw-q-form">
      <Card padded>
        <h2 className="fw-q-h2">{t('terms.party.title')}</h2>
        {editable ? (
          <div className="fw-q-fields">
            <Field label={t('terms.contact')} hint={t('terms.contactHint')}>
              <Select value={draft.contactId} onChange={(event) => set('contactId', event.target.value)}>
                <option value="">{t('terms.noContact')}</option>
                {contacts.map((contact) => (
                  <option key={contact.id} value={contact.id}>
                    {contact.name}
                    {contact.email ? ` · ${contact.email}` : ` · ${t('terms.noEmail')}`}
                  </option>
                ))}
                {quote.contactId && !contacts.some((contact) => contact.id === quote.contactId) && <option value={quote.contactId}>{quote.contact?.name ?? quote.contactId}</option>}
              </Select>
            </Field>
            <Field label={t('terms.customerRef')} hint={t('terms.customerRefHint')}>
              <Input value={draft.customerRef} onChange={(event) => set('customerRef', event.target.value)} maxLength={100} />
            </Field>
            <Field label={t('terms.billTo')}>
              <Select value={draft.billToAddressId} onChange={(event) => set('billToAddressId', event.target.value)}>
                <option value="">{t('terms.noAddress')}</option>
                {addressChoices(party, 'bill').map((address) => (
                  <option key={address.id} value={address.id}>
                    {addressLine(address)}
                    {address.isDefaultBillTo ? ` · ${t('terms.default')}` : ''}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('terms.shipTo')}>
              <Select value={draft.shipToAddressId} onChange={(event) => set('shipToAddressId', event.target.value)}>
                <option value="">{t('terms.noAddress')}</option>
                {addressChoices(party, 'ship').map((address) => (
                  <option key={address.id} value={address.id}>
                    {addressLine(address)}
                    {address.isDefaultShipTo ? ` · ${t('terms.default')}` : ''}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        ) : (
          <KeyValue
            dense
            labelCase="sentence"
            items={[
              { label: t('terms.contact'), value: quote.contact ? `${quote.contact.name}${quote.contact.email ? ` · ${quote.contact.email}` : ''}` : '—' },
              { label: t('terms.customerRef'), value: text(quote.customerRef) },
              { label: t('terms.billTo'), value: addressText(current.billToAddressId ?? '') },
              { label: t('terms.shipTo'), value: addressText(current.shipToAddressId ?? '') },
            ]}
          />
        )}
        <KeyValue
          dense
          labelCase="sentence"
          items={[
            { label: t('terms.identity'), value: identity ? [identity.vatNumber, identity.fiscalCode].filter(Boolean).join(' · ') || '—' : '—' },
            { label: t('terms.sdi'), value: identity ? identity.sdiRecipientCode ?? identity.pec ?? '—' : '—' },
            { label: t('terms.vies'), value: party ? t(`vies.${party.vies.state}`) : '—' },
          ]}
        />
      </Card>

      <Card padded>
        <h2 className="fw-q-h2">{t('terms.vat.title')}</h2>
        <KeyValue
          dense
          labelCase="sentence"
          items={[
            { label: t('terms.taxMode'), value: t(`taxMode.${current.taxMode}`) },
            { label: t('terms.priceBasis'), value: t(`priceBasis.${current.priceBasis}`) },
            { label: t('terms.vatLines'), value: quote.lines.length === 0 ? '—' : [...new Set(quote.lines.map((line) => (line.vatNature ? t('terms.nature', { nature: line.vatNature }) : percent(line.vatRatePct, locale))))].join(' · ') },
            { label: t('terms.currency'), value: current.currency },
          ]}
        />
        {quote.issues.some((issue) => issue.code === 'VIES_NOT_PROVEN') && <Banner tone="warning" title={t('issue.VIES_NOT_PROVEN')} />}
        {editable ? (
          <Field label={t('terms.language')} hint={t('terms.languageHint')}>
            <Select value={draft.language} onChange={(event) => set('language', event.target.value === 'en' ? 'en' : 'it')}>
              <option value="it">{t('languageName.it')}</option>
              <option value="en">{t('languageName.en')}</option>
            </Select>
          </Field>
        ) : (
          <KeyValue dense labelCase="sentence" items={[{ label: t('terms.language'), value: t(`languageName.${current.language === 'en' ? 'en' : 'it'}`) }]} />
        )}
      </Card>

      <Card padded>
        <h2 className="fw-q-h2">{t('terms.validity.title')}</h2>
        {editable ? (
          <div className="fw-q-fields">
            <Field label={t('terms.validUntil')} error={problems.validUntil ? t(problems.validUntil) : undefined}>
              <DateField value={draft.validUntil} onChange={(value) => set('validUntil', value)} locale={dateLocale} min={model.today} clearable />
            </Field>
            <Field label={t('terms.firmOffer')} hint={t('terms.firmOfferHint')}>
              <span className="fw-q-inline">
                <Toggle checked={draft.firmOffer} onChange={(next: boolean) => set('firmOffer', next)} aria-label={t('terms.firmOffer')} />
                {t(draft.firmOffer ? 'terms.firmOn' : 'terms.firmOff')}
              </span>
            </Field>
          </div>
        ) : (
          <KeyValue
            dense
            labelCase="sentence"
            items={[
              { label: t('terms.validUntil'), value: current.validUntil ? formatDate(`${current.validUntil}T12:00:00Z`, { locale }) : '—' },
              { label: t('terms.firmOffer'), value: t(current.firmOffer ? 'terms.firmOn' : 'terms.firmOff') },
            ]}
          />
        )}
        <KeyValue dense labelCase="sentence" items={[{ label: t('terms.termsVersion'), value: text(current.termsVersion) ?? '—' }]} />
        <p className="fw-q-hint">{t('terms.termsNote')}</p>
      </Card>

      <Card padded>
        <h2 className="fw-q-h2">{t('terms.delivery.title')}</h2>
        {editable ? (
          <Field label={t('terms.promiseDate')} hint={t(current.taxMode.endsWith('B2C') ? 'terms.promiseConsumer' : 'terms.promiseHint')}>
            <DateField value={draft.promiseDate} onChange={(value) => set('promiseDate', value)} locale={dateLocale} min={model.today} clearable />
          </Field>
        ) : (
          <KeyValue dense labelCase="sentence" items={[{ label: t('terms.promiseDate'), value: current.promiseDate ? formatDate(`${current.promiseDate}T12:00:00Z`, { locale }) : '—' }]} />
        )}
      </Card>

      <Card padded>
        <h2 className="fw-q-h2">{t('terms.payment.title')}</h2>
        {editable ? (
          <div className="fw-q-fields">
            {/* B-W2a-49 (FIN-075): terms from the library of the quote's company; their printed name follows. */}
            {model.library?.allowed && (
              <Field label={t('terms.library')} hint={chosenTerms ? (locale === 'en' ? chosenTerms.summary.en : chosenTerms.summary.it) : model.library.problem ? t('terms.libraryFailed') : t('terms.libraryHint')}>
                <Select value={draft.paymentTermsId} disabled={model.library.items === null} onChange={(event) => set('paymentTermsId', event.target.value)}>
                  <option value="">{t('terms.libraryNone')}</option>
                  {libraryChoices.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.code ? `${row.code} · ${row.name}` : row.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            {draft.paymentTermsId === '' && (
              <Field label={t('terms.paymentTerms')} hint={model.library?.allowed ? t('terms.typedHint') : undefined}>
                <Input value={draft.paymentTerms} onChange={(event) => set('paymentTerms', event.target.value)} maxLength={200} />
              </Field>
            )}
            <Field label={t('terms.depositPct')} hint={t('terms.depositHint')} error={problems.depositPct ? t(problems.depositPct) : undefined}>
              <Input value={draft.depositPct} onChange={(event) => set('depositPct', event.target.value)} inputMode="decimal" />
            </Field>
            <fieldset className="fw-q-radios">
              <legend className="fw-q-legend">{t('terms.depositKind')}</legend>
              {(['ACCONTO', 'CAPARRA'] as const).map((kind) => (
                <RadioCard key={kind} name="fw-q-deposit-kind" value={kind} checked={draft.depositKind === kind} selected={draft.depositKind === kind} onChange={() => set('depositKind', kind)} title={t(`depositKind.${kind}`)} description={t(`depositKindBody.${kind}`)} />
              ))}
            </fieldset>
          </div>
        ) : (
          <KeyValue
            dense
            labelCase="sentence"
            items={[
              { label: t('terms.paymentTerms'), value: text(current.paymentTerms) },
              { label: t('terms.depositPct'), value: current.depositPct ? percent(current.depositPct, locale) : '—' },
              { label: t('terms.depositKind'), value: current.depositKind ? t(`depositKind.${current.depositKind}`) : '—' },
            ]}
          />
        )}
        <KeyValue
          dense
          labelCase="sentence"
          items={[
            { label: t('terms.depositAmount'), value: model.grains.price ? money(current.depositAmount, current.currency, locale) : t('summary.noPrice') },
            { label: t('terms.depositDue'), value: t('terms.depositDueValue') },
          ]}
        />
      </Card>

      {/* B-W2a-49 (SAL-012): the customer's minimum order against this quote's net total (price grain). */}
      {model.grains.price && current.belowMinimum && (
        <Banner tone="warning" title={t('terms.belowMinimum', { minimum: money(current.belowMinimum.minimum, current.currency, locale), short: money(current.belowMinimum.short, current.currency, locale) })} />
      )}

      {(current.taxMode.endsWith('B2C') || current.noWithdrawal) && (
        <Card padded>
          <h2 className="fw-q-h2">{t('terms.consumer.title')}</h2>
          <ul className="fw-q-list">
            <li>{t('terms.consumer.grossFirst')}</li>
            {current.noWithdrawal && <li>{t('terms.consumer.noWithdrawal')}</li>}
          </ul>
        </Card>
      )}

      </div>

      {editable && count > 0 && (
        <EditModeBar
          count={count}
          message={t('terms.unsaved', { count })}
          applyLabel={t('terms.save')}
          busy={saving}
          applyHeldReason={problemCount > 0 ? t('terms.fixFirst', { count: problemCount }) : null}
          onDiscard={() => setDraft(before)}
          onApply={save}
          saveShortcut
        />
      )}
    </div>
  )
}
