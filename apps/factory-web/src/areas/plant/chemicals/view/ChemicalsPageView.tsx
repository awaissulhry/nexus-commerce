'use client'

import { useEffect, useRef, useState } from 'react'
import { MoreHorizontal, Plus, QrCode } from 'lucide-react'
import { Banner, Menu, MetricStrip, type Metric } from '@nexus/ui/components'
import { Button, Skeleton } from '@nexus/ui/primitives'
import { AsOf } from '../../../../lib/i18n/ds-parts'
import { WithMessages } from '../../../../record-panels/i18n'
import { isListKey } from '../../../../list-frame/model'
import { tilesOf, type TileId } from '../model'
import type { ChemicalsPageActions, ChemicalsPageModel } from '../view-model'
import '../chemicals.css'
import { AddChemicalDialog } from './AddChemicalDialog'
import { ChemicalWindow } from './ChemicalWindow'
import { LibrarySection } from './LibrarySection'
import { CHEMICALS_NAMESPACES, KeysModal, NoChemicalsAccess, useWords } from './parts'
import { QrDialog } from './QrDialog'
import { ArchiveManyDialog, RegisterSection } from './RegisterSection'

export type { ChemicalsPageActions, ChemicalsPageModel } from '../view-model'

/**
 * SCR-213 — Plant › Health & safety › Chemicals & waste (design plant.chemicals; QHS-277, QHS-278; D.Lgs. 81/2008 art. 223;
 * REACH art. 35): the band (when it was read; Print cabinet QR; Add chemical, `c`; ⋯ Export register, SDS requests (Later),
 * the keys), the tiles (a tile filters the register), the chemical register and the SDS library, each section loading and
 * failing on its own; the dialogs open from the address. Waste and restricted substances stay Later (hidden until built).
 * One view model, nothing fetched. The page fills the main area (no max-width); every word from the catalogues; every held
 * button says why.
 */
export function ChemicalsPageView({ model, actions }: { model: ChemicalsPageModel; actions?: ChemicalsPageActions }) {
  return (
    <WithMessages namespaces={CHEMICALS_NAMESPACES}>
      <Page model={model} actions={actions} />
    </WithMessages>
  )
}

function Page({ model, actions }: { model: ChemicalsPageModel; actions?: ChemicalsPageActions | undefined }) {
  const t = useWords()
  const [keysOpen, setKeysOpen] = useState(model.keysOpen ?? false)
  const [heldSaid, setHeldSaid] = useState(false)
  const registerRef = useRef<HTMLElement | null>(null)
  const { address, can } = model
  const dialogOpen = address.add || !!address.open || address.qr || !!model.archiveMany || keysOpen
  const addHeld = can.manage ? (model.companyId ? null : t('held.company')) : t('held.manage')

  const goTo = (ref: { current: HTMLElement | null }) => {
    const section = ref.current
    if (!section) return
    section.scrollIntoView({ behavior: 'smooth', block: 'start' })
    section.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true })
  }

  // c adds a chemical, ? the keys (not in a field, a menu or a dialog).
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
      <div className="fw-ch">
        <NoChemicalsAccess />
      </div>
    )
  }

  const counts = model.counts.status === 'ready' ? model.counts.value : null
  const tileClick = (id: TileId) => {
    if (id === 'withoutSds' || id === 'toRequest') actions?.onAddress?.({ tile: address.tile === id ? null : id, status: 'ACTIVE' })
    else if (id === 'cabinets') return actions?.onAddress?.({ qr: true })
    else actions?.onAddress?.({ tile: null, status: 'ACTIVE' })
    goTo(registerRef)
  }
  const metrics: Metric[] = tilesOf(counts).map((tile): Metric => ({
    label: t(`tile.${tile.id}.label`),
    value: tile.value === null ? model.counts.status === 'loading' ? <Skeleton width={40} height={24} /> : '—' : String(tile.value),
    hint: t(`tile.${tile.id}.hint`),
    onClick: () => tileClick(tile.id),
    active: (tile.id === 'withoutSds' || tile.id === 'toRequest') && address.tile === tile.id,
    ...(tile.id === 'withoutSds' && (tile.value ?? 0) > 0 ? { accent: 'var(--nds-danger)' } : {}),
    ...(tile.id === 'toRequest' && (tile.value ?? 0) > 0 ? { accent: 'var(--nds-warning)' } : {}),
  }))
  const notice = model.notice

  return (
    <div className="fw-ch">
      <div className="fw-ch-band" role="group" aria-label={t('band.label')}>
        <span className="fw-ch-status">{model.readAt ? <AsOf at={model.readAt} /> : <span className="fw-ch-muted">{t('band.reading')}</span>}</span>
        <span className="fw-ch-actions">
          <Button size="sm" onClick={() => actions?.onAddress?.({ qr: true })}>
            <QrCode size={14} aria-hidden /> {t('band.qr')}
          </Button>
          <Button size="sm" variant="primary" aria-keyshortcuts="c" heldReason={addHeld} onClick={() => actions?.onAddress?.({ add: true })}>
            <Plus size={14} aria-hidden /> {t('band.add')}
          </Button>
          <Menu
            label={<MoreHorizontal size={16} aria-hidden />}
            align="right"
            triggerProps={{ 'aria-label': t('band.more') }}
            items={[
              { id: 'export', label: t('band.export'), description: t('band.exportHint'), onSelect: () => goTo(registerRef) },
              { id: 'requests', label: t('band.requests'), description: t('band.requestsLater'), disabled: true },
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
            <ul className="fw-ch-list">
              {notice.refused.map((entry, index) => (
                <li key={`${entry.label}-${index}`}>{t('bulk.refusedRow', { label: entry.label, why: t(entry.key) })}</li>
              ))}
            </ul>
          ) : null}
        </Banner>
      )}

      <section className="fw-ch-section" aria-labelledby="fw-ch-tiles">
        <h2 id="fw-ch-tiles" className="fw-ch-vh">
          {t('tile.title')}
        </h2>
        <MetricStrip metrics={metrics} minTileWidth={190} />
        {model.counts.status === 'loading' && <span className="fw-ch-slow">{t('common.stillLoading')}</span>}
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

      <section ref={registerRef} className="fw-ch-section fw-ch-anchor" aria-labelledby="fw-ch-register">
        <RegisterSection model={model} actions={actions} onHelp={() => setKeysOpen(true)} />
      </section>

      <section className="fw-ch-section fw-ch-anchor" aria-labelledby="fw-ch-sds">
        <LibrarySection model={model} actions={actions} onHelp={() => setKeysOpen(true)} />
      </section>

      {model.add && <AddChemicalDialog model={model} state={model.add} actions={actions} />}
      {model.open && <ChemicalWindow model={model} state={model.open} actions={actions} />}
      {model.archiveMany && <ArchiveManyDialog model={model} state={model.archiveMany} actions={actions} />}
      {model.qr && <QrDialog model={model} state={model.qr} actions={actions} />}
      {keysOpen && <KeysModal onClose={() => setKeysOpen(false)} />}
    </div>
  )
}
