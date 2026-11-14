'use client'

import { Banner, EmptyState } from '@nexus/ui/components'
import { VersionCompare } from '@nexus/ui/patterns/VersionCompare/index'
import { Button, Select, Spinner } from '@nexus/ui/primitives'
import { Modal, useDsWords } from '../../../../../../lib/i18n/ds-parts'
import { INTL_LOCALE } from '../../../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import type { Grains } from '../../../model'
import { decimalText, moneyText } from '../../../model'
import { lineWords } from '../../components/model'
import type { CompareView, VersionRow } from '../api'
import { CS_NS } from '../model'
import type { CompareModel, VersionsActions } from '../screen'

/**
 * SCR-501 — Compare two versions (design products.styles style.cost.versions "Compare two versions", the DS VersionCompare):
 * pick the two versions; the lines added, removed and changed (quantity, unit cost, cost — the figures only with the cost
 * grain), the weighted cost and each size's total before → after. Two versions in different currencies are not compared
 * figure by figure (said). Esc closes; focus returns to the opener.
 */
export function CompareDialog({ rows, model, grains, actions }: { rows: readonly VersionRow[]; model: CompareModel; grains: Grains; actions?: VersionsActions }) {
  const t = useT(CS_NS)
  const close = () => actions?.onCompareClose?.()
  const sorted = [...rows].sort((a, b) => a.sheetVersion - b.sheetVersion || a.createdAt.localeCompare(b.createdAt))
  const option = (row: VersionRow) => `${t('ver.name', { version: row.sheetVersion })} · ${row.season?.code ?? t('ver.noSeason')} · ${t(`verCmp.state.${row.state}`)}`
  return (
    <Modal open onClose={close} size="xl" title={t('verCmp.title')} footer={<Button onClick={close}>{t('csCommon.close')}</Button>}>
      <div className="fw-st-dialog">
        <div className="fw-st-cellpick">
          <label className="fw-st-scope">
            <span className="fw-st-hint">{t('verCmp.a')}</span>
            <Select size="sm" value={model.a} aria-label={t('verCmp.a')} onChange={(event) => actions?.onCompare?.(event.target.value, model.b)}>
              {sorted.map((row) => (
                <option key={row.id} value={row.id}>
                  {option(row)}
                </option>
              ))}
            </Select>
          </label>
          <label className="fw-st-scope">
            <span className="fw-st-hint">{t('verCmp.b')}</span>
            <Select size="sm" value={model.b} aria-label={t('verCmp.b')} onChange={(event) => actions?.onCompare?.(model.a, event.target.value)}>
              {sorted.map((row) => (
                <option key={row.id} value={row.id}>
                  {option(row)}
                </option>
              ))}
            </Select>
          </label>
        </div>
        {model.a === model.b ? (
          <p className="fw-st-hint">{t('verCmp.same')}</p>
        ) : model.result.status === 'idle' || model.result.status === 'loading' ? (
          <p className="fw-st-hint" role="status">
            <Spinner size={14} /> {t('verCmp.loading')}
          </p>
        ) : model.result.status === 'error' ? (
          <EmptyState title={t('verCmp.failed')} description={t(model.result.problem)} action={<Button size="sm" onClick={() => actions?.onCompare?.(model.a, model.b)}>{t('csCommon.retry')}</Button>} />
        ) : (
          <CompareBody view={model.result.value} grains={grains} />
        )}
      </div>
    </Modal>
  )
}

function CompareBody({ view, grains }: { view: CompareView; grains: Grains }) {
  const t = useT(CS_NS)
  const tp = useT('products')
  const ds = useDsWords()
  const locale = useLocale()
  const money = (value: string | null | undefined, currency: string) => (grains.cost && view.comparable && value !== undefined && value !== null ? moneyText(value, currency, locale) : null)
  const side = (entry: CompareView['lines'][number]['a'], currency: string) =>
    entry
      ? {
          fields: {
            quantity: entry.uom ? `${decimalText(entry.quantity, locale)} ${tp(`uom.${entry.uom}`)}` : entry.pct ? `${decimalText(entry.pct, locale)} %` : decimalText(entry.quantity, locale),
            ...(grains.cost ? { unitCost: money(entry.unitCost, currency), cost: money(entry.cost, currency) } : {}),
          },
        }
      : null
  return (
    <div className="fw-st-stack">
      {!view.comparable && <Banner tone="warning" title={t('verCmp.notComparable', { a: view.a.currency, b: view.b.currency })} />}
      <VersionCompare
        before={{ label: t('ver.name', { version: view.a.sheetVersion }), note: t(`verCmp.state.${view.a.state}`) }}
        after={{ label: t('ver.name', { version: view.b.sheetVersion }), note: t(`verCmp.state.${view.b.state}`) }}
        lines={view.lines.map((line) => {
          const words = lineWords(line, (kind) => tp(`kind.${kind}`))
          return {
            id: line.key,
            label: t(words.key, words.params),
            detail: `${t(`stepCat.${line.category}`)} · ${line.size === null ? t('steps.everySize') : t('steps.inSizeShort', { size: line.size })}`,
            before: side(line.a, view.a.currency),
            after: side(line.b, view.b.currency),
          }
        })}
        fields={[{ id: 'quantity', label: t('steps.col.quantity') }, ...(grains.cost ? [{ id: 'unitCost', label: t('steps.col.unitCost') }, { id: 'cost', label: t('steps.col.cost') }] : [])]}
        totals={
          grains.cost && view.comparable
            ? [
                { id: 'weighted', label: t('verView.weighted'), before: money(view.weighted.a, view.a.currency), after: money(view.weighted.b, view.b.currency) },
                ...view.sizesCompared.map((size) => ({ id: `size:${size.size}`, label: t('verCmp.sizeTotal', { size: size.size }), before: money(size.total.a, view.a.currency), after: money(size.total.b, view.b.currency) })),
              ]
            : []
        }
        locale={INTL_LOCALE[locale]}
        labels={ds.versionCompare}
      />
      {!grains.cost && <p className="fw-st-hint">{t('verCmp.noGrain')}</p>}
    </div>
  )
}
