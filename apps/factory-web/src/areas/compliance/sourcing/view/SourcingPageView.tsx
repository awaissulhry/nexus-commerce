'use client'

import { useEffect, useRef, useState } from 'react'
import { MoreHorizontal, Plus } from 'lucide-react'
import { Banner, Menu, MetricStrip, Tabs, type Metric } from '@nexus/ui/components'
import { Button, Skeleton } from '@nexus/ui/primitives'
import { AsOf } from '../../../../lib/i18n/ds-parts'
import { WithMessages } from '../../../../record-panels/i18n'
import { isListKey } from '../../../../list-frame/model'
import { stateOfTile, tileOfState, tilesOf, type TileId } from '../model'
import type { SourcingPageActions, SourcingPageModel } from '../view-model'
import '../sourcing.css'
import { ClaimsSection, WithdrawManyDialog } from './ClaimsSection'
import { ClaimWindow } from './ClaimWindow'
import { NewClaimDialog } from './ClaimForm'
import { KeysModal, NoSourcingAccess, SOURCING_NAMESPACES, SourcingStepUp, useWords } from './parts'

export type { SourcingPageActions, SourcingPageModel } from '../view-model'

/**
 * SCR-215 — Compliance › Sustainability › Sourcing & claims (design compliance.sourcing; PRD-380; Dir. (EU) 2024/825): the band
 * (when it was read; New claim, `c`; ⋯ Export, the keys), the claim tiles (a tile filters the claims), the views (Claims; Chain
 * of custody comes later and says so), the claims grid, each section loading and failing on its own; New claim, the claim's
 * window and the step-up dialog open from the address. One view model, nothing fetched. The page fills the main area (no
 * max-width); every word from the catalogues; every held button says why.
 */
export function SourcingPageView({ model, actions }: { model: SourcingPageModel; actions?: SourcingPageActions }) {
  return (
    <WithMessages namespaces={SOURCING_NAMESPACES}>
      <Page model={model} actions={actions} />
    </WithMessages>
  )
}

function Page({ model, actions }: { model: SourcingPageModel; actions?: SourcingPageActions | undefined }) {
  const t = useWords()
  const [keysOpen, setKeysOpen] = useState(model.keysOpen ?? false)
  const [heldSaid, setHeldSaid] = useState(false)
  const claimsRef = useRef<HTMLElement | null>(null)
  const { address, can } = model
  const dialogOpen = address.add || !!address.open || keysOpen || model.stepUp.open || !!model.withdrawMany
  const addHeld = can.manage ? (model.companyId ? null : t('held.company')) : t('held.manage')

  const goTo = (ref: { current: HTMLElement | null }) => {
    const section = ref.current
    if (!section) return
    section.scrollIntoView({ behavior: 'smooth', block: 'start' })
    section.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true })
  }

  // c drafts a claim, ? the keys (not in a field, a menu or a dialog).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (dialogOpen || !isListKey(event, event.target as HTMLElement | null)) return
      if (event.key === 'c') {
        event.preventDefault()
        if (addHeld) setHeldSaid(true)
        else actions?.onAddress?.({ add: true })
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
      <div className="fw-sc">
        <NoSourcingAccess />
      </div>
    )
  }

  const counts = model.counts.status === 'ready' ? model.counts.value : null
  const activeTile = tileOfState(address.state)
  const tileClick = (id: TileId) => {
    actions?.onAddress?.({ state: activeTile === id ? 'current' : stateOfTile(id) })
    goTo(claimsRef)
  }
  const metrics: Metric[] = tilesOf(counts).map((tile): Metric => ({
    label: t(`tile.${tile.id}.label`),
    value: tile.value === null ? model.counts.status === 'loading' ? <Skeleton width={40} height={24} /> : '—' : String(tile.value),
    hint: t(`tile.${tile.id}.hint`),
    onClick: () => tileClick(tile.id),
    active: activeTile === tile.id,
    ...(tile.id === 'blocked' && (tile.value ?? 0) > 0 ? { accent: 'var(--nds-danger)' } : {}),
    ...(tile.id === 'drafts' && (tile.value ?? 0) > 0 ? { accent: 'var(--nds-info)' } : {}),
  }))
  const notice = model.notice

  return (
    <div className="fw-sc">
      <div className="fw-sc-band" role="group" aria-label={t('band.label')}>
        <span className="fw-sc-status">{model.readAt ? <AsOf at={model.readAt} /> : <span className="fw-sc-muted">{t('band.reading')}</span>}</span>
        <span className="fw-sc-actions">
          <Button size="sm" variant="primary" aria-keyshortcuts="c" heldReason={addHeld} onClick={() => actions?.onAddress?.({ add: true })}>
            <Plus size={14} aria-hidden /> {t('band.add')}
          </Button>
          <Menu
            label={<MoreHorizontal size={16} aria-hidden />}
            align="right"
            triggerProps={{ 'aria-label': t('band.more') }}
            items={[
              { id: 'export', label: t('band.export'), description: t('band.exportHint'), onSelect: () => goTo(claimsRef) },
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
          title={t(notice.key, { ...(notice.params ?? {}), count: notice.params?.count ?? 0 })}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
              {t('common.close')}
            </Button>
          }
        >
          {notice.refused && notice.refused.length > 0 ? (
            <ul className="fw-sc-list">
              {notice.refused.map((entry, index) => (
                <li key={`${entry.label}-${index}`}>{t('bulk.refusedRow', { label: entry.label, why: t(entry.key) })}</li>
              ))}
            </ul>
          ) : null}
        </Banner>
      )}

      <section className="fw-sc-section" aria-labelledby="fw-sc-tiles">
        <h2 id="fw-sc-tiles" className="fw-sc-vh">
          {t('tile.title')}
        </h2>
        <MetricStrip metrics={metrics} minTileWidth={200} />
        {model.counts.status === 'loading' && <span className="fw-sc-slow">{t('common.stillLoading')}</span>}
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

      <div className="fw-sc-section">
        <Tabs
          ariaLabel={t('views.label')}
          tabs={[
            { id: 'claims', label: t('views.claims'), href: `${model.prefix}/compliance/sourcing` },
            { id: 'custody', label: t('views.custodyLater'), disabled: true },
          ]}
          active="claims"
        />
      </div>

      <section ref={claimsRef} className="fw-sc-section fw-sc-anchor" aria-labelledby="fw-sc-claims">
        <ClaimsSection model={model} actions={actions} onHelp={() => setKeysOpen(true)} />
      </section>

      {model.add && <NewClaimDialog model={model} state={model.add} actions={actions} />}
      {model.open && <ClaimWindow model={model} state={model.open} actions={actions} />}
      {model.withdrawMany && <WithdrawManyDialog model={model} state={model.withdrawMany} actions={actions} />}
      <SourcingStepUp state={model.stepUp} onSubmit={actions?.onStepUp} onCancel={actions?.onStepUpCancel} />
      {keysOpen && <KeysModal onClose={() => setKeysOpen(false)} />}
    </div>
  )
}
