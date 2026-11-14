'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Trash2 } from 'lucide-react'
import { Banner, EmptyState, Field, KeyValue, SummaryTable } from '@nexus/ui/components'
import { Button, Checkbox, Input, Pill, Spinner, Tag } from '@nexus/ui/primitives'
import { Modal, StepUpModal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { MassApplyView, MassPreviewView, MaterialRow } from '../api'
import '../mass-update.css'
import { applyHeld, decimalMoney, MASS_NS, minorMoney, percent, plainMoney, previewHeld, rowProblem, styleOfKey, type MassAbilities, type PriceRow } from '../model'

export type MassStep = 'prices' | 'effect' | 'done'

export interface MassUpdateModel {
  readonly prefix: string
  readonly can: MassAbilities
  readonly open: boolean
  readonly step: MassStep
  readonly rows: readonly PriceRow[]
  readonly search: { readonly text: string; readonly results: readonly MaterialRow[] | null; readonly busy: boolean; readonly problem: string | null }
  readonly preview: MassPreviewView | null
  readonly applied: MassApplyView | null
  readonly leaveOut: boolean
  readonly note: string
  readonly busy: boolean
  /** A refused preview or apply, in words; `stale`: the effect was read again because something moved. */
  readonly problem: string | null
  readonly stale: boolean
  readonly stepUp: { readonly open: boolean; readonly busy: boolean; readonly problem: string | null }
}

export interface MassUpdateActions {
  onOpen?: () => void
  onClose?: () => void
  onSearch?: (text: string) => void
  onAdd?: (material: MaterialRow) => void
  onPrice?: (itemId: string, text: string) => void
  onRemove?: (itemId: string) => void
  onPreview?: () => void
  onBack?: () => void
  onLeaveOut?: (on: boolean) => void
  onNote?: (text: string) => void
  onApply?: () => void
  onStepUpSubmit?: (code: string) => void
  onStepUpCancel?: () => void
}

/**
 * SCR-505 — Finance › Costing › Mass cost update (design finance.costing page.h "Mass cost update" secondary, pop:mass;
 * FIN-022): the band's button and its pop-up in three steps — the new standard price of one or more materials; their effect
 * (each cost sheet series recomputed and the draft it would get, the styles without a sheet, the price lists' and open order
 * lines' margins — margins only with the margin grain); "Approve update" asks a fresh code first and makes NEW draft versions
 * (an approved version is never touched; each draft goes for its yes from its style's Cost tab). Something that moved since
 * the preview is shown again before anything is written. Esc closes; focus returns to the button.
 */
export function MassUpdateDialog({ model, actions }: { model: MassUpdateModel; actions?: MassUpdateActions }) {
  // Its own catalogues (WithMessages replaces the page's): the products words name the units.
  return (
    <WithMessages namespaces={[MASS_NS, 'products']}>
      <MassUpdate model={model} actions={actions} />
    </WithMessages>
  )
}

function MassUpdate({ model, actions }: { model: MassUpdateModel; actions?: MassUpdateActions }) {
  const t = useT(MASS_NS)
  return (
    <>
      <Button size="sm" heldReason={model.can.preview ? null : t('mass.held.noGrain')} onClick={() => actions?.onOpen?.()}>
        {t('mass.open')}
      </Button>
      {model.open && <Dialog model={model} actions={actions} />}
      <StepUpModal
        open={model.stepUp.open}
        title={t('mass.stepUp.title')}
        sentence={t('mass.stepUp.sentence')}
        busy={model.stepUp.busy}
        error={model.stepUp.problem ? t(model.stepUp.problem) : null}
        onSubmit={(code) => actions?.onStepUpSubmit?.(code)}
        onClose={() => actions?.onStepUpCancel?.()}
        confirmLabel={t('mass.stepUp.confirm')}
      />
    </>
  )
}

function Dialog({ model, actions }: { model: MassUpdateModel; actions?: MassUpdateActions }) {
  const t = useT(MASS_NS)
  const close = () => actions?.onClose?.()
  const held = (phrase: { key: string; params?: Record<string, string | number> } | null) => (phrase ? t(phrase.key, phrase.params) : null)
  const footer =
    model.step === 'prices' ? (
      <>
        <Button onClick={close}>{t('csCommon.cancel')}</Button>
        <Button variant="primary" heldReason={held(previewHeld(model.can, model.rows, model.busy))} onClick={() => actions?.onPreview?.()}>
          {model.busy ? t('csCommon.working') : t('mass.preview')}
        </Button>
      </>
    ) : model.step === 'effect' ? (
      <>
        <Button onClick={() => actions?.onBack?.()}>{t('mass.back')}</Button>
        <Button variant="primary" heldReason={held(applyHeld(model.can, model.preview, model.leaveOut, model.busy))} onClick={() => actions?.onApply?.()}>
          {model.busy ? t('csCommon.working') : t('mass.approve')}
        </Button>
      </>
    ) : (
      <Button variant="primary" onClick={close}>
        {t('csCommon.close')}
      </Button>
    )
  return (
    <Modal open onClose={close} size="xl" title={t('mass.title')} footer={footer}>
      <div className="fw-mcu">
        <p className="fw-mcu-steps" aria-label={t('mass.stepsLabel')}>
          {(['prices', 'effect', 'done'] as const).map((step, index) => (
            <Tag key={step} tone={model.step === step ? 'info' : 'neutral'}>
              {index + 1}. {t(`mass.step.${step}`)}
            </Tag>
          ))}
        </p>
        {model.problem && <Banner tone={model.stale ? 'warning' : 'danger'} title={t(model.problem)} />}
        {model.step === 'prices' && <PricesStep model={model} actions={actions} />}
        {model.step === 'effect' && model.preview && <EffectStep model={model} preview={model.preview} actions={actions} />}
        {model.step === 'done' && model.applied && <DoneStep model={model} applied={model.applied} />}
      </div>
    </Modal>
  )
}

function PricesStep({ model, actions }: { model: MassUpdateModel; actions?: MassUpdateActions }) {
  const t = useT(MASS_NS)
  const tp = useT('products')
  const locale = useLocale()
  const [text, setText] = useState(model.search.text)
  const taken = new Set(model.rows.map((row) => row.itemId))
  return (
    <div className="fw-mcu-stack">
      <p className="fw-mcu-hint">{t('mass.pricesIntro')}</p>
      {model.can.materials ? (
        <form
          className="fw-mcu-search"
          onSubmit={(event) => {
            event.preventDefault()
            actions?.onSearch?.(text)
          }}
        >
          <Field label={t('mass.find')} hint={t('mass.findHint')}>
            <Input value={text} onChange={(event) => setText(event.target.value)} />
          </Field>
          <Button type="submit" size="sm" heldReason={text.trim().length < 2 ? t('mass.held.search') : model.search.busy ? t('mass.held.busy') : null}>
            {t('mass.search')}
          </Button>
        </form>
      ) : (
        <Banner tone="info" title={t('mass.noMaterials')} />
      )}
      {model.search.busy && (
        <p className="fw-mcu-hint" role="status">
          <Spinner size={12} /> {t('mass.searching')}
        </p>
      )}
      {model.search.problem && <Banner tone="danger" title={t(model.search.problem)} />}
      {model.search.results && (
        <SummaryTable
          label={t('mass.results')}
          stackOnPhone
          density="roomy"
          columns={[t('mass.col.material'), t('mass.col.now'), t('mass.col.add')]}
          align={[undefined, 'right', 'right']}
          rows={
            model.search.results.length === 0
              ? [{ id: 'none', cells: [<span key="n" className="fw-mcu-hint">{t('mass.noResults')}</span>, '', ''] }]
              : model.search.results.map((material) => ({
                  id: material.id,
                  cells: [
                    <span key="m" className="fw-mcu-cell">
                      <b>{material.code}</b>
                      <span className="nds-summary-sub">{material.name}</span>
                    </span>,
                    material.standardCost ? `${decimalMoney(material.standardCost, material.currency, locale)} / ${tp(`uom.${material.baseUom}`)}` : t('mass.noPriceNow'),
                    <Button key="a" size="sm" heldReason={taken.has(material.id) ? t('mass.held.taken') : null} onClick={() => actions?.onAdd?.(material)}>
                      {t('mass.add')}
                    </Button>,
                  ],
                }))
          }
        />
      )}
      <h3 className="fw-mcu-h3">{t('mass.newPrices', { count: model.rows.length })}</h3>
      {model.rows.length === 0 ? (
        <EmptyState title={t('mass.noRows')} description={t('mass.noRowsBody')} />
      ) : (
        <SummaryTable
          label={t('mass.newPrices', { count: model.rows.length })}
          stackOnPhone
          density="roomy"
          columns={[t('mass.col.material'), t('mass.col.now'), t('mass.col.new'), t('mass.col.remove')]}
          widths={['34%', '22%', '30%', undefined]}
          align={[undefined, 'right', undefined, 'right']}
          rows={model.rows.map((row) => {
            const problem = row.newPrice.trim() === '' ? null : rowProblem(row)
            return {
              id: row.itemId,
              cells: [
                <span key="m" className="fw-mcu-cell">
                  <b>{row.code}</b>
                  <span className="nds-summary-sub">{row.name}</span>
                </span>,
                row.priceNow ? `${decimalMoney(row.priceNow, row.currency, locale)} / ${tp(`uom.${row.baseUom}`)}` : t('mass.noPriceNow'),
                <Field key="n" label={t('mass.newFor', { code: row.code, unit: tp(`uom.${row.baseUom}`), currency: row.currency })} error={problem ? t(problem) : undefined}>
                  <Input size="sm" inputMode="decimal" value={row.newPrice} onChange={(event) => actions?.onPrice?.(row.itemId, event.target.value)} />
                </Field>,
                <Button key="r" size="sm" variant="quiet" aria-label={t('mass.removeLabel', { code: row.code })} onClick={() => actions?.onRemove?.(row.itemId)}>
                  <Trash2 size={14} aria-hidden />
                </Button>,
              ],
            }
          })}
        />
      )}
    </div>
  )
}

function EffectStep({ model, preview, actions }: { model: MassUpdateModel; preview: MassPreviewView; actions?: MassUpdateActions }) {
  const t = useT(MASS_NS)
  const tp = useT('products')
  const locale = useLocale()
  const counts = preview.counts
  return (
    <div className="fw-mcu-stack">
      <KeyValue
        dense
        labelCase="sentence"
        columns={3}
        items={[
          { label: t('mass.count.series'), value: String(counts.series), hint: t('mass.count.recomputed', { count: counts.recomputed }) },
          { label: t('mass.count.incomplete'), value: String(counts.incomplete), hint: counts.seasonClosed > 0 ? t('mass.count.closed', { count: counts.seasonClosed }) : undefined },
          { label: t('mass.count.documents'), value: t('mass.count.documentsValue', { lists: counts.listEntries, lines: counts.orderLines }) },
        ]}
      />
      {preview.truncated && <Banner tone="info" title={t('mass.truncated')} />}
      <h3 className="fw-mcu-h3">{t('mass.materials')}</h3>
      <SummaryTable
        label={t('mass.materials')}
        stackOnPhone
        columns={[t('mass.col.material'), t('mass.col.now'), t('mass.col.new'), t('mass.col.change')]}
        align={[undefined, 'right', 'right', 'right']}
        rows={preview.materials.map((material) => ({
          id: material.itemId,
          cells: [
            <span key="m" className="fw-mcu-cell">
              <b>{material.code}</b>
              <span className="nds-summary-sub">{material.name}</span>
            </span>,
            material.priceNow ? `${decimalMoney(material.priceNow, material.currency, locale)} / ${tp(`uom.${material.baseUom}`)}` : t('mass.noPriceNow'),
            `${decimalMoney(material.newPrice, material.currency, locale)} / ${tp(`uom.${material.baseUom}`)}`,
            material.changePct ? percent(material.changePct, locale, true) : '—',
          ],
        }))}
      />
      <h3 className="fw-mcu-h3">{t('mass.series', { count: preview.series.length })}</h3>
      {preview.series.length === 0 ? (
        <p className="fw-mcu-hint">{t('mass.noSeries')}</p>
      ) : (
        <SummaryTable
          label={t('mass.series', { count: preview.series.length })}
          stackOnPhone
          columns={[t('mass.col.style'), t('mass.col.version'), t('mass.col.base'), t('mass.col.weighted'), t('mass.col.what')]}
          widths={['20%', '16%', '22%', '22%', undefined]}
          align={[undefined, undefined, 'right', 'right', undefined]}
          rows={preview.series.map((series) => ({
            id: series.key,
            cells: [
              <span key="s" className="fw-mcu-cell">
                <b>{series.style.code}</b>
                <span className="nds-summary-sub">{series.style.name}</span>
              </span>,
              t('mass.versionOf', { version: series.sheet.sheetVersion, state: t(`mass.sheetState.${series.sheet.state}`) }),
              `${plainMoney(series.baseSize.before, locale)} → ${plainMoney(series.baseSize.after, locale)} (${series.sheet.baseSize})`,
              `${plainMoney(series.weighted.before, locale)} → ${plainMoney(series.weighted.after, locale)}`,
              <Pill key="w" tone={series.state === 'RECOMPUTED' ? 'info' : series.state === 'INCOMPLETE' ? 'warning' : 'neutral'}>
                {t(`massSeries.${series.state}`)}
              </Pill>,
            ],
          }))}
        />
      )}
      {preview.withoutSheet.length > 0 && (
        <Banner tone="info" title={t('mass.withoutSheet', { count: preview.withoutSheet.length })}>
          {preview.withoutSheet.map((entry) => t('mass.withoutSheetOne', { code: entry.code, revision: entry.revision })).join(' · ')}
        </Banner>
      )}
      <h3 className="fw-mcu-h3">{t('mass.lists', { count: preview.priceLists.length })}</h3>
      {preview.priceLists.length === 0 ? (
        <p className="fw-mcu-hint">{t('mass.noLists')}</p>
      ) : (
        <SummaryTable
          label={t('mass.lists', { count: preview.priceLists.length })}
          stackOnPhone
          columns={[t('mass.col.list'), t('mass.col.style'), ...(model.can.price ? [t('mass.col.price')] : []), t('mass.col.cost'), ...(model.can.margin ? [t('mass.col.margin')] : [])]}
          align={[undefined, undefined, ...(model.can.price ? (['right'] as const) : []), 'right', ...(model.can.margin ? (['right'] as const) : [])]}
          rows={preview.priceLists.map((entry) => ({
            id: `${entry.versionId}:${entry.styleId}:${entry.colourwayId ?? '*'}`,
            cells: [
              <span key="l" className="fw-mcu-cell">
                <b>{entry.code}</b>
                <span className="nds-summary-sub">{t('mass.listRevision', { name: entry.name, revision: entry.revision })}</span>
              </span>,
              entry.styleCode,
              ...(model.can.price ? [decimalMoney(entry.price, entry.currency, locale)] : []),
              entry.comparable ? `${decimalMoney(entry.costBefore, entry.currency, locale)} → ${decimalMoney(entry.costAfter, entry.currency, locale)}` : t('mass.otherCurrency'),
              ...(model.can.margin ? [entry.comparable ? `${percent(entry.marginBefore, locale)} → ${percent(entry.marginAfter, locale)}` : '—'] : []),
            ],
          }))}
        />
      )}
      <h3 className="fw-mcu-h3">{t('mass.orders', { count: preview.orders.length })}</h3>
      {preview.orders.length === 0 ? (
        <p className="fw-mcu-hint">{t('mass.noOrders')}</p>
      ) : (
        <SummaryTable
          label={t('mass.orders', { count: preview.orders.length })}
          stackOnPhone
          columns={[t('mass.col.order'), t('mass.col.style'), t('mass.col.pieces'), t('mass.col.cost'), ...(model.can.margin ? [t('mass.col.margin')] : [])]}
          align={[undefined, undefined, 'right', 'right', ...(model.can.margin ? (['right'] as const) : [])]}
          rows={preview.orders.map((line) => ({
            id: line.lineId,
            cells: [
              <span key="o" className="fw-mcu-cell">
                <b>{t('mass.orderLine', { number: line.number, seq: line.seq })}</b>
                <span className="nds-summary-sub">{line.customer}</span>
              </span>,
              line.styleCode,
              String(line.pieces),
              `${minorMoney(line.costBefore, line.currency, locale)} → ${minorMoney(line.costAfter, line.currency, locale)}`,
              ...(model.can.margin ? [`${percent(line.marginBefore, locale)} → ${percent(line.marginAfter, locale)}`] : []),
            ],
          }))}
        />
      )}
      {!model.can.margin && <p className="fw-mcu-hint">{t('mass.noMargin')}</p>}
      {counts.incomplete > 0 && (
        <>
          <Checkbox checked={model.leaveOut} onChange={(event) => actions?.onLeaveOut?.(event.target.checked)} label={t('mass.leaveOut', { count: counts.incomplete })} />
          <p className="fw-mcu-hint">{t('mass.leaveOutHint')}</p>
        </>
      )}
      <Field label={t('mass.note')} hint={t('mass.noteHint')}>
        <Textarea rows={2} maxLength={500} value={model.note} onChange={(event) => actions?.onNote?.(event.target.value)} />
      </Field>
      <p className="fw-mcu-hint">{t('mass.whatHappens')}</p>
    </div>
  )
}

function DoneStep({ model, applied }: { model: MassUpdateModel; applied: MassApplyView }) {
  const t = useT(MASS_NS)
  return (
    <div className="fw-mcu-stack">
      <Banner tone="success" title={t('mass.done', { prices: applied.materials.length, drafts: applied.created.length })} />
      {applied.created.length > 0 && (
        <SummaryTable
          label={t('mass.created')}
          stackOnPhone
          columns={[t('mass.col.style'), t('mass.col.version'), t('mass.col.open')]}
          align={[undefined, undefined, 'right']}
          rows={applied.created.map((entry) => {
            const style = styleOfKey(model.preview, entry.key)
            return {
              id: entry.sheetId,
              cells: [
                style?.code ?? '—',
                <span key="v" className="fw-mcu-cell">
                  <span>{t('mass.draftVersion', { version: entry.sheetVersion })}</span>
                  {entry.leftOut > 0 && <span className="nds-summary-sub">{t('mass.leftOutCount', { count: entry.leftOut })}</span>}
                </span>,
                style ? (
                  <Link key="o" href={`${model.prefix}/products/styles/${encodeURIComponent(style.id)}?tab=cost`}>
                    {t('mass.openCost')}
                  </Link>
                ) : (
                  '—'
                ),
              ],
            }
          })}
        />
      )}
      {applied.skipped.length > 0 && (
        <Banner tone="info" title={t('mass.skipped', { count: applied.skipped.length })}>
          {applied.skipped.map((entry) => t(`massSeries.${entry.state}`)).join(' · ')}
        </Banner>
      )}
      <p className="fw-mcu-hint">{t('mass.next')}</p>
    </div>
  )
}
