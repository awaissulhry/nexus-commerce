'use client'

import { useEffect, useMemo, useState } from 'react'
import { ExternalLink, MoreHorizontal, Network } from 'lucide-react'
import { Banner, Card, EmptyState, Field, KeyValue, Menu } from '@nexus/ui/components'
import { Button, Kbd, NumberStepper, Select, Skeleton, Spinner, Tag } from '@nexus/ui/primitives'
import { LoadBar, PlanningBoard, type PlanningMove, type PlanningPlace } from '@nexus/ui/patterns/planning-board/index'
import { Modal } from '../../../../lib/i18n/ds-parts'
import { INTL_LOCALE } from '../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { BOARD_KIT_NAMESPACE, useBoardWords } from '../../../_shared/planning-board/words'
import type { Allocation } from '../api'
import { dayWords, drawAllocation, laneDetail, laneKeyOf, minutesText, NAMESPACE, type Words } from '../model'
import type { AllocationActions, AllocationDialog, AllocationViewModel } from '../view-model'
import '../allocation.css'

/**
 * SCR-126 — Lines & subcontractors (design planning.allocation: Lanes, Allocation board): one small load summary per line
 * and workshop (the next four weeks' LoadBar, garments booked), then the DS PlanningBoard in its columns layout — "Not
 * allocated" first, one column per line and workshop. Dragging a card moves all its garments (keyboard: M or Space, ← →,
 * Enter); a card's detail moves part of them. Never optimistic: a card shows "Saving" until the API answered.
 *
 * With no `actions` (the design index) the moves stay in this view: nothing is saved.
 */
export function AllocationView({ model, actions }: { model: AllocationViewModel; actions?: AllocationActions }) {
  return (
    <WithMessages namespaces={[NAMESPACE, BOARD_KIT_NAMESPACE]}>
      <AllocationBody model={model} actions={actions} />
    </WithMessages>
  )
}

function AllocationBody({ model, actions }: { model: AllocationViewModel; actions?: AllocationActions }) {
  const t = useT(NAMESPACE)
  const locale = useLocale()
  const kit = useBoardWords()
  const words = useMemo<Words>(() => ({ t, locale }), [t, locale])
  const data = model.read.status === 'ready' ? model.read.value : null
  const drawn = useMemo(() => (data ? drawAllocation(data, words) : null), [data, words])
  const [local, setLocal] = useState<Record<string, PlanningPlace>>({})
  const cards = useMemo(() => (drawn ? (actions?.onMove ? drawn.cards : drawn.cards.map((card) => (local[card.id] ? { ...card, ...local[card.id] } : card))) : []), [drawn, actions?.onMove, local])
  const mayChange = data?.mayChange ?? false
  const held = !data ? null : !mayChange ? t('held.readOnly') : model.offline ? t('held.offline') : null
  const onMove = useMemo(() => {
    if (!data || !mayChange) return undefined
    if (actions?.onMove) return actions.onMove
    return (move: PlanningMove) => {
      setLocal((current) => ({ ...current, [move.cardId]: move.to }))
      return true
    }
  }, [data, mayChange, actions?.onMove])

  return (
    <div className="fw-al">
      <div className="fw-al-band">
        <div className="fw-al-scope">
          {model.sites.length > 1 ? (
            <Select size="sm" aria-label={t('band.site')} value={model.controls.site ?? data?.site.id ?? ''} onChange={(event) => actions?.onSite?.(event.target.value)}>
              {model.sites.map((site) => (
                <option key={site.id} value={site.id}>
                  {`${site.code} · ${site.name}`}
                </option>
              ))}
            </Select>
          ) : data ? (
            <span className="fw-al-site">{`${data.site.code} · ${data.site.name}`}</span>
          ) : null}
          <span className="fw-al-status" role="status">
            {data ? t('band.asOf', { time: new Intl.DateTimeFormat(INTL_LOCALE[locale], { timeZone: data.site.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(data.asOf)) }) : model.read.status === 'loading' ? t('band.reading') : t('band.notRead')}
            {' · '}
            {model.save.state === 'saving' ? t('save.saving') : model.save.state === 'saved' ? t('save.saved') : model.save.state === 'failed' ? t('save.failed', { reason: t(`refusal.${model.save.refusal}`) }) : t('save.idle')}
            {model.notice ? ` · ${model.notice}` : ''}
          </span>
        </div>
        <div className="fw-al-actions">
          <Button size="sm" variant="secondary" asChild>
            <a href={`${model.prefix}/planning/board${data ? `?site=${encodeURIComponent(data.site.id)}` : ''}`} target="_blank" rel="noopener">
              <ExternalLink size={14} aria-hidden /> {t('band.board')}
            </a>
          </Button>
          <Menu label={<MoreHorizontal size={16} aria-hidden />} align="right" triggerProps={{ 'aria-label': t('band.more') }} items={[{ id: 'keys', label: t('band.keys'), onSelect: () => actions?.onOpenKeys?.() }]} />
        </div>
      </div>

      <section className="fw-al-lanes" aria-labelledby="fw-al-lanes">
        <h2 className="fw-al-h2" id="fw-al-lanes">
          {t('lanes.title')}
        </h2>
        {model.read.status === 'loading' ? (
          <div className="fw-al-tiles" aria-busy="true" aria-label={t('band.reading')}>
            {[0, 1, 2].map((index) => (
              <Card key={index} padded>
                <Skeleton width="50%" />
                <Skeleton height={28} />
              </Card>
            ))}
          </div>
        ) : data ? (
          <div className="fw-al-tiles">
            {data.lanes.map((lane) => (
              <Card key={laneKeyOf(lane)} padded className="fw-al-tile">
                <span className="fw-al-tile-name">
                  {lane.name} <Tag tone="neutral">{t(`kind.${lane.kind}`)}</Tag>
                </span>
                <LoadBar
                  size="md"
                  label={lane.name}
                  labelVisible={false}
                  booked={lane.load ? Number(lane.load.bookedMinutes) : 0}
                  available={lane.load ? Number(lane.load.availableMinutes) : undefined}
                  words={kit.load}
                  locale={INTL_LOCALE[locale]}
                />
                <span className="fw-al-hint">{laneDetail(lane, words)}</span>
              </Card>
            ))}
            {data.lanes.length === 0 ? <p className="fw-al-hint">{t('lanes.none')}</p> : null}
          </div>
        ) : null}
      </section>

      {data && held ? (
        <Banner tone={model.offline ? 'warning' : 'info'} title={held}>
          {t(model.offline ? 'held.offlineBody' : 'held.readOnlyBody')}
        </Banner>
      ) : null}

      <section className="fw-al-board" aria-labelledby="fw-al-board">
        <div className="fw-al-section-head">
          <h2 className="fw-al-h2" id="fw-al-board">
            {t('board.title')}
          </h2>
          <span className="fw-al-hint">{t('board.hint')}</span>
        </div>
        {model.read.status === 'loading' ? (
          <div className="fw-al-skeleton" aria-busy="true" aria-label={t('band.reading')}>
            <Skeleton height={120} />
          </div>
        ) : model.read.status === 'error' ? (
          <EmptyState
            icon={<Network size={28} aria-hidden />}
            title={t('error.title')}
            description={t(`error.${model.read.problem}`)}
            action={
              model.read.problem === 'forbidden' || model.read.problem === 'noSite' ? undefined : (
                <Button size="sm" onClick={() => actions?.onRetry?.()}>
                  {t('error.retry')}
                </Button>
              )
            }
          />
        ) : drawn ? (
          <PlanningBoard
            label={t('board.label', { site: data!.site.name })}
            layout="columns"
            lanes={drawn.lanes}
            buckets={drawn.buckets}
            cards={cards}
            onMove={onMove}
            onOpen={(card) => actions?.onOpen?.(card)}
            heldReason={held}
            words={{ ...kit.board, tray: t('board.tray'), trayEmpty: t('board.trayEmpty'), empty: t('board.empty'), moveBucket: t('board.moveBucket') }}
            loadWords={kit.load}
            locale={INTL_LOCALE[locale]}
          />
        ) : null}
      </section>

      <AllocationDialogs model={model} actions={actions} words={words} data={data} />
    </div>
  )
}

function AllocationDialogs({ model, actions, words, data }: { model: AllocationViewModel; actions?: AllocationActions; words: Words; data: Allocation | null }) {
  const dialog = model.dialog
  if (!dialog) return null
  const close = () => actions?.onCloseDialog?.()
  if (dialog.kind === 'keys') return <KeysDialog words={words} onClose={close} />
  return <CardDialog dialog={dialog} model={model} actions={actions} words={words} data={data} onClose={close} />
}

const NOT_ALLOCATED = ''

function CardDialog({ dialog, model, actions, words, data, onClose }: { dialog: Extract<AllocationDialog, { kind: 'card' }>; model: AllocationViewModel; actions?: AllocationActions; words: Words; data: Allocation | null; onClose: () => void }) {
  const { t, locale } = words
  const card = data?.cards.find((entry) => entry.id === dialog.cardId) ?? null
  const here = card?.lane ? laneKeyOf(card.lane) : NOT_ALLOCATED
  const others = data?.lanes.filter((lane) => laneKeyOf(lane) !== here) ?? []
  const [lane, setLane] = useState<string>(others[0] ? laneKeyOf(others[0]) : NOT_ALLOCATED)
  const [pieces, setPieces] = useState<number>(card?.pieces ?? 1)
  useEffect(() => setPieces(card?.pieces ?? 1), [card?.pieces])
  if (!card) {
    return (
      <Modal open onClose={onClose} size="md" title={t('card.gone')} footer={<Button size="sm" onClick={onClose}>{t('dialog.close')}</Button>}>
        <p>{t('card.goneBody')}</p>
      </Modal>
    )
  }
  const mayChange = data?.mayChange ?? false
  const held = !mayChange
    ? t('held.readOnly')
    : model.offline
      ? t('held.offline')
      : dialog.busy
        ? t('held.busy')
        : lane === here
          ? t('held.same')
          : !Number.isInteger(pieces) || pieces < 1 || pieces > card.pieces
            ? t('held.pieces', { count: card.pieces, pieces: card.pieces })
            : null
  const workOrderHref = `${model.prefix}/production/work-orders/${encodeURIComponent(card.workOrder.id)}`
  const boardHref = `${model.prefix}/planning/board?site=${encodeURIComponent(data!.site.id)}&wo=${encodeURIComponent(card.workOrder.id)}`
  const laneName = (key: string) => (key === NOT_ALLOCATED ? t('board.tray') : (data?.lanes.find((entry) => laneKeyOf(entry) === key)?.name ?? ''))
  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={t('card.title', { order: card.workOrder.number, lane: laneName(here) })}
      subtitle={`${card.workOrder.style.code} · ${card.workOrder.style.name}`}
      footer={
        <>
          <Button size="sm" variant="quiet" asChild>
            <a href={boardHref} target="_blank" rel="noopener">
              {t('card.onBoard')}
            </a>
          </Button>
          <span className="grow" />
          <Button size="sm" asChild>
            <a href={workOrderHref}>{t('card.open')}</a>
          </Button>
          <Button size="sm" variant="primary" heldReason={held} onClick={() => !held && actions?.onMovePart?.(card.id, lane === NOT_ALLOCATED ? null : lane, pieces)}>
            {dialog.busy ? <Spinner size={12} /> : null} {t('card.move', { count: pieces, pieces })}
          </Button>
        </>
      }
    >
      <div className="fw-al-dialog">
        {dialog.error ? <Banner tone="danger" title={dialog.error} /> : null}
        <KeyValue
          columns={2}
          labelCase="sentence"
          items={[
            { label: t('card.pieces'), value: t('card.piecesValue', { pieces: card.pieces, of: card.workOrder.garments }) },
            { label: t('card.minutes'), value: t('card.minutesValue', { minutes: minutesText(card.minutes, locale) }) },
            { label: t('card.dueLabel'), value: card.workOrder.dueDate ? dayWords(card.workOrder.dueDate, locale) : t('card.noDue') },
            { label: t('card.status'), value: t(`status.${card.schedule.status}`) },
          ]}
        />
        {card.workOrder.holdReason ? <Banner tone="warning" title={t('mark.onHold')}>{card.workOrder.holdReason}</Banner> : null}
        <h3 className="fw-al-h3">{t('card.moveTitle')}</h3>
        <div className="fw-al-form">
          <Field label={t('card.to')}>
            <Select size="sm" value={lane} onChange={(event) => setLane(event.target.value)}>
              {here !== NOT_ALLOCATED ? <option value={NOT_ALLOCATED}>{t('board.tray')}</option> : null}
              {others.map((entry) => (
                <option key={laneKeyOf(entry)} value={laneKeyOf(entry)}>
                  {`${entry.name} · ${t(`kind.${entry.kind}`)}`}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('card.howMany')} hint={t('card.howManyHint', { pieces: card.pieces })}>
            <NumberStepper size="sm" value={pieces} min={1} max={card.pieces} onChange={setPieces} decrementLabel={t('card.less')} incrementLabel={t('card.more')} />
          </Field>
        </div>
        <p className="fw-al-hint">{t('card.rule')}</p>
      </div>
    </Modal>
  )
}

function KeysDialog({ words, onClose }: { words: Words; onClose: () => void }) {
  const { t } = words
  const rows: Array<[readonly string[], string]> = [
    [['M', 'Space'], 'keys.pick'],
    [['←', '→'], 'keys.columns'],
    [['Enter'], 'keys.drop'],
    [['Esc'], 'keys.cancel'],
    [['⌘', 'Z'], 'keys.undo'],
  ]
  return (
    <Modal open onClose={onClose} size="md" title={t('keys.title')} footer={<Button size="sm" onClick={onClose}>{t('dialog.close')}</Button>}>
      <dl className="fw-al-keys">
        {rows.map(([keys, label]) => (
          <div key={label} className="fw-al-keys-row">
            <dt>
              {keys.map((key) => (
                <Kbd key={key}>{key}</Kbd>
              ))}
            </dt>
            <dd>{t(label)}</dd>
          </div>
        ))}
      </dl>
    </Modal>
  )
}
