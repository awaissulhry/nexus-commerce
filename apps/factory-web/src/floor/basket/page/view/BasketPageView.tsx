'use client'

import { Calendar, CircleAlert, CloudOff, FileImage, Image as ImageIcon, Layers, Lock, Package, Palette, RotateCcw, Ruler, Shirt, Tag, TriangleAlert, UserCheck } from 'lucide-react'
import { FloorButton } from '@nexus/ui/floor'
import { ReadAloudButton } from '@nexus/ui/floor/ReadAloud/index'
import { Modal, useDsWords } from '../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../lib/i18n/format'
import type { Locale } from '../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { TeamChip } from '../../../../lib/people-picture/view/TeamChip'
import { FloorFrameView, type FrameAction, type FrameModel } from '../../../frame/view/FloorFrameView'
import { FloorState } from '../../../frame/view/FloorState'
import { HidePhoto } from '../../../tasks/cutting/view/HidePhoto'
import type { BasketRead } from '../../api'
import { BasketDock, dockDraws, type BasketDockModel, type DockAction } from '../../dock/BasketDock'
import { QcCard, type QcAction, type QcCardModel } from '../../dock/QcCard'
import { AskCard, AskTile, AskWindow, NotesTile, PhotoTile, ProblemCard, ProblemTile } from '../../help'
import { readyOf, type BasketView, type StepBarModel, type StepBarStep } from '../../model'
import { BASKET_NS, BasketPic, Flag, RowFlags, StateFlag, StepName } from '../../parts'
import { LeaderRow, StepsWindow } from '../../steps'
import { StepBar } from './StepBar'
import '../../basket.css'

/**
 * owb-fl5 steps 2–4 — one basket on a phone (`/floor/basket/<code>`; design § 4.3–4.5, § 5zg C; P/floor.js floorBasket). ONE short page,
 * worker ≤ 1.8 screens at 390 × 800, in this order and nothing more:
 *   the head          the big picture · the B-number (in <bdi>) · the state · Listen · Design page
 *   the step bar      "Step 3 / 6 · Change" (Change only once fl6's window exists)
 *   another department (after a scan, settle 8): "This basket is in another department." + where it is, or "Not on its route. Its
 *                     next step is 4 Stitching."
 *   the facts         the customer's CODE (never a name, no price) · the team · size, colour, label, leather · pieces · due
 *   what needs you    a hold's words · the changed design · the problem and the ask (fl8's cards; an answer for you)
 *   the quality check at Quality while it is worked on (the points, the photos, send back)
 *   4 tiles           Problem · Ask · Photo · Notes (fl8; drawn only when built)
 *   the leader's row  Give to… · Do this first · Will be late (fl6)
 * The ONE next action is the dock in the frame's foot. A restricted basket shows its lock and nothing of it. View only.
 */

export interface BasketPageViewModel {
  readonly frame: FrameModel
  readonly state: 'loading' | 'ready' | 'refused' | 'offline' | 'unavailable'
  /** A refusal in words (the server's, or the page's "no basket with this code"). */
  readonly refusal: string | null
  readonly read: BasketRead | null
  readonly view: BasketView | null
  readonly bar: StepBarModel | null
  readonly readAt: number
  readonly speechLang: string
  readonly scanned: boolean
  readonly leader: boolean
  readonly stepsReady: boolean
  readonly helpReady: boolean
  /** The changed design's words (the office's, as written); null: none. */
  readonly designWords: string | null
  /** Not marked seen on this device yet. */
  readonly designPending: boolean
  /** In another department (the session's department is not the basket's). */
  readonly elsewhere: boolean
  readonly dock: BasketDockModel
  readonly qc: QcCardModel | null
  readonly stepsOpen: boolean
  readonly askOpen: boolean
  /** The quality photo being taken (its step's code). */
  readonly photo: { readonly code: string; readonly words: string } | null
  readonly online: boolean
  readonly timeZone?: string
}

export type BasketPageAction =
  | { readonly type: 'dock'; readonly action: DockAction }
  | { readonly type: 'qc'; readonly action: QcAction }
  | { readonly type: 'retry' }
  | { readonly type: 'designPage' }
  | { readonly type: 'closeSteps' }
  | { readonly type: 'closeAsk' }
  | { readonly type: 'photoTaken'; readonly photo: Blob }
  | { readonly type: 'photoCancel' }
  | { readonly type: 'changed' }

export function BasketPageView({ model, onAction, onFrame }: { readonly model: BasketPageViewModel; readonly onAction: (action: BasketPageAction) => void; readonly onFrame?: (action: FrameAction) => void }) {
  const tb = useT(BASKET_NS)
  const actions = dockDraws(model.dock) ? <BasketDock model={model.dock} onAction={(action) => onAction({ type: 'dock', action })} /> : undefined
  return (
    <FloorFrameView frame={model.frame} onFrame={onFrame} actions={actions}>
      {model.state === 'loading' ? <FloorState tone="info" icon={<Package />} title={tb('page.loading')} busy /> : null}
      {model.state === 'offline' ? <FloorState tone="warning" icon={<CloudOff />} title={tb('page.offline')} /> : null}
      {model.state === 'refused' || model.state === 'unavailable' ? (
        <FloorState tone="danger" icon={<CircleAlert />} title={model.refusal ?? tb('page.unavailable')} alert>
          {model.state === 'unavailable' ? (
            <FloorButton size="md" variant="secondary" icon={<RotateCcw />} onClick={() => onAction({ type: 'retry' })}>
              {tb('page.retry')}
            </FloorButton>
          ) : null}
        </FloorState>
      ) : null}
      {model.state === 'ready' && model.read?.restricted ? <Locked model={model} read={model.read} restricted={model.read.restricted} onAction={onAction} /> : null}
      {model.state === 'ready' && model.view && model.read && !model.read.restricted ? <Basket model={model} view={model.view} read={model.read} onAction={onAction} /> : null}
    </FloorFrameView>
  )
}

function Basket({ model, view, read, onAction }: { readonly model: BasketPageViewModel; readonly view: BasketView; readonly read: BasketRead; readonly onAction: (action: BasketPageAction) => void }) {
  const tb = useT(BASKET_NS)
  const ds = useDsWords()
  const changed = () => onAction({ type: 'changed' })
  const ready = readyOf(view.route.steps)
  const bar = model.bar
  const stateWord = tb(`state.${ready ? 'READY' : view.work.state}`)
  const stepWords = bar && bar.at !== null && bar.now ? `${tb('page.readStep', { at: bar.at, total: bar.total, now: stepWord(bar.now) })}${bar.next ? ` ${tb('page.readNext', { next: stepWord(bar.next) })}` : ''}` : ''
  const readText = () => tb('page.readAloud', { code: view.basket.code, state: stateWord, step: stepWords })

  return (
    <div className="fw-bk-stack">
      <header className="fw-bk-head">
        <BasketPic id={view.basket.id} code={view.basket.code} label={view.basket.words.label} picture={read.picture} size="board" now={model.readAt} />
        <div className="fw-bk-head-text">
          <div className="fw-bk-head-top">
            <h1 className="fw-bk-id">
              <bdi>{view.basket.code}</bdi>
            </h1>
            <ReadAloudButton text={readText} lang={model.speechLang} size="sm" showVoice={false} labels={ds.readAloud} />
          </div>
          <span className="fw-bk-flags">
            <StateFlag state={ready ? 'READY' : view.work.state} />
            <RowFlags first={view.flags.first} rush={view.basket.rush} problem={view.flags.problem !== null} late={view.flags.late !== null} lateDays={view.flags.late?.days ?? null} />
          </span>
          {read.designPageHref ? (
            <div className="fw-bk-head-acts">
              <FloorButton size="sm" variant="secondary" icon={<FileImage />} onClick={() => onAction({ type: 'designPage' })}>
                {tb('page.designPage')}
              </FloorButton>
            </div>
          ) : null}
        </div>
      </header>
      {bar ? <StepBar bar={bar} code={view.basket.code} onChange={model.stepsReady ? () => onAction({ type: 'dock', action: 'changeStep' }) : null} /> : null}
      {model.elsewhere && (model.scanned || !model.leader) && bar ? <Elsewhere view={view} now={bar.now} next={bar.next} /> : null}
      <Facts view={view} timeZone={model.timeZone} />
      {view.hold ? (
        <div className="fw-bk-needs" data-tone="danger" role="status">
          <TriangleAlert aria-hidden="true" />
          <div className="fw-bk-needs-text">
            <span className="fw-bk-needs-title">{tb(`needs.hold.${view.hold.kind}`)}</span>
            <bdi>{view.hold.words}</bdi>
          </div>
        </div>
      ) : null}
      {model.designWords ? (
        <div className="fw-bk-needs" data-tone="warning">
          <ImageIcon aria-hidden="true" />
          <div className="fw-bk-needs-text">
            <span className="fw-bk-needs-title">{tb('needs.changed')}</span>
            <bdi>{model.designWords}</bdi>
            {model.designPending ? null : (
              <span className="fw-bk-flags">
                <Flag tone="success" icon={<ImageIcon />}>
                  {tb('needs.seen')}
                </Flag>
              </span>
            )}
          </div>
        </div>
      ) : null}
      <ProblemCard read={read} onChanged={changed} />
      <AskCard read={read} onChanged={changed} />
      {model.qc ? <QcCard model={model.qc} onAction={(action) => onAction({ type: 'qc', action })} /> : null}
      {model.helpReady ? (
        <div className="fw-bk-tiles">
          <ProblemTile read={read} onChanged={changed} />
          <AskTile read={read} onChanged={changed} />
          <PhotoTile read={read} onChanged={changed} />
          <NotesTile read={read} onChanged={changed} />
        </div>
      ) : null}
      {model.leader ? <LeaderRow view={view} leader={model.leader} onChanged={changed} /> : null}
      {model.stepsReady && model.stepsOpen ? <StepsWindow open onClose={() => onAction({ type: 'closeSteps' })} view={view} leader={model.leader} onChanged={changed} /> : null}
      {model.helpReady ? <AskWindow open={model.askOpen} onClose={() => onAction({ type: 'closeAsk' })} read={read} onChanged={changed} /> : null}
      <Modal open={model.photo !== null} onClose={() => onAction({ type: 'photoCancel' })} title={model.photo ? tb('qc.photo', { words: model.photo.words }) : tb('qc.title')} size="md" sheet className="fw-floor-dialog">
        {model.photo ? <HidePhoto label={tb('qc.take')} heldReason={model.online ? null : tb('qc.photoOffline')} onCapture={(photo) => onAction({ type: 'photoTaken', photo: photo.photo })} onCancel={() => onAction({ type: 'photoCancel' })} /> : null}
      </Modal>
    </div>
  )
}

/** A basket this person may not open (R23, R44): its number and why, nothing of it; "Ask your team leader" once fl8 is built. */
function Locked({ model, read, restricted, onAction }: { readonly model: BasketPageViewModel; readonly read: BasketRead; readonly restricted: 'RESTRICTED' | 'OTHER_TEAM'; readonly onAction: (action: BasketPageAction) => void }) {
  const tb = useT(BASKET_NS)
  return (
    <div className="fw-bk-stack">
      {read.basket ? (
        <h1 className="fw-bk-id">
          <bdi>{read.basket.code}</bdi>
        </h1>
      ) : null}
      <FloorState tone="warning" icon={<Lock />} title={tb(`lock.${restricted}`)}>
        {model.helpReady ? (
          <FloorButton size="lg" variant="primary" icon={<UserCheck />} onClick={() => onAction({ type: 'dock', action: 'askLeader' })}>
            {tb('dock.askLeader')}
          </FloorButton>
        ) : null}
      </FloorState>
      {model.helpReady ? <AskWindow open={model.askOpen} onClose={() => onAction({ type: 'closeAsk' })} read={read} onChanged={() => onAction({ type: 'changed' })} /> : null}
    </div>
  )
}

/** A step in words for Listen ("4 Stitching"). */
const stepWord = (step: StepBarStep): string => (step.dept ? `${step.dept.no} ${step.dept.shortName}` : step.name)

function Elsewhere({ view, now, next }: { readonly view: BasketView; readonly now: StepBarStep | null; readonly next: StepBarStep | null }) {
  const tb = useT(BASKET_NS)
  if (!view.here.onRoute) {
    const step = next ?? now
    return (
      <div className="fw-bk-else" role="status">
        <p className="fw-bk-else-title">{step ? tb('elsewhere.offRoute', { step: stepWord(step) }) : tb('elsewhere.offRouteNoNext')}</p>
      </div>
    )
  }
  return (
    <div className="fw-bk-else" role="status">
      <p className="fw-bk-else-title">{tb('elsewhere.title')}</p>
      {now ? (
        <span className="fw-bk-flags">
          {tb('elsewhere.isAt')} <StepName dept={now.dept} name={now.name} />
        </span>
      ) : null}
    </div>
  )
}

function Facts({ view, timeZone }: { readonly view: BasketView; readonly timeZone?: string | undefined }) {
  const tb = useT(BASKET_NS)
  const locale = useLocale() as Locale
  const { basket } = view
  const words = basket.words
  return (
    <ul className="fw-bk-facts" aria-label={tb('facts.label')}>
      <li className="fw-bk-fact">
        <Tag aria-hidden="true" />
        <bdi>{tb('facts.customer', { code: basket.customerCode })}</bdi>
      </li>
      {basket.team ? (
        <li className="fw-bk-fact">
          <TeamChip team={{ name: basket.team.name, kind: basket.team.picture?.kind ?? null, icon: basket.team.picture?.icon ?? null, colour: basket.team.picture?.colour ?? null }} />
        </li>
      ) : null}
      {words.label ? (
        <li className="fw-bk-fact">
          <Shirt aria-hidden="true" />
          <bdi>{words.label}</bdi>
        </li>
      ) : null}
      {words.size ? (
        <li className="fw-bk-fact">
          <Ruler aria-hidden="true" />
          <bdi>{words.size}</bdi>
        </li>
      ) : null}
      {words.colour ? (
        <li className="fw-bk-fact">
          <Palette aria-hidden="true" />
          <bdi>{words.colour}</bdi>
        </li>
      ) : null}
      {words.leather ? (
        <li className="fw-bk-fact">
          <Layers aria-hidden="true" />
          <bdi>{words.leather}</bdi>
        </li>
      ) : null}
      {basket.smallParts || basket.quantity > 1 ? (
        <li className="fw-bk-fact">
          <Package aria-hidden="true" />
          <bdi>{tb('facts.pieces', { count: basket.quantity })}</bdi>
        </li>
      ) : null}
      {basket.due ? (
        <li className="fw-bk-fact">
          <Calendar aria-hidden="true" />
          <bdi>{tb('facts.due', { date: formatDate(basket.due, { locale, ...(timeZone ? { timeZone } : {}) }) })}</bdi>
        </li>
      ) : null}
    </ul>
  )
}
