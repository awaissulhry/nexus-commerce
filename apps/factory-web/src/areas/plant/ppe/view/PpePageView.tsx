'use client'

import { useEffect, useRef, useState } from 'react'
import { HandHelping, MoreHorizontal, Plus } from 'lucide-react'
import { Banner, Menu, MetricStrip, type Metric } from '@nexus/ui/components'
import { Button, SegmentedControl, Skeleton } from '@nexus/ui/primitives'
import { AsOf } from '../../../../lib/i18n/ds-parts'
import { WithMessages } from '../../../../record-panels/i18n'
import { isListKey } from '../../../../list-frame/model'
import { LENSES, tileActive, tilesOf, type Lens } from '../model'
import type { PpePageActions, PpePageModel } from '../view-model'
import '../ppe.css'
import { CatalogueLens } from './CatalogueLens'
import { ArchiveManyDialog, ScanDialog, VoidDialog } from './Dialogs'
import { GapsLens } from './GapsLens'
import { IssueDialog } from './IssueDialog'
import { IssuesLens } from './IssuesLens'
import { ItemDialog } from './ItemDialog'
import { KitsLens } from './KitsLens'
import { KeysModal, NoPpeAccess, PPE_NAMESPACES, useWords } from './parts'

export type { PpePageActions, PpePageModel } from '../view-model'

/**
 * SCR-211 — Plant › Health & safety › PPE for workers (design plant.ppe; QHS-259, QHS-260, QHS-261; D.Lgs. 81/2008 art. 18 c.1 d,
 * art. 77): the band (when it was read; New PPE item `c`; Issue PPE `i`; ⋯ Print receipts, Export, the keys), the tiles (who
 * lacks what; a tile opens its lens with its filter), the four lenses on one page (a SegmentedControl, `1`–`4`: Gaps per person,
 * Issues and receipts, Kits per role, Catalogue), each loading and failing on its own; the dialogs open from the address. One
 * view model, nothing fetched. The page fills the main area (no max-width); every word from the catalogues; every held button
 * says why.
 */
export function PpePageView({ model, actions }: { model: PpePageModel; actions?: PpePageActions }) {
  return (
    <WithMessages namespaces={PPE_NAMESPACES}>
      <Page model={model} actions={actions} />
    </WithMessages>
  )
}

function Page({ model, actions }: { model: PpePageModel; actions?: PpePageActions | undefined }) {
  const t = useWords()
  const [keysOpen, setKeysOpen] = useState(model.keysOpen ?? false)
  const [heldSaid, setHeldSaid] = useState<string | null>(null)
  const lensRef = useRef<HTMLElement | null>(null)
  const { address, can } = model
  const dialogOpen = !!address.issue || !!address.item || !!address.void || !!address.scan || !!model.archiveMany || keysOpen
  const issueHeld = can.issue ? null : t('held.issue')
  const itemHeld = can.manage ? (model.companyId ? null : t('held.company')) : t('held.manage')

  const focusLens = () => {
    const section = lensRef.current
    if (!section) return
    section.scrollIntoView({ behavior: 'smooth', block: 'start' })
    section.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true })
  }

  // i issues PPE, c adds an item, 1–4 the lenses, ? the keys (not in a field, a menu or a dialog).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (dialogOpen || !isListKey(event, event.target as HTMLElement | null)) return
      if (event.key === 'i') {
        event.preventDefault()
        if (issueHeld) setHeldSaid(issueHeld)
        else actions?.onAddress?.({ issue: 'new' })
        return
      }
      if (event.key === 'c') {
        event.preventDefault()
        if (itemHeld) setHeldSaid(itemHeld)
        else actions?.onAddress?.({ item: 'new' })
        return
      }
      const lens = LENSES[Number(event.key) - 1]
      if (lens && /^[1-4]$/.test(event.key)) {
        event.preventDefault()
        actions?.onAddress?.({ view: lens })
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
      <div className="fw-ppe">
        <NoPpeAccess />
      </div>
    )
  }

  const counts = model.counts.status === 'ready' ? model.counts.value : null
  const metrics: Metric[] = tilesOf(counts).map((tile): Metric => ({
    label: t(`tile.${tile.id}.label`),
    value: tile.value === null ? model.counts.status === 'loading' ? <Skeleton width={40} height={24} /> : '—' : String(tile.value),
    hint: t(`tile.${tile.id}.hint`),
    onClick: () => {
      actions?.onAddress?.(tileActive(tile, model.address) && tile.id !== 'peopleMissingKit' ? { show: 'missing', signed: 'all' } : tile.to)
      focusLens()
    },
    active: tileActive(tile, address),
    ...((tile.value ?? 0) > 0 ? { accent: tile.id === 'peopleMissingKit' ? 'var(--nds-danger)' : 'var(--nds-warning)' } : {}),
  }))
  const notice = model.notice

  return (
    <div className="fw-ppe">
      <div className="fw-ppe-band" role="group" aria-label={t('band.label')}>
        <span className="fw-ppe-status">{model.readAt ? <AsOf at={model.readAt} /> : <span className="fw-ppe-muted">{t('band.reading')}</span>}</span>
        <span className="fw-ppe-actions">
          <Button size="sm" aria-keyshortcuts="c" heldReason={itemHeld} onClick={() => actions?.onAddress?.({ item: 'new' })}>
            <Plus size={14} aria-hidden /> {t('band.newItem')}
          </Button>
          <Button size="sm" variant="primary" aria-keyshortcuts="i" heldReason={issueHeld} onClick={() => actions?.onAddress?.({ issue: 'new' })}>
            <HandHelping size={14} aria-hidden /> {t('band.issue')}
          </Button>
          <Menu
            label={<MoreHorizontal size={16} aria-hidden />}
            align="right"
            triggerProps={{ 'aria-label': t('band.more') }}
            items={[
              {
                id: 'print',
                label: t('band.printReceipts'),
                description: t('band.printReceiptsHint'),
                onSelect: () => {
                  actions?.onAddress?.({ view: 'issues' })
                  focusLens()
                },
              },
              { id: 'export', label: t('band.export'), description: t('band.exportLater'), disabled: true },
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

      {model.roleBanner && (
        <Banner
          tone="warning"
          title={t('roleBanner.title', { role: model.roleBanner.role, count: model.roleBanner.people })}
          action={
            <span className="fw-ppe-row">
              <Button size="sm" onClick={() => actions?.onAddress?.({ view: 'gaps', show: 'missing' })}>
                {t('roleBanner.show')}
              </Button>
              <Button size="sm" variant="quiet" onClick={() => actions?.onDismissRoleBanner?.()}>
                {t('common.close')}
              </Button>
            </span>
          }
        >
          {t('roleBanner.body')}
        </Banner>
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
            <ul className="fw-ppe-list">
              {notice.refused.map((entry, index) => (
                <li key={`${entry.label}-${index}`}>{t('bulk.refusedRow', { label: entry.label, why: t(entry.key) })}</li>
              ))}
            </ul>
          ) : null}
        </Banner>
      )}

      <section className="fw-ppe-section" aria-labelledby="fw-ppe-tiles">
        <h2 id="fw-ppe-tiles" className="fw-ppe-vh">
          {t('tile.title')}
        </h2>
        <MetricStrip metrics={metrics} minTileWidth={200} />
        {model.counts.status === 'loading' && <span className="fw-ppe-slow">{t('common.stillLoading')}</span>}
        {model.counts.status === 'error' && (
          <Banner
            tone="warning"
            title={t('tile.failed')}
            action={
              <Button size="sm" onClick={() => actions?.onRetry?.('counts')}>
                {t('common.retry')}
              </Button>
            }
          >
            {t(model.counts.problem)}
          </Banner>
        )}
      </section>

      <section ref={lensRef} className="fw-ppe-section fw-ppe-anchor" aria-labelledby={`fw-ppe-${address.view}`}>
        <div className="fw-ppe-lenses">
          <SegmentedControl
            size="sm"
            wrap
            ariaLabel={t('lens.label')}
            value={address.view}
            onChange={(value) => actions?.onAddress?.({ view: value as Lens })}
            options={LENSES.map((lens) => ({ value: lens, label: t(`lens.${lens}`) }))}
          />
        </div>
        {address.view === 'gaps' && <GapsLens model={model} actions={actions} onHelp={() => setKeysOpen(true)} />}
        {address.view === 'issues' && <IssuesLens model={model} actions={actions} onHelp={() => setKeysOpen(true)} />}
        {address.view === 'kits' && <KitsLens model={model} actions={actions} onHelp={() => setKeysOpen(true)} />}
        {address.view === 'catalogue' && <CatalogueLens model={model} actions={actions} onHelp={() => setKeysOpen(true)} />}
      </section>

      {model.issue && <IssueDialog model={model} state={model.issue} actions={actions} />}
      {model.item && <ItemDialog model={model} state={model.item} actions={actions} />}
      {model.voiding && <VoidDialog model={model} state={model.voiding} actions={actions} />}
      {model.scan && <ScanDialog model={model} state={model.scan} actions={actions} />}
      {model.archiveMany && <ArchiveManyDialog model={model} state={model.archiveMany} actions={actions} />}
      {keysOpen && <KeysModal onClose={() => setKeysOpen(false)} />}
    </div>
  )
}
