'use client'

import { useEffect, useRef, useState } from 'react'
import { ClipboardCheck, MoreHorizontal, Plus } from 'lucide-react'
import { Banner, Menu, MetricStrip, type Metric } from '@nexus/ui/components'
import { Button, Skeleton } from '@nexus/ui/primitives'
import { AsOf } from '../../../../lib/i18n/ds-parts'
import { WithMessages } from '../../../../record-panels/i18n'
import { isListKey } from '../../../../list-frame/model'
import { monthStep, moveMonth } from '../../_shared/calendar/model'
import { dialogOpen, tileActive, tileChange, tilesOf, type TileId } from '../model'
import type { PreventivePageActions, PreventivePageModel } from '../view-model'
import '../preventive.css'
import { CalendarSection } from './CalendarSection'
import { MoveDialog } from './MoveDialog'
import { PlanDetail } from './PlanDetail'
import { PlanDialog } from './PlanDialog'
import { PlansSection } from './PlansSection'
import { RegisterSection } from './RegisterSection'
import { ResultDetail } from './ResultDetail'
import { ResultDialog } from './ResultDialog'
import { KeysModal, NoPlantView, PREVENTIVE_NAMESPACES, useWords } from './parts'

export type { PreventivePageActions, PreventivePageModel } from '../view-model'

/**
 * SCR-266 — Plant › Maintenance › Preventive & statutory checks (design plant.preventive; QHS-205): the band (when it was
 * read; New plan `n`; Record a check result `r`; ⋯ the register print, the export, the keys), the tiles (a tile filters a
 * list), the calendar Month | List (drag a due check onto a day to move it), the plans and the check register, each
 * section loading and failing on its own; the dialogs open from the address. One view model, nothing fetched. The page
 * fills the main area (no max-width); every word from the catalogues; every held button says why.
 */
export function PreventivePageView({ model, actions }: { model: PreventivePageModel; actions?: PreventivePageActions }) {
  return (
    <WithMessages namespaces={PREVENTIVE_NAMESPACES}>
      <Page model={model} actions={actions} />
    </WithMessages>
  )
}

function Page({ model, actions }: { model: PreventivePageModel; actions?: PreventivePageActions | undefined }) {
  const t = useWords()
  const [keysOpen, setKeysOpen] = useState(model.keysOpen ?? false)
  const [heldSaid, setHeldSaid] = useState<string | null>(null)
  const plansRef = useRef<HTMLElement | null>(null)
  const registerRef = useRef<HTMLElement | null>(null)
  const { address, can } = model
  const anyDialog = dialogOpen(address) || !!model.move || keysOpen
  const manageHeld = can.manage ? null : t('held.manage')

  /** Scroll a section into view and put the focus on its heading (keyboard and screen readers land there too). */
  const goTo = (ref: { current: HTMLElement | null }) => {
    const section = ref.current
    if (!section) return
    section.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
    section.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true })
  }

  // n a new plan, r record a result, [ / ] move the month, ? the keys (not in a field, a menu or a dialog).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (anyDialog || !isListKey(event, event.target as HTMLElement | null)) return
      if (event.key === 'n' || event.key === 'r') {
        event.preventDefault()
        if (manageHeld) setHeldSaid(manageHeld)
        else actions?.onAddress?.(event.key === 'n' ? { newPlan: true } : { record: 'new' })
        return
      }
      const step = monthStep(event.key)
      if (step !== null && address.view === 'month') {
        event.preventDefault()
        actions?.onAddress?.({ month: moveMonth(model.month, step), day: null })
        return
      }
      if (event.key === '?') {
        event.preventDefault()
        setKeysOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (!can.view) {
    return (
      <div className="fw-pv">
        <NoPlantView />
      </div>
    )
  }

  const counts = model.counts.status === 'ready' ? model.counts.value : null
  const tileClick = (id: TileId) => {
    actions?.onAddress?.(tileChange(id, address))
    goTo(id === 'REPORTS_MISSING' ? registerRef : plansRef)
  }
  const metrics: Metric[] = tilesOf(counts).map((tile): Metric => ({
    label: t(`tile.${tile.id}.label`),
    value: tile.value === null ? model.counts.status === 'loading' ? <Skeleton width={40} height={24} /> : '—' : String(tile.value),
    hint: t(`tile.${tile.id}.hint`),
    onClick: () => tileClick(tile.id),
    active: tileActive(tile.id, address),
    ...(tile.id === 'OVERDUE' && (tile.value ?? 0) > 0 ? { accent: 'var(--nds-danger)' } : {}),
    ...(tile.id !== 'OVERDUE' && (tile.value ?? 0) > 0 ? { accent: 'var(--nds-warning)' } : {}),
  }))
  const notice = model.notice

  return (
    <div className="fw-pv">
      <div className="fw-pv-band" role="group" aria-label={t('band.label')}>
        <span className="fw-pv-status">{model.readAt ? <AsOf at={model.readAt} /> : <span className="fw-pv-muted">{t('band.reading')}</span>}</span>
        <span className="fw-pv-actions">
          <Button size="sm" aria-keyshortcuts="n" heldReason={manageHeld} onClick={() => actions?.onAddress?.({ newPlan: true })}>
            <Plus size={14} aria-hidden /> {t('band.newPlan')}
          </Button>
          <Button size="sm" variant="primary" aria-keyshortcuts="r" heldReason={manageHeld} onClick={() => actions?.onAddress?.({ record: 'new' })}>
            <ClipboardCheck size={14} aria-hidden /> {t('band.record')}
          </Button>
          <Menu
            label={<MoreHorizontal size={16} aria-hidden />}
            align="right"
            triggerProps={{ 'aria-label': t('band.more') }}
            items={[
              { id: 'print', label: t('band.print'), description: t('band.printHint'), href: `${model.prefix}/plant/preventive/register`, target: '_blank' },
              { id: 'export', label: t('band.export'), description: t('band.exportHint'), onSelect: () => goTo(registerRef) },
              { id: 'keys', label: t('keys.title'), onSelect: () => setKeysOpen(true) },
            ]}
          />
        </span>
      </div>

      {heldSaid && (
        <Banner
          tone="info"
          title={heldSaid}
          action={
            <Button size="sm" variant="quiet" onClick={() => setHeldSaid(null)}>
              {t('common.close')}
            </Button>
          }
        />
      )}

      {notice && (
        <Banner
          tone={notice.tone}
          title={t(notice.key, { ...(notice.params ?? {}), count: notice.params?.count ?? 0 })}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
              {t('common.close')}
            </Button>
          }
        >
          {notice.refused && notice.refused.length > 0 ? (
            <ul className="fw-pv-list">
              {notice.refused.map((entry, index) => (
                <li key={`${entry.label}-${index}`}>{t('bulk.refusedRow', { label: entry.label, why: t(entry.key) })}</li>
              ))}
            </ul>
          ) : null}
        </Banner>
      )}

      <section className="fw-pv-section" aria-labelledby="fw-pv-tiles">
        <h2 id="fw-pv-tiles" className="fw-pv-vh">
          {t('tile.title')}
        </h2>
        <MetricStrip metrics={metrics} minTileWidth={200} />
        {model.counts.status === 'loading' && <span className="fw-pv-slow">{t('common.stillLoading')}</span>}
        {model.counts.status === 'error' && (
          <Banner
            tone="warning"
            title={t('tile.failed')}
            action={
              <Button size="sm" onClick={() => actions?.onRetryCounts?.()}>
                {t('common.retry')}
              </Button>
            }
          >
            {t(model.counts.problem)}
          </Banner>
        )}
      </section>

      <section className="fw-pv-section" aria-labelledby="fw-pv-calendar">
        <CalendarSection model={model} actions={actions} onHelp={() => setKeysOpen(true)} />
      </section>

      <section ref={plansRef} className="fw-pv-section fw-pv-anchor" aria-labelledby="fw-pv-plans">
        <PlansSection model={model} actions={actions} onHelp={() => setKeysOpen(true)} />
      </section>

      <section ref={registerRef} className="fw-pv-section fw-pv-anchor" aria-labelledby="fw-pv-register">
        <RegisterSection model={model} actions={actions} onHelp={() => setKeysOpen(true)} />
      </section>

      {model.planNew && <PlanDialog model={model} state={model.planNew} actions={actions} />}
      {model.resultNew && <ResultDialog model={model} state={model.resultNew} actions={actions} />}
      {model.planOpen && <PlanDetail model={model} state={model.planOpen} actions={actions} />}
      {model.resultOpen && <ResultDetail model={model} state={model.resultOpen} actions={actions} />}
      {model.move && <MoveDialog model={model} state={model.move} actions={actions} />}
      {keysOpen && <KeysModal onClose={() => setKeysOpen(false)} />}
    </div>
  )
}
