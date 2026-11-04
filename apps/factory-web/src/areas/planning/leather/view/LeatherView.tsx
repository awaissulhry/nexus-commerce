'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { MoreHorizontal, Play, Search, ShieldOff } from 'lucide-react'
import { Banner, Card, EmptyState, Menu, MetricStrip } from '@nexus/ui/components'
import { Button, Input, Select, Skeleton, Spinner } from '@nexus/ui/primitives'
import { formatDateTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { NAMESPACE, sectionOfTile, tileCounts, TILES, visibleNeed, type Words } from '../model'
import type { LeatherActions, LeatherModel } from '../view-model'
import { LeatherDialogs } from './LeatherDialogs'
import { NeedSection } from './NeedSection'
import { ProtectorsSection } from './ProtectorsSection'
import { ShadeDrawer } from './ShadeDrawer'
import { YieldSection } from './YieldSection'
import '../leather.css'

export type { LeatherActions, LeatherModel } from '../view-model'

/**
 * SCR-252 — Planning › Leather & cut plan (design planning.leather, a workspace list): the band (the plan run it reads, Run plan
 * now, ⋯ Print cut plan · Export · Keyboard shortcuts), the tiles Leather at a glance (counts that are saved filters: a press
 * filters its section), then the three sections, each loading and failing on its own: Leather need per order (the shade
 * drawer on Enter), Certified protectors, Planned vs actual yield (Accept / Dismiss the proposal). No page max-width.
 */
export function LeatherView({ model, actions }: { model: LeatherModel; actions?: LeatherActions }) {
  return (
    <WithMessages namespaces={[NAMESPACE, 'buying', 'lists']}>
      <LeatherScreen model={model} actions={actions} />
    </WithMessages>
  )
}

export function useLeatherWords(): Words {
  const t = useT(NAMESPACE)
  const units = useT('buying')
  const locale = useLocale()
  return useMemo(() => ({ t, unit: (uom: string) => (uom ? units(`uom.${uom}`) : ''), locale }), [t, units, locale])
}

function LeatherScreen({ model, actions }: { model: LeatherModel; actions?: LeatherActions }) {
  const words = useLeatherWords()
  const { t, locale } = words
  const [query, setQuery] = useState(model.controls.q)
  useEffect(() => setQuery(model.controls.q), [model.controls.q])
  const typed = useRef(false)
  const latest = useRef(actions)
  latest.current = actions
  useEffect(() => {
    if (!typed.current) return
    const timer = setTimeout(() => latest.current?.onSearch?.(query), 250)
    return () => clearTimeout(timer)
  }, [query])
  const sectionRefs = { need: useRef<HTMLElement>(null), protectors: useRef<HTMLElement>(null), yield: useRef<HTMLElement>(null) }
  const tile = model.controls.tile
  useEffect(() => {
    if (!tile) return
    sectionRefs[sectionOfTile(tile)].current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' })
    // The section's ref is stable; only a new tile scrolls.
  }, [tile])

  if (!model.can.view) {
    return (
      <div className="fw-lp">
        <Card padded>
          <EmptyState icon={<ShieldOff size={24} aria-hidden />} title={t('noAccess.title')} description={t('noAccess.body')} />
        </Card>
      </div>
    )
  }

  const sites = model.sites.status === 'ready' ? model.sites.value : []
  const site = sites.find((entry) => entry.id === model.siteId) ?? null
  const need = model.need.status === 'ready' ? model.need.value : null
  const counts = tileCounts(need, model.protectors.status === 'ready' ? model.protectors.value : null, model.yields.status === 'ready' ? model.yields.value : null)
  const runHeld = !model.can.run ? t('held.noRun') : model.running ? t('held.running') : !model.siteId ? t('held.noSite') : null
  const place = { locale, timeZone: model.timeZone }
  const openRow = need && model.controls.open ? (need.rows.find((row) => row.id === model.controls.open) ?? null) : null
  const order = need ? visibleNeed(need.rows, model.controls).map((row) => row.id) : []

  return (
    <div className="fw-lp">
      <div className="fw-lp-head">
        <span className="fw-lp-status" role="status">
          {model.need.status === 'loading' ? <Skeleton width={180} height={18} /> : need?.run ? t('page.asOf', { time: formatDateTime(need.run.finishedAt, place) }) : t('page.noRun')}
          {' · '}
          {t(`live.${model.live}`)}
        </span>
        <span className="fw-lp-inline">
          {sites.length > 1 && (
            <Select size="sm" aria-label={t('page.site')} value={model.siteId ?? ''} onChange={(event) => actions?.onSite?.(event.target.value)}>
              {sites.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.code} · {entry.name}
                </option>
              ))}
            </Select>
          )}
          {sites.length === 1 && site && <span className="fw-lp-hint">{t('page.siteOne', { site: `${site.code} · ${site.name}` })}</span>}
          <Input
            size="sm"
            type="search"
            leadingIcon={<Search size={13} aria-hidden />}
            aria-label={t('page.search')}
            placeholder={t('page.search')}
            value={query}
            onChange={(event) => {
              typed.current = true
              setQuery(event.target.value)
            }}
          />
          <Button size="sm" heldReason={runHeld} onClick={() => actions?.onRun?.()}>
            {model.running ? <Spinner size={12} /> : <Play size={13} aria-hidden />} {model.running ? t('page.running') : t('page.run')}
          </Button>
          <Menu
            label={<MoreHorizontal size={16} aria-hidden />}
            align="right"
            triggerProps={{ 'aria-label': t('page.more') }}
            items={[
              { id: 'print', label: t('page.print'), onSelect: () => actions?.onPrint?.(), disabled: !need },
              { id: 'export', label: t('page.export'), onSelect: () => actions?.onExport?.([]), disabled: !need || need.rows.length === 0 },
              { id: 'keys', label: t('page.keys'), onSelect: () => actions?.onKeys?.() },
            ]}
          />
        </span>
      </div>

      {model.sites.status === 'ready' && sites.length === 0 && <Banner tone="info" title={t('page.noSites')} />}
      {model.updates > 0 && (
        <Banner
          tone="info"
          title={t('page.newRun', { count: model.updates })}
          action={
            <Button size="sm" onClick={() => actions?.onShowUpdates?.()}>
              {t('page.show')}
            </Button>
          }
        />
      )}
      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={t(model.notice.key, model.notice.params)}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
              {t('common.dismiss')}
            </Button>
          }
        />
      )}

      <section aria-label={t('tile.title')}>
        <MetricStrip
          metrics={TILES.map((id) => ({
            label: t(`tile.${id}`),
            value: counts[id] === null ? '—' : String(counts[id]),
            hint: t(`tile.hint.${id}`),
            onClick: () => actions?.onTile?.(tile === id ? null : id),
            active: tile === id,
          }))}
        />
      </section>
      {tile && (
        <p className="fw-lp-hint">
          {t('tile.filtering', { tile: t(`tile.${tile}`) })}{' '}
          <Button size="sm" variant="quiet" onClick={() => actions?.onTile?.(null)}>
            {t('common.clearFilters')}
          </Button>
        </p>
      )}

      <section ref={sectionRefs.need} aria-labelledby="fw-lp-need" className="fw-lp-section">
        <NeedSection model={model} actions={actions} words={words} />
      </section>
      <section ref={sectionRefs.protectors} aria-labelledby="fw-lp-protectors" className="fw-lp-section">
        <ProtectorsSection model={model} actions={actions} words={words} />
      </section>
      <section ref={sectionRefs.yield} aria-labelledby="fw-lp-yield" className="fw-lp-section">
        <YieldSection model={model} actions={actions} words={words} />
      </section>

      {model.controls.open && <ShadeDrawer model={model} actions={actions} words={words} row={openRow} order={order} />}
      <LeatherDialogs model={model} actions={actions} words={words} />
    </div>
  )
}
