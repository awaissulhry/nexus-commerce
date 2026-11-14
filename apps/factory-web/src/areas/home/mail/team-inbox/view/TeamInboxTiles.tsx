'use client'

import { InfoTip } from '@nexus/ui/primitives'
import { MetricStrip, type Metric } from '@nexus/ui/components'
import { useT } from '../../../../../lib/i18n/provider'
import type { TeamInboxModel } from '../model'
import '../team-inbox.css'

/**
 * Home › Mail's tiles (design home.mail sec:tiles "To sort · … · Team inboxes (W2b: orders@, quotes@)", "Tile → chip"): the
 * first tile is Mail to sort (W0's list, the mail no record took), then one tile per team inbox the person works: its open
 * mail, with nobody's and mine under it. A tile opens its list below (pressed again: back to Mail to sort). While the
 * inboxes are read the tiles say "—"; a failed read says so in the strip and Mail to sort keeps working.
 */
export function TeamInboxTiles({ model, toSort, onInbox }: { model: TeamInboxModel; toSort: { count: number | null; more: boolean }; onInbox?: (inboxId: string | null) => void }) {
  const t = useT('mail-depth')
  const open = model.queue?.inboxId ?? null
  const sortTile: Metric = {
    label: t('tiles.toSort'),
    value: toSort.count === null ? '—' : t(toSort.more ? 'tiles.countMore' : 'tiles.count', { count: toSort.count }),
    hint: t('tiles.toSortHint'),
    onClick: () => onInbox?.(null),
    active: open === null,
  }
  const inboxes = model.inboxes.status === 'ready' ? model.inboxes.data.inboxes.filter((inbox) => inbox.active) : []
  const tiles: Metric[] = inboxes.map((inbox) => ({
    label: inbox.address ? `${inbox.name} · ${inbox.localPart}@` : inbox.name,
    value: t('tiles.open', { count: inbox.counts.open }),
    hint: t('tiles.inboxHint', { unassigned: inbox.counts.unassigned, mine: inbox.counts.mine }),
    onClick: () => onInbox?.(open === inbox.id ? null : inbox.id),
    active: open === inbox.id,
  }))
  const extra: Metric[] =
    model.inboxes.status === 'loading'
      ? [{ label: t('tiles.inboxes'), value: '—' }]
      : model.inboxes.status === 'error'
        ? [{ label: t('tiles.inboxes'), value: <span className="fw-tin-unknown">—<InfoTip tip={t(model.inboxes.problem)} /></span> }]
        : inboxes.length === 0
          ? [{ label: t('tiles.inboxes'), value: t('tiles.none'), hint: t('tiles.noneHint') }]
          : []
  return (
    <section className="fw-tin-tiles" aria-labelledby="fw-tin-tiles-title">
      <h2 id="fw-tin-tiles-title" className="fw-tin-h">
        {t('tiles.title')}
      </h2>
      <MetricStrip metrics={[sortTile, ...tiles, ...extra]} minTileWidth={190} />
    </section>
  )
}
