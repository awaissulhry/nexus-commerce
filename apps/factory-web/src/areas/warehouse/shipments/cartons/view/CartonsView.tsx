'use client'

import { useEffect, useRef } from 'react'
import { ChevronDown, ChevronUp, FileText, PackagePlus, Scale, Trash2 } from 'lucide-react'
import { Card, Drawer, EmptyState, KeyValue, SummaryTable } from '@nexus/ui/components'
import { Button, Kbd, Pill, Tag } from '@nexus/ui/primitives'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { DEPTH_NAMESPACES } from '../../queue/shared/depth'
import { PartRead, useDepthWords } from '../../queue/shared/DepthDialog'
import type { Bench, Carton } from '../api'
import { addHeld, cartonName, contentsBySize, dimensions, kilos, MARKS_TONE, marksState, packedTotals, removeHeld, serialsOf, trackingOf, weighHeld, type CartonsActions, type CartonsModel } from '../model'
import '../../shipments.css'
import '../../queue/shared/depth.css'

/**
 * SCR-594 — Lines & cartons › Cartons (design sh-cartons, pop:sh-carton; sh-lines "serials"): every carton as packed at the
 * station (B-W2b-384) — "n of N", its packaging (the carton master), contents by size with the serials counted, net and
 * gross weight, L × W × H, its tracking number and its label and marks — a row opens the docked carton drawer (contents by
 * size with the lot and every serial, weights, dimensions, packaging, label; ⌘↑ / ⌘↓ the carton before / after); Packed by
 * size (ordered against packed); the shipment's serials with their carton. Add carton, Weigh and measure and Remove are
 * W1's (the station scans the garments in); each held button says why.
 */
export function CartonsView({ model, actions }: { model: CartonsModel; actions?: CartonsActions }) {
  return (
    <WithMessages namespaces={DEPTH_NAMESPACES}>
      <Cartons model={model} actions={actions} />
    </WithMessages>
  )
}

function Cartons({ model, actions }: { model: CartonsModel; actions?: CartonsActions }) {
  const { t, say } = useDepthWords()
  const locale = useLocale()
  const head = (
    <div className="fw-sh-card-head">
      <h2 className="fw-sh-h2">{t('cartons.title')}</h2>
      <span className="fw-sh-inline">
        {model.bench.state === 'ready' && model.bench.value.cartons.length > 0 && <span className="fw-sh-hint">{t('cartons.count', { count: model.bench.value.cartons.length })}</span>}
        {model.context.status === 'DRAFT' && (
          <Button size="sm" heldReason={say(addHeld(model.context))} onClick={() => actions?.onAdd?.()}>
            <PackagePlus size={14} aria-hidden /> {t('cartons.add')}
          </Button>
        )}
      </span>
    </div>
  )
  if (model.bench.state !== 'ready') {
    return (
      <Card padded>
        {head}
        <PartRead problem={model.bench.state === 'error' ? model.bench.problem : null} onRetry={actions?.onRetry} label={t('cartons.title')} />
      </Card>
    )
  }
  const bench = model.bench.value
  const open = bench.cartons.find((carton) => carton.id === model.openId) ?? null
  const totals = packedTotals(bench)
  const serials = serialsOf(bench)
  return (
    <Card padded>
      {head}
      {bench.problems.length > 0 && (
        <span className="fw-shd-chips" role="status">
          {bench.problems.map((problem) => (
            <Tag key={problem} tone="warning">
              {t(`cartons.problem.${problem}`)}
            </Tag>
          ))}
        </span>
      )}
      {bench.cartons.length === 0 ? (
        <EmptyState title={t('cartons.none.title')} description={t('cartons.none.body')} />
      ) : (
        <SummaryTable
          label={t('cartons.title')}
          columns={[t('cartons.col.carton'), t('cartons.col.packaging'), t('cartons.col.contents'), t('cartons.col.weight'), t('cartons.col.size'), t('cartons.col.tracking'), t('cartons.col.label'), t('cartons.col.actions')]}
          rows={bench.cartons.map((carton) => {
            const net = kilos(carton.netWeightKg, locale)
            const gross = kilos(carton.grossWeightKg, locale)
            const size = dimensions(carton, locale)
            const tracking = trackingOf(model.context, carton.id)
            const marks = marksState(carton)
            const groups = contentsBySize(carton.contents)
            return {
              id: carton.id,
              cells: [
                <Button key="n" size="sm" variant="quiet" onClick={() => actions?.onOpen?.(carton.id)} aria-label={t('cartons.openOf', { carton: say(cartonName(carton)) ?? '' })} aria-expanded={model.openId === carton.id}>
                  {say(cartonName(carton))}
                </Button>,
                carton.packagingType ? (
                  <span key="p" className="fw-sh-cell">
                    <span>{carton.packagingType.name}</span>
                    <span className="fw-sh-cell-sub">{t(`packagingKind.${carton.packagingType.kind}`)}</span>
                  </span>
                ) : (
                  <span key="p" className="fw-sh-muted">
                    {carton.closed ? t('cartons.noPackaging') : t('cartons.packagingAtClose')}
                  </span>
                ),
                groups.length === 0 ? (
                  <span key="c" className="fw-sh-muted">
                    {t('cartons.empty')}
                  </span>
                ) : (
                  <span key="c" className="fw-sh-cell">
                    {groups.map((group) => (
                      <span key={group.key}>
                        {group.style}: {group.sizes}
                      </span>
                    ))}
                    <span className="fw-sh-cell-sub">
                      {t('cartons.garments', { count: carton.garments })}
                      {groups.some((group) => group.serials > 0) ? ` · ${t('cartons.serialsCount', { count: groups.reduce((sum, group) => sum + group.serials, 0) })}` : ''}
                    </span>
                  </span>
                ),
                gross === null ? (
                  <Tag key="w" tone="warning">
                    {t('cartons.notWeighed')}
                  </Tag>
                ) : (
                  <span key="w" className="fw-sh-cell">
                    <span>{t('cartons.gross', { value: gross })}</span>
                    {net !== null && <span className="fw-sh-cell-sub">{t('cartons.net', { value: net })}</span>}
                  </span>
                ),
                <span key="s">{size ? t('cartons.cm', { size }) : '—'}</span>,
                tracking ? (
                  <span key="t" className="fw-sh-mono">
                    {tracking}
                  </span>
                ) : (
                  <span key="t" className="fw-sh-muted">
                    —
                  </span>
                ),
                <span key="l" className="fw-sh-cell">
                  <Pill tone={MARKS_TONE[marks]}>{t(`cartons.marks.${marks}`)}</Pill>
                  <span className="fw-sh-cell-sub">{carton.labelled || tracking ? t('cartons.labelled') : t('cartons.noLabel')}</span>
                </span>,
                <span key="a" className="fw-sh-inline">
                  <Button size="sm" variant="quiet" heldReason={say(weighHeld(model.context, carton))} onClick={() => actions?.onWeigh?.(carton.id)} aria-label={t('cartons.weighOf', { carton: say(cartonName(carton)) ?? '' })}>
                    <Scale size={14} aria-hidden />
                  </Button>
                  {model.context.status === 'DRAFT' && (
                    <Button size="sm" variant="quiet" heldReason={say(removeHeld(model.context, carton))} onClick={() => actions?.onRemove?.(carton.id)} aria-label={t('cartons.removeOf', { carton: say(cartonName(carton)) ?? '' })}>
                      <Trash2 size={14} aria-hidden />
                    </Button>
                  )}
                </span>,
              ],
            }
          })}
          density="roomy"
          stackOnPhone
          align={['left', 'left', 'left', 'right', 'left', 'left', 'left', 'right']}
        />
      )}
      {bench.grid.length > 0 && (
        <details className="fw-sh-details">
          <summary>{t('cartons.bySize', { packed: totals.packed, ordered: totals.ordered })}</summary>
          <SummaryTable
            label={t('cartons.bySizeLabel')}
            columns={[t('cartons.col.style'), t('cartons.col.sizes'), t('cartons.col.lot')]}
            rows={bench.grid.map((row) => ({
              id: `${row.styleId}|${row.colourwayId}`,
              cells: [
                <span key="s" className="fw-sh-cell">
                  <span>
                    {row.styleCode} · {row.colourwayName}
                  </span>
                  {row.serialTracked && <span className="fw-sh-cell-sub">{t('cartons.serialTracked')}</span>}
                </span>,
                <span key="z" className="fw-shd-chips">
                  {row.sizes.map((size) => (
                    <Tag key={size.size} tone={size.packed >= size.ordered ? 'success' : 'neutral'}>
                      {t('cartons.sizeOf', { size: size.size, packed: size.packed, ordered: size.ordered })}
                    </Tag>
                  ))}
                </span>,
                <span key="b" className="fw-sh-mono">
                  {row.batchNumbers.join(', ') || '—'}
                </span>,
              ],
            }))}
            density="compact"
            stackOnPhone
          />
        </details>
      )}
      {serials.length > 0 && (
        <details className="fw-sh-details">
          <summary>{t('cartons.serials', { count: serials.length })}</summary>
          <ul className="fw-sh-list fw-sh-mono" aria-label={t('cartons.serialsLabel')}>
            {serials.map((entry) => (
              <li key={entry.serial}>{`${entry.serial} · ${entry.style} ${entry.size} · ${say(entry.carton)}`}</li>
            ))}
          </ul>
        </details>
      )}
      <div className="fw-sh-card-foot">
        <span className="fw-sh-hint">{t('cartons.foot')}</span>
        {model.context.canPack && bench.cartons.length > 0 && model.context.status !== 'CANCELLED' && (
          <Button size="sm" heldReason={model.context.busy ? t('cartons.held.busy') : null} onClick={() => actions?.onPackingList?.()}>
            <FileText size={14} aria-hidden /> {t('cartons.packingList')}
          </Button>
        )}
      </div>
      {open && <CartonDrawer bench={bench} carton={open} model={model} actions={actions} />}
    </Card>
  )
}

function CartonDrawer({ bench, carton, model, actions }: { bench: Bench; carton: Carton; model: CartonsModel; actions?: CartonsActions }) {
  const { t, say } = useDepthWords()
  const locale = useLocale()
  const latest = useRef(actions)
  latest.current = actions
  const index = bench.cartons.findIndex((entry) => entry.id === carton.id)
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        event.preventDefault()
        latest.current?.onStep?.(event.key === 'ArrowUp' ? -1 : 1)
      } else if (event.key === 'Escape' && !(event.target as HTMLElement | null)?.closest('[role="dialog"]')) {
        latest.current?.onOpen?.(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const tracking = trackingOf(model.context, carton.id)
  const marks = marksState(carton)
  const net = kilos(carton.netWeightKg, locale)
  const gross = kilos(carton.grossWeightKg, locale)
  const size = dimensions(carton, locale)
  return (
    <Drawer
      open
      mode="dock"
      width={460}
      onClose={() => actions?.onOpen?.(null)}
      closeLabel={t('cartons.drawer.close')}
      title={say(cartonName(carton))}
      subtitle={t('cartons.drawer.position', { index: index + 1, count: bench.cartons.length, number: bench.shipment.number })}
      footer={
        <div className="fw-shd-drawer-foot">
          <Button size="sm" variant="quiet" heldReason={index <= 0 ? t('cartons.drawer.first') : null} onClick={() => actions?.onStep?.(-1)} aria-keyshortcuts="Meta+ArrowUp Control+ArrowUp">
            <ChevronUp size={14} aria-hidden /> {t('cartons.drawer.previous')}
          </Button>
          <Button size="sm" variant="quiet" heldReason={index >= bench.cartons.length - 1 ? t('cartons.drawer.last') : null} onClick={() => actions?.onStep?.(1)} aria-keyshortcuts="Meta+ArrowDown Control+ArrowDown">
            <ChevronDown size={14} aria-hidden /> {t('cartons.drawer.next')}
          </Button>
          <span className="fw-sh-hint" aria-hidden>
            <Kbd>⌘</Kbd>
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>
          </span>
        </div>
      }
    >
      <div className="fw-shd-stack">
        <section aria-labelledby="fw-shd-carton-contents">
          <h3 className="fw-sh-h3" id="fw-shd-carton-contents">
            {t('cartons.drawer.contents')}
          </h3>
          {carton.contents.length === 0 ? (
            <p className="fw-sh-hint">{t('cartons.empty')}</p>
          ) : (
            <ul className="fw-shd-contents">
              {carton.contents.map((line) => (
                <li key={line.id} className="fw-shd-content">
                  <span className="fw-sh-cell">
                    <strong>
                      {line.styleCode} · {line.colourwayName} · {line.size} × {line.quantity}
                    </strong>
                    <span className="fw-sh-cell-sub">
                      {line.styleName} · {t('cartons.drawer.lot', { lot: line.batchNumber ?? '—', order: line.workOrderNumber })}
                      {line.originCountry ? ` · ${t('cartons.drawer.origin', { country: line.originCountry })}` : ''}
                    </span>
                  </span>
                  {line.serials.length > 0 && (
                    <ul className="fw-shd-serials fw-sh-mono" aria-label={t('cartons.drawer.serialsOf', { style: line.styleCode, size: line.size })}>
                      {line.serials.map((serial) => (
                        <li key={serial.id}>
                          {serial.serial}
                          {serial.packedAt ? <span className="fw-sh-cell-sub"> · {t('cartons.drawer.scanned', { when: formatDateTime(serial.packedAt, { locale }) })}</span> : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
        <section aria-labelledby="fw-shd-carton-facts">
          <h3 className="fw-sh-h3" id="fw-shd-carton-facts">
            {t('cartons.drawer.facts')}
          </h3>
          <KeyValue
            dense
            labelCase="sentence"
            items={[
              { label: t('cartons.col.packaging'), value: carton.packagingType ? `${carton.packagingType.name} · ${t(`packagingKind.${carton.packagingType.kind}`)}` : t('cartons.noPackaging') },
              { label: t('cartons.drawer.gross'), value: gross === null ? t('cartons.notWeighed') : t('cartons.kg', { value: gross }) },
              { label: t('cartons.drawer.net'), value: net === null ? '—' : t('cartons.kg', { value: net }) },
              { label: t('cartons.col.size'), value: size ? t('cartons.cm', { size }) : '—' },
              { label: t('cartons.col.tracking'), value: tracking ?? t('cartons.noLabel') },
              { label: t('cartons.drawer.marks'), value: `${t(`cartons.marks.${marks}`)}${carton.marksPrintedAt ? ` · ${formatDateTime(carton.marksPrintedAt, { locale })}` : ''}` },
            ]}
          />
          {(marks === 'stale' || marks === 'notPrinted') && <p className="fw-sh-hint">{t('cartons.drawer.marksHint')}</p>}
        </section>
      </div>
    </Drawer>
  )
}
