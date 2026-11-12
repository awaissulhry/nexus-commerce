'use client'

import { useMemo } from 'react'
import { MoreHorizontal, ShieldOff } from 'lucide-react'
import { Banner, Card, EmptyState, Menu, MetricStrip } from '@nexus/ui/components'
import { Button, SegmentedControl, Select, Skeleton } from '@nexus/ui/primitives'
import { Modal } from '../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { listKeys, type ListKey } from '../../../../list-frame/model'
import { WithMessages } from '../../../../record-panels/i18n'
import { BUCKETS, dayWords, isLayer, NAMESPACE, pieces, sourcesWords, tilesInOrder, WEEK_CHOICES, type Bucket, type Words } from '../model'
import type { DemandActions, DemandModel } from '../view-model'
import { RowsSection } from './RowsSection'
import { TimePhasedGrid } from './TimePhasedGrid'
import '../demand.css'

export type { DemandActions, DemandModel } from '../view-model'

/**
 * SCR-374 — Planning › Long range › Demand & forecast (design planning.demand, a workspace list; the plan's SCR-201 is Lots &
 * traceability's since W1). The band: as of, live, the site, Week / Month and the horizon, ⋯ (Export the grid, Production
 * strategy per item, Keyboard shortcuts). Then three sections, each loading and failing on its own: Demand at a glance (a tile
 * per layer in the design's order, the W3 layers "—", never 0; a tile narrows the list to its layer), Demand over time (the
 * TimePhasedGrid: style-colour lines × buckets, layer by layer, the cell popover "What makes this number"), Demand rows (the
 * same demand as a list with its source). The design's W3 parts (Publish forecast, Import forecast, Versions, the size curve,
 * editable forecast cells) are not drawn. No page max-width; pieces only.
 */
export function DemandView({ model, actions }: { model: DemandModel; actions?: DemandActions }) {
  return (
    <WithMessages namespaces={[NAMESPACE, 'lists']}>
      <DemandScreen model={model} actions={actions} />
    </WithMessages>
  )
}

function DemandScreen({ model, actions }: { model: DemandModel; actions?: DemandActions }) {
  const t = useT(NAMESPACE)
  const locale = useLocale()
  const words: Words = useMemo(() => ({ t, locale }), [t, locale])

  if (!model.can.view) {
    return (
      <div className="fw-dm">
        <Card padded>
          <EmptyState icon={<ShieldOff size={24} aria-hidden />} title={t('noAccess.title')} description={t('noAccess.body')} />
        </Card>
      </div>
    )
  }

  const sites = model.sites.status === 'ready' ? model.sites.value : []
  const site = sites.find((entry) => entry.id === model.siteId) ?? null
  const demand = model.demand.status === 'ready' ? model.demand.value : null
  const weeks = model.controls.weeks ?? demand?.horizon.weeks ?? null
  const weekChoices = [...new Set([...WEEK_CHOICES, ...(weeks ? [weeks] : [])])].sort((a, b) => a - b)
  const tiles = demand ? tilesInOrder(demand.tiles) : tilesInOrder([])
  const place = { locale, timeZone: demand?.site.timeZone ?? 'Europe/Rome' }

  return (
    <div className="fw-dm">
      <div className="fw-dm-head">
        <span className="fw-dm-status" role="status">
          {model.demand.status === 'loading' ? <Skeleton width={180} height={18} /> : demand ? t('page.asOf', { time: formatDateTime(demand.asOf, place) }) : null}
          {demand && <span>{t('page.horizon', { from: dayWords(demand.horizon.from, locale), to: dayWords(demand.horizon.to, locale, true) })}</span>}
          <span>{t(`live.${model.live}`)}</span>
        </span>
        <span className="fw-dm-inline">
          {sites.length > 1 && (
            <Select size="sm" aria-label={t('page.site')} value={model.siteId ?? ''} onChange={(event) => actions?.onSite?.(event.target.value)}>
              {sites.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.code} · {entry.name}
                </option>
              ))}
            </Select>
          )}
          {sites.length === 1 && site && <span className="fw-dm-hint">{t('page.siteOne', { site: `${site.code} · ${site.name}` })}</span>}
          <SegmentedControl size="sm" ariaLabel={t('page.bucket')} value={model.controls.bucket} onChange={(value) => actions?.onBucket?.(value as Bucket)} options={BUCKETS.map((bucket) => ({ value: bucket, label: t(`bucket.${bucket}`) }))} />
          <Select size="sm" aria-label={t('page.weeks')} value={weeks ? String(weeks) : ''} onChange={(event) => actions?.onWeeks?.(event.target.value ? Number(event.target.value) : null)}>
            {!weeks && <option value="">{t('page.weeksSite')}</option>}
            {weekChoices.map((count) => (
              <option key={count} value={String(count)}>
                {t('page.weeksCount', { count })}
              </option>
            ))}
          </Select>
          <Menu
            label={<MoreHorizontal size={16} aria-hidden />}
            align="right"
            triggerProps={{ 'aria-label': t('page.more') }}
            items={[
              { id: 'export', label: t('page.exportGrid'), onSelect: () => actions?.onExportGrid?.([]), disabled: !demand || demand.rows.length === 0 },
              { id: 'strategy', label: t('page.strategy'), href: `${model.prefix}/planning/mps${model.siteId ? `?site=${encodeURIComponent(model.siteId)}` : ''}` },
              { id: 'keys', label: t('page.keys'), onSelect: () => actions?.onKeys?.() },
            ]}
          />
        </span>
      </div>

      {model.sites.status === 'ready' && sites.length === 0 && <Banner tone="info" title={t('page.noSites')} />}
      {model.sites.status === 'error' && (
        <Banner
          tone="danger"
          title={t('page.sitesFailed')}
          action={
            <Button size="sm" onClick={() => actions?.onRetry?.('demand')}>
              {t('common.retry')}
            </Button>
          }
        >
          {t(model.sites.problem)}
        </Banner>
      )}
      {demand?.truncated && <Banner tone="info" title={t('page.truncated', { count: demand.rows.length })} />}
      {demand && demand.unplaced.orderLines + demand.unplaced.quoteLines + demand.unplaced.sampleRounds > 0 && (
        <Banner tone="warning" title={t('page.unplacedTitle')}>
          {t('page.unplaced', { orders: demand.unplaced.orderLines, quotes: demand.unplaced.quoteLines, rounds: demand.unplaced.sampleRounds })}
        </Banner>
      )}

      <section aria-labelledby="fw-dm-tiles" className="fw-dm-section">
        <div className="fw-dm-section-head">
          <h2 className="fw-dm-h2" id="fw-dm-tiles">
            {t('tiles.title')}
          </h2>
          <p className="fw-dm-hint">{t('tiles.purpose')}</p>
        </div>
        {model.demand.status === 'error' ? (
          <Card padded>
            <EmptyState
              title={t('tiles.error')}
              description={t(model.demand.problem)}
              action={
                <Button size="sm" onClick={() => actions?.onRetry?.('demand')}>
                  {t('common.retry')}
                </Button>
              }
            />
          </Card>
        ) : (
          <MetricStrip
            metrics={tiles.map((tile) => {
              const layer = tile.layer
              const value = !demand || !tile.known || tile.pieces === null ? '—' : pieces(tile.pieces, locale)
              const hint = !demand ? t('tiles.loading') : !tile.known ? t(`tiles.later.${layer}`) : t('tiles.hint', { sources: sourcesWords(tile.sources ?? 0, words), late: tile.pastDue ?? 0, after: tile.later ?? 0 })
              return isLayer(layer) && demand
                ? { label: t(`tile.${layer}`), value, hint, onClick: () => actions?.onTile?.(model.controls.layer === layer ? null : layer), active: model.controls.layer === layer }
                : { label: t(`tile.${layer}`), value, hint }
            })}
          />
        )}
      </section>

      <section aria-labelledby="fw-dm-phased" className="fw-dm-section">
        <div className="fw-dm-section-head">
          <h2 className="fw-dm-h2" id="fw-dm-phased">
            {t('grid.title')}
          </h2>
          <p className="fw-dm-hint">{t('grid.purpose')}</p>
        </div>
        <TimePhasedGrid model={model} actions={actions} words={words} />
        <p className="fw-dm-hint">{t('grid.note')}</p>
      </section>

      <section aria-labelledby="fw-dm-list" className="fw-dm-section" id="fw-dm-list-section">
        <div className="fw-dm-section-head">
          <h2 className="fw-dm-h2" id="fw-dm-list">
            {t('rows.title')}
          </h2>
          <p className="fw-dm-hint">{t('rows.purpose')}</p>
        </div>
        <RowsSection model={model} actions={actions} words={words} />
      </section>

      {model.dialog?.kind === 'keys' && (
        <Modal open onClose={() => actions?.onCloseDialog?.()} title={t('page.keys')} size="sm">
          <KeysList t={t} />
        </Modal>
      )}
    </div>
  )
}

function KeysList({ t }: { t: (key: string) => string }) {
  const lists = useT('lists')
  const own: ListKey[] = [
    { keys: ['Enter'], does: t('keys.what') },
    { keys: ['o'], does: t('keys.sizes') },
  ]
  return (
    <ul className="fw-dm-list">
      {listKeys(own, true).map((entry) => (
        <li key={entry.does}>
          <b>{entry.keys.join(' ')}</b> — {entry.does.startsWith('keys.') ? lists(entry.does) : entry.does}
        </li>
      ))}
      <li>
        <b>Esc</b> — {t('keys.close')}
      </li>
    </ul>
  )
}
