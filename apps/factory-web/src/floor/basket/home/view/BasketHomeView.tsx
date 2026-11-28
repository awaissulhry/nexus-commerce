'use client'

import type { ReactNode } from 'react'
import { CircleAlert, CircleCheck, CloudOff, History, Image as ImageIcon, MessageSquare, Package, RotateCcw, UserCheck } from 'lucide-react'
import { FloorButton, FloorList, FloorListRow, ScanInput, type CameraScanner, type FloorTone } from '@nexus/ui/floor'
import { useT } from '../../../../lib/i18n/provider'
import type { BasketRow, ForYouItem, ForYouKind } from '../../api'
import { deptOf, opensBasket, type DoneFlash, type HomeLists } from '../../model'
import { BASKET_NS, BasketPic, RowFlags, StateFlag, StepName } from '../../parts'
import { FloorFrameView, type FrameAction, type FrameModel } from '../../../frame/view/FloorFrameView'
import { FloorState } from '../../../frame/view/FloorState'
import { TILE_ICON } from '../../../home/view/HomeView'
import type { TileKey } from '../../../model'
import { DepartmentButton, DepartmentPickWindow, type DepartmentPickAction, type DepartmentPickModel } from './DepartmentPick'
import '../../basket.css'

/**
 * owb-fl5 step 1 — the basket home of a PHONE (lead settle 9; design § 5zf B, § 5zg C; P/floor.js floorHome, fbRow, nextRows): in this
 * order, and nothing more —
 *   For you        ONE list, a line = one tap → its basket (what this device opened before is hidden: settle 12)
 *   Scan           the big scan field (the camera, or a typed number)
 *   In this department   the picture rows of the baskets here ("Do this first" on top)
 *   Coming next    the baskets whose next step is here, read only
 *   Other jobs     the phone's own tiles of today (Clock, My day, Report an incident, Line view): one row, last
 * The department pick sits in the top bar. An empty part says what it is and the next step; an empty For you / Coming next is not
 * drawn. A tablet opens the same home from its Baskets tile. View only: the container reads and sends.
 */

export interface BasketHomeViewModel {
  readonly frame: FrameModel
  readonly pick: DepartmentPickModel
  readonly state: 'loading' | 'ready' | 'offline' | 'unavailable'
  readonly lists: HomeLists | null
  readonly locale: string
  /** When the lists were read (the pictures' address life). */
  readonly readAt: number
  /** The line after a Done, once. */
  readonly flash: DoneFlash | null
  /** The phone's own tiles (Scan anything is the scan field above); empty on a tablet (its Home keeps them). */
  readonly jobs: readonly TileKey[]
  /** A badge scanned here did not open this phone. */
  readonly badgeRefused?: boolean
  /** The worker notice holds the scans (the scan field says so, as Home's does). */
  readonly scanHeld?: boolean
}

export type BasketHomeAction =
  | { readonly type: 'scan'; readonly code: string }
  | { readonly type: 'open'; readonly code: string; readonly item?: ForYouItem }
  | { readonly type: 'retry' }
  | { readonly type: 'job'; readonly key: TileKey }
  | DepartmentPickAction

const ITEM_LOOK: Readonly<Record<ForYouKind, { readonly tone: FloorTone; readonly icon: ReactNode }>> = {
  CHANGED_DESIGN: { tone: 'warning', icon: <ImageIcon /> },
  ANSWER: { tone: 'success', icon: <MessageSquare /> },
  SOLVED: { tone: 'info', icon: <CircleCheck /> },
  HANDOVER: { tone: 'primary', icon: <History /> },
  PROBLEM: { tone: 'danger', icon: <CircleAlert /> },
  ASK: { tone: 'primary', icon: <UserCheck /> },
}

export function BasketHomeView({ model, onAction, onFrame, camera }: { readonly model: BasketHomeViewModel; readonly onAction: (action: BasketHomeAction) => void; readonly onFrame?: (action: FrameAction) => void; readonly camera?: CameraScanner }) {
  const tb = useT(BASKET_NS)
  const t = useT('floor')
  const lists = model.lists
  const department = model.pick.current
  return (
    <FloorFrameView frame={model.frame} onFrame={onFrame} lead={<DepartmentButton current={department} onPress={() => onAction({ type: 'pickOpen' })} />}>
      <div className="fw-bk-stack">
        {model.flash ? <FlashLine flash={model.flash} /> : null}
        {lists && lists.forYou.length > 0 ? (
          <section className="fw-bk-stack fw-bk-list" aria-labelledby="fw-bk-foryou">
            <SectionHead id="fw-bk-foryou" words={tb('homePage.forYou')} count={lists.forYou.length} />
            <FloorList label={tb('homePage.forYou')}>
              {lists.forYou.map((item) => (
                <FloorListRow
                  key={`${item.kind}:${item.bundleId ?? '-'}:${item.at}`}
                  icon={ITEM_LOOK[item.kind].icon}
                  tone={ITEM_LOOK[item.kind].tone}
                  title={tb(`item.${item.kind}`)}
                  meta={
                    <>
                      {item.code ? <bdi className="fw-bk-code">{item.code}</bdi> : null}
                      {item.code && item.words ? ' · ' : null}
                      {item.words ? <bdi>{item.words}</bdi> : null}
                    </>
                  }
                  {...(opensBasket(item) ? { onPress: () => onAction({ type: 'open', code: item.code!, item }) } : {})}
                />
              ))}
            </FloorList>
          </section>
        ) : null}
        <ScanInput
          label={tb('homePage.scan')}
          hint={model.scanHeld ? t('tile.held.notice') : tb('homePage.scanHint')}
          scannedLabel={(code) => t('scan.read', { code })}
          keyboardLabel={t('scan.type')}
          disabled={model.scanHeld}
          camera={camera ? { scanner: camera, startLabel: t('scan.camera.start'), stopLabel: t('scan.camera.stop'), errorLabel: t('scan.camera.error') } : undefined}
          onScan={(code) => onAction({ type: 'scan', code })}
        />
        {model.badgeRefused ? (
          <p role="alert" className="fw-floor-notice" data-tone="danger">
            <span className="fw-floor-inline-icon" aria-hidden="true">
              <CircleAlert />
            </span>
            {t('home.badgeRefused')}
          </p>
        ) : null}
        <section className="fw-bk-stack fw-bk-list" aria-labelledby="fw-bk-here">
          <SectionHead id="fw-bk-here" words={tb('homePage.here')} count={lists ? lists.here.length : null} />
          <HereBody model={model} onAction={onAction} />
        </section>
        {lists && lists.next.length > 0 ? (
          <section className="fw-bk-stack fw-bk-list" aria-labelledby="fw-bk-next">
            <SectionHead id="fw-bk-next" words={tb('homePage.next')} count={lists.next.length} />
            <FloorList label={tb('homePage.next')}>
              {lists.next.map((row) => (
                <FloorListRow key={row.bundleId} icon={<BasketPic id={row.bundleId} code={row.code} picture={row.picture} size="phone" now={model.readAt} />} title={<bdi className="fw-bk-code">{row.code}</bdi>} meta={<StepName dept={deptOf(row.step.department, model.locale)} name="" />} />
              ))}
            </FloorList>
          </section>
        ) : null}
        {model.jobs.length > 0 ? (
          <section className="fw-bk-stack" aria-labelledby="fw-bk-jobs">
            <SectionHead id="fw-bk-jobs" words={tb('homePage.otherJobs')} count={null} />
            <div className="fw-bk-jobs">
              {model.jobs.map((key) => (
                <FloorButton key={key} size="md" variant="secondary" icon={TILE_ICON[key]} onClick={() => onAction({ type: 'job', key })}>
                  {t(`tile.${key}`)}
                </FloorButton>
              ))}
            </div>
          </section>
        ) : null}
      </div>
      <DepartmentPickWindow model={model.pick} onAction={onAction} />
    </FloorFrameView>
  )
}

function SectionHead({ id, words, count }: { readonly id: string; readonly words: string; readonly count: number | null }) {
  return (
    <h2 id={id} className="fw-bk-sec">
      <span>{words}</span>
      {count !== null ? <span className="fw-bk-count">{count}</span> : null}
    </h2>
  )
}

function HereBody({ model, onAction }: { readonly model: BasketHomeViewModel; readonly onAction: (action: BasketHomeAction) => void }) {
  const tb = useT(BASKET_NS)
  if (model.state === 'loading') return <FloorState tone="info" icon={<Package />} title={tb('homePage.loading')} busy />
  if (model.state === 'offline') return <FloorState tone="warning" icon={<CloudOff />} title={tb('homePage.offline')} />
  if (model.state === 'unavailable' || !model.lists) {
    return (
      <FloorState tone="danger" icon={<CircleAlert />} title={tb('homePage.unavailable')} alert>
        <FloorButton size="md" variant="secondary" icon={<RotateCcw />} onClick={() => onAction({ type: 'retry' })}>
          {tb('homePage.retry')}
        </FloorButton>
      </FloorState>
    )
  }
  if (model.lists.here.length === 0) return <p className="fw-bk-muted">{model.pick.current ? tb('homePage.nothingHere') : tb('homePage.noDepartment')}</p>
  return (
    <FloorList label={tb('homePage.here')}>
      {model.lists.here.map((row) => (
        <HereRow key={row.bundleId} row={row} now={model.readAt} onOpen={() => onAction({ type: 'open', code: row.code })} />
      ))}
    </FloorList>
  )
}

function HereRow({ row, now, onOpen }: { readonly row: BasketRow; readonly now: number; readonly onOpen: () => void }) {
  return (
    <FloorListRow
      icon={<BasketPic id={row.bundleId} code={row.code} picture={row.picture} size="phone" now={now} />}
      tone={row.flags.problem ? 'danger' : row.flags.first ? 'primary' : row.state === 'WORKING' ? 'info' : 'neutral'}
      title={<bdi className="fw-bk-code">{row.code}</bdi>}
      meta={<bdi>{row.customerCode}</bdi>}
      status={
        <span className="fw-bk-flags">
          <RowFlags first={row.flags.first} problem={row.flags.problem} late={row.flags.late} />
          <StateFlag state={row.state} />
        </span>
      }
      onPress={onOpen}
    />
  )
}

function FlashLine({ flash }: { readonly flash: DoneFlash }) {
  const tb = useT(BASKET_NS)
  const dept = flash.to ? `${flash.to.no} ${flash.to.shortName}` : tb('state.READY')
  const words = flash.saved
    ? tb('homePage.flash.saved', { code: flash.code })
    : flash.to === null
      ? tb('homePage.flash.ready', { code: flash.code })
      : flash.moved
        ? tb('homePage.flash.moved', { code: flash.code, dept })
        : tb('homePage.flash.done', { code: flash.code, dept })
  return (
    <p role="status" className="fw-floor-notice" data-tone={flash.saved ? 'warning' : 'success'}>
      <span className="fw-floor-inline-icon" aria-hidden="true">
        <CircleCheck />
      </span>
      <bdi>{words}</bdi>
    </p>
  )
}
