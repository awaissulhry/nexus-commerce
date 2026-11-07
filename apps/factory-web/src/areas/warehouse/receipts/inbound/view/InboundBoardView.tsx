'use client'

import { useMemo } from 'react'
import { MoreHorizontal, PackageCheck, StickyNote } from 'lucide-react'
import { Banner, EmptyState, Field, Menu } from '@nexus/ui/components'
import { BoardView } from '@nexus/ui/grid/views/board/index'
import { Button, Textarea } from '@nexus/ui/primitives'
import { formatTime } from '../../../../../lib/i18n/format'
import { INTL_LOCALE } from '../../../../../lib/i18n/locales'
import { Modal } from '../../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { BOARD_VIEW_KIT_NAMESPACE, useBoardViewWords } from '../../../../_shared/board-view/words'
import { quantity } from '../../../../_shared/buying/model'
import type { InboundCard } from '../api'
import { cardOf, INBOUND_DAYS, INBOUND_NAMESPACE, lanesOf, receiveHeldKey, siteRows, type InboundActions, type InboundModel } from '../model'
import '../inbound.css'

/**
 * Warehouse › Receipts, the inbound board (B-W2b-182; SCM-110; design warehouse.receipts sec:rc-inbound): what comes in
 * the next seven days, a row per site (the top bar's site, or every site the person reaches), a column per day, a card per
 * delivery — a supplier's ship notice (its number, the PO, the lines, the tracking state, the packing list's verdict, the
 * supplier's and our dock note) or a confirmed order still without one. The card opens the PO; Receive opens the receiving
 * page filled from the notice (or the order); Note for the dock (inventory.receive). A day without deliveries draws
 * nothing. Read only (the board moves nothing). `InboundMenu` is the page's ⋯ "Inbound board on / off".
 */
export function InboundBoardView({ model, actions }: { model: InboundModel; actions?: InboundActions }) {
  return (
    <WithMessages namespaces={[INBOUND_NAMESPACE, BOARD_VIEW_KIT_NAMESPACE, 'buying']}>
      <Inbound model={model} actions={actions} />
    </WithMessages>
  )
}

/** The page's ⋯ menu with the board's switch (design warehouse.receipts h.more "Inbound board on / off (W2b)"). */
export function InboundMenu({ on, onToggle }: { on: boolean; onToggle?: (on: boolean) => void }) {
  return (
    <WithMessages namespaces={[INBOUND_NAMESPACE]}>
      <MenuInner on={on} onToggle={onToggle} />
    </WithMessages>
  )
}

function MenuInner({ on, onToggle }: { on: boolean; onToggle?: (on: boolean) => void }) {
  const t = useT(INBOUND_NAMESPACE)
  return <Menu label={<MoreHorizontal size={16} aria-hidden />} align="right" triggerProps={{ 'aria-label': t('menu.label') }} items={[{ id: 'inbound', label: t(on ? 'menu.hide' : 'menu.show'), onSelect: () => onToggle?.(!on) }]} />
}

function Inbound({ model, actions }: { model: InboundModel; actions?: InboundActions }) {
  const t = useT(INBOUND_NAMESPACE)
  const tb = useT('buying')
  const locale = useLocale()
  const kitWords = useBoardViewWords()
  // A day's column moves nothing (the days come from the notices and orders): its own read-only sentence and empty word.
  const boardWords = useMemo(() => ({ ...kitWords, readOnly: t('readOnly'), laneEmpty: t('laneEmpty') }), [kitWords, t])
  const dayLocale = locale === 'en' ? 'en' : 'it'
  const held = receiveHeldKey(model.canReceive)
  const board = model.board.status === 'ready' ? model.board.value : null
  const cardsById = useMemo(() => new Map((board?.cards ?? []).map((card) => [card.id, card])), [board])
  const qty = (text: string) => quantity(text, locale)
  const translate = (key: string, params?: Readonly<Record<string, string | number>>) => (key.startsWith('uom.') ? tb(key) : t(key, params))
  if (!model.on) return null

  const head = (
    <header className="fw-ib-head">
      <span className="fw-ib-title">
        <h2>{t('title')}</h2>
        <span className="fw-ib-sub">{t('subtitle', { days: INBOUND_DAYS })}</span>
      </span>
      <span className="fw-ib-status" role="status">
        {board ? t('asOf', { time: formatTime(board.asOf, { locale, timeZone: model.timeZone }) }) : model.board.status === 'loading' ? t('loading') : ''}
      </span>
    </header>
  )

  const footer = (card: { id: string }) => {
    const delivery = cardsById.get(card.id)
    if (!delivery) return null
    return (
      <span className="fw-ib-actions">
        <Button size="sm" variant="primary" heldReason={held ? t(held) : null} onClick={() => actions?.onReceive?.(delivery)} aria-label={t('receiveCard', { label: delivery.shipNotice?.number ?? delivery.purchaseOrder.number })}>
          <PackageCheck size={13} aria-hidden /> {t('receive')}
        </Button>
        {delivery.shipNotice && (
          <Button size="sm" variant="quiet" heldReason={held ? t(held) : null} onClick={() => actions?.onNote?.(delivery)} aria-label={t('noteCard', { label: delivery.shipNotice.number })}>
            <StickyNote size={13} aria-hidden /> {t(delivery.dockNote ? 'noteEdit' : 'noteAdd')}
          </Button>
        )}
      </span>
    )
  }

  let body
  if (model.board.status === 'forbidden') body = <EmptyState title={t('forbidden.title')} description={t('forbidden.body')} />
  else if (model.board.status === 'error') body = <EmptyState title={t('failed')} description={tb(model.board.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('retry')}</Button>} />
  else if (model.board.status === 'loading') {
    const days = Array.from({ length: INBOUND_DAYS }, (_, index) => {
      const date = new Date(`${model.today}T12:00:00Z`)
      date.setUTCDate(date.getUTCDate() + index)
      return date.toISOString().slice(0, 10)
    })
    body = <BoardView label={t('boardLabel', { site: '' })} lanes={lanesOf({ days }, [], model.today, dayLocale, translate)} cards={[]} loading words={boardWords} locale={INTL_LOCALE[locale]} />
  } else if (board && board.cards.length === 0) body = <EmptyState title={t('empty.title', { days: INBOUND_DAYS })} description={t('empty.body')} />
  else if (board) {
    body = (
      <div className="fw-ib-sites">
        {siteRows(board).map(({ site, cards }) => (
          <section key={site.id} className="fw-ib-site" aria-label={t('siteLabel', { site: site.name })}>
            {board.sites.length > 1 && <h3 className="fw-ib-site-name">{site.name}</h3>}
            {cards.length === 0 ? (
              <p className="fw-ib-none">{t('siteEmpty', { days: INBOUND_DAYS })}</p>
            ) : (
              <BoardView
                label={t('boardLabel', { site: site.name })}
                lanes={lanesOf(board, cards, model.today, dayLocale, translate)}
                cards={cards.map((card) => cardOf(card, model.prefix, translate, qty))}
                words={boardWords}
                locale={INTL_LOCALE[locale]}
                listBelow={720}
                renderFooter={footer}
              />
            )}
          </section>
        ))}
        {!board.complete && <Banner tone="warning" title={t('incomplete')} />}
      </div>
    )
  }

  return (
    <section className="fw-ib" aria-label={t('title')}>
      {head}
      {body}
      {model.noting && <NoteDialog model={model} actions={actions} card={model.noting.card} />}
    </section>
  )
}

function NoteDialog({ model, actions, card }: { model: InboundModel; actions?: InboundActions; card: InboundCard }) {
  const t = useT(INBOUND_NAMESPACE)
  const tb = useT('buying')
  const noting = model.noting!
  return (
    <Modal
      open
      onClose={() => actions?.onNote?.(null)}
      title={t('note.title', { number: card.shipNotice?.number ?? '' })}
      subtitle={t('note.subtitle', { supplier: card.supplier.name, order: card.purchaseOrder.number })}
      size="sm"
      footer={
        <>
          <Button size="sm" variant="quiet" onClick={() => actions?.onNote?.(null)}>
            {t('note.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={noting.saving ? t('note.saving') : null} onClick={() => actions?.onNoteSave?.()}>
            {t('note.save')}
          </Button>
        </>
      }
    >
      {noting.problem && <Banner tone="danger" title={tb(noting.problem)} />}
      <Field label={t('note.label')} hint={t('note.hint')}>
        <Textarea rows={4} maxLength={2000} value={noting.text} onChange={(event) => actions?.onNoteText?.(event.target.value)} />
      </Field>
    </Modal>
  )
}
