'use client'

import type { ReactNode } from 'react'
import { useState } from 'react'
import { ChevronRight, Info, Lock } from 'lucide-react'
import { Banner, Card, DetailPopover, EmptyState, KeyValue, MetricStrip, SummaryTable } from '@nexus/ui/components'
import { Button, Select, Spinner, Tag } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { BomView, CostCell, CostSheetView, StyleView } from '../../api'
import { costCellOf, costChange, decimalText, defaultCostCell, minutesText, missingWords, moneyText, revisionInView, share } from '../../model'
import type { StyleRecordActions, StyleRecordViewModel } from '../../record/record-model'

/**
 * SCR-044 Cost of the revision in view, for one colourway and size (the base size of the first colourway to start): the
 * strip (cost per garment, material, labour, overhead, the change against the released revision), the cost sheet from
 * materials to cost — each step opens to the lines behind it, a bar shows its share, and "How is this made?" gives the
 * formula with its numbers —, cost by size, the material prices it used, and the labour rates and overhead (Finance
 * settings). A figure that cannot be known is "—" with what is missing, never 0. Money by grain: without the cost grain
 * (production manager, sales) the sheet keeps its structure — quantities, minutes, what is missing — and no figure.
 */
export function CostTab({ style, model, actions }: { style: StyleView; model: StyleRecordViewModel; actions?: StyleRecordActions }) {
  const t = useT('products')
  const locale = useLocale()
  const revision = revisionInView(style.revisions, model.revisionId)
  if (!revision) return <EmptyState title={t('bom.noRevision.title')} description={t('bom.noRevision.body')} />
  if (model.cost.status === 'loading' || model.cost.status === 'idle')
    return (
      <Card padded aria-busy="true">
        <p className="fw-st-hint" role="status">
          <Spinner size={14} /> {t('cost.loading')}
        </p>
      </Card>
    )
  if (model.cost.status === 'error')
    return <Banner tone="danger" title={t('cost.failed')} action={<Button size="sm" onClick={() => actions?.onReload?.()}>{t('common.retry')}</Button>}>{t(model.cost.problem)}</Banner>
  const sheet = model.cost.value
  const at = model.costCell ?? defaultCostCell(sheet)
  const cell = costCellOf(sheet, at)
  const money = (value: string | null | undefined) => (model.grains.cost ? moneyText(value, sheet.currency, locale) : null)
  const bom = model.bom.status === 'ready' ? model.bom.value : null
  if (sheet.cells.length === 0 || !cell || !at)
    return (
      <div className="fw-st-stack-lg">
        <Card padded>
          <EmptyState title={t('cost.empty.title')} description={t('cost.empty.body')} />
        </Card>
        <MissingCard sheet={sheet} bom={bom} />
      </div>
    )
  const change = costChange(model.costCompare, at)
  const colourway = sheet.colourways.find((entry) => entry.id === at.colourwayId)

  return (
    <div className="fw-st-stack-lg">
      {!model.grains.cost && <Banner tone="info" icon={<Lock size={16} aria-hidden />} title={t('cost.noGrain')} />}
      {sheet.estimate && <Banner tone="info" title={t('cost.estimate', { revision: sheet.revision.revision })} />}

      <div className="fw-st-cellpick">
        <label className="fw-st-scope">
          <span className="fw-st-hint">{t('cost.colourway')}</span>
          <Select size="sm" value={at.colourwayId} onChange={(event) => actions?.onCostCell?.({ colourwayId: event.target.value, size: at.size })} aria-label={t('cost.colourway')}>
            {sheet.colourways.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.code} · {entry.name}
              </option>
            ))}
          </Select>
        </label>
        <label className="fw-st-scope">
          <span className="fw-st-hint">{t('cost.size')}</span>
          <Select size="sm" value={at.size} onChange={(event) => actions?.onCostCell?.({ colourwayId: at.colourwayId, size: event.target.value })} aria-label={t('cost.size')}>
            {sheet.sizes.map((size) => (
              <option key={size} value={size}>
                {size}
                {size === sheet.style.baseSize ? ` · ${t('range.baseMark')}` : ''}
              </option>
            ))}
          </Select>
        </label>
        <span className="fw-st-hint">{t('cost.computed', { date: formatDate(sheet.computedAt, { locale }), currency: sheet.currency })}</span>
      </div>

      <MetricStrip
        metrics={[
          { label: t('cost.strip.total', { colourway: colourway?.code ?? '', size: at.size }), value: money(cell.total) ?? t('cost.notInRole'), hint: cell.complete ? t('cost.strip.complete') : t('cost.strip.incomplete', { count: cell.missing.length }) },
          { label: t('cost.strip.material'), value: money(cell.material.amount) ?? t('cost.notInRole'), hint: cell.material.complete ? undefined : t('cost.partial') },
          { label: t('cost.strip.labour'), value: money(cell.labour.amount) ?? t('cost.notInRole'), hint: t('routing.minutes', { minutes: minutesText(cell.minutes, locale) }) },
          { label: t('cost.strip.overhead'), value: cell.overhead ? (money(cell.overhead.amount) ?? t('cost.notInRole')) : t('cost.noOverhead'), hint: cell.overhead ? t('cost.overheadPct', { pct: decimalText(cell.overhead.overheadPct, locale) }) : undefined },
          ...(model.costCompare
            ? [
                {
                  label: t('cost.strip.change', { revision: model.costCompare.from.revision }),
                  value: !model.grains.cost ? t('cost.notInRole') : change === null ? '—' : moneyText(change, sheet.currency, locale),
                  delta: model.grains.cost && change !== null && Number(change) !== 0 ? { value: Number(change) > 0 ? t('cost.up') : t('cost.down'), tone: Number(change) > 0 ? ('negative' as const) : ('positive' as const) } : undefined,
                  hint: change === null ? t('cost.changeUnknown') : undefined,
                },
              ]
            : []),
        ]}
      />

      <MissingCard sheet={sheet} bom={bom} />
      <div className="fw-st-pair">
        <SheetCard cell={cell} money={money} />
        <RatesCard sheet={sheet} money={money} />
      </div>
      <BySizeCard sheet={sheet} colourwayId={at.colourwayId} money={money} grain={model.grains.cost} />
      <PricesCard sheet={sheet} money={money} grain={model.grains.cost} />
    </div>
  )
}

type Money = (value: string | null | undefined) => string | null

/** A step of the sheet that opens to the lines behind it (the DS Disclosure's summary does not stretch to a figure row). */
function SheetStep({ summary, children }: { summary: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="fw-st-step">
      <button type="button" className="fw-st-step-head" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
        <ChevronRight size={14} className="fw-st-step-chevron" aria-hidden />
        {summary}
      </button>
      {open && <div className="fw-st-step-body">{children}</div>}
    </div>
  )
}

/** "How is this made?" — the formula with its numbers (only figures the person may see). */
function How({ label, children }: { label: string; children: ReactNode }) {
  const t = useT('products')
  return (
    <DetailPopover trigger={<Info size={13} aria-hidden />} triggerLabel={t('cost.how', { what: label })} triggerClassName="fw-st-how" label={t('cost.howTitle')} hoverDelay={250}>
      <div className="fw-st-howbody">{children}</div>
    </DetailPopover>
  )
}

function SheetCard({ cell, money }: { cell: CostCell; money: Money }) {
  const t = useT('products')
  const locale = useLocale()
  const known = cell.knownTotal
  const bar = (amount: string | null | undefined) =>
    amount ? (
      <span className="fw-st-bar" aria-hidden>
        <span className="fw-st-bar-fill" style={{ width: `${share(amount, known)}%` }} />
      </span>
    ) : null
  const missingFor = (complete: boolean) => (complete ? null : <Tag tone="warning">{t('cost.partial')}</Tag>)
  const linesOf = (category: string) => cell.material.lines.filter((line) => line.category === category)
  return (
    <Card header={t('cost.sheet.title')} description={t('cost.sheet.intro')}>
      <div className="fw-st-stack">
        {cell.material.byCategory.map((category) => (
          <SheetStep
            key={category.category}
            summary={
              <span className="fw-st-sheetrow">
                <span>{t(`category.${category.category}`)}</span>
                {missingFor(category.complete)}
                <span className="fw-st-grow" />
                {bar(amountOf(category.amount))}
                <b>{money(category.amount) ?? t('cost.notInRole')}</b>
              </span>
            }
          >
            <SummaryTable
              label={t(`category.${category.category}`)}
              stackOnPhone
              columns={[t('cost.col.material'), t('cost.col.qty'), t('cost.col.base'), t('cost.col.unitCost'), t('cost.col.amount')]}
              widths={['34%', '18%', '18%', '15%', undefined]}
              align={[undefined, 'right', 'right', 'right', 'right']}
              rows={linesOf(category.category).map((line) => ({
                id: line.lineId,
                cells: [
                  <span key="m" className="fw-st-cellstack">
                    <b>{line.code}</b>
                    <span className="nds-summary-sub">{line.placement ?? ''}</span>
                  </span>,
                  line.qty === null ? t('bom.missing') : `${decimalText(line.qty, locale)} ${t(`uom.${line.uom}`)} + ${decimalText(line.wastagePct, locale)} %`,
                  line.baseQuantity === null ? '—' : `${decimalText(line.baseQuantity, locale)} ${t(`uom.${line.baseUom}`)}`,
                  money(line.unitCost) ?? '·',
                  <span key="a" className="fw-st-inline fw-st-nowrap">
                    {money(line.amount) ?? '·'}
                    <How label={line.code}>
                      <p>{t('cost.howMaterial', { qty: line.qty ?? '—', wastage: line.wastagePct, base: line.baseQuantity ?? '—', unit: t(`uom.${line.baseUom}`) })}</p>
                      {money(line.unitCost) && <p>{t('cost.howMaterialCost', { base: line.baseQuantity ?? '—', price: money(line.unitCost) ?? '', amount: money(line.amount) ?? '—' })}</p>}
                    </How>
                  </span>,
                ],
              }))}
            />
          </SheetStep>
        ))}
        <SheetStep
          summary={
            <span className="fw-st-sheetrow">
              <span>{t('cost.sheet.labour', { minutes: minutesText(cell.minutes, locale) })}</span>
              {missingFor(cell.labour.complete)}
              <span className="fw-st-grow" />
              {bar(amountOf(cell.labour.amount))}
              <b>{money(cell.labour.amount) ?? t('cost.notInRole')}</b>
            </span>
          }
        >
          <SummaryTable
            label={t('cost.sheet.labourTable')}
            stackOnPhone
            columns={[t('routing.col.department'), t('cost.col.minutes'), t('cost.col.perMinute'), t('cost.col.efficiency'), t('cost.col.amount')]}
            align={[undefined, 'right', 'right', 'right', 'right']}
            rows={cell.labour.lines.map((line) => ({
              id: line.workCentreKind,
              cells: [
                t(`department.${line.workCentreKind}`),
                minutesText(line.minutes, locale),
                money(line.costPerMinute) ?? '·',
                line.plannedEfficiencyPct ? `${decimalText(line.plannedEfficiencyPct, locale)} %` : '—',
                <span key="a" className="fw-st-inline fw-st-nowrap">
                  {money(line.amount) ?? '·'}
                  <How label={t(`department.${line.workCentreKind}`)}>
                    <p>{t('cost.howLabour', { minutes: minutesText(line.minutes, locale), rate: money(line.costPerMinute) ?? '·', efficiency: line.plannedEfficiencyPct ?? '—', amount: money(line.amount) ?? '·' })}</p>
                  </How>
                </span>,
              ],
            }))}
          />
        </SheetStep>
        {cell.overhead && (
          <div className="fw-st-sheetrow fw-st-sheetrow-flat">
            <span>{t('cost.sheet.overhead', { pct: decimalText(cell.overhead.overheadPct, locale) })}</span>
            <How label={t('cost.strip.overhead')}>
              <p>{t('cost.howOverhead', { base: money(cell.overhead.base) ?? '·', pct: decimalText(cell.overhead.overheadPct, locale), amount: money(cell.overhead.amount) ?? '·' })}</p>
            </How>
            <span className="fw-st-grow" />
            {bar(amountOf(cell.overhead.amount))}
            <b>{money(cell.overhead.amount) ?? t('cost.notInRole')}</b>
          </div>
        )}
        {cell.waterfall.some((step) => step.step === 'ROUNDING') && (
          <div className="fw-st-sheetrow fw-st-sheetrow-flat">
            <span className="fw-st-hint">{t('cost.sheet.rounding')}</span>
            <span className="fw-st-grow" />
            <span>{money(cell.waterfall.find((step) => step.step === 'ROUNDING')?.amount) ?? '·'}</span>
          </div>
        )}
        <div className="fw-st-sheetrow fw-st-sheetrow-total">
          <span>{t('cost.sheet.total')}</span>
          {!cell.complete && <Tag tone="warning">{t('cost.incomplete')}</Tag>}
          <span className="fw-st-grow" />
          <b>{cell.complete ? (money(cell.total) ?? t('cost.notInRole')) : t('cost.knownSoFar', { amount: money(cell.knownTotal) ?? t('cost.notInRole') })}</b>
        </div>
      </div>
    </Card>
  )
}

/** The bar's amount (a figure only with the grain; the API leaves it out otherwise). */
const amountOf = (amount: string | null | undefined): string | null => amount ?? null

function BySizeCard({ sheet, colourwayId, money, grain }: { sheet: CostSheetView; colourwayId: string; money: Money; grain: boolean }) {
  const t = useT('products')
  const cells = sheet.sizes.map((size) => sheet.cells.find((cell) => cell.colourwayId === colourwayId && cell.size === size) ?? null)
  const row = (label: string, pick: (cell: CostCell) => string | null | undefined, complete: (cell: CostCell) => boolean) => ({
    id: label,
    cells: [label, ...cells.map((cell) => (cell ? (complete(cell) ? (money(pick(cell)) ?? '·') : '—') : '—'))],
  })
  return (
    <Card header={t('cost.bySize.title')} description={t('cost.bySize.intro')}>
      <div className="fw-st-scroll">
        <SummaryTable
          label={t('cost.bySize.title')}
          columns={[t('cost.bySize.what'), ...sheet.sizes.map((size) => (size === sheet.style.baseSize ? `${size} ·` : size))]}
          align={[undefined, ...sheet.sizes.map(() => 'right' as const)]}
          widths={['16%']}
          rows={[
            row(t('cost.strip.material'), (cell) => cell.material.amount, (cell) => cell.material.complete),
            row(t('cost.strip.labour'), (cell) => cell.labour.amount, (cell) => cell.labour.complete),
            ...(cells.some((cell) => cell?.overhead) ? [row(t('cost.strip.overhead'), (cell) => cell.overhead?.amount, (cell) => cell.complete)] : []),
            row(t('cost.sheet.total'), (cell) => cell.total, (cell) => cell.complete),
          ]}
        />
      </div>
      <p className="fw-st-hint">{t(grain ? 'cost.bySize.hint' : 'cost.bySize.hintNoGrain')}</p>
    </Card>
  )
}

function MissingCard({ sheet, bom }: { sheet: CostSheetView; bom: BomView | null }) {
  const t = useT('products')
  if (sheet.missing.length === 0) return null
  return (
    <Banner tone="warning" title={t('cost.missingTitle', { count: sheet.missing.length })}>
      <ul className="fw-st-list">
        {sheet.missing.map((entry) => {
          const words = missingWords(entry, sheet, bom)
          const kind = entry.workCentreKind ? t(`department.${entry.workCentreKind}`) : '—'
          return <li key={entry.key}>{t(words.key, { ...words.params, kind })}</li>
        })}
      </ul>
    </Banner>
  )
}

function PricesCard({ sheet, money, grain }: { sheet: CostSheetView; money: Money; grain: boolean }) {
  const t = useT('products')
  const locale = useLocale()
  return (
    <Card header={t('cost.prices.title')} description={t('cost.prices.intro')}>
      <SummaryTable
        label={t('cost.prices.title')}
        stackOnPhone
        columns={[t('cost.col.material'), t('cost.prices.source'), t('cost.prices.perBase'), t('cost.prices.perPurchase'), t('cost.prices.asOf')]}
        widths={['34%', '14%', '18%', '18%', undefined]}
        align={[undefined, undefined, 'right', 'right', 'right']}
        rows={sheet.inputs.materials.map((material) => ({
          id: material.itemId,
          cells: [
            <span key="m" className="fw-st-cellstack">
              <b>{material.code}</b>
              <span className="nds-summary-sub">{material.name}</span>
            </span>,
            t(`priceSource.${material.source}`),
            money(material.standardCost) === null ? '·' : material.standardCost === null || material.standardCost === undefined ? <span className="fw-st-danger">{t('cost.prices.none')}</span> : `${money(material.standardCost)} / ${t(`uom.${material.baseUom}`)}`,
            money(material.standardCostPerPurchaseUnit) === null || material.standardCostPerPurchaseUnit === null || material.standardCostPerPurchaseUnit === undefined ? '·' : `${money(material.standardCostPerPurchaseUnit)} / ${t(`uom.${material.purchaseUom}`)}`,
            material.asOf ? formatDate(material.asOf, { locale }) : '—',
          ],
        }))}
      />
      {!grain && <p className="fw-st-hint">{t('cost.prices.noGrain')}</p>}
    </Card>
  )
}

function RatesCard({ sheet, money }: { sheet: CostSheetView; money: Money }) {
  const t = useT('products')
  const locale = useLocale()
  const overhead = sheet.inputs.overhead
  return (
    <Card header={t('cost.rates.title')} description={t('cost.rates.intro')}>
      <div className="fw-st-stack">
        <SummaryTable
          label={t('cost.rates.title')}
          stackOnPhone
          columns={[t('routing.col.department'), t('cost.col.minutes'), t('cost.col.perMinute'), t('cost.col.efficiency'), t('cost.rates.from')]}
          align={[undefined, 'right', 'right', 'right', 'right']}
          rows={sheet.inputs.labour.map((rate) => ({
            id: rate.workCentreKind,
            cells: [
              t(`department.${rate.workCentreKind}`),
              minutesText(rate.minutes, locale),
              rate.source === 'NONE' ? <span className="fw-st-danger">{t('cost.rates.none')}</span> : (money(rate.costPerMinute) ?? '·'),
              rate.plannedEfficiencyPct ? `${decimalText(rate.plannedEfficiencyPct, locale)} %` : '—',
              rate.validFrom ? formatDate(`${rate.validFrom}T12:00:00Z`, { locale }) : '—',
            ],
          }))}
        />
        <KeyValue
          dense
          labelCase="sentence"
          items={[
            { label: t('cost.rates.overhead'), value: overhead.source === 'NONE' ? t('cost.noOverhead') : t('cost.overheadPct', { pct: decimalText(overhead.overheadPct ?? '0', locale) }) },
            { label: t('cost.rates.company'), value: sheet.companyId ? t('cost.rates.companyOwn') : t('cost.rates.tenantWide') },
          ]}
        />
        <p className="fw-st-hint">{t('cost.rates.where')}</p>
      </div>
    </Card>
  )
}
