'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { CalendarDays, Keyboard, List, MoreHorizontal, Plus, Rows3, Search, ShieldOff } from 'lucide-react'
import { Banner, Card, EmptyState, Menu, MetricStrip } from '@nexus/ui/components'
import { Button, Input, SegmentedControl, Skeleton } from '@nexus/ui/primitives'
import { WAITING_TILES } from '@nexus/factory-domain/planning/milestones/rules'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { MODE_NAMESPACES } from '../../../../list-frame/w2b/words'
import { WithMessages } from '../../../../record-panels/i18n'
import { usePageKeys } from '../../../_shared/buying/hooks'
import { dayText, NAMESPACE, VIEWS, type View, type Words } from '../model'
import type { MilestonesActions, MilestonesModel } from '../view-model'
import { CalendarSection } from './CalendarSection'
import { GateDialogs } from './GateDialogs'
import { ListSection } from './ListSection'
import { MilestoneDialog } from './MilestoneDialog'
import { OrdersSection } from './OrdersSection'
import '../milestones.css'

export type { MilestonesActions, MilestonesModel } from '../view-model'

/** The catalogues the screen reads: its own, the list frame's, the calendar's and the DS words. */
export const MILESTONES_NAMESPACES = [NAMESPACE, 'lists', ...MODE_NAMESPACES] as const

/**
 * SCR-253 — Planning › Time & action (design planning.milestones, a calendar page): the band (as of, live, the view switch
 * Calendar · List · Per order, the search, Add gate, ⋯ Keyboard shortcuts), Waiting on a gate (five tiles that are saved
 * filters: Sample not approved, Leather not received, Leather not passed, Trims not in, Lab or other — each counts orders,
 * 0 when none, — while unknown), then Milestones in the view picked (the address keeps it). A milestone opens in a centred
 * dialog (Mark done on a day, Start before the gate, Change, Remove, the order in a new tab). No page max-width.
 */
export function MilestonesView({ model, actions }: { model: MilestonesModel; actions?: MilestonesActions }) {
  return (
    <WithMessages namespaces={[...MILESTONES_NAMESPACES]}>
      <MilestonesScreen model={model} actions={actions} />
    </WithMessages>
  )
}

export function useMilestonesWords(): Words {
  const t = useT(NAMESPACE)
  const locale = useLocale()
  return useMemo(() => ({ t, locale }), [t, locale])
}

const VIEW_ICONS = { calendar: CalendarDays, list: List, orders: Rows3 } as const

function MilestonesScreen({ model, actions }: { model: MilestonesModel; actions?: MilestonesActions }) {
  const words = useMilestonesWords()
  const { t } = words
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
  const quiet = model.dialog !== null || model.controls.open !== null || model.controls.add !== null

  usePageKeys((event) => {
    if (quiet || event.metaKey || event.ctrlKey || event.altKey) return
    const index = ['1', '2', '3'].indexOf(event.key)
    if (index >= 0) {
      event.preventDefault()
      actions?.onView?.(VIEWS[index]!)
    } else if (event.key === 'n' && model.can.manage) {
      event.preventDefault()
      actions?.onAdd?.(null)
    }
  })

  if (!model.can.view) {
    return (
      <div className="fw-tna">
        <Card padded>
          <EmptyState icon={<ShieldOff size={24} aria-hidden />} title={t('noAccess.title')} description={t('noAccess.body')} />
        </Card>
      </div>
    )
  }

  const world = model.world.status === 'ready' ? model.world.value : null
  const addHeld = !model.can.manage ? t('needs.planning.milestones.manage') : model.world.status !== 'ready' ? t('held.loading') : null

  return (
    <div className="fw-tna">
      <div className="fw-tna-head">
        <span className="fw-tna-status" role="status">
          {model.world.status === 'loading' ? <Skeleton width={160} height={18} /> : world ? t('page.today', { day: dayText(world.today, words.locale) }) : t('page.notRead')}
          {' · '}
          {t(`live.${model.live}`)}
          {model.updates > 0 && (
            <Button size="sm" variant="quiet" onClick={() => actions?.onShowUpdates?.()}>
              {t('page.updates', { count: model.updates })}
            </Button>
          )}
        </span>
        <span className="fw-tna-inline">
          <SegmentedControl
            size="sm"
            ariaLabel={t('view.label')}
            value={model.controls.view}
            onChange={(next) => actions?.onView?.(next as View)}
            options={VIEWS.map((value) => {
              const Icon = VIEW_ICONS[value]
              return { value, label: t(`view.${value}`), icon: <Icon size={13} aria-hidden /> }
            })}
          />
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
          <Button size="sm" variant="primary" heldReason={addHeld} onClick={() => actions?.onAdd?.(null)}>
            <Plus size={13} aria-hidden /> {t('page.add')}
          </Button>
          <Menu
            label={<MoreHorizontal size={16} aria-hidden />}
            align="right"
            triggerProps={{ 'aria-label': t('page.more') }}
            items={[{ id: 'keys', label: t('page.keys'), icon: <Keyboard size={14} aria-hidden />, onSelect: () => actions?.onKeys?.() }]}
          />
        </span>
      </div>

      {model.notice && <Banner tone={model.notice.tone} title={t(model.notice.key, model.notice.params)} onDismiss={() => actions?.onDismissNotice?.()} />}

      <section className="fw-tna-section" aria-labelledby="fw-tna-gates">
        <div className="fw-tna-section-head">
          <h2 className="fw-tna-h2" id="fw-tna-gates">
            {t('gates.title')}
          </h2>
          <p className="fw-tna-hint">{t('gates.purpose')}</p>
        </div>
        {model.world.status === 'error' ? (
          <Card padded>
            <EmptyState title={t('gates.error')} description={t(model.world.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('common.retry')}</Button>} />
          </Card>
        ) : (
          <MetricStrip
            metrics={WAITING_TILES.map((id) => ({
              label: t(`tile.${id}`),
              value: world ? String(world.tiles[id]) : '—',
              hint: t(`tile.hint.${id}`),
              onClick: () => actions?.onTile?.(model.controls.tile === id ? null : id),
              active: model.controls.tile === id,
            }))}
          />
        )}
        {model.controls.tile && (
          <p className="fw-tna-hint">
            {t('tile.filtering', { tile: t(`tile.${model.controls.tile}`) })}{' '}
            <Button size="sm" variant="quiet" onClick={() => actions?.onTile?.(null)}>
              {t('common.clearFilters')}
            </Button>
          </p>
        )}
      </section>

      <section className="fw-tna-section" aria-labelledby="fw-tna-calendar">
        <div className="fw-tna-section-head">
          <h2 className="fw-tna-h2" id="fw-tna-calendar">
            {t('calendar.title')}
          </h2>
          <p className="fw-tna-hint">{t(`calendar.purpose.${model.controls.view}`)}</p>
        </div>
        {world?.truncated && <Banner tone="info" title={t('page.truncated')} />}
        {model.world.status === 'error' ? (
          <Card padded>
            <EmptyState title={t('calendar.error')} description={t(model.world.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('common.retry')}</Button>} />
          </Card>
        ) : model.controls.view === 'calendar' ? (
          <CalendarSection model={model} actions={actions} words={words} />
        ) : model.controls.view === 'list' ? (
          <ListSection model={model} actions={actions} words={words} />
        ) : (
          <OrdersSection model={model} actions={actions} words={words} />
        )}
      </section>

      <MilestoneDialog model={model} actions={actions} words={words} />
      <GateDialogs model={model} actions={actions} words={words} />
    </div>
  )
}
