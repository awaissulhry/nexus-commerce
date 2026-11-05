'use client'

import { useRef, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { Ambulance, BellRing, CircleAlert, Footprints, HeartPulse, PhoneCall, Trash2, UserRound, UserRoundPlus, UsersRound } from 'lucide-react'
import { FloorButton } from '@nexus/ui/floor'
import { ReasonGrid, type ReasonTile } from '@nexus/ui/floor/ReasonGrid/index'
import { useReasonWords } from '../../../../lib/ds-words/reason-grid'
import { formatTime } from '../../../../lib/i18n/format'
import { INTL_LOCALE, type Locale } from '../../../../lib/i18n/locales'
import type { Translate } from '../../../../lib/i18n/messages'
import { TaskLine, Ticks, type TickState } from '../../shared/view/TaskParts'
import type { PersonDraft } from '../model'

/**
 * The parts of SCR-230 (B-W2b-137): the emergency first (design floor.incident sec:emergency "Banner (floor size)": the DS
 * Banner is console sized, so the floor's own notice card carries it, named in the notes), the short emergency line every
 * later step keeps (design "Emergency number always shown"), the one-tap pick grid (DS ReasonGrid: a tap or Enter moves on,
 * arrows only move the pick, so the keyboard never jumps a step), and the people of an incident.
 */

export interface FirstAider {
  readonly name: string
  readonly shift: string | null
}

/** The emergency's call for help: one tap sends the station's Safety (or team leader's) call; else Call for help opens. */
export type HelpButton =
  | { readonly kind: 'page' }
  | { readonly kind: 'send'; readonly label: string; readonly busy?: boolean }
  | { readonly kind: 'queued'; readonly label: string; readonly ticks: TickState; readonly refusal: string | null }
  | { readonly kind: 'open'; readonly label: string; readonly status: 'SENT' | 'SEEN' | 'ON_THE_WAY' }

export interface EmergencyModel {
  /** 112: factory-domain's, so it shows before any read and with no network. */
  readonly number: string
  /** The site's first aiders in force; null: never read on this tablet (offline since it started). */
  readonly firstAiders: readonly FirstAider[] | null
  /** Read earlier, shown from this tablet's memory. */
  readonly asOf?: string | null
  readonly help: HelpButton
}

export type EmergencyAction = { readonly type: 'callHelp' } | { readonly type: 'openHelp' }

/** "Someone badly hurt?": 112 first, the first aiders by name, and the call for help. Before any form. */
export function EmergencyBanner({ model, t, locale, onAction, headingId }: { model: EmergencyModel; t: Translate; locale: Locale; onAction: (action: EmergencyAction) => void; headingId: string }) {
  const aiders = model.firstAiders
  return (
    <section className="fw-floor-notice fw-floor-notice-card fw-in-emergency" data-tone="danger" aria-labelledby={headingId}>
      <span className="fw-floor-inline-icon fw-in-emergency-icon" aria-hidden="true">
        <Ambulance />
      </span>
      <div className="fw-floor-notice-card-text">
        <h2 id={headingId} className="fw-in-emergency-title">
          {t('emergency.title')}
        </h2>
        <p className="fw-in-emergency-call">
          <span className="fw-floor-inline-icon" aria-hidden="true">
            <PhoneCall />
          </span>
          <span>{t('emergency.callFirst')}</span>
          <strong className="fw-in-emergency-number" aria-label={t('emergency.numberLabel', { number: model.number })}>
            {model.number}
          </strong>
        </p>
        {aiders === null ? (
          <p className="fw-in-emergency-line">{t('emergency.aidersUnknown')}</p>
        ) : aiders.length === 0 ? (
          <p className="fw-in-emergency-line">{t('emergency.aidersNone')}</p>
        ) : (
          <div className="fw-in-emergency-aiders">
            <h3 className="fw-in-emergency-line">{t('emergency.aiders', { count: aiders.length })}</h3>
            <ul className="fw-in-aiders">
              {aiders.map((aider, index) => (
                <li key={`${aider.name}-${index}`}>
                  <span className="fw-floor-inline-icon" aria-hidden="true">
                    <HeartPulse />
                  </span>
                  <span>{aider.shift ? t('emergency.aiderShift', { name: aider.name, shift: aider.shift }) : aider.name}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {model.asOf ? <p className="fw-floor-muted">{t('emergency.asOf', { time: formatTime(model.asOf, { locale }) })}</p> : null}
        <HelpCall help={model.help} t={t} onAction={onAction} />
      </div>
    </section>
  )
}

function HelpCall({ help, t, onAction }: { help: HelpButton; t: Translate; onAction: (action: EmergencyAction) => void }) {
  switch (help.kind) {
    case 'page':
      return (
        <div className="fw-in-help">
          <FloorButton size="lg" variant="danger" icon={<BellRing />} onClick={() => onAction({ type: 'openHelp' })}>
            {t('emergency.help')}
          </FloorButton>
        </div>
      )
    case 'send':
      return (
        <div className="fw-in-help">
          <FloorButton size="lg" variant="danger" icon={<BellRing />} heldReason={help.busy ? t('held.busy') : null} onClick={() => onAction({ type: 'callHelp' })}>
            {t('emergency.helpCall', { call: help.label })}
          </FloorButton>
          <p className="fw-floor-muted">{t('emergency.helpOneTap')}</p>
        </div>
      )
    case 'queued':
      return (
        <div className="fw-in-help" role="status">
          <p className="fw-in-emergency-line">
            <strong>{help.ticks === 'refused' ? t('emergency.helpRefused', { call: help.label }) : t('emergency.helpCalled', { call: help.label })}</strong> <Ticks state={help.ticks} />
          </p>
          {help.refusal ? <p className="fw-in-emergency-line">{help.refusal}</p> : null}
          <FloorButton size="md" variant="secondary" icon={<Footprints />} onClick={() => onAction({ type: 'openHelp' })}>
            {t('emergency.helpFollow')}
          </FloorButton>
        </div>
      )
    case 'open':
      return (
        <div className="fw-in-help" role="status">
          <p className="fw-in-emergency-line">
            <strong>{t(`emergency.helpOpen.${help.status}`, { call: help.label })}</strong>
          </p>
          <FloorButton size="md" variant="secondary" icon={<Footprints />} onClick={() => onAction({ type: 'openHelp' })}>
            {t('emergency.helpFollow')}
          </FloorButton>
        </div>
      )
  }
}

/** The line every later step keeps: 112, and the first aiders' count (design "Emergency number always shown"). */
export function EmergencyLine({ model, t, injury }: { model: EmergencyModel; t: Translate; injury: boolean }) {
  const count = model.firstAiders?.length ?? null
  return (
    <TaskLine tone="danger" icon={<PhoneCall />}>
      {injury ? t('emergency.lineInjury', { number: model.number }) : t('emergency.line', { number: model.number })}
      {count !== null && count > 0 ? ` ${t('emergency.lineAiders', { count })}` : ''}
    </TaskLine>
  )
}

// ---- the pick grid ---------------------------------------------------------------------------------------------------------

const ARROWS = new Set(['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'Home', 'End'])

/**
 * The DS ReasonGrid as a one-tap step (its question is the step's heading, so the grid keeps it for screen readers only): a tap (or Enter / Space) on a tile picks it and moves on; arrows only move the pick
 * (the grid is a radio group: an arrow picks), so the keyboard never jumps a step by itself; a tap or Enter on the tile already
 * picked moves on too.
 */
export function PickStep({ label, tiles, value, onPick, locale }: { label: string; tiles: readonly ReasonTile[]; value: string | null; onPick: (id: string, advance: boolean) => void; locale: Locale }) {
  const words = useReasonWords()
  const last = useRef<'pointer' | 'arrow' | 'key'>('pointer')
  const onKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>) => {
    if (ARROWS.has(event.key)) {
      last.current = 'arrow'
      return
    }
    last.current = 'key'
    if (event.key !== 'Enter' && event.key !== ' ') return
    const id = (event.target as HTMLElement).closest('[data-reason-id]')?.getAttribute('data-reason-id')
    // Enter on the tile already picked: the grid does nothing (no change), so the step moves on here.
    if (id && id === value) {
      event.preventDefault()
      onPick(id, true)
    }
  }
  // A tap on the tile already picked (one passed on by another screen): the grid sees no change, so the step moves on here.
  const onClickCapture = (event: MouseEvent<HTMLDivElement>) => {
    if (last.current !== 'pointer') return
    const id = (event.target as HTMLElement).closest('[data-reason-id]')?.getAttribute('data-reason-id')
    if (id && id === value) onPick(id, true)
  }
  return (
    <div className="fw-in-pick" onKeyDownCapture={onKeyDownCapture} onPointerDownCapture={() => (last.current = 'pointer')} onClickCapture={onClickCapture}>
      <ReasonGrid label={label} hideLabel reasons={tiles} value={value} onChange={(id) => onPick(id, last.current !== 'arrow')} words={words} locale={INTL_LOCALE[locale]} />
    </div>
  )
}

// ---- the people of an incident ------------------------------------------------------------------------------------------------

export type PeopleAction =
  | { readonly type: 'addMe' }
  | { readonly type: 'addWorker' }
  | { readonly type: 'addOutside' }
  | { readonly type: 'involvement'; readonly id: string; readonly involvement: 'INJURED' | 'INVOLVED' }
  | { readonly type: 'removePerson'; readonly id: string }

const whoIcon = (who: PersonDraft['who']): ReactNode => (who === 'ME' ? <UserRound /> : who === 'WORKER' ? <UsersRound /> : <UserRoundPlus />)

/** Who was hurt or there (an incident only): each row hurt or only there, removable; the injury itself is the office's. */
export function PeopleSection({ people, held, t, onAction }: { people: readonly PersonDraft[]; held: { me: string | null; worker: string | null; outside: string | null }; t: Translate; onAction: (action: PeopleAction) => void }) {
  return (
    <section className="fw-floor-section" aria-labelledby="fw-in-people">
      <h3 id="fw-in-people" className="fw-floor-subtitle">
        {t('people.title')}
      </h3>
      <p className="fw-floor-muted">{t('people.hint')}</p>
      {people.length > 0 ? (
        <ul className="fw-in-people" aria-label={t('people.list', { count: people.length })}>
          {people.map((person) => (
            <li key={person.id} className="fw-in-person">
              <span className="fw-floor-inline-icon" aria-hidden="true">
                {whoIcon(person.who)}
              </span>
              <span className="fw-in-person-name">{person.who === 'ME' ? t('people.me', { name: person.name }) : person.who === 'OUTSIDE' ? t('people.outsideName', { name: person.name }) : person.name}</span>
              <span className="fw-in-person-how" role="group" aria-label={t('people.how', { name: person.name })}>
                {(['INJURED', 'INVOLVED'] as const).map((involvement) => (
                  <FloorButton
                    key={involvement}
                    size="md"
                    variant={person.involvement === involvement ? (involvement === 'INJURED' ? 'danger' : 'primary') : 'secondary'}
                    aria-pressed={person.involvement === involvement}
                    onClick={() => onAction({ type: 'involvement', id: person.id, involvement })}
                  >
                    {t(`people.${involvement}`)}
                  </FloorButton>
                ))}
              </span>
              <FloorButton size="md" variant="quiet" icon={<Trash2 />} aria-label={t('people.remove', { name: person.name })} onClick={() => onAction({ type: 'removePerson', id: person.id })} />
            </li>
          ))}
        </ul>
      ) : null}
      <div className="fw-in-add">
        <FloorButton size="lg" variant="secondary" icon={<UserRound />} heldReason={held.me ? t(held.me) : null} onClick={() => onAction({ type: 'addMe' })}>
          {t('people.addMe')}
        </FloorButton>
        <FloorButton size="lg" variant="secondary" icon={<UsersRound />} heldReason={held.worker ? t(held.worker) : null} onClick={() => onAction({ type: 'addWorker' })}>
          {t('people.addWorker')}
        </FloorButton>
        <FloorButton size="lg" variant="secondary" icon={<UserRoundPlus />} heldReason={held.outside ? t(held.outside) : null} onClick={() => onAction({ type: 'addOutside' })}>
          {t('people.addOutside')}
        </FloorButton>
      </div>
      {held.worker && held.worker !== 'held.peopleFull' ? <p className="fw-floor-muted">{t(held.worker)}</p> : null}
    </section>
  )
}

/** A refusal in this screen's words, or the API's. */
export function RefusalLine({ text }: { text: string }) {
  return (
    <TaskLine tone="danger" icon={<CircleAlert />} alert>
      {text}
    </TaskLine>
  )
}
