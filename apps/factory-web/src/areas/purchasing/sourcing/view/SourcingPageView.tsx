'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { MoreHorizontal, Plus } from 'lucide-react'
import { Banner, Menu } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import { AsOf } from '../../../../lib/i18n/ds-parts'
import { WithMessages } from '../../../../record-panels/i18n'
import { isListKey } from '../../../../list-frame/model'
import { recordHref } from '../api'
import type { SourcingPageActions, SourcingPageModel } from '../view-model'
import '../sourcing.css'
import { NewSampleDialog } from './NewSampleDialog'
import { KeysModal, NoSourcingAccess, SOURCING_NAMESPACES, useWords } from './parts'
import { SamplesSection } from './SamplesSection'

export type { SourcingPageActions, SourcingPageModel } from '../view-model'

/**
 * SCR-222 — Purchasing › Sourcing & claims › RFQs & sourcing (design purchasing.sourcing; SCM-043): the band (when the list was
 * read; New sample order, `c`; ⋯ Export, the keys), the sample and development orders (the list frame), and New sample order
 * from the address. Requests for quotation and the RFQ record are Later in the design: no RFQ section, tab or door is drawn
 * (they come with RFQs). One view model, nothing fetched. The page fills the main area (no max-width); every word from the
 * catalogues; every held button says why.
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
  const listRef = useRef<HTMLElement | null>(null)
  const { address, can } = model
  const dialogOpen = address.add || keysOpen
  const addHeld = can.manage ? (model.companyId ? null : t('held.company')) : t('held.manage')
  const readAt = model.orders.status === 'ready' ? model.orders.value.readAt : null

  const goToList = () => {
    const section = listRef.current
    if (!section) return
    section.scrollIntoView({ behavior: 'smooth', block: 'start' })
    section.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true })
  }

  // c drafts a sample order, ? the keys (not in a field, a menu or a dialog).
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
      <div className="fw-src">
        <NoSourcingAccess />
      </div>
    )
  }

  const notice = model.notice
  return (
    <div className="fw-src">
      <div className="fw-src-band" role="group" aria-label={t('band.label')}>
        <span className="fw-src-status">{readAt ? <AsOf at={readAt} /> : <span className="fw-src-muted">{t('band.reading')}</span>}</span>
        <span className="fw-src-actions">
          <Button size="sm" variant="primary" aria-keyshortcuts="c" heldReason={addHeld} onClick={() => actions?.onAddress?.({ add: true })}>
            <Plus size={14} aria-hidden /> {t('band.add')}
          </Button>
          <Menu
            label={<MoreHorizontal size={16} aria-hidden />}
            align="right"
            triggerProps={{ 'aria-label': t('band.more') }}
            items={[
              { id: 'export', label: t('band.export'), description: t('band.exportHint'), onSelect: goToList },
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
          title={t(notice.key, notice.params)}
          action={
            <span className="fw-src-row">
              {notice.orderId && (
                <Button size="sm" asChild>
                  <Link href={recordHref(model.prefix, notice.orderId)}>{t('notice.open')}</Link>
                </Button>
              )}
              <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
                {t('common.close')}
              </Button>
            </span>
          }
        >
          {notice.key === 'notice.drafted' ? t('notice.draftedNext') : null}
        </Banner>
      )}

      <section ref={listRef} className="fw-src-section fw-src-anchor" aria-labelledby="fw-src-samples">
        <SamplesSection model={model} actions={actions} onHelp={() => setKeysOpen(true)} />
      </section>

      {model.add && <NewSampleDialog model={model} state={model.add} actions={actions} />}
      {keysOpen && <KeysModal onClose={() => setKeysOpen(false)} />}
    </div>
  )
}
