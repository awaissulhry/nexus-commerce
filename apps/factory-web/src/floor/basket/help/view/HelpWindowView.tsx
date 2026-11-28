'use client'

import { Check, CircleAlert, Hourglass, Info, WifiOff, X } from 'lucide-react'
import { FloorButton } from '@nexus/ui/floor'
import { ReadAloudButton } from '@nexus/ui/floor/ReadAloud/index'
import { ReasonGrid, type ReasonTile } from '@nexus/ui/floor/ReasonGrid/index'
import { DeptChip } from '../../../../lib/department/view/DeptChip'
import type { Department } from '../../../../lib/department/model'
import { useReasonWords } from '../../../../lib/ds-words/reason-grid'
import { Modal, useDsWords } from '../../../../lib/i18n/ds-parts'
import { INTL_LOCALE } from '../../../../lib/i18n/locales'
import type { Translate } from '../../../../lib/i18n/messages'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { CaptureStep } from '../../../tasks/machine/view/MediaParts'
import type { TaskProblem } from '../../../tasks/shared/task-api'
import { TaskLine, Ticks, type TickState } from '../../../tasks/shared/view/TaskParts'
import type { CallGroup } from '../api'
import { askIcon, problemIcon } from '../icons'
import { askTo, isAskCode, mediaHeld, VOICE_ASK, type HelpTile } from '../model'
import '../help2.css'

/**
 * owb-fl8 step 1 + 2 — the Problem window and the Ask window (design § 5zf B, § 4.4; P/floor.js floorModal 'problem' / 'ask';
 * `Modal sheet` + `ReasonGrid`): ONE tap on a tile tells it. A phone with no department picked first gets the pick (one tap; a
 * department with several stations lists their names once; one with none answers in words). An ask shows who answers (Designer ·
 * Team leader), fixed by its code: no pick. "Something else (voice)" records a voice note first. Listen reads the tiles aloud.
 * The view fetches nothing: HelpWindow.tsx reads and sends.
 */

export type WindowStep =
  | { readonly kind: 'loading' }
  | { readonly kind: 'department'; readonly busy?: boolean; readonly problem?: TaskProblem | null }
  | { readonly kind: 'station'; readonly departmentId: string; readonly stations: readonly { readonly id: string; readonly name: string }[]; readonly busy?: boolean; readonly problem?: TaskProblem | null }
  | { readonly kind: 'noStation' }
  | { readonly kind: 'tiles' }
  | { readonly kind: 'voice'; readonly typeId: string }
  | { readonly kind: 'sending' }
  | { readonly kind: 'already'; readonly basketCode: string }
  | { readonly kind: 'saved'; readonly code: string; readonly ticks: TickState; readonly voiceLost?: boolean }
  | { readonly kind: 'problem'; readonly problem: TaskProblem; readonly afterVoice?: boolean }

export type WindowAction =
  | { readonly type: 'department'; readonly id: string }
  | { readonly type: 'station'; readonly id: string }
  | { readonly type: 'tile'; readonly code: string; readonly typeId: string }
  | { readonly type: 'voice'; readonly blob: Blob }
  | { readonly type: 'again' }
  | { readonly type: 'close' }

export interface HelpWindowModel {
  readonly group: CallGroup
  readonly open: boolean
  readonly step: WindowStep
  readonly basket: { readonly code: string; readonly picture: string | null }
  readonly tiles: readonly HelpTile<string>[]
  /** The server's sentence when the site has none of these codes (null: this screen's own). */
  readonly none: string | null
  readonly departments: readonly Department[]
  readonly online: boolean
  /** The phone's voice tag for Listen (`it-IT`, `en-GB`). */
  readonly speech?: string | null
}

/** The words of a refusal or failure, in this screen's words for the codes it knows. */
export function problemWords(t: Translate, problem: TaskProblem): string {
  switch (problem.kind) {
    case 'offline':
      return t('window.offline')
    case 'refused':
      return problem.code === 'NO_STATION' ? t('window.noStation') : problem.message || t('window.failed')
    case 'notFound':
      return t('window.notFound')
    case 'forbidden':
      return t('window.forbidden')
    default:
      return t('window.failed')
  }
}

export function HelpWindowView({ model, onAction }: { model: HelpWindowModel; onAction: (action: WindowAction) => void }) {
  const t = useT('floor-help2')
  const machine = useT('floor-machine')
  const ds = useDsWords()
  const reasonWords = useReasonWords()
  const locale = useLocale()
  const { group, step } = model
  const ask = group === 'ASK'
  const wordOf = (code: string) => t(ask ? `ask.code.${code}` : `problem.code.${code}`)
  const title = t(ask ? 'ask.title' : 'problem.title', { code: model.basket.code })
  const offline = mediaHeld(model.online) ? t('media.offline') : null

  const reasons: ReasonTile[] = model.tiles.map((tile) => {
    const to = ask && isAskCode(tile.code) ? askTo(tile.code) : null
    return {
      id: tile.typeId,
      label: wordOf(tile.code),
      ...(to ? { hint: t(`ask.to.${to}`) } : {}),
      icon: ask ? askIcon(tile.code) : problemIcon(tile.code),
      tone: ask ? 'info' : 'danger',
      // The voice ask records first: its note needs the network.
      heldReason: tile.code === VOICE_ASK && offline ? offline : null,
    }
  })
  const listenText = () => [title, ...model.tiles.map((tile) => wordOf(tile.code)), t(ask ? 'ask.lead' : 'problem.lead')].join('. ')

  let body
  switch (step.kind) {
    case 'loading':
    case 'sending':
      body = (
        <TaskLine tone="info" icon={<Hourglass />}>
          {t(step.kind === 'loading' ? 'window.loading' : 'window.sending')}
        </TaskLine>
      )
      break
    case 'department':
      body = (
        <>
          <TaskLine tone="warning" icon={<Info />}>
            {t('department.first')}
          </TaskLine>
          <div className="fw-h2-depts" role="group" aria-label={t('department.label')}>
            {model.departments
              .filter((dept) => !dept.closed && dept.id)
              .map((dept) => (
                <FloorButton key={dept.id!} size="lg" variant="secondary" heldReason={step.busy ? t('window.sending') : null} onClick={() => onAction({ type: 'department', id: dept.id! })}>
                  <DeptChip dept={dept} />
                </FloorButton>
              ))}
          </div>
          {model.departments.every((dept) => !dept.id) ? <p className="fw-floor-muted">{t('department.loading')}</p> : null}
          {step.problem ? (
            <TaskLine tone="danger" icon={<CircleAlert />} alert>
              {problemWords(t, step.problem)}
            </TaskLine>
          ) : null}
        </>
      )
      break
    case 'station':
      body = (
        <>
          <p className="fw-floor-lead">{t('department.station')}</p>
          <div className="fw-h2-depts" role="group" aria-label={t('department.station')}>
            {step.stations.map((station) => (
              <FloorButton key={station.id} size="lg" variant="secondary" heldReason={step.busy ? t('window.sending') : null} onClick={() => onAction({ type: 'station', id: station.id })}>
                {station.name}
              </FloorButton>
            ))}
          </div>
          {step.problem ? (
            <TaskLine tone="danger" icon={<CircleAlert />} alert>
              {problemWords(t, step.problem)}
            </TaskLine>
          ) : null}
        </>
      )
      break
    case 'noStation':
      body = (
        <TaskLine tone="warning" icon={<CircleAlert />} alert>
          {t('department.none')}
        </TaskLine>
      )
      break
    case 'tiles':
      body =
        reasons.length === 0 ? (
          <p className="fw-floor-lead">{model.none ?? t(ask ? 'ask.none' : 'problem.none')}</p>
        ) : (
          <>
            <p className="fw-floor-muted">{t(ask ? 'ask.lead' : 'problem.lead')}</p>
            <ReasonGrid
              label={t(ask ? 'ask.question' : 'problem.question')}
              reasons={reasons}
              value={null}
              onChange={(id) => {
                const tile = model.tiles.find((entry) => entry.typeId === id)
                if (tile) onAction({ type: 'tile', code: tile.code, typeId: tile.typeId })
              }}
              words={reasonWords}
              locale={INTL_LOCALE[locale]}
            />
            {!model.online ? (
              <TaskLine tone="warning" icon={<WifiOff />}>
                {t('window.offlineSaved')}
              </TaskLine>
            ) : null}
            <ReadAloudButton text={listenText} lang={model.speech ?? INTL_LOCALE[locale]} labels={ds.readAloud} />
          </>
        )
      break
    case 'voice':
      body = <CaptureStep kind="AUDIO" title={t('ask.code.ASK_OTHER')} t={machine} onPhoto={() => undefined} onVoice={(blob) => onAction({ type: 'voice', blob })} onCancel={() => onAction({ type: 'again' })} />
      break
    case 'already':
      body = (
        <TaskLine tone="info" icon={<Check />}>
          {t('window.already', { code: step.basketCode })}
        </TaskLine>
      )
      break
    case 'saved':
      body = (
        <>
          <TaskLine tone="warning" icon={<WifiOff />}>
            {t('window.saved', { what: wordOf(step.code) })}
          </TaskLine>
          <p className="fw-h2-ticks">
            <Ticks state={step.ticks} />
          </p>
          {step.voiceLost ? <p className="fw-floor-muted">{t('ask.voiceLost')}</p> : null}
        </>
      )
      break
    case 'problem':
      body = (
        <TaskLine tone="danger" icon={<CircleAlert />} alert>
          {step.afterVoice ? t('ask.voiceFailed') : problemWords(t, step.problem)}
        </TaskLine>
      )
      break
  }

  const again = step.kind === 'problem' || step.kind === 'already' || step.kind === 'voice'
  return (
    <Modal
      open={model.open}
      onClose={() => onAction({ type: 'close' })}
      title={title}
      size="md"
      sheet
      className="fw-floor-dialog"
      footer={
        <>
          {again && step.kind !== 'voice' ? (
            <FloorButton size="lg" variant="secondary" onClick={() => onAction({ type: 'again' })}>
              {t('window.again')}
            </FloorButton>
          ) : null}
          <FloorButton size="lg" variant="quiet" icon={<X />} onClick={() => onAction({ type: 'close' })}>
            {t('window.close')}
          </FloorButton>
        </>
      }
    >
      <div className="fw-h2-window">
        <div className="fw-h2-basket">
          <span className="fw-h2-basket-pic" aria-hidden>
            {model.basket.picture ? <img src={model.basket.picture} alt="" /> : null}
          </span>
          <bdi className="fw-h2-code">{model.basket.code}</bdi>
        </div>
        {body}
      </div>
    </Modal>
  )
}
