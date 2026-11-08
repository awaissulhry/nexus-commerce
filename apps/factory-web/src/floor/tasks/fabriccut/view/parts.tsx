'use client'

import type { ReactNode } from 'react'
import { Check, CircleDashed, CloudOff, Layers, Ruler, Scissors, ScanLine, Sticker, Truck } from 'lucide-react'
import { LabelPreview, type LabelPrintState } from '@nexus/ui/components/LabelPreview/index'
import { FloorList, FloorListRow, type FloorTone } from '@nexus/ui/floor'
import { FloorCard } from '@nexus/ui/floor/FloorCard/index'
import { useDsWords } from '../../../../lib/i18n/ds-parts'
import type { Translate } from '../../../../lib/i18n/messages'
import { ListFooter, TaskLine, Ticks, type TickState } from '../../shared/view/TaskParts'
import type { LayView, OpenTrolleys, PrintJob, Recut, TicketCard, Trolley, WaitingTicket } from '../api'
import { isKeptRow, linesOf, printStatusOf, ratioChips, stepStates, type LayStep } from '../model'

/**
 * SCR-182's parts (B-W2b-121): the ticket's card, the lay's head with the step strip, the running sums, the rows of the lay report,
 * the tickets / recuts / trolleys lists, a label's print state and the receipt strip. Each takes its words from the screen
 * (`t`); none fetches. Composed of DS parts (FloorCard, FloorList, FloorListRow, LabelPreview) with layout-only CSS.
 */

export type Num = (value: number, decimals?: number) => string

/** What was just done, on top of the next step (a receipt with its ticks). */
export interface DoneLine {
  readonly kind: 'started' | 'roll' | 'undo' | 'count' | 'cut' | 'fabric' | 'recutStarted' | 'recutDone' | 'load' | 'unload' | 'send' | 'receive' | 'process'
  readonly code: string
  readonly count?: number
  readonly line?: string
  readonly ticks: TickState | null
}

export function DoneStrip({ done, t }: { done: DoneLine | null; t: Translate }) {
  if (!done) return null
  return (
    <div className="fw-floor-notice fw-fc-done" data-tone="success" role="status">
      <span className="fw-floor-inline-icon" aria-hidden="true">
        <Check />
      </span>
      <span className="fw-fc-done-text">{t(`done.${done.kind}`, { code: done.code, count: done.count ?? 0, line: done.line ?? '' })}</span>
      {done.ticks ? <Ticks state={done.ticks} /> : null}
    </div>
  )
}

const STEP_ICON: Readonly<Record<LayStep, ReactNode>> = {
  start: <ScanLine />,
  spread: <Layers />,
  check: <Ruler />,
  cut: <Scissors />,
  stickers: <Sticker />,
  fabric: <Ruler />,
}

/** The ticket, its lay and the step strip (design status "Cut ticket code", "Step: Spread / Check / Cut / Issue"). */
export function LayHead({ card, step, t }: { card: TicketCard; step: LayStep; t: Translate }) {
  const states = stepStates(step)
  return (
    <header className="fw-fc-head" aria-labelledby="fw-fc-head-code">
      <p className="fw-fc-head-line">
        <span className="fw-fc-head-type">{t('ticket.type')}</span>
        <span id="fw-fc-head-code" className="fw-floor-card-code">
          {card.ticket.number}
        </span>
        <span className="fw-floor-muted">{card.lay ? t('ticket.layOf', { seq: card.lay.seq, of: card.lay.of }) : card.cutOrder.number}</span>
      </p>
      <ol className="fw-fc-steps" aria-label={t('steps.label')}>
        {states.map((entry) => (
          <li key={entry.step} className="fw-fc-step" data-state={entry.state} aria-current={entry.state === 'now' ? 'step' : undefined}>
            <span className="fw-floor-inline-icon" aria-hidden="true">
              {entry.state === 'done' ? <Check /> : entry.state === 'now' ? STEP_ICON[entry.step] : <CircleDashed />}
            </span>
            <span className="fw-fc-step-word">{t(`steps.${entry.step}`)}</span>
            <span className="nds-vh">{t(`steps.state.${entry.state}`)}</span>
          </li>
        ))}
      </ol>
    </header>
  )
}

/** The ticket's card (design sec:ticket): the ratio as size chips, the plies big, marker, material, parts, work orders, due. */
export function TicketFacts({ card, asOf, t, num, day, time, locale }: { card: TicketCard; asOf: string | null; t: Translate; num: Num; day: (value: string) => string; time: (value: string) => string; locale: 'it' | 'en' }) {
  const ds = useDsWords()
  const { styles, workOrders } = linesOf(card)
  const chips = ratioChips(card.cutOrder.ratio)
  const plies = card.lay?.plies ?? card.cutOrder.plies
  const material = [card.cutOrder.material.item.code, card.cutOrder.material.colour?.code, card.cutOrder.material.item.name].filter(Boolean).join(' · ')
  return (
    <FloorCard
      icon={<Scissors />}
      kind={t('ticket.type')}
      code={card.ticket.number}
      id="fw-fc-card"
      headingLevel={2}
      title={<span className="fw-fc-card-title">{styles.join(', ')}</span>}
      status={{ label: t(`ticketStatus.${card.ticket.status}`), tone: card.ticket.status === 'STARTED' ? 'info' : card.ticket.status === 'DONE' ? 'success' : card.ticket.status === 'VOID' ? 'danger' : 'neutral' }}
      facts={[
        { id: 'garments', label: t('fact.garments'), value: num(card.cutOrder.garments) },
        { id: 'lay', label: t('fact.lay'), value: card.lay ? t('ticket.layOf', { seq: card.lay.seq, of: card.lay.of }) : null },
        { id: 'marker', label: t('fact.marker'), value: card.cutOrder.marker ? `${card.cutOrder.marker.name} · ${card.cutOrder.marker.words[locale]}` : null },
        { id: 'material', label: t('fact.material'), value: material },
        { id: 'parts', label: t('fact.parts'), value: card.parts.join(', ') },
        { id: 'workOrders', label: t('fact.workOrders'), value: workOrders.join(', ') },
        { id: 'due', label: t('fact.due'), value: card.cutOrder.dueDate ? day(card.cutOrder.dueDate) : null },
      ]}
      asOf={asOf}
      formatTime={time}
      labels={ds.floorCard}
    >
      <div className="fw-fc-ticket-row">
        {chips.length > 0 ? (
          <div className="fw-fc-chips" role="list" aria-label={t('ticket.ratio')}>
            {chips.map((chip) => (
              <span key={chip.size} role="listitem" className="fw-fc-chip">
                <span className="fw-fc-chip-size">{chip.size}</span>
                <span className="fw-fc-chip-ratio">× {num(chip.ratio)}</span>
              </span>
            ))}
          </div>
        ) : null}
        {plies !== null ? (
          <p className="fw-fc-plies">
            <span className="fw-fc-sum-big">{num(plies)}</span>
            <span className="fw-fc-sum-of">{t('fact.pliesCount', { count: plies })}</span>
          </p>
        ) : null}
      </div>
    </FloorCard>
  )
}

/** The running sums (design sec:spread "Running totals: plies, lay length, rolls used"). */
export function SpreadSums({ lay, t, num }: { lay: LayView; t: Translate; num: Num }) {
  const ply = Number(lay.lay.plyMetres)
  return (
    <dl className="fw-fc-sums" aria-label={t('spread.sums')}>
      <div className="fw-fc-sum" data-tone={lay.spread.needed === 0 ? 'success' : 'neutral'}>
        <dt>{t('spread.plies')}</dt>
        <dd>
          <span className="fw-fc-sum-big">{num(lay.spread.plies)}</span>
          <span className="fw-fc-sum-of">{t('spread.of', { planned: num(lay.lay.plies) })}</span>
        </dd>
      </div>
      <div className="fw-fc-sum">
        <dt>{t('spread.needed')}</dt>
        <dd>
          <span className="fw-fc-sum-big">{num(lay.spread.needed)}</span>
        </dd>
      </div>
      <div className="fw-fc-sum">
        <dt>{t('spread.length')}</dt>
        <dd>
          <span className="fw-fc-sum-big">{num(ply, 2)}</span>
          <span className="fw-fc-sum-of">{t('unit.m')}</span>
        </dd>
      </div>
      <div className="fw-fc-sum">
        <dt>{t('spread.rolls')}</dt>
        <dd>
          <span className="fw-fc-sum-big">{num(lay.spread.rolls)}</span>
        </dd>
      </div>
    </dl>
  )
}

/** The lay report, roll by roll; a row kept on the tablet says so. */
export function RollRows({ lay, t, num }: { lay: LayView; t: Translate; num: Num }) {
  if (lay.rolls.length === 0) {
    return (
      <TaskLine tone="info" icon={<Layers />}>
        {t('spread.empty')}
      </TaskLine>
    )
  }
  return (
    <section className="fw-floor-stack" aria-labelledby="fw-fc-rolls">
      <h2 id="fw-fc-rolls" className="fw-floor-section-title">
        {t('spread.report')}
      </h2>
      <FloorList label={t('spread.report')}>
        {lay.rolls.map((roll) => {
          const kept = isKeptRow(roll.id)
          const meta = [roll.lotCode ? t('roll.lot', { lot: roll.lotCode }) : null, roll.splices > 0 ? t('roll.splices', { count: roll.splices }) : null, Number(roll.endLoss) > 0 ? t('roll.endLoss', { length: num(Number(roll.endLoss), 2), unit: unitOf(roll.uom, t) }) : null, roll.shade ? t('roll.shade', { shade: roll.shade }) : null].filter(Boolean).join(' · ')
          return <FloorListRow key={roll.id} icon={kept ? <CloudOff /> : <Layers />} tone={kept ? 'warning' : 'neutral'} title={<span className="fw-floor-code">{roll.code}</span>} meta={meta || undefined} status={kept ? t('roll.kept') : undefined} count={num(roll.plies)} countLabel={t('roll.plies', { count: roll.plies })} />
        })}
      </FloorList>
    </section>
  )
}

const unitOf = (uom: string, t: Translate): string => (uom === 'CM' ? t('unit.cm') : uom === 'MM' ? t('unit.mm') : t('unit.m'))

/** The site's tickets to cut (sec:ticket), oldest first; a row opens its card. Keys in the footer's icon. */
export function TicketRows({ rows, t, num, day, onOpen }: { rows: readonly WaitingTicket[] | null; t: Translate; num: Num; day: (value: string) => string; onOpen: (code: string) => void }) {
  if (rows === null) {
    return (
      <p className="fw-floor-muted" aria-busy="true">
        {t('start.reading')}
      </p>
    )
  }
  return (
    <section className="fw-floor-stack" aria-labelledby="fw-fc-waiting">
      <h2 id="fw-fc-waiting" className="fw-floor-section-title">
        {t('start.waiting')}
      </h2>
      {rows.length === 0 ? (
        <TaskLine tone="info" icon={<Scissors />}>
          {t('start.none')}
        </TaskLine>
      ) : (
        <>
          <FloorList label={t('start.waiting')}>
            {rows.map((row) => {
              const material = [row.cutOrder.material.item.code, row.cutOrder.material.colour?.code].filter(Boolean).join(' · ')
              const meta = [row.cutOrder.number, row.lay ? t('start.lay', { seq: row.lay.seq }) : null, material, row.ratio, row.cutOrder.dueDate ? t('start.due', { day: day(row.cutOrder.dueDate) }) : null].filter(Boolean).join(' · ')
              return (
                <FloorListRow
                  key={row.id}
                  icon={<Scissors />}
                  tone={row.status === 'STARTED' ? 'info' : 'neutral'}
                  title={<span className="fw-floor-code">{row.number}</span>}
                  meta={meta}
                  status={t(`ticketStatus.${row.status}`)}
                  count={row.lay ? num(row.lay.plies) : undefined}
                  countLabel={row.lay ? t('fact.pliesCount', { count: row.lay.plies }) : undefined}
                  onPress={() => onOpen(row.code)}
                />
              )
            })}
          </FloorList>
          <ListFooter count={t('start.count', { count: rows.length })} keys={listKeys(t)} />
        </>
      )}
    </section>
  )
}

export const listKeys = (t: Translate) => [
  { key: 'Tab', does: t('keys.tab') },
  { key: 'Enter', does: t('keys.enter') },
  { key: 'Esc', does: t('keys.escape') },
]

/** The recut tickets waiting (sec:recut): bundle, part, size, shade lot or end bits; the new panels join the bundle. */
export function RecutRows({ rows, t, num, locale, onOpen }: { rows: readonly Recut[]; t: Translate; num: Num; locale: 'it' | 'en'; onOpen: (code: string) => void }) {
  if (rows.length === 0) {
    return (
      <TaskLine tone="success" icon={<Check />}>
        {t('recuts.none')}
      </TaskLine>
    )
  }
  return (
    <>
      <FloorList label={t('recuts.title')}>
        {rows.map((row) => (
          <FloorListRow
            key={row.id}
            icon={<Scissors />}
            tone={row.status === 'STARTED' ? 'info' : row.workOrder.rush ? 'danger' : 'warning'}
            title={
              <span>
                <span className="fw-floor-code">{row.bundle?.code ?? row.number}</span> · {row.part ?? t('recut.whole')}
              </span>
            }
            meta={[t('recut.size', { colour: row.cell.colourwayCode, size: row.cell.size }), row.from[locale], row.workOrder.number, row.workOrder.rush ? t('recut.rush') : null].filter(Boolean).join(' · ')}
            status={t(`ticketStatus.${row.status}`)}
            count={num(row.quantity)}
            countLabel={t('recut.sets', { count: row.quantity })}
            onPress={() => onOpen(row.code)}
          />
        ))}
      </FloorList>
      <ListFooter count={t('recuts.count', { count: rows.length })} keys={listKeys(t)} />
    </>
  )
}

const TROLLEY_TONE: Readonly<Record<Trolley['status'], FloorTone>> = { LOADING: 'neutral', SENT: 'info', RECEIVED: 'success', CANCELLED: 'danger' }

/** The site's open trolleys (sec:issue): those coming to this tablet's line first. */
export function TrolleyRows({ open, t, num, onOpen }: { open: OpenTrolleys; t: Translate; num: Num; onOpen: (code: string) => void }) {
  if (open.rows.length === 0) {
    return (
      <TaskLine tone="info" icon={<Truck />}>
        {t('trolleys.none')}
      </TaskLine>
    )
  }
  return (
    <>
      <FloorList label={t('trolleys.title')}>
        {open.rows.map((row) => {
          const mine = open.here !== null && row.line.id === open.here.id && row.status === 'SENT'
          return (
            <FloorListRow
              key={row.id}
              icon={<Truck />}
              tone={mine ? 'warning' : TROLLEY_TONE[row.status]}
              title={<span className="fw-floor-code">{row.trolleyCode}</span>}
              meta={[t('trolley.toLine', { line: row.line.code }), mine ? t('trolleys.mine') : null].filter(Boolean).join(' · ')}
              status={t(`trolleyStatus.${row.status}`)}
              count={num(row.counts.bundles)}
              countLabel={t('trolley.bundles', { count: row.counts.bundles })}
              onPress={() => onOpen(row.trolleyCode)}
            />
          )
        })}
      </FloorList>
      <ListFooter count={t('trolleys.count', { count: open.rows.length })} keys={listKeys(t)} />
    </>
  )
}

/** A trolley's bundles: on a loading trolley a row is picked (Take off); at the line a tap names it missing or found. */
export function TrolleyBundles({ trolley, t, num, picked, missing, onRow }: { trolley: Trolley; t: Translate; num: Num; picked: string | null; missing: readonly string[] | null; onRow: (code: string) => void }) {
  if (trolley.bundles.length === 0) {
    return (
      <TaskLine tone="info" icon={<Layers />}>
        {t('trolley.empty')}
      </TaskLine>
    )
  }
  return (
    <FloorList label={t('trolley.list')}>
      {trolley.bundles.map((entry) => {
        const isMissing = missing?.includes(entry.bundle.code) ?? false
        const received = entry.receivedAt !== null
        return (
          <FloorListRow
            key={entry.id}
            icon={<Layers />}
            tone={isMissing ? 'danger' : received ? 'success' : 'neutral'}
            title={<span className="fw-floor-code">{entry.bundle.code}</span>}
            meta={[entry.workOrder.number, `${entry.cell.colourwayCode} ${entry.cell.size}`, entry.bundle.part].filter(Boolean).join(' · ')}
            status={missing ? (isMissing ? t('trolley.missing') : t('trolley.here')) : received ? t('trolley.received') : undefined}
            count={num(entry.bundle.quantity)}
            countLabel={t('trolley.pieces', { count: entry.bundle.quantity })}
            selected={picked === entry.bundle.code}
            onPress={trolley.status === 'LOADING' || missing ? () => onRow(entry.bundle.code) : undefined}
          />
        )
      })}
    </FloorList>
  )
}

/** A print job's state for LabelPreview, in the screen's words (the API's error line is the office's, kept as detail). */
export function printState(job: PrintJob | null, t: Translate): LabelPrintState | undefined {
  if (!job) return undefined
  const status = printStatusOf(job)
  return { status, label: t(`print.${status}`), detail: status === 'failed' ? t('print.failedHint') : undefined }
}

/** A label drawn as the printer prints it, with its print state. */
export function Label({ layout, job, t, codeLabel }: { layout: Parameters<typeof LabelPreview>[0]['layout']; job: PrintJob | null; t: Translate; codeLabel?: (value: string) => string }) {
  return (
    <div className="fw-fc-label">
      <LabelPreview layout={layout} scale={4} print={printState(job, t)} codeLabel={codeLabel ? (value) => codeLabel(value) : undefined} invalidCodeLabel={(value) => t('print.invalid', { code: value })} />
    </div>
  )
}
