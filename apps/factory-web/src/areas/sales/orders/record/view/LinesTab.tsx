'use client'

import { useEffect } from 'react'
import { Banner, Card, EmptyState } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import { formatTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { Order } from '../../api'
import { amendHeld, cellFloorsOf } from '../../daily-model'
import { frozenCells } from '../../depth/model'
import type { Phrase } from '../../model'
import { rowAnchor } from '../dock/discuss'
import { readOf } from '../overview/model'
import type { OrderRecordActions, OrderRecordModel } from '../record-model'
// ---- F-OL-02 (Order LINES lane): the tab — one table per style, change in place, the ONE line ⋯ ----
import { draftHoldsOf, EMPTY_DRAFT, holdPhrase } from '../lines-draft'
import { headOf, linesReaderOf, orderTotalOf, ownDatesOf, styleCardsOf, taxBasisOf, totalsOf } from '../lines-table'
import { useLineMenu } from './LineMenu'
import { LinesHead, ADD_STYLE_ID } from './lines/LinesHead'
import { lineNameOf, StyleTable, type LinesCtx } from './lines/StyleTable'
import { ChargesBlock, TotalsBlock } from './lines/LinesMoney'
import { SaveBar } from './lines/SaveBar' // F-OL-03
import { ReviewSave } from './lines/ReviewSave' // F-OL-03
import { AddColourDialog, AddStyleDialog } from './lines/AddStyleDialog' // F-OL-04
import './lines/lines.css'

/**
 * F-OL-02 (Order LINES lane, plan v2 §1; 10-design-tab; replaces F-SA-231's view mode) — Lines, the commercial truth, changed in
 * place: the head ("17 pieces · 3 lines · 1 charge · Ready by … ✎", the order total for price readers, Add a style, the tab ⋯), one
 * card per style with ONE native table (thin DS boxes for who changes lines, plain numbers for everyone else; marks "was 3", New,
 * struck + Put back; floors "min 3" only where cut or shipped binds; the company lock said before typing), the notes folded under
 * each row, the charges read-only, the totals in plain words. Sales sees no money anywhere and one line why; Read-only and Warehouse
 * see no button and no ⋯. What is typed waits in the draft (use-lines-draft.ts) for the save bar. Fetches nothing.
 */
export function LinesTab({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  return <LinesView order={order} model={model} actions={actions} />
}

function LinesView({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const tab = model.linesTab ?? null
  const draft = tab?.draft ?? EMPTY_DRAFT
  const reader = linesReaderOf(model.can)
  // Held by the order's state (shipped, closed, waiting: today's words); the right is the reader's (no boxes without it).
  const held = amendHeld(order, model.can)
  const busy = model.busy || !!tab?.saving
  const boxes = reader.writes && held === null && !busy
  const menu = useLineMenu(order, model, actions)
  const styles = tab?.styles ?? {}
  const cards = styleCardsOf(order, draft, styles)
  const basis = taxBasisOf(order)
  // F-OL-09: the server's figures of THIS draft once its preview answered; until then the client estimate.
  const figures = tab?.figures ?? null
  const totals = totalsOf(order, draft, cards, figures)
  const ctx: LinesCtx = {
    order,
    model,
    actions,
    draft,
    reader,
    boxes,
    readyBy: ownDatesOf(order),
    floors: cellFloorsOf(readOf(model.production)?.lines ?? []),
    freeze: model.depth?.freeze?.value ?? null,
    menu,
    clashes: tab?.clashes ?? [],
    moved: tab?.moved?.lineIds ?? [],
    styles,
    basis,
    colleague: tab?.moved?.by ?? null,
    figures,
  }
  // F-OL-03: what holds "Review and save…", in order, said for its cell (a size locked for good never changes).
  const lockedForGood = frozenCells(ctx.freeze).filter((cell) => cell.state === 'BLOCKED').map((cell) => ({ lineId: cell.lineId, size: cell.size }))
  const holds = draftHoldsOf(draft, order, { floors: ctx.floors, clashes: ctx.clashes.length, lockedForGood, unlisted: tab?.unlisted })
  const say = (phrase: Phrase) => t(phrase.key, phrase.params)
  // F-OL-04: n (not while typing, not inside a window) focuses "Add a style" (who changes lines).
  useEffect(() => {
    if (!reader.writes) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'n' || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return
      const button = document.getElementById(ADD_STYLE_ID)
      if (!button) return
      event.preventDefault()
      button.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [reader.writes])
  const addColourCard = tab?.addColour ? cards.find((card) => card.styleId === tab.addColour!.styleId) : undefined
  return (
    <div className="fw-lt">
      <LinesHead order={order} model={model} actions={actions} head={headOf(order, draft)} total={orderTotalOf(totals)} basis={basis} reader={reader} held={held} busy={busy} />
      <LinesNotices order={order} model={model} actions={actions} />
      {model.production?.status === 'failed' && reader.writes && <p className="fw-lt-quiet">{t('lines.floorsUnread')}</p>}
      {cards.length === 0 ? (
        <Card padded>
          <EmptyState
            title={t('lines.empty')}
            description={t('lines.emptyHint')}
            action={
              boxes ? (
                <Button size="sm" variant="primary" onClick={() => actions?.linesTab?.onAddStyleOpen?.()}>
                  {t('editor.add.title')}
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : (
        cards.map((card, index) => <StyleTable key={card.styleId} card={card} first={index === 0} ctx={ctx} />)
      )}
      <ChargesBlock order={order} reader={reader} />
      {reader.prices && cards.length > 0 && <TotalsBlock order={order} rows={totals} basis={basis} />}
      {/* ---- F-OL-03: the save bar (only while the draft holds a change), the ONE Review window ---- */}
      {tab && reader.writes && <SaveBar order={order} draft={draft} canUndo={tab.canUndo} held={busy ? t('held.busy') : holds[0] ? say(holdPhrase(holds[0], (key) => lineNameOf(order, draft, key))) : null} saving={tab.saving} actions={actions?.linesTab} />}
      {/* ---- F-OL-04: Add a style (the order's own search), + Add a colour ---- */}
      {tab?.addStyle && <AddStyleDialog order={order} draft={draft} state={tab.addStyle} seesPrices={reader.prices} actions={actions?.linesTab} />}
      {addColourCard && <AddColourDialog card={addColourCard} style={styles[addColourCard.styleId]} actions={actions?.linesTab} />}
      {tab?.review && <ReviewSave order={order} draft={draft} review={tab.review} seesPrices={reader.prices} freeze={ctx.freeze} floors={ctx.floors} portalGone={tab.portalGone} saving={busy} actions={actions?.linesTab} />}
    </div>
  )
}

/** F-OL-03: another person saved while I had changes — who, when, which lines moved; Show scrolls to the first; and a failed ask. */
function LinesNotices({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const locale = useLocale()
  const tab = model.linesTab ?? null
  if (!tab) return null
  const moved = tab.moved
  const name = (lineId: string) => {
    const line = order.lines.find((entry) => entry.id === lineId)
    return line ? t('save.lineName', { seq: line.seq, colour: lineNameOf(order, tab.draft, lineId) }) : null
  }
  return (
    <>
      {moved && (
        <Banner
          tone="info"
          title={moved.lineIds.length > 0 ? t('save.moved', { name: moved.by ?? t('dates.someone'), time: formatTime(moved.at, { locale }), lines: moved.lineIds.map(name).filter(Boolean).join(', ') }) : t('save.movedNone', { name: moved.by ?? t('dates.someone'), time: formatTime(moved.at, { locale }) })}
          action={
            moved.lineIds.length > 0 ? (
              <Button size="sm" variant="quiet" onClick={() => document.getElementById(rowAnchor('SalesOrderLine', moved.lineIds[0]!))?.scrollIntoView({ block: 'center' })}>
                {t('save.show')}
              </Button>
            ) : undefined
          }
          onDismiss={() => actions?.linesTab?.onMovedDismiss?.()}
        >
          {moved.gone.length > 0 ? t('save.gone', { count: moved.gone.length }) : undefined}
        </Banner>
      )}
      {tab.askFailed && (
        <Banner
          tone="warning"
          title={t('save.askFailed', { customer: order.party?.legalName ?? '' })}
          action={
            <Button size="sm" onClick={() => actions?.linesTab?.onAskAgain?.()}>
              {t('save.askAgain')}
            </Button>
          }
          onDismiss={() => actions?.linesTab?.onAskDismiss?.()}
        />
      )}
    </>
  )
}
// ---- end F-OL-02
