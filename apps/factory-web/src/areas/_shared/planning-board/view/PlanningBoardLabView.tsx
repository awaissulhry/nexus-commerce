'use client'

import { useMemo, useState } from 'react'
import { CalendarX2 } from 'lucide-react'
import { EmptyState } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import { LoadBar, PlanningBoard, withMove, type PlanningBucket, type PlanningCard, type PlanningLane, type PlanningMove, type PlanningPlace, type PlanningTone } from '@nexus/ui/patterns/planning-board/index'
import { INTL_LOCALE, type Locale } from '../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { BOARD_KIT_NAMESPACE, useBoardWords } from '../words'
import '../planning-board-lab.css'

/** Made-up text in both interface languages (fixture data stands in for what the API and the tenant would give). */
export type Two = Readonly<{ it: string; en: string }>

export interface LabLane {
  id: string
  name: Two
  /** People × minutes per day × efficiency: the capacity words and the lane's detail line. */
  people?: number
  minutesPerDay?: number
  efficiency?: number
  kind: Two
  /** Available standard minutes per bucket id (null = no working time set; missing = not known). */
  capacity?: Readonly<Record<string, number | null>>
  held?: Two
  closed?: Readonly<Record<string, Two>>
}

export interface LabBucket {
  id: string
  /** YYYY-MM-DD; drawn as the day in the page's language. */
  date: string
  today?: boolean
  closed?: Two
}

export interface LabCard {
  id: string
  number: string
  style: Two
  pieces: number
  minutes: number
  laneId: string | null
  bucketId: string | null
  span?: number
  load?: readonly number[]
  pinned?: boolean
  late?: boolean
  marks?: readonly { text: Two; tone: PlanningTone }[]
  note?: Two
}

/** The ONE view model of the planning board lab: the board's data and its state. It fetches nothing. */
export interface PlanningBoardLabModel {
  layout: 'time' | 'columns' | 'list'
  lanes: readonly LabLane[]
  buckets: readonly LabBucket[]
  cards: readonly LabCard[]
  load: 'ready' | 'loading' | 'error'
  /** Why nothing can move: this person may only look, or the tablet is offline. */
  held?: 'readOnly' | 'offline' | null
  /** The site's setting: a drop over capacity is refused (`block`) or made and flagged (`allow`). */
  overload?: 'allow' | 'block'
  /** The app's own check: this card may not start before this bucket (material arrives later). */
  materialHeld?: { cardId: string; from: string; text: Two }
  defaultMove?: { cardId: string; to: PlanningPlace }
  /** Show the load bar's states on their own under the board. */
  loadBars?: boolean
}

/**
 * SCR-243 — the planning board and the load bar, DS parts D18 + LoadBar (B-W2a-14; NEW id: the design gives the DS part
 * no screen of its own; its screens are the Planning board SCR-122 and Lines & subcontractors SCR-126, B-W2a-45, on
 * the schedule API of B-W2a-34). Made-up lines and work orders; moves are kept in this view only (nothing is saved).
 * Every word from `board-kit` in Italian and English; numbers and days in the page's language.
 */
export function PlanningBoardLabView({ model }: { model: PlanningBoardLabModel }) {
  return (
    <WithMessages namespaces={[BOARD_KIT_NAMESPACE]}>
      <Lab model={model} />
    </WithMessages>
  )
}

const pick = (text: Two | undefined, locale: Locale): string | undefined => (text ? text[locale] : undefined)

function Lab({ model }: { model: PlanningBoardLabModel }) {
  const t = useT(BOARD_KIT_NAMESPACE)
  const locale = useLocale()
  const intl = INTL_LOCALE[locale]
  const words = useBoardWords()
  const [cards, setCards] = useState<readonly LabCard[]>(model.cards)
  const [opened, setOpened] = useState<string | null>(null)
  const number = useMemo(() => new Intl.NumberFormat(intl, { maximumFractionDigits: 1 }), [intl])
  const day = useMemo(() => new Intl.DateTimeFormat(intl, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }), [intl])

  const buckets = useMemo<PlanningBucket[]>(
    () => model.buckets.map((bucket) => ({ id: bucket.id, label: day.format(new Date(`${bucket.date}T12:00:00Z`)), today: bucket.today, closed: pick(bucket.closed, locale) ?? null })),
    [model.buckets, day, locale],
  )
  const lanes = useMemo<PlanningLane[]>(
    () =>
      model.lanes.map((lane) => {
        const formula = (available: number) =>
          lane.people && lane.minutesPerDay && lane.efficiency
            ? t('lab.formula', { people: lane.people, minutes: number.format(lane.minutesPerDay), efficiency: lane.efficiency, available: number.format(available) })
            : ''
        const capacityWords = Object.fromEntries(Object.entries(lane.capacity ?? {}).flatMap(([id, value]) => (typeof value === 'number' && value > 0 && formula(value) ? [[id, formula(value)]] : [])))
        const detail = lane.people && lane.efficiency ? t('lab.laneDetail', { kind: lane.kind[locale], people: lane.people, efficiency: lane.efficiency }) : lane.kind[locale]
        return {
          id: lane.id,
          label: lane.name[locale],
          detail,
          held: pick(lane.held, locale) ?? null,
          capacity: lane.capacity,
          capacityWords,
          closed: lane.closed ? Object.fromEntries(Object.entries(lane.closed).map(([id, reason]) => [id, reason[locale]])) : undefined,
        }
      }),
    [model.lanes, locale, t, number],
  )
  const boardCards = useMemo<PlanningCard[]>(
    () =>
      cards.map((card) => ({
        id: card.id,
        label: card.number,
        detail: t('lab.cardDetail', { style: card.style[locale], pieces: number.format(card.pieces) }),
        minutes: card.minutes,
        laneId: card.laneId,
        bucketId: card.bucketId,
        span: card.span,
        load: card.load,
        pinned: card.pinned,
        late: card.late,
        marks: card.marks?.map((mark) => ({ label: mark.text[locale], tone: mark.tone })),
        note: pick(card.note, locale),
      })),
    [cards, locale, t, number],
  )

  if (model.load === 'error') {
    return (
      <div className="fw-pblab">
        <EmptyState icon={<CalendarX2 size={22} aria-hidden="true" />} title={t('lab.errorTitle')} description={t('lab.errorReason')} action={<Button variant="primary">{t('lab.retry')}</Button>} />
      </div>
    )
  }

  const layout = model.layout === 'columns' ? 'columns' : 'time'
  const onMove = (move: PlanningMove) => {
    setCards((now) => {
      const moved = withMove(boardCards, move.cardId, move.to, layout)
      return now.map((card) => {
        const next = moved.find((item) => item.id === card.id)
        return next ? { ...card, laneId: next.laneId, bucketId: next.bucketId } : card
      })
    })
  }
  const material = model.materialHeld
  const order = new Map(model.buckets.map((bucket, at) => [bucket.id, at]))
  const dropHeld = material
    ? (card: PlanningCard, to: PlanningPlace) =>
        card.id === material.cardId && to.laneId !== null && (order.get(to.bucketId ?? '') ?? 0) < (order.get(material.from) ?? 0) ? material.text[locale] : null
    : undefined
  const heldReason = model.held === 'readOnly' ? t('lab.readOnly') : model.held === 'offline' ? t('lab.offline') : null
  const openedCard = boardCards.find((card) => card.id === opened)

  return (
    <div className="fw-pblab">
      <PlanningBoard
        label={model.layout === 'columns' ? t('lab.labelAllocation') : t('lab.label')}
        lanes={lanes}
        buckets={buckets}
        cards={model.load === 'loading' ? [] : boardCards}
        layout={model.layout}
        loading={model.load === 'loading'}
        heldReason={heldReason}
        overload={model.overload ?? 'allow'}
        dropHeld={dropHeld}
        defaultMove={model.defaultMove}
        onMove={onMove}
        onOpen={(card) => setOpened(card.id)}
        onPin={(card, pinned) => setCards((now) => now.map((item) => (item.id === card.id ? { ...item, pinned } : item)))}
        words={words.board}
        loadWords={words.load}
        locale={intl}
      />
      {openedCard ? <p className="fw-pblab-opened">{t('lab.opened', { card: openedCard.label })}</p> : null}
      {model.loadBars ? (
        <section className="fw-pblab-bars" aria-label={t('lab.bars')}>
          <LoadBar size="md" label={t('lab.barOk')} booked={2340} available={2880} words={words.load} locale={intl} />
          <LoadBar size="md" label={t('lab.barFull')} booked={2880} available={2880} words={words.load} locale={intl} />
          <LoadBar size="md" label={t('lab.barOver')} booked={3520} available={2880} words={words.load} locale={intl} />
          <LoadBar size="md" label={t('lab.barPreview')} booked={2340} available={2880} after={2844} words={words.load} locale={intl} />
          <LoadBar size="md" label={t('lab.barNone')} booked={0} available={null} words={words.load} locale={intl} />
          <LoadBar size="md" label={t('lab.barClosed')} booked={0} available={0} words={words.load} locale={intl} />
          <LoadBar size="md" label={t('lab.barUnknown')} booked={0} available={undefined} words={words.load} locale={intl} />
        </section>
      ) : null}
    </div>
  )
}
