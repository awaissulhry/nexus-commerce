'use client'

import type { ReactNode } from 'react'
import { ArrowLeft, CircleAlert, CircleCheckBig, CloudOff, House, Layers, Lock, Minus, Play, Printer, RotateCcw, Ruler, ScanLine, Scissors, Send, Sticker, Truck, Undo2, Workflow } from 'lucide-react'
import { FloorActionBar, FloorButton, FloorTile, FloorTileGrid, QuantityPad, ScanInput, type CameraScanner, type FloorAction, type FloorActions } from '@nexus/ui/floor'
import { FloorCard } from '@nexus/ui/floor/FloorCard/index'
import { FloorElapsed } from '@nexus/ui/floor/FloorElapsed/index'
import { useDsWords } from '../../../../lib/i18n/ds-parts'
import { formatDate, formatNumber, formatTime } from '../../../../lib/i18n/format'
import type { Translate } from '../../../../lib/i18n/messages'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { FloorFrameView, type FrameAction, type FrameModel } from '../../../frame/view/FloorFrameView'
import { FloorState } from '../../../frame/view/FloorState'
import type { TaskProblem } from '../../shared/task-api'
import { ProblemState, TaskLine } from '../../shared/view/TaskParts'
import type { BundleProcesses, LayView, OpenTrolleys, PlyRun, PrintJob, RecutCard, RecutPrinted, RecutsWaiting, TicketCard, Trolley, WaitingTicket } from '../api'
import { countProblem, fabricBody, fabricDifference, isKnownRefusal, isKnownWarning, recutLayout, rollHeld, sendHeld, stepOf, stickerLayout, type RollDraft } from '../model'
import { DoneStrip, Label, LayHead, RecutRows, RollRows, SpreadSums, TicketFacts, TicketRows, TrolleyBundles, TrolleyRows, type DoneLine, type Num } from './parts'
import '../fabriccut.css'

/**
 * SCR-182 — Floor › Fabric cutting (design floor.fabriccut; MES-038 lay report, MES-039 ply count, MES-041 cut ticket, MES-043 ply
 * stickers, MES-044 recut tickets, MES-046 fabric used, MES-047 secondary processes, MES-048 issue to sewing; B-W2b-121 on the API of
 * B-W2b-112, -116 and -117). Tablet first, one job per screen, centred. Never a person, never money.
 *
 *   Cut ticket      scan the ticket (or a row of the tickets to cut) → its card: the ratio as size chips, the plies big, marker, parts,
 *                   due → Start cutting (the start scan as a tap; online only)
 *   Spread          scan each roll → plies (default: what the lay still needs), splices, end loss, the roll end back → Add roll (one
 *                   tap after the scan); the running sums; Undo last roll. Online first: kept on the tablet without the network
 *   Check           both ends counted, each starting at the plies spread → Both ends match; a difference is a hard stop
 *   Cut             the time since the start; scan the ticket again when the cut is done (or Cut done; online only)
 *   Ply stickers    a run of the next plies printed on the station's label printer, shown as the printer prints it (online only)
 *   Fabric used     the estimate, the lay report's figure, the pad to confirm or correct; the difference in words (online only)
 *   Recut tickets   the site's recuts waiting → one: Start, Done (one tap each), Print its ticket (online only)
 *   Send to sewing  scan the trolley label → scan bundles onto it → Send N bundles to line X; at the line the same label → Received
 *                   (bundles named missing); a bundle that waits for a secondary process gets its one tap here. Online first
 * The view fetches nothing: the container (FabricCut.tsx) reads and maps.
 */

export type Wrong = { readonly why: 'notTicket' | 'notRoll' | 'notBundle' | 'notTrolley' | 'notFound' | 'notOnTablet' | 'otherFactory' | 'typo' | 'otherTicket'; readonly code: string }

export type RollField = 'plies' | 'splices' | 'endLoss' | 'endReturned'

export type FabricStep =
  | { readonly kind: 'noPermission' }
  | { readonly kind: 'start'; readonly tickets: readonly WaitingTicket[] | null; readonly asOf: string | null; readonly recuts: number | null; readonly wrong?: Wrong | null }
  | { readonly kind: 'loading'; readonly code: string }
  | { readonly kind: 'ticket'; readonly card: TicketCard; readonly asOf: string | null; readonly busy?: boolean }
  | { readonly kind: 'spread'; readonly card: TicketCard; readonly lay: LayView | null; readonly asOf: string | null; readonly draft: RollDraft | null; readonly field: RollField; readonly busy?: boolean; readonly warnings?: readonly string[]; readonly wrong?: Wrong | null }
  | { readonly kind: 'count'; readonly card: TicketCard; readonly lay: LayView; readonly left: number | null; readonly right: number | null; readonly differ: { readonly left: number; readonly right: number } | null; readonly busy?: boolean }
  | { readonly kind: 'cut'; readonly card: TicketCard; readonly busy?: boolean; readonly wrong?: Wrong | null }
  | { readonly kind: 'stickers'; readonly card: TicketCard; readonly run: PlyRun | null; readonly stickers: readonly (readonly [string, string, string])[] | null; readonly job: PrintJob | null; readonly notPrinted: boolean; readonly busy?: boolean }
  | { readonly kind: 'fabric'; readonly card: TicketCard; readonly lay: LayView | null; readonly value: number | null; readonly busy?: boolean; readonly saved?: boolean }
  | { readonly kind: 'recuts'; readonly list: RecutsWaiting | null; readonly asOf: string | null; readonly wrong?: Wrong | null }
  | { readonly kind: 'recut'; readonly card: RecutCard; readonly printed: RecutPrinted | null; readonly busy?: boolean }
  | { readonly kind: 'trolleys'; readonly open: OpenTrolleys | null; readonly asOf: string | null; readonly wrong?: Wrong | null }
  | {
      readonly kind: 'trolley'
      readonly code: string
      readonly trolley: Trolley | null
      readonly next: 'LOAD' | 'RECEIVE' | 'NONE'
      readonly asOf: string | null
      /** Bundles loaded on this tablet and not yet answered (offline). */
      readonly kept: readonly string[]
      /** The bundle picked on a loading trolley (Take off), or null. */
      readonly picked: string | null
      /** At the line: the bundles named missing. */
      readonly missing: readonly string[]
      /** A bundle that waits for a secondary process before sewing (its one tap). */
      readonly process: BundleProcesses | null
      readonly busy?: boolean
      readonly warnings?: readonly string[]
      readonly wrong?: Wrong | null
    }
  | { readonly kind: 'problem'; readonly problem: TaskProblem; readonly code: string | null }

export interface FabricCutViewModel {
  readonly frame: FrameModel
  readonly online: boolean
  readonly step: FabricStep
  readonly done?: DoneLine | null
  /** A write that did not go, under the step (a refusal, the network). */
  readonly notice?: TaskProblem | null
  /** What the person may do besides the table (production.trolleys, production.secondary). */
  readonly may: { readonly trolleys: boolean; readonly secondary: boolean }
  readonly timeZone?: string
}

export type FabricAction =
  | { type: 'scan'; code: string }
  | { type: 'back' }
  | { type: 'home' }
  | { type: 'retry' }
  | { type: 'openTicket'; code: string }
  | { type: 'openRecuts' }
  | { type: 'openTrolleys' }
  | { type: 'startTicket' }
  | { type: 'toStep' }
  | { type: 'rollField'; field: RollField }
  | { type: 'rollValue'; value: number | null }
  | { type: 'addRoll' }
  | { type: 'undoRoll' }
  | { type: 'toCount' }
  | { type: 'countLeft'; value: number | null }
  | { type: 'countRight'; value: number | null }
  | { type: 'countSave' }
  | { type: 'recount' }
  | { type: 'finish' }
  | { type: 'makeRun' }
  | { type: 'reprintRun' }
  | { type: 'toFabric' }
  | { type: 'fabricValue'; value: number | null }
  | { type: 'fabricSave' }
  | { type: 'openRecut'; code: string }
  | { type: 'recutMove' }
  | { type: 'recutPrint' }
  | { type: 'openTrolley'; code: string }
  | { type: 'pickBundle'; code: string }
  | { type: 'unload' }
  | { type: 'send' }
  | { type: 'receive' }
  | { type: 'processMove' }

export interface FabricCutViewProps {
  model: FabricCutViewModel
  onAction?: (action: FabricAction) => void
  onFrame?: (action: FrameAction) => void
  camera?: CameraScanner
}

const padWords = (t: Translate) => ({
  decrementLabel: t('pad.less'),
  incrementLabel: t('pad.more'),
  clearLabel: t('pad.clear'),
  backLabel: t('pad.back'),
  emptyLabel: t('pad.empty'),
  rangeLabel: (min: number | undefined, max: number | undefined) => t('pad.range', { min: min ?? 0, max: max ?? '' }),
})

export function FabricCutView({ model, onAction, onFrame, camera }: FabricCutViewProps) {
  const t = useT('floor-fabriccut')
  const shared = useT('floor-tasks')
  const locale = useLocale()
  const ds = useDsWords()
  const send = (action: FabricAction) => onAction?.(action)
  const { step, online } = model
  const time = (value: string) => formatTime(value, { locale, timeZone: model.timeZone })
  const day = (value: string) => formatDate(`${value}T12:00:00.000Z`, { locale, timeZone: model.timeZone })
  const num: Num = (value, decimals = 0) => formatNumber(value, locale, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
  const lang: 'it' | 'en' = locale === 'it' ? 'it' : 'en'
  const refusal = (code: string) => (isKnownRefusal(code) ? { message: t(`refusal.${code}.message`), fix: t(`refusal.${code}.fix`) } : null)

  const home: FloorAction = { label: shared('action.home'), icon: <House />, onPress: () => send({ type: 'home' }) }
  const back: FloorAction = { label: shared('action.back'), icon: <ArrowLeft />, onPress: () => send({ type: 'back' }), variant: 'secondary' }
  const needsNetwork = online ? null : t('held.online')

  const scanField = (label: string, hint: string, keepFocus = true) => (
    <ScanInput
      label={label}
      hint={hint}
      keepFocus={keepFocus}
      scannedLabel={(code) => t('scan.read', { code })}
      keyboardLabel={t('scan.type')}
      camera={camera ? { scanner: camera, startLabel: t('scan.camera.start'), stopLabel: t('scan.camera.stop'), errorLabel: t('scan.camera.error') } : undefined}
      onScan={(code) => send({ type: 'scan', code })}
    />
  )
  const wrongLine = (wrong: Wrong | null | undefined) =>
    wrong ? (
      <TaskLine tone="danger" icon={<CircleAlert />} alert>
        {t(`wrong.${wrong.why}`, { code: wrong.code })}
      </TaskLine>
    ) : null
  const notice = <Notice notice={model.notice ?? null} refusal={refusal} t={t} shared={shared} />
  const asOfLine = (asOf: string | null) =>
    asOf ? (
      <TaskLine tone="info" icon={<CloudOff />}>
        {shared('asOf', { time: time(asOf) })}
      </TaskLine>
    ) : null

  let actions: FloorActions | null = null
  let body: ReactNode = null

  switch (step.kind) {
    case 'noPermission':
      actions = [home]
      body = <FloorState tone="warning" icon={<Lock />} title={t('noPermission.title')} text={t('noPermission.body')} alert />
      break

    case 'problem':
      actions = [back, { label: shared('action.retry'), icon: <RotateCcw />, onPress: () => send({ type: 'retry' }) }]
      body = <ProblemState problem={step.problem} code={step.code} words={refusal} />
      break

    case 'loading':
      actions = [back]
      body = (
        <p className="fw-floor-muted" aria-busy="true">
          {t('loading', { code: step.code })}
        </p>
      )
      break

    case 'start': {
      actions = [home]
      const recuts = step.recuts
      body = (
        <>
          {scanField(t('start.scan'), t('start.scanHint'))}
          {wrongLine(step.wrong)}
          <FloorTileGrid label={t('start.more')}>
            <FloorTile icon={<Scissors />} label={t('start.recuts')} hint={t('start.recutsHint')} count={recuts && recuts > 0 ? recuts : undefined} countLabel={recuts ? t('start.recutsCount', { count: recuts }) : undefined} tone={recuts ? 'warning' : 'neutral'} onPress={() => send({ type: 'openRecuts' })} />
            <FloorTile icon={<Truck />} label={t('start.sewing')} hint={t('start.sewingHint')} heldReason={model.may.trolleys ? null : t('held.trolleys')} onPress={() => send({ type: 'openTrolleys' })} />
          </FloorTileGrid>
          {asOfLine(step.asOf)}
          <TicketRows rows={step.tickets} t={t} num={num} day={day} onOpen={(code) => send({ type: 'openTicket', code })} />
        </>
      )
      break
    }

    case 'ticket': {
      const { card } = step
      const at = stepOf(card.ticket.status, card.lay?.status ?? null)
      const main: FloorAction | null =
        card.cutOrder.kind !== 'FABRIC'
          ? null
          : at === 'start'
            ? { label: t('ticket.start'), icon: <Play />, onPress: () => send({ type: 'startTicket' }), heldReason: needsNetwork ?? (step.busy ? t('busy') : card.next.refusal && card.next.next === 'NONE' ? t('ticket.notNow') : null), id: 'start' }
            : at === null
              ? null
              : { label: t(`ticket.go.${at}`), icon: <Workflow />, onPress: () => send({ type: 'toStep' }), id: 'go' }
      actions = main ? [back, main] : [back]
      body = (
        <>
          <TicketFacts card={card} asOf={step.asOf} t={t} num={num} day={day} time={time} locale={lang} />
          {card.cutOrder.kind !== 'FABRIC' ? (
            <TaskLine tone="warning" icon={<CircleAlert />}>
              {t('ticket.leather')}
            </TaskLine>
          ) : card.next.refusal ? (
            <TaskLine tone="warning" icon={<CircleAlert />}>
              {refusal(card.next.refusal.code)?.message ?? t('ticket.notNow')}
            </TaskLine>
          ) : null}
          {notice}
        </>
      )
      break
    }

    case 'spread': {
      const { card, lay, draft } = step
      if (!lay) {
        actions = [back]
        body = (
          <>
            <LayHead card={card} step="spread" t={t} />
            <p className="fw-floor-muted" aria-busy="true">
              {t('spread.reading')}
            </p>
          </>
        )
        break
      }
      if (draft) {
        const held = rollHeld(draft, lay.spread.needed)
        const field = step.field
        const value = field === 'plies' ? draft.plies : field === 'splices' ? draft.splices : field === 'endLoss' ? draft.endLoss : draft.endReturned
        actions = [
          { label: t('roll.cancel'), icon: <ArrowLeft />, onPress: () => send({ type: 'back' }), variant: 'secondary' },
          { label: t('roll.add'), icon: <Layers />, onPress: () => send({ type: 'addRoll' }), heldReason: step.busy ? t('busy') : held ? t(`roll.held.${held}`) : null, id: 'add' },
        ]
        // The roll's own step takes the screen (the head and the steps come back with Back): the pad stays in view on a tablet.
        body = (
          <>
            <div className="fw-task-split">
              <div className="fw-floor-stack">
                <p className="fw-fc-subject">
                  <span className="fw-floor-inline-icon" aria-hidden="true">
                    <Layers />
                  </span>
                  <span className="fw-floor-card-code">{draft.code}</span>
                </p>
                <p className="fw-floor-muted fw-fc-subject-meta">{t('roll.subject', { ticket: card.ticket.number, seq: lay.lay.seq, of: lay.lay.of })}</p>
                <div className="fw-fc-fields" role="group" aria-label={t('roll.fields')}>
                  {(['plies', 'splices', 'endLoss', 'endReturned'] as const).map((key) => {
                    const shown = key === 'plies' ? (draft.plies === null ? t('roll.asNeeded') : num(draft.plies)) : key === 'splices' ? num(draft.splices) : key === 'endLoss' ? (draft.endLoss === null ? '–' : `${num(draft.endLoss, 2)} ${t('unit.m')}`) : draft.endReturned === null ? t('roll.notMeasured') : `${num(draft.endReturned, 2)} ${t('unit.m')}`
                    return (
                      <FloorButton key={key} size="lg" block className="fw-fc-field-btn" variant={field === key ? 'primary' : 'secondary'} aria-pressed={field === key} onClick={() => send({ type: 'rollField', field: key })}>
                        <span className="fw-fc-field">
                          <span className="fw-fc-field-label">{t(`roll.field.${key}`)}</span>
                          <span className="fw-fc-field-value">{shown}</span>
                        </span>
                      </FloorButton>
                    )
                  })}
                </div>
                {notice}
                {/* The pad keeps the focus; a scanner's burst is read anywhere: this roll again = Add, another roll opens it. */}
                {scanField(t('roll.scan'), t('roll.scanHint'), false)}
              </div>
              <QuantityPad
                key={field}
                label={t(`roll.field.${field}`)}
                value={value}
                onChange={(next) => send({ type: 'rollValue', value: next })}
                min={field === 'plies' ? 1 : 0}
                max={field === 'plies' ? Math.max(1, lay.lay.plies) : field === 'splices' ? 99 : 999}
                decimals={field === 'endLoss' || field === 'endReturned' ? 2 : 0}
                step={field === 'endLoss' ? 0.05 : 1}
                unit={field === 'endLoss' || field === 'endReturned' ? t('unit.m') : field === 'plies' ? t('unit.plies') : undefined}
                expected={field === 'plies' && lay.spread.needed > 0 ? lay.spread.needed : undefined}
                expectedLabel={(expected) => t('roll.needed', { count: expected })}
                quickValues={field === 'endLoss' ? [0.1, 0.2, 0.3].map((metres) => ({ value: metres, label: num(metres, 1) })) : field === 'splices' ? [0, 1, 2] : undefined}
                decimalSeparator={locale === 'it' ? ',' : '.'}
                autoFocus
                {...padWords(t)}
              />
            </div>
          </>
        )
        break
      }
      // Counting queues offline; a lay not started yet waits for its first roll (the API starts it with the roll).
      const countHeld = lay.spread.plies === 0 ? t('spread.held.nothing') : lay.lay.status === 'PLANNED' ? t('spread.held.planned') : !lay.can.count && lay.refusal ? (refusal(lay.refusal.code)?.message ?? t('ticket.notNow')) : null
      actions = [
        back,
        { label: t('spread.undo'), icon: <Undo2 />, onPress: () => send({ type: 'undoRoll' }), variant: 'secondary', heldReason: lay.rolls.length === 0 ? t('spread.held.noRoll') : step.busy ? t('busy') : null, id: 'undo' },
        { label: t('spread.count'), icon: <Ruler />, onPress: () => send({ type: 'toCount' }), heldReason: countHeld, id: 'count' },
      ]
      body = (
        <>
          <LayHead card={card} step="spread" t={t} />
          <SpreadSums lay={lay} t={t} num={num} />
          {scanField(t('spread.scan'), lay.spread.needed > 0 ? t('spread.scanHint', { count: lay.spread.needed }) : t('spread.full'))}
          {wrongLine(step.wrong)}
          {lay.refusal && lay.refusal.code !== 'TICKET_NOT_STARTED' ? (
            <TaskLine tone="warning" icon={<CircleAlert />}>
              {refusal(lay.refusal.code)?.message ?? t('ticket.notNow')}
            </TaskLine>
          ) : null}
          {(step.warnings ?? []).map((code) => (
            <TaskLine key={code} tone="warning" icon={<CircleAlert />}>
              {isKnownWarning(code) ? t(`warning.${code}`) : t('warning.other')}
            </TaskLine>
          ))}
          {asOfLine(step.asOf)}
          <RollRows lay={lay} t={t} num={num} />
          {notice}
        </>
      )
      break
    }

    case 'count': {
      const { card, lay } = step
      const spread = lay.spread.plies
      if (step.differ) {
        actions = [back, { label: t('count.recount'), icon: <RotateCcw />, onPress: () => send({ type: 'recount' }), id: 'recount' }]
        body = (
          <>
            <LayHead card={card} step="check" t={t} />
            <FloorState tone="danger" icon={<CircleAlert />} title={t('count.differ', { left: num(step.differ.left), right: num(step.differ.right) })} text={t('count.differFix')} alert />
          </>
        )
        break
      }
      const problem = countProblem({ left: step.left, right: step.right }, spread)
      actions = [back, { label: t('count.match'), icon: <CircleCheckBig />, onPress: () => send({ type: 'countSave' }), heldReason: step.busy ? t('busy') : problem === 'nothing' ? t('spread.held.nothing') : problem === 'empty' ? t('count.held.empty') : null, id: 'match' }]
      body = (
        <>
          <LayHead card={card} step="check" t={t} />
          <p className="fw-floor-lead">{t('count.lead', { count: spread })}</p>
          <div className="fw-fc-ends">
            <QuantityPad label={t('count.left')} value={step.left} onChange={(value) => send({ type: 'countLeft', value })} min={1} max={9999} expected={spread} expectedLabel={(expected) => t('count.expected', { count: expected })} quickValues={[spread]} showPad={false} {...padWords(t)} />
            <QuantityPad label={t('count.right')} value={step.right} onChange={(value) => send({ type: 'countRight', value })} min={1} max={9999} expected={spread} expectedLabel={(expected) => t('count.expected', { count: expected })} quickValues={[spread]} showPad={false} {...padWords(t)} />
          </div>
          <TaskLine tone="info" icon={<Ruler />}>
            {t('count.hardStop')}
          </TaskLine>
          {notice}
        </>
      )
      break
    }

    case 'cut': {
      const { card } = step
      actions = [back, { label: t('cut.done'), icon: <Scissors />, onPress: () => send({ type: 'finish' }), heldReason: needsNetwork ?? (step.busy ? t('busy') : null), id: 'finish' }]
      body = (
        <>
          <LayHead card={card} step="cut" t={t} />
          {card.ticket.startedAt ? <FloorElapsed label={t('cut.elapsed')} since={card.ticket.startedAt} labels={ds.floorElapsed} /> : null}
          {scanField(t('cut.scan'), t('cut.scanHint', { code: card.ticket.number }))}
          {wrongLine(step.wrong)}
          {!online ? (
            <TaskLine tone="warning" icon={<CloudOff />}>
              {t('held.online')}
            </TaskLine>
          ) : null}
          {notice}
        </>
      )
      break
    }

    case 'stickers': {
      const { card, run } = step
      // No parts on the pattern: the API would refuse (NO_PARTS); the cutting office names them, said before the press.
      const noParts = !run && card.parts.length === 0
      const printing = step.busy ? t('busy') : (needsNetwork ?? (noParts ? t('stickers.held.noParts') : null))
      actions = run
        ? [{ label: t('stickers.again'), icon: <Printer />, onPress: () => send({ type: 'reprintRun' }), variant: 'secondary', heldReason: printing, id: 'again' }, { label: t('stickers.next'), icon: <Ruler />, onPress: () => send({ type: 'toFabric' }), id: 'next' }]
        : [{ label: t('stickers.skip'), icon: <Ruler />, onPress: () => send({ type: 'toFabric' }), variant: 'secondary', id: 'skip' }, { label: t('stickers.print'), icon: <Printer />, onPress: () => send({ type: 'makeRun' }), heldReason: printing, id: 'print' }]
      const first = step.stickers?.[0] ?? null
      body = (
        <>
          <LayHead card={card} step="stickers" t={t} />
          <p className="fw-floor-lead">{t('stickers.lead')}</p>
          {run ? (
            <>
              <p className="fw-fc-subject">
                <span className="fw-floor-inline-icon" aria-hidden="true">
                  <Sticker />
                </span>
                {t('stickers.run', { first: run.firstPly, last: run.lastPly, count: run.labelCount, parts: run.parts.join(', ') })}
              </p>
              {first ? <Label layout={stickerLayout(first, t('stickers.labelName'))} job={step.job} t={t} /> : null}
              {step.stickers && step.stickers.length > 1 ? (
                <div className="fw-fc-sticker-strip" aria-label={t('stickers.more')}>
                  {step.stickers.slice(1, 4).map((lines, index) => (
                    <Label key={`${index}:${lines.join('|')}`} layout={stickerLayout(lines, t('stickers.labelName'))} job={null} t={t} />
                  ))}
                </div>
              ) : null}
              {step.notPrinted ? (
                <TaskLine tone="warning" icon={<Printer />}>
                  {t('stickers.noPrinter')}
                </TaskLine>
              ) : null}
            </>
          ) : noParts ? (
            <TaskLine tone="warning" icon={<Sticker />}>
              {t('stickers.held.noParts')}
            </TaskLine>
          ) : (
            <TaskLine tone="info" icon={<Sticker />}>
              {t('stickers.parts', { parts: card.parts.join(', ') })}
            </TaskLine>
          )}
          {notice}
        </>
      )
      break
    }

    case 'fabric': {
      const { card, lay } = step
      const used = lay?.fabricUsed ?? null
      if (step.saved && used) {
        actions = [home, { label: t('fabric.nextTicket'), icon: <ScanLine />, onPress: () => send({ type: 'back' }), id: 'next' }]
        body = (
          <>
            <LayHead card={card} step="fabric" t={t} />
            <FloorState tone="success" icon={<CircleCheckBig />} title={t('fabric.saved', { metres: num(Number(used.confirmed ?? used.recorded), 2) })} text={t('fabric.savedText')} alert />
          </>
        )
        break
      }
      if (!lay || !used) {
        actions = [back]
        body = (
          <>
            <LayHead card={card} step="fabric" t={t} />
            {lay ? (
              <TaskLine tone="warning" icon={<CircleAlert />}>
                {t('fabric.notCut')}
              </TaskLine>
            ) : (
              <p className="fw-floor-muted" aria-busy="true">
                {t('spread.reading')}
              </p>
            )}
          </>
        )
        break
      }
      const value = step.value
      const diff = value === null ? null : fabricDifference(value, used.estimated)
      const body2 = value === null ? null : fabricBody(value, used)
      actions = [
        back,
        {
          label: used.posted ? t('fabric.correct') : t('fabric.confirm'),
          icon: <CircleCheckBig />,
          onPress: () => send({ type: 'fabricSave' }),
          heldReason: needsNetwork ?? (step.busy ? t('busy') : value === null ? t('count.held.empty') : body2 === null ? t('fabric.held.same') : !lay.can.fabricUsed ? t('fabric.held.closed') : null),
          id: 'confirm',
        },
      ]
      body = (
        <>
          <LayHead card={card} step="fabric" t={t} />
          <div className="fw-task-split">
            <div className="fw-floor-stack">
              <dl className="fw-fc-sums fw-fc-sums-col" aria-label={t('fabric.figures')}>
                <div className="fw-fc-sum">
                  <dt>{t('fabric.estimate')}</dt>
                  <dd>
                    <span className="fw-fc-sum-big">{num(Number(used.estimated), 2)}</span>
                    <span className="fw-fc-sum-of">{t('unit.m')}</span>
                  </dd>
                </div>
                <div className="fw-fc-sum">
                  <dt>{t('fabric.recorded')}</dt>
                  <dd>
                    <span className="fw-fc-sum-big">{num(Number(used.recorded), 2)}</span>
                    <span className="fw-fc-sum-of">{t('unit.m')}</span>
                  </dd>
                </div>
                {used.confirmed !== null ? (
                  <div className="fw-fc-sum" data-tone="success">
                    <dt>{t('fabric.confirmed')}</dt>
                    <dd>
                      <span className="fw-fc-sum-big">{num(Number(used.confirmed), 2)}</span>
                      <span className="fw-fc-sum-of">{t('unit.m')}</span>
                    </dd>
                  </div>
                ) : null}
              </dl>
              {diff ? (
                <TaskLine tone={diff.kind === 'same' ? 'success' : 'warning'} icon={<Ruler />}>
                  {t(`fabric.diff.${diff.kind}`, { metres: num(diff.metres, 2), percent: diff.percent })}
                </TaskLine>
              ) : null}
            </div>
            <QuantityPad label={t('fabric.used')} value={value} onChange={(next) => send({ type: 'fabricValue', value: next })} min={0} max={9999} decimals={2} step={0.1} unit={t('unit.m')} decimalSeparator={locale === 'it' ? ',' : '.'} {...padWords(t)} />
          </div>
          {!online ? (
            <TaskLine tone="warning" icon={<CloudOff />}>
              {t('held.online')}
            </TaskLine>
          ) : null}
          {notice}
        </>
      )
      break
    }

    case 'recuts': {
      actions = [back]
      body = (
        <>
          <h2 className="fw-floor-section-title">{t('recuts.title')}</h2>
          {scanField(t('recuts.scan'), t('recuts.scanHint'))}
          {wrongLine(step.wrong)}
          {asOfLine(step.asOf)}
          {step.list === null ? (
            <p className="fw-floor-muted" aria-busy="true">
              {t('recuts.reading')}
            </p>
          ) : (
            <RecutRows rows={step.list.rows} t={t} num={num} locale={lang} onOpen={(code) => send({ type: 'openRecut', code })} />
          )}
        </>
      )
      break
    }

    case 'recut': {
      const { card } = step
      const ticket = card.ticket
      const next = card.next
      const main: FloorAction =
        next.next === 'START'
          ? { label: t('recut.start'), icon: <Play />, onPress: () => send({ type: 'recutMove' }), heldReason: needsNetwork ?? (step.busy ? t('busy') : null), id: 'move' }
          : next.next === 'FINISH'
            ? { label: t('recut.finish'), icon: <CircleCheckBig />, onPress: () => send({ type: 'recutMove' }), heldReason: needsNetwork ?? (step.busy ? t('busy') : null), id: 'move' }
            : { label: t('recut.start'), icon: <Play />, onPress: () => send({ type: 'recutMove' }), heldReason: next.refusal ? (refusal(next.refusal.code)?.message ?? t('ticket.notNow')) : t('ticket.notNow'), id: 'move' }
      actions = [back, { label: t('recut.print'), icon: <Printer />, onPress: () => send({ type: 'recutPrint' }), variant: 'secondary', heldReason: needsNetwork ?? (step.busy ? t('busy') : null), id: 'print' }, main]
      body = (
        <>
          <FloorCard
            icon={<Scissors />}
            kind={t('recut.type')}
            code={ticket.number}
            id="fw-fc-recut"
            title={<span>{t('recut.joins', { bundle: ticket.bundle?.code ?? '–' })}</span>}
            status={{ label: t(`ticketStatus.${ticket.status}`), tone: ticket.status === 'STARTED' ? 'info' : 'warning' }}
            facts={[
              { id: 'part', label: t('recut.part'), value: ticket.part ?? t('recut.whole') },
              { id: 'sets', label: t('recut.setsLabel'), value: num(ticket.quantity) },
              { id: 'size', label: t('recut.sizeLabel'), value: `${ticket.cell.colourwayCode} ${ticket.cell.size}` },
              { id: 'from', label: t('recut.from'), value: ticket.from[lang] },
              { id: 'style', label: t('recut.style'), value: `${ticket.workOrder.style.code} · ${ticket.workOrder.style.name}` },
              { id: 'wo', label: t('fact.workOrders'), value: ticket.workOrder.number },
              { id: 'due', label: t('fact.due'), value: ticket.workOrder.dueDate ? day(ticket.workOrder.dueDate) : null },
            ]}
            flags={ticket.workOrder.rush ? [{ id: 'rush', label: t('recut.rush'), tone: 'danger' }] : []}
            labels={ds.floorCard}
          />
          <TaskLine tone="info" icon={<Layers />}>
            {ticket.endBits && ticket.lot ? t('recut.cutFromBoth', { lot: ticket.lot.code }) : ticket.lot ? t('recut.cutFrom', { lot: ticket.lot.code }) : t('recut.cutFromEnds')}
          </TaskLine>
          {step.printed ? <Label layout={recutLayout(step.printed.label, ticket.code)} job={step.printed.job} t={t} codeLabel={(value) => t('print.code', { code: value })} /> : null}
          {step.printed && !step.printed.job ? (
            <TaskLine tone="warning" icon={<Printer />}>
              {t('recut.noPrinter')}
            </TaskLine>
          ) : null}
          {notice}
        </>
      )
      break
    }

    case 'trolleys': {
      actions = [back]
      body = (
        <>
          <h2 className="fw-floor-section-title">{t('trolleys.title')}</h2>
          {scanField(t('trolleys.scan'), t('trolleys.scanHint'))}
          {wrongLine(step.wrong)}
          {step.open?.here ? (
            <TaskLine tone="info" icon={<Truck />}>
              {t('trolleys.here', { line: step.open.here.code })}
            </TaskLine>
          ) : null}
          {asOfLine(step.asOf)}
          {step.open === null ? (
            <p className="fw-floor-muted" aria-busy="true">
              {t('trolleys.reading')}
            </p>
          ) : (
            <TrolleyRows open={step.open} t={t} num={num} onOpen={(code) => send({ type: 'openTrolley', code })} />
          )}
        </>
      )
      break
    }

    case 'trolley': {
      const { trolley } = step
      const status = trolley?.status ?? (step.next === 'LOAD' ? 'LOADING' : null)
      const lineCode = trolley?.line.code ?? null
      const head = (
        <header className="fw-fc-head" aria-labelledby="fw-fc-trolley">
          <p className="fw-fc-head-line">
            <span className="fw-fc-head-type">{t('trolley.type')}</span>
            <span id="fw-fc-trolley" className="fw-floor-card-code">
              {step.code}
            </span>
            {status ? <span className="fw-floor-pill" data-tone={status === 'SENT' ? 'info' : status === 'RECEIVED' ? 'success' : 'neutral'}>{t(`trolleyStatus.${status}`)}</span> : null}
            {lineCode ? <span className="fw-floor-muted">{t('trolley.toLine', { line: lineCode })}</span> : null}
          </p>
        </header>
      )
      if (step.next === 'NONE' && trolley) {
        actions = [back]
        body = (
          <>
            {head}
            <FloorState tone={trolley.status === 'RECEIVED' ? 'success' : 'warning'} icon={trolley.status === 'RECEIVED' ? <CircleCheckBig /> : <CircleAlert />} title={t(`trolley.none.${trolley.status}`, { line: trolley.line.code, time: trolley.receivedAt ? time(trolley.receivedAt) : '' })} text={trolley.counts.missing > 0 ? t('trolley.missingCount', { count: trolley.counts.missing }) : undefined} />
          </>
        )
        break
      }
      if (step.next === 'RECEIVE' && trolley) {
        const missing = step.missing.length
        actions = [back, { label: missing > 0 ? t('trolley.receiveMissing', { count: missing }) : t('trolley.receive'), icon: <CircleCheckBig />, onPress: () => send({ type: 'receive' }), heldReason: step.busy ? t('busy') : null, id: 'receive' }]
        body = (
          <>
            {head}
            <p className="fw-floor-lead">{t('trolley.receiveLead', { count: trolley.counts.bundles })}</p>
            <TrolleyBundles trolley={trolley} t={t} num={num} picked={null} missing={step.missing} onRow={(code) => send({ type: 'pickBundle', code })} />
            {notice}
          </>
        )
        break
      }
      const loaded = (trolley?.counts.bundles ?? 0) + step.kept.length
      const held = sendHeld(trolley, step.kept.length)
      const process = step.process
      const sendIt: FloorAction = { label: lineCode ? t('trolley.send', { count: loaded, line: lineCode }) : t('trolley.sendNoLine', { count: loaded }), icon: <Send />, onPress: () => send({ type: 'send' }), heldReason: step.busy ? t('busy') : held ? t('trolley.held.empty') : null, id: 'send' }
      actions = step.picked ? [back, { label: t('trolley.unload'), icon: <Minus />, onPress: () => send({ type: 'unload' }), variant: 'secondary', heldReason: step.busy ? t('busy') : null, id: 'unload' }, sendIt] : [back, sendIt]
      body = (
        <>
          {head}
          {scanField(t('trolley.scan'), t('trolley.scanHint'))}
          {wrongLine(step.wrong)}
          {(step.warnings ?? []).map((code) => (
            <TaskLine key={code} tone="warning" icon={<CircleAlert />}>
              {isKnownWarning(code) ? t(`warning.${code}`) : t('warning.other')}
            </TaskLine>
          ))}
          {process && process.next ? (
            <section className="fw-fc-process" aria-labelledby="fw-fc-process">
              <h2 id="fw-fc-process" className="fw-floor-section-title">
                {t('process.title', { bundle: process.bundle.code })}
              </h2>
              <p className="fw-floor-muted">{process.toSewing ? process.toSewing[lang] : t('process.waits')}</p>
              <FloorButton size="lg" block icon={<Workflow />} heldReason={needsNetwork ?? (!model.may.secondary ? t('held.secondary') : step.busy ? t('busy') : null)} onClick={() => send({ type: 'processMove' })}>
                {process.next.words[lang]}
              </FloorButton>
            </section>
          ) : process ? (
            <TaskLine tone="warning" icon={<Workflow />}>
              {process.toSewing ? process.toSewing[lang] : t('process.elsewhere')}
            </TaskLine>
          ) : null}
          {step.kept.length > 0 ? (
            <TaskLine tone="warning" icon={<CloudOff />}>
              {t('trolley.kept', { count: step.kept.length, codes: step.kept.join(', ') })}
            </TaskLine>
          ) : null}
          {asOfLine(step.asOf)}
          {trolley ? <TrolleyBundles trolley={trolley} t={t} num={num} picked={step.picked} missing={null} onRow={(code) => send({ type: 'pickBundle', code })} /> : step.kept.length === 0 ? (
            <TaskLine tone="info" icon={<Truck />}>
              {t('trolley.new')}
            </TaskLine>
          ) : null}
          {notice}
        </>
      )
      break
    }
  }

  return (
    <FloorFrameView frame={model.frame} onFrame={onFrame} actions={actions ? <FloorActionBar label={t('title')} actions={actions} /> : null}>
      <div className="fw-floor-stack fw-fc" id="fw-fc-flash">
        <DoneStrip done={model.done ?? null} t={t} />
        {body}
      </div>
    </FloorFrameView>
  )
}

/** A write that did not go: a refusal in the screen's words, the network, or another problem, under the step. */
function Notice({ notice, refusal, t, shared }: { notice: TaskProblem | null; refusal: (code: string) => { message: string; fix: string | null } | null; t: Translate; shared: Translate }) {
  if (!notice) return null
  if (notice.kind === 'refused') {
    const words = refusal(notice.code)
    return (
      <TaskLine tone="danger" icon={<CircleAlert />} alert>
        {words ? `${words.message} ${words.fix ?? ''}`.trim() : t('notice.refused')}
      </TaskLine>
    )
  }
  const kind = notice.kind === 'stepUp' ? 'forbidden' : notice.kind
  return (
    <TaskLine tone={kind === 'offline' || kind === 'unavailable' ? 'warning' : 'danger'} icon={kind === 'offline' ? <CloudOff /> : <CircleAlert />} alert>
      {shared(`problem.${kind}.title`)}. {shared(`problem.${kind}.body`)}
    </TaskLine>
  )
}
