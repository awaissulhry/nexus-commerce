'use client'

import { Plus, Trash2 } from 'lucide-react'
import { Banner, Field, SummaryTable } from '@nexus/ui/components'
import { Button, Input, Select, Spinner } from '@nexus/ui/primitives'
import { DateField } from '../../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { quantity } from '../../../../_shared/buying/model'
import { plainQuantity, receiveHeld, stockKey, type BackLineDraft, type ReceiveDraft } from '../record-model'
import { Frame, type DialogProps } from './Dialogs'
import { dateLocale } from './OperationsTab'
import { useSay } from './parts'

/**
 * Receive back (design rec back "Receive back"; SCM-142): what the workshop returns, per operation and — when the bundles
 * can be read — per bundle (one line per bundle: good, defective, scrapped there, the reason when not good), the unused
 * material it hands back (out of its stock location into a place of ours), the workshop's own DDT and when it came. ONE
 * act: the order is partly back or back, the fee for the pieces back good goes on the work order's cost (cost grain).
 */
export function ReceiveDialog({ order, model, actions, draft }: DialogProps & { draft: ReceiveDraft }) {
  const t = useT('subcontract-order')
  const sayWords = useSay()
  const locale = useLocale()
  const held = receiveHeld(draft, order, model.today)
  const set = (next: Partial<ReceiveDraft>) => actions?.onDialog?.({ kind: 'receive', draft: { ...draft, ...next } })
  const setLine = (key: string, next: Partial<BackLineDraft>) => set({ lines: draft.lines.map((line) => (line.key === key ? { ...line, ...next } : line)) })
  const out = order.operations.filter((operation) => operation.atWorkshop > 0)
  const bundles = draft.bundles?.value ?? null

  return (
    <Frame model={model} actions={actions} size="lg" title={t('receive.title', { number: order.number, workshop: order.workshop.name })} held={held ? sayWords(held) : null} label={t('receive.confirm')} onConfirm={() => actions?.onReceive?.()}>
      <div className="fw-by-fields">
        <Field label={t('receive.when')} required>
          <DateField value={draft.receivedOn} onChange={(value) => set({ receivedOn: value })} max={model.today} locale={dateLocale(locale)} placeholder={t('ops.noDate')} ariaLabel={t('receive.when')} />
        </Field>
        <Field label={t('receive.ddtNumber')} hint={t('receive.ddtHint')}>
          <Input size="sm" maxLength={40} value={draft.ddtNumber} onChange={(event) => set({ ddtNumber: event.target.value })} />
        </Field>
        <Field label={t('receive.ddtDate')}>
          <DateField value={draft.ddtDate} onChange={(value) => set({ ddtDate: value })} max={model.today} locale={dateLocale(locale)} clearable clearLabel={t('common.clear')} placeholder={t('back.noDdt')} ariaLabel={t('receive.ddtDate')} />
        </Field>
      </div>

      <section className="fw-sco-section" aria-label={t('receive.piecesTitle')}>
        <h3 className="fw-by-h3">{t('receive.piecesTitle')}</h3>
        {out.length === 0 ? (
          <p className="fw-by-hint">{t('receive.nothingOut')}</p>
        ) : (
          out.map((operation) => {
            const lines = draft.lines.filter((line) => line.operationId === operation.id)
            const cells = new Set(operation.sizes.map((size) => size.workOrderSizeId))
            const mine = bundles ? bundles.filter((bundle) => cells.size === 0 || cells.has(bundle.workOrderSizeId)) : []
            return (
              <div key={operation.id} className="fw-sco-back">
                <div className="fw-by-card-head">
                  <h4 className="fw-by-h3">{t('receive.operation', { line: operation.seq, code: operation.workOrderOperation.code, name: operation.workOrderOperation.name, count: operation.atWorkshop })}</h4>
                  {bundles && mine.length > 0 && (
                    <Button size="sm" variant="quiet" onClick={() => set({ lines: [...draft.lines, { key: `${operation.id}:${draft.lines.length + 1}:${Date.now() % 100000}`, operationId: operation.id, bundleId: '', good: '0', defective: '0', scrapped: '0', reason: '' }] })}>
                      <Plus size={13} aria-hidden /> {t('receive.addBundle')}
                    </Button>
                  )}
                </div>
                {lines.map((line, index) => (
                  <div key={line.key} className="fw-sco-backline">
                    {draft.bundles === null ? null : draft.bundles.value === null ? (
                      <p className="fw-by-hint" role="status">
                        {draft.bundles.problem ? t(draft.bundles.problem) : <><Spinner size={12} /> {t('common.loading')}</>}
                      </p>
                    ) : (
                      <Field label={t('receive.bundle')}>
                        <Select size="sm" value={line.bundleId} onChange={(event) => setLine(line.key, { bundleId: event.target.value })}>
                          <option value="">{t('receive.noBundle')}</option>
                          {mine.map((bundle) => (
                            <option key={bundle.id} value={bundle.id}>
                              {t('receive.bundleOption', { code: bundle.code, colourway: bundle.colourwayCode, size: bundle.size, count: bundle.quantity })}
                            </option>
                          ))}
                        </Select>
                      </Field>
                    )}
                    <Field label={t('receive.good')}>
                      <Input size="sm" inputMode="numeric" value={line.good} onChange={(event) => setLine(line.key, { good: event.target.value })} />
                    </Field>
                    <Field label={t('receive.defective')}>
                      <Input size="sm" inputMode="numeric" value={line.defective} onChange={(event) => setLine(line.key, { defective: event.target.value })} />
                    </Field>
                    <Field label={t('receive.scrapped')}>
                      <Input size="sm" inputMode="numeric" value={line.scrapped} onChange={(event) => setLine(line.key, { scrapped: event.target.value })} />
                    </Field>
                    {(line.defective.trim() !== '0' && line.defective.trim() !== '') || (line.scrapped.trim() !== '0' && line.scrapped.trim() !== '') ? (
                      <Field label={t('receive.reason')} required>
                        <Input size="sm" maxLength={300} value={line.reason} onChange={(event) => setLine(line.key, { reason: event.target.value })} />
                      </Field>
                    ) : null}
                    {index > 0 && (
                      <Button size="sm" variant="quiet" tone="danger" aria-label={t('receive.removeLine')} onClick={() => set({ lines: draft.lines.filter((entry) => entry.key !== line.key) })}>
                        <Trash2 size={13} aria-hidden />
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )
          })
        )}
        {draft.bundles === null && <p className="fw-by-hint">{t('receive.bundlesNoRight')}</p>}
      </section>

      <section className="fw-sco-section" aria-label={t('receive.returnsTitle')}>
        <h3 className="fw-by-h3">{t('receive.returnsTitle')}</h3>
        {draft.stock.problem ? (
          <Banner tone="danger" title={t(draft.stock.problem)} />
        ) : draft.stock.value === null ? (
          <p className="fw-by-hint" role="status">
            <Spinner size={14} /> {t('common.loading')}
          </p>
        ) : draft.stock.value.length === 0 ? (
          <p className="fw-by-hint">{t('receive.noStock')}</p>
        ) : (
          <SummaryTable
            label={t('receive.returnsTitle')}
            columns={[t('receive.col.material'), t('receive.col.lot'), t('receive.col.there'), t('receive.col.back'), t('receive.col.to')]}
            align={['left', 'left', 'right', 'left', 'left']}
            stackOnPhone
            rows={draft.stock.value.map((row) => {
              const key = stockKey(row)
              const entry = draft.returns[key] ?? { quantity: '', toLocationId: '' }
              const update = (next: Partial<typeof entry>) => set({ returns: { ...draft.returns, [key]: { ...entry, ...next } } })
              return {
                id: key,
                cells: [
                  `${row.item.code} ${row.item.name}${row.colour ? ` · ${row.colour.code}` : ''}`,
                  row.lot?.code ?? row.hide?.code ?? '—',
                  `${quantity(row.onHand, locale, 4)} ${t(`uom.${row.item.baseUom}`)}`,
                  <Input key="q" size="sm" inputMode="decimal" aria-label={t('receive.returnOf', { code: row.item.code })} placeholder={plainQuantity(row.onHand)} value={entry.quantity} onChange={(event) => update({ quantity: event.target.value })} />,
                  draft.locations.value ? (
                    <Select key="l" size="sm" aria-label={t('receive.toOf', { code: row.item.code })} value={entry.toLocationId} onChange={(event) => update({ toLocationId: event.target.value })}>
                      <option value="">{t('receive.pickTo')}</option>
                      {draft.locations.value.map((location) => (
                        <option key={location.id} value={location.id}>
                          {location.code} · {location.name}
                        </option>
                      ))}
                    </Select>
                  ) : draft.locations.problem ? (
                    t(draft.locations.problem)
                  ) : (
                    t('common.loading')
                  ),
                ],
              }
            })}
          />
        )}
      </section>

      <Field label={t('receive.note')}>
        <Input size="sm" maxLength={1000} value={draft.note} onChange={(event) => set({ note: event.target.value })} />
      </Field>
      <ul className="fw-by-list">
        <li>{t('receive.what')}</li>
        {model.can.cost && <li>{t('receive.fee')}</li>}
      </ul>
    </Frame>
  )
}
