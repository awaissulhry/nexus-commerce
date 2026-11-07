'use client'

import Link from 'next/link'
import { Lock } from 'lucide-react'
import { Banner, Card, EmptyState } from '@nexus/ui/components'
import { Button, FilterChip, Skeleton, Spinner } from '@nexus/ui/primitives'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import { labelOf, TIME_ZONE } from '../../../_shared/model'
import { LiveLine, useWords, type Loaded } from '../../../_shared/parts'
import type { LiveState } from '../../../_shared/hooks'
import type { WallAnswer } from '../api'
import { WALL_FILTERS, wallTilesOf, type WallFilter } from '../model'
import { useDepthWords, useSay } from '../parts'

/**
 * StatusWall — the area part of design plant.machines sec:wall and tab:wall (QHS-167): every machine in use as a tile, one
 * column per line (the machines on no line last), coloured by its live status AND saying it (the word, a lock for an unsafe
 * lock, since when); a tile opens the machine. Filter by status (each chip with its count). Read-only: it is left open on
 * an office screen, live from machine.status_changed. No person, no money.
 */
export function StatusWall({
  loaded,
  filter,
  prefix,
  live,
  asOf,
  newTab = false,
  onFilter,
  onRetry,
}: {
  loaded: Loaded<WallAnswer>
  filter: WallFilter
  prefix: string
  live: LiveState
  asOf: string | null
  /** The wall's own tab: a tile opens the machine in another tab, so the wall stays. */
  newTab?: boolean
  onFilter?: (filter: WallFilter) => void
  onRetry?: () => void
}) {
  const t = useDepthWords()
  const plant = useWords()
  const say = useSay()
  const locale = useLocale()
  const value = loaded.status === 'ready' ? loaded.value : null
  const count = (entry: WallFilter): number | null => {
    if (!value) return null
    const counts = value.counts
    if (entry === 'ALL') return counts.RUNNING + counts.DOWN + counts.UNDER_MAINTENANCE + counts.DO_NOT_USE
    if (entry === 'NOT_RUNNING') return counts.DOWN + counts.UNDER_MAINTENANCE + counts.DO_NOT_USE
    return counts[entry]
  }
  const lines = value ? wallTilesOf(value.lines, filter) : []
  return (
    <section className="fw-md-stack" aria-label={t('wall.title')}>
      <div className="fw-md-head">
        <span className="fw-md-row" role="group" aria-label={t('wall.filter')}>
          {WALL_FILTERS.map((entry) => {
            const n = count(entry)
            return (
              <FilterChip key={entry} pressed={filter === entry} count={n ?? undefined} onClick={() => onFilter?.(entry)}>
                {t(`wall.show.${entry}`)}
              </FilterChip>
            )
          })}
        </span>
        <LiveLine asOf={asOf} live={live} />
      </div>
      {loaded.status === 'loading' ? (
        <Card padded aria-busy="true">
          <p className="fw-md-muted" role="status">
            <Spinner size={14} /> {t('wall.loading')}
          </p>
          <div className="fw-md-wall">
            {Array.from({ length: 3 }, (_, index) => (
              <Skeleton key={index} height={180} />
            ))}
          </div>
        </Card>
      ) : loaded.status !== 'ready' ? (
        <Card padded>
          <EmptyState title={t('wall.failed')} description={loaded.status === 'error' ? say({ key: loaded.problem }) : loaded.status === 'forbidden' ? plant('problem.noPermission', { permission: 'plant.view' }) : t('docs.notFound')} action={loaded.status === 'error' ? <Button size="sm" onClick={() => onRetry?.()}>{t('common.retry')}</Button> : undefined} />
        </Card>
      ) : value && lines.length === 0 ? (
        <Card padded>
          <EmptyState title={filter === 'ALL' ? t('wall.emptyTitle') : t('wall.noneTitle')} description={filter === 'ALL' ? t('wall.empty') : t('wall.none')} />
        </Card>
      ) : (
        <>
          {value?.truncated && <Banner tone="info" title={t('wall.truncated')} />}
          <div className="fw-md-wall">
            {lines.map((line) => (
              <Card key={line.line?.id ?? `site-${line.siteCode}`} padded>
                <section className="fw-md-stack tight" aria-label={line.line ? t('wall.line', { line: `${line.line.code} · ${line.line.name}` }) : t('wall.noLine', { site: line.siteCode })}>
                  <h3 className="fw-md-h3">
                    {line.line ? `${line.line.code} · ${line.line.name}` : t('wall.noLine', { site: line.siteCode })} <span className="fw-md-muted">{line.siteCode}</span>
                  </h3>
                  <ul className="fw-md-plain fw-md-tiles">
                    {line.machines.map((tile) => (
                      <li key={tile.id}>
                        <Link
                          className="fw-md-tile"
                          data-status={tile.locked ? 'LOCKED' : tile.status}
                          href={`${prefix}/plant/machines/${encodeURIComponent(tile.id)}`}
                          {...(newTab ? { target: '_blank' } : {})}
                          aria-label={t('wall.tileLabel', { machine: tile.assetNumber, status: tile.locked ? plant('machineStatus.LOCKED') : plant(`machineStatus.${tile.status}`), since: formatDateTime(tile.statusSince, { locale, timeZone: TIME_ZONE }) })}
                        >
                          <span className="fw-md-tile-asset">{tile.assetNumber}</span>
                          <span className="fw-md-tile-status">
                            {tile.locked ? <Lock size={12} aria-hidden /> : null} {tile.locked ? plant('machineStatus.LOCKED') : plant(`machineStatus.${tile.status}`)}
                          </span>
                          <span className="fw-md-tile-since">{plant('machine.since', { time: formatDateTime(tile.statusSince, { locale, timeZone: TIME_ZONE }) })}</span>
                          <span className="fw-md-tile-type">{[labelOf(tile.class, locale), tile.station?.code].filter(Boolean).join(' · ')}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </section>
              </Card>
            ))}
          </div>
        </>
      )}
      <p className="fw-md-muted">{t('wall.foot')}</p>
    </section>
  )
}
