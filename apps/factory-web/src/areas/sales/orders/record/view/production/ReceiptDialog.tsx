'use client'

import { Banner, Field } from '@nexus/ui/components'
import { Checkbox, Input, Select } from '@nexus/ui/primitives'
import { DateField } from '../../../../../../lib/i18n/ds-parts'
import { INTL_LOCALE } from '../../../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import type { Order } from '../../../api'
import { isHide, receivePlacesOf, type ReceiptActions, type ReceiptModel } from '../../production/receipt'
import { Frame } from '../Dialogs'
import { PartFailed, PartReading } from './Kit'
import './receipt.css' // F-PT-304: laid out by the screen (the dialog is outside the tab's size container)

/**
 * F-PT-304 (order PRODUCTION tab, 10-design §9 D3) — "Record what the customer sent · SO-…": the site and the place the goods go
 * (the goods-in dock first), the customer's delivery note number and day, one row per material pre-filled with what is still to
 * come and their lot reference. Leather received hide by hide is said in words and left out BEFORE anything is sent. Centred, two
 * footer buttons (Cancel · Record the receipt), held in words until it can be sent. Fetches nothing (use-customer-receipt does).
 */
export function ReceiptDialog({ order, model, actions }: { order: Order; model: ReceiptModel; actions?: ReceiptActions }) {
  const t = useT('orders')
  const locale = useLocale()
  const sites = model.sites.value ?? []
  const site = sites.find((entry) => entry.id === model.draft.siteId) ?? null
  const places = receivePlacesOf(site)
  return (
    <Frame
      title={t('productionTab.receipt.title', { number: order.number })}
      held={model.held ? t(model.held.key, model.held.params) : null}
      go={() => actions?.onSubmit()}
      goLabel={model.busy ? t('common.working') : t('productionTab.receipt.go')}
      onClose={() => actions?.onClose()}
      problem={model.problem ? <Banner tone="danger" title={t(model.problem.key, model.problem.params)} /> : null}
      size="lg"
    >
      {!model.sites.value && !model.sites.problem ? <PartReading rows={1} height={30} /> : null}
      {model.sites.problem ? <PartFailed part={t('productionTab.receipt.sites')} problem={model.sites.problem} /> : null}
      {sites.length > 1 ? (
        <Field label={t('productionTab.receipt.site')}>
          <Select value={model.draft.siteId ?? ''} onChange={(event) => actions?.onDraft({ siteId: event.target.value || null })}>
            <option value="">{t('productionTab.receipt.sitePick')}</option>
            {sites.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.code} · {entry.name}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      {site ? (
        <Field label={t('productionTab.receipt.place')} hint={places.length === 0 ? t('productionTab.receipt.noPlace') : undefined}>
          <Select value={model.draft.locationId ?? ''} onChange={(event) => actions?.onDraft({ locationId: event.target.value || null })}>
            <option value="">{t('productionTab.receipt.placePick')}</option>
            {places.map((place) => (
              <option key={place.id} value={place.id}>
                {place.code} · {place.name}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      <div className="fw-pt-rc-ddt">
        <Field label={t('productionTab.receipt.ddt')}>
          <Input value={model.draft.ddtNumber} onChange={(event) => actions?.onDraft({ ddtNumber: event.target.value })} maxLength={60} autoComplete="off" />
        </Field>
        <Field label={t('productionTab.receipt.ddtDate')}>
          <DateField value={model.draft.ddtDate} onChange={(value) => actions?.onDraft({ ddtDate: value })} locale={INTL_LOCALE[locale]} ariaLabel={t('productionTab.receipt.ddtDate')} />
        </Field>
      </div>
      <table className="fw-pt-table fw-pt-rc">
        <thead>
          <tr>
            <th scope="col">{t('productionTab.materials.col.material')}</th>
            <th scope="col">{t('productionTab.receipt.col.quantity')}</th>
            <th scope="col">{t('productionTab.receipt.col.lot')}</th>
          </tr>
        </thead>
        <tbody>
          {model.draft.lines.map((line) =>
            isHide(model.tracking, line) ? (
              <tr key={line.key}>
                <td className="fw-pt-first" colSpan={3}>
                  {line.label}
                  <span className="fw-pt-sub">{t('productionTab.receipt.hide')}</span>
                </td>
              </tr>
            ) : (
              <tr key={line.key}>
                <td className="fw-pt-first">
                  <Checkbox checked={line.take} onChange={(event) => actions?.onLine(line.key, { take: event.target.checked })} label={line.label} />
                </td>
                <td data-label={t('productionTab.receipt.col.quantity')}>
                  <span className="fw-pt-inline">
                    <Input inputMode="decimal" value={line.quantity} disabled={!line.take} onChange={(event) => actions?.onLine(line.key, { quantity: event.target.value })} aria-label={t('productionTab.receipt.quantityOf', { material: line.label })} autoComplete="off" />
                    <span className="fw-pt-sub">{line.uom}</span>
                  </span>
                </td>
                <td data-label={t('productionTab.receipt.col.lot')}>
                  <Input value={line.lot} disabled={!line.take} maxLength={80} onChange={(event) => actions?.onLine(line.key, { lot: event.target.value })} aria-label={t('productionTab.receipt.lotOf', { material: line.label })} autoComplete="off" />
                </td>
              </tr>
            ),
          )}
        </tbody>
      </table>
      <p className="fw-so-hint">{t('productionTab.receipt.hint')}</p>
    </Frame>
  )
}
