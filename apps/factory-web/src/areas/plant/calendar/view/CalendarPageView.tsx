'use client'

import { useEffect, useRef, useState } from 'react'
import { CalendarPlus, MoreHorizontal, Users } from 'lucide-react'
import { Banner, Menu, MetricStrip, type Metric } from '@nexus/ui/components'
import { Button, Skeleton } from '@nexus/ui/primitives'
import { AsOf } from '../../../../lib/i18n/ds-parts'
import { WithMessages } from '../../../../record-panels/i18n'
import { isListKey } from '../../../../list-frame/model'
import { monthStep, moveMonth } from '../../_shared/calendar/model'
import { failedKey, tilesOf, type TileId } from '../model'
import type { CalendarPageActions, CalendarPageModel } from '../view-model'
import '../calendar.css'
import { CalendarSection } from './CalendarSection'
import { AddDeadlineModal, DeadlineDetail } from './DeadlineDialogs'
import { AppointmentDialog } from './AppointmentDialog'
import { FilingDialog } from './FilingDialog'
import { EndTermsDialog, OrganisationSection } from './OrganisationSection'
import { KeysModal, NoSafetyAccess, SAFETY_NAMESPACES, useWords } from './parts'
import { RlsPanel } from './RlsPanel'

export type { CalendarPageActions, CalendarPageModel } from '../view-model'

/**
 * SCR-267 — Plant › Health & safety › Safety calendar (design plant.calendar; QHS-224, QHS-226, QHS-227): the band (when
 * it was read; Safety organisation; Add deadline, `c`; ⋯ the two prints, the export, the keys), the four tiles (a tile
 * filters the List or goes to its section), the calendar Month | List, the safety organisation and the RLS notice to
 * INAIL, each section loading and failing on its own; the dialogs open from the address. One view model, nothing fetched.
 * The page fills the main area (no max-width); every word from the catalogues; every held button says why.
 */
export function CalendarPageView({ model, actions }: { model: CalendarPageModel; actions?: CalendarPageActions }) {
  return (
    <WithMessages namespaces={SAFETY_NAMESPACES}>
      <Page model={model} actions={actions} />
    </WithMessages>
  )
}

function Page({ model, actions }: { model: CalendarPageModel; actions?: CalendarPageActions | undefined }) {
  const t = useWords()
  const [keysOpen, setKeysOpen] = useState(model.keysOpen ?? false)
  const [heldSaid, setHeldSaid] = useState(false)
  const calendarRef = useRef<HTMLElement | null>(null)
  const orgRef = useRef<HTMLElement | null>(null)
  const rlsRef = useRef<HTMLElement | null>(null)
  const { address, can } = model
  const dialogOpen = address.newDeadline || !!address.open || !!address.appoint || !!address.filing || !!model.endTerms || keysOpen
  const addHeld = can.manageCalendar ? (model.companyId ? null : t('held.company')) : t('held.calendar')

  /** Scroll a section into view and put the focus on its heading (keyboard and screen readers land there too). */
  const goTo = (ref: { current: HTMLElement | null }) => {
    const section = ref.current
    if (!section) return
    section.scrollIntoView({ behavior: 'smooth', block: 'start' })
    section.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true })
  }

  // c adds a deadline, [ / ] move the month, ? the keys (not in a field, a menu or a dialog).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (dialogOpen || !isListKey(event, event.target as HTMLElement | null)) return
      if (event.key === 'c') {
        event.preventDefault()
        if (addHeld) setHeldSaid(true)
        else actions?.onAddress?.({ newDeadline: true })
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
      <div className="fw-hs">
        <NoSafetyAccess />
      </div>
    )
  }

  const counts = model.counts.status === 'ready' ? model.counts.value : null
  const tileClick = (id: TileId) => {
    if (id === 'roles') return goTo(orgRef)
    if (id === 'rls') return goTo(rlsRef)
    actions?.onAddress?.({ tile: address.tile === id ? null : id, view: 'list' })
    goTo(calendarRef)
  }
  const metrics: Metric[] = tilesOf(counts).map((tile): Metric => ({
    label: t(`tile.${tile.id}.label`),
    value: tile.value === null ? model.counts.status === 'loading' ? <Skeleton width={40} height={24} /> : '—' : String(tile.value),
    hint: t(`tile.${tile.id}.hint`),
    onClick: () => tileClick(tile.id),
    active: (tile.id === 'overdue' || tile.id === 'dueSoon') && address.tile === tile.id,
    ...(tile.id === 'overdue' && (tile.value ?? 0) > 0 ? { accent: 'var(--nds-danger)' } : {}),
    ...(tile.id === 'roles' && (tile.value ?? 0) > 0 ? { accent: 'var(--nds-warning)' } : {}),
  }))
  const notice = model.notice
  const noticeSub = notice?.sub ? Object.fromEntries(Object.entries(notice.sub).map(([name, key]) => [name, t(key)])) : {}

  return (
    <div className="fw-hs">
      <div className="fw-hs-band" role="group" aria-label={t('band.label')}>
        <span className="fw-hs-status">
          {model.readAt ? <AsOf at={model.readAt} /> : <span className="fw-hs-muted">{t('band.reading')}</span>}
          {model.calendarReading && model.readAt ? <span className="fw-hs-muted">{t('band.again')}</span> : null}
        </span>
        <span className="fw-hs-actions">
          <Button size="sm" onClick={() => goTo(orgRef)}>
            <Users size={14} aria-hidden /> {t('band.organisation')}
          </Button>
          <Button size="sm" variant="primary" aria-keyshortcuts="c" heldReason={addHeld} onClick={() => actions?.onAddress?.({ newDeadline: true })}>
            <CalendarPlus size={14} aria-hidden /> {t('band.add')}
          </Button>
          <Menu
            label={<MoreHorizontal size={16} aria-hidden />}
            align="right"
            triggerProps={{ 'aria-label': t('band.more') }}
            items={[
              { id: 'org-print', label: t('band.printOrganisation'), href: `${model.prefix}/plant/calendar/organisation`, target: '_blank' },
              { id: 'cal-print', label: t('band.printCalendar'), href: `${model.prefix}/plant/calendar/print`, target: '_blank' },
              { id: 'export', label: t('band.export'), description: t('band.exportHint'), onSelect: () => actions?.onAddress?.({ view: 'list' }) },
              { id: 'keys', label: t('keys.title'), onSelect: () => setKeysOpen(true) },
            ]}
          />
        </span>
      </div>

      {heldSaid && addHeld && (
        <Banner
          tone="info"
          title={addHeld}
          action={
            <Button size="sm" variant="quiet" onClick={() => setHeldSaid(false)}>
              {t('common.close')}
            </Button>
          }
        />
      )}

      {notice && (
        <Banner
          tone={notice.tone}
          title={t(notice.key, { ...(notice.params ?? {}), ...noticeSub, count: notice.params?.count ?? 0 })}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
              {t('common.close')}
            </Button>
          }
        >
          {notice.refused && notice.refused.length > 0 ? (
            <ul className="fw-hs-list">
              {notice.refused.map((entry, index) => (
                <li key={`${entry.label}-${index}`}>{t('bulk.refusedRow', { label: entry.label, why: t(entry.key) })}</li>
              ))}
            </ul>
          ) : null}
        </Banner>
      )}

      <section className="fw-hs-section" aria-labelledby="fw-hs-tiles">
        <h2 id="fw-hs-tiles" className="fw-hs-vh">
          {t('tile.title')}
        </h2>
        <MetricStrip metrics={metrics} minTileWidth={190} />
        {model.counts.status === 'loading' && <span className="fw-hs-slow">{t('common.stillLoading')}</span>}
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
        {counts && counts.failed.length > 0 && <p className="fw-hs-warn">{t('tile.partial', { sources: counts.failed.map((kind) => t(failedKey(kind))).join(' · ') })}</p>}
      </section>

      <section ref={calendarRef} className="fw-hs-section" aria-labelledby="fw-hs-calendar">
        <CalendarSection model={model} actions={actions} onHelp={() => setKeysOpen(true)} />
      </section>

      <section ref={orgRef} className="fw-hs-section fw-hs-anchor" aria-labelledby="fw-hs-org">
        <OrganisationSection model={model} actions={actions} onHelp={() => setKeysOpen(true)} />
      </section>

      <section ref={rlsRef} className="fw-hs-section fw-hs-anchor" aria-labelledby="fw-hs-rls">
        <RlsPanel model={model} actions={actions} />
      </section>

      {model.deadlineNew && <AddDeadlineModal model={model} state={model.deadlineNew} actions={actions} />}
      {model.deadline && <DeadlineDetail model={model} state={model.deadline} actions={actions} />}
      {model.appointment && <AppointmentDialog model={model} state={model.appointment} actions={actions} />}
      {model.filing && <FilingDialog model={model} state={model.filing} actions={actions} />}
      {model.endTerms && <EndTermsDialog model={model} state={model.endTerms} actions={actions} />}
      {keysOpen && <KeysModal onClose={() => setKeysOpen(false)} />}
    </div>
  )
}
