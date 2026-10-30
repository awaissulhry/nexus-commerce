'use client'

import { useMemo, useRef, useState } from 'react'
import { FileWarning, FilterX, Lock } from 'lucide-react'
import { EmptyState, Modal, ProgressBar } from '@nexus/ui/components'
import { Button, Tag } from '@nexus/ui/primitives'
import { BoardView, type BoardCard, type BoardLane, type BoardMove, type BoardTone } from '@nexus/ui/grid/views/board/index'
import { INTL_LOCALE, type Locale } from '../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { BOARD_VIEW_KIT_NAMESPACE, useBoardViewWords } from '../words'
import '../board-view-lab.css'

/** Made-up text in both interface languages (fixture data stands in for what the API and the tenant would give). */
export type Two = Readonly<{ it: string; en: string }>

export interface LabLane {
  id: string
  name: Two
  tone?: BoardTone
  /** The server's count of rows in this lane (more than drawn: "Show more"). */
  total?: number
  /** Days since the oldest row in this lane entered it. */
  oldestDays?: number
  /** Only a quality manager may drop here (the case's person is not one). */
  managersOnly?: boolean
  /** The lane is reached only through a dialog: never by a drag. */
  dialogOnly?: boolean
}

export interface LabCard {
  id: string
  number: string
  laneId: string
  title: Two
  severity?: Two
  owner?: Two
  subject?: string
  quantity?: Two
  ageDays?: number
  /** Days to the due date (negative: late). */
  dueDays?: number
  /** Garments decided of the garments on the NCR. */
  decided?: { done: number; total: number }
  reason?: { text: Two; tone: BoardTone }
  marks?: readonly { text: Two; tone: BoardTone }[]
  /** Waiting for the closing signature: it cannot move. */
  waitingSignature?: boolean
}

/** The ONE view model of the board view lab: the board's data and its state. It fetches nothing. */
export interface BoardViewLabModel {
  board: 'ncr' | 'holds'
  lanes: readonly LabLane[]
  cards: readonly LabCard[]
  layout: 'board' | 'list'
  load: 'ready' | 'loading' | 'error' | 'empty' | 'filtered' | 'no-permission'
  /** Why nothing can move: this person may only look, or the device is offline. */
  held?: 'readOnly' | 'offline' | null
  /** The person is a quality manager: Closed takes drops, through the signature dialog. */
  manager?: boolean
  defaultMove?: { cardId: string; to: string }
  /** Start with the closing (or release) dialog open for this card: a drop on Closed (Released). */
  closing?: string
}

/**
 * SCR-244 — the board (kanban) view for lists, DS part D19 (B-W2a-24; NEW id: the design gives the DS part no screen of
 * its own; its screens are the NCR board SCR-145 (B-W2a-68) and the hold board on SCR-078/079 (B-W2a-67), with W2b
 * boards later). Made-up nonconformances and holds; moves are kept in this view only (nothing is saved). Every word from
 * `boardview-kit` in Italian and English; numbers in the page's language.
 */
export function BoardViewLabView({ model }: { model: BoardViewLabModel }) {
  return (
    <WithMessages namespaces={[BOARD_VIEW_KIT_NAMESPACE]}>
      <Lab model={model} />
    </WithMessages>
  )
}

const pick = (text: Two | undefined, locale: Locale): string | undefined => (text ? text[locale] : undefined)

function Lab({ model }: { model: BoardViewLabModel }) {
  const t = useT(BOARD_VIEW_KIT_NAMESPACE)
  const locale = useLocale()
  const intl = INTL_LOCALE[locale]
  const words = useBoardViewWords()
  const number = useMemo(() => new Intl.NumberFormat(intl), [intl])
  const [cards, setCards] = useState<readonly LabCard[]>(model.cards)
  // The server's count per lane, kept in step with the moves made here (the API would answer it).
  const [totals, setTotals] = useState<Readonly<Record<string, number | undefined>>>(() => Object.fromEntries(model.lanes.map((lane) => [lane.id, lane.total])))
  const [opened, setOpened] = useState<string | null>(null)
  const [log, setLog] = useState<string | null>(null)
  const [closing, setClosing] = useState<{ cardId: string; to: string } | null>(() => {
    const to = model.lanes.find((lane) => lane.dialogOnly)?.id
    return model.closing && to ? { cardId: model.closing, to } : null
  })
  const answer = useRef<((made: boolean) => void) | null>(null)

  const lanes = useMemo<BoardLane[]>(
    () =>
      model.lanes.map((lane) => ({
        id: lane.id,
        label: lane.name[locale],
        tone: lane.tone,
        total: totals[lane.id],
        detail: lane.oldestDays === undefined ? null : lane.oldestDays === 0 ? t('lab.oldestOne') : t('lab.oldest', { count: lane.oldestDays }),
        held: lane.managersOnly && !model.manager ? t('lab.onlyManagers') : null,
      })),
    [model.lanes, model.manager, totals, locale, t, number],
  )
  const boardCards = useMemo<BoardCard[]>(
    () =>
      cards.map((card) => {
        const fields = [
          card.severity ? { label: t('lab.severity'), value: card.severity[locale] } : null,
          card.subject ? { label: t('lab.subject'), value: card.subject } : null,
          card.quantity ? { label: t('lab.quantity'), value: card.quantity[locale] } : null,
          card.ageDays !== undefined ? { label: t('lab.age'), value: t('lab.ageDays', { days: number.format(card.ageDays) }) } : null,
          card.owner ? { label: t('lab.owner'), value: card.owner[locale] } : null,
        ].filter((field): field is { label: string; value: string } => field !== null)
        const marks = [...(card.reason ? [card.reason] : []), ...(card.marks ?? [])].map((mark) => ({ label: mark.text[locale], tone: mark.tone }))
        return {
          id: card.id,
          laneId: card.laneId,
          label: card.number,
          title: card.title[locale],
          fields,
          marks,
          held: card.waitingSignature ? t('lab.waitingSignature') : null,
        }
      }),
    [cards, locale, t, number],
  )
  const labCard = (id: string) => cards.find((card) => card.id === id)

  const label = model.board === 'ncr' ? t('lab.labelNcr') : t('lab.labelHolds')

  if (model.load === 'error' || model.load === 'empty' || model.load === 'filtered' || model.load === 'no-permission') {
    const state = {
      error: { icon: <FileWarning size={22} aria-hidden="true" />, title: t('lab.errorTitle'), text: t('lab.errorReason'), action: <Button variant="primary">{t('lab.retry')}</Button> },
      empty: { icon: null, title: t('lab.emptyTitle'), text: t('lab.emptyText'), action: null },
      filtered: { icon: <FilterX size={22} aria-hidden="true" />, title: t('lab.filteredTitle'), text: null, action: <Button>{t('lab.clearFilters')}</Button> },
      'no-permission': { icon: <Lock size={22} aria-hidden="true" />, title: t('lab.noPermTitle'), text: t('lab.noPermText'), action: null },
    }[model.load]
    return (
      <div className="fw-bvlab">
        <EmptyState icon={state.icon} title={state.title} description={state.text} action={state.action} />
      </div>
    )
  }

  const moveCard = (cardId: string, to: string) => {
    const card = labCard(cardId)
    setCards((now) => now.map((item) => (item.id === cardId ? { ...item, laneId: to } : item)))
    if (card) {
      setTotals((now) => ({
        ...now,
        [card.laneId]: now[card.laneId] === undefined ? undefined : Math.max(0, (now[card.laneId] ?? 0) - 1),
        [to]: now[to] === undefined ? undefined : (now[to] ?? 0) + 1,
      }))
    }
    const lane = lanes.find((item) => item.id === to)
    if (card && lane) setLog(t('lab.moveLog', { card: card.number, lane: lane.label }))
  }

  // A drop on a dialog-only lane (Closed) waits for the closing signature; Cancel answers "not moved".
  const onMove = (move: BoardMove): boolean | Promise<boolean> => {
    const lane = model.lanes.find((item) => item.id === move.to)
    if (lane?.dialogOnly) {
      setClosing({ cardId: move.cardId, to: move.to })
      return new Promise<boolean>((resolve) => {
        answer.current = resolve
      })
    }
    moveCard(move.cardId, move.to)
    return true
  }
  const finishClosing = (made: boolean) => {
    const pending = closing
    setClosing(null)
    if (made && pending) moveCard(pending.cardId, pending.to)
    answer.current?.(made)
    answer.current = null
  }

  const moveHeld = (card: BoardCard, laneId: string): string | null => {
    const source = labCard(card.id)
    if (laneId === 'decided' && source?.decided && source.decided.done < source.decided.total) {
      return t('lab.notDecided', { left: number.format(source.decided.total - source.decided.done), total: number.format(source.decided.total) })
    }
    return null
  }

  const heldReason = model.held === 'readOnly' ? t('lab.readOnly') : model.held === 'offline' ? t('lab.offline') : null
  const due = (days: number) => (days < 0 ? t('lab.overdue', { count: -days }) : days === 0 ? t('lab.dueToday') : t('lab.dueIn', { count: days }))
  const closingCard = closing ? labCard(closing.cardId) : undefined
  const openedCard = opened ? labCard(opened) : undefined

  return (
    <div className="fw-bvlab">
      <BoardView
        label={label}
        lanes={lanes}
        cards={model.load === 'loading' ? [] : boardCards}
        layout={model.layout}
        loading={model.load === 'loading'}
        heldReason={heldReason}
        defaultMove={model.defaultMove}
        onMove={onMove}
        moveHeld={moveHeld}
        onOpen={(card) => setOpened(card.id)}
        onMore={(lane) => setLog(t('lab.more', { lane: lane.label }))}
        renderAside={(card) => {
          const days = labCard(card.id)?.dueDays
          if (days === undefined) return null
          return days <= 0 ? <Tag tone={days < 0 ? 'danger' : 'warning'}>{due(days)}</Tag> : due(days)
        }}
        renderFooter={(card) => {
          const decided = labCard(card.id)?.decided
          if (!decided) return null
          const text = t('lab.decided', { done: number.format(decided.done), total: number.format(decided.total) })
          return (
            <span className="fw-bvlab-decided">
              <ProgressBar value={(decided.done / Math.max(1, decided.total)) * 100} ariaLabel={text} height={5} />
              <span>{text}</span>
            </span>
          )
        }}
        words={words}
        locale={intl}
      />
      {log ? <p className="fw-bvlab-note">{log}</p> : null}
      {openedCard ? <p className="fw-bvlab-note">{t('lab.opened', { card: openedCard.number })}</p> : null}
      {closingCard ? (
        <Modal
          open
          size="sm"
          onClose={() => finishClosing(false)}
          title={t(model.board === 'ncr' ? 'lab.closeTitle' : 'lab.releaseTitle', { card: closingCard.number })}
          footer={
            <>
              <Button onClick={() => finishClosing(false)}>{t('lab.cancel')}</Button>
              <Button variant="primary" onClick={() => finishClosing(true)}>
                {t(model.board === 'ncr' ? 'lab.closeSign' : 'lab.releaseConfirm')}
              </Button>
            </>
          }
        >
          <p className="fw-bvlab-dialog">{t(model.board === 'ncr' ? 'lab.closeBody' : 'lab.releaseBody')}</p>
          <p className="fw-bvlab-dialog">{pick(closingCard.title, locale)}</p>
        </Modal>
      ) : null}
    </div>
  )
}
