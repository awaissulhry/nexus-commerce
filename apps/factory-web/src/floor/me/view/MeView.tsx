'use client'

import type { ReactNode } from 'react'
import { CalendarCheck, CheckCheck, Languages, Lightbulb, ListChecks, Type, UserCheck, UserRound, Users, Volume2, VolumeX, WifiOff } from 'lucide-react'
import { FloorButton } from '@nexus/ui/floor'
import { DeptChip } from '../../../lib/department/view/DeptChip'
import type { Department } from '../../../lib/department/model'
import { FLOOR_LOCALE_NAMES, type FloorLocale } from '../../../lib/i18n/locales'
import { useT } from '../../../lib/i18n/provider'
import { TeamChip } from '../../../lib/people-picture/view/TeamChip'
import { FloorState } from '../../frame/view/FloorState'
import { TaskLine } from '../../tasks/shared/view/TaskParts'
import type { FloorProfile } from '../api'
import { netStripShown } from '../model'
import type { FloorDeviceSettings } from '../settings'
import '../../basket/help/help2.css'
import '../me.css'

/**
 * owb-fl8 step 4 — Floor › Me (design § 5zf B; P/floor.js floorMe), ONE short page, no heading per part but two:
 *
 *   me            my name, worker or team leader, my team and its leader
 *   I can work in the departments I may work in (the department chips)
 *   the net strip "Saved on this phone · 3 wait" (only while offline or while something waits) → My record
 *   the buttons   My day (behind the PIN) · Tell the office · Large words · Sound · My record · Change person
 *   Language      the site's floor languages, one tap each
 *
 * Nothing here is a person's score. The view fetches nothing: Me.tsx reads and sends.
 */

export type MeAction =
  | { readonly type: 'myday' }
  | { readonly type: 'tell' }
  | { readonly type: 'large' }
  | { readonly type: 'sound' }
  | { readonly type: 'record' }
  | { readonly type: 'person' }
  | { readonly type: 'language'; readonly locale: FloorLocale }
  | { readonly type: 'retry' }

export interface MeModel {
  readonly name: string
  readonly role: 'LEADER' | 'WORKER'
  readonly profile: FloorProfile | null
  readonly state: 'loading' | 'ready' | 'failed'
  readonly departments: readonly Department[]
  readonly locale: FloorLocale
  readonly languages: readonly FloorLocale[]
  readonly settings: FloorDeviceSettings
  readonly online: boolean
  /** This person's actions saved on this phone and not yet recorded by the office. */
  readonly waiting: number
}

function Toggle({ icon, label, on, onPress, t }: { icon: ReactNode; label: string; on: boolean; onPress: () => void; t: (key: string) => string }) {
  return (
    <FloorButton size="lg" variant="secondary" icon={icon} aria-pressed={on} onClick={onPress} className="fw-me-toggle">
      <span>{label}</span>
      <span className="fw-me-state">{t(on ? 'me.on' : 'me.off')}</span>
    </FloorButton>
  )
}

export function MeView({ model, onAction }: { model: MeModel; onAction: (action: MeAction) => void }) {
  const t = useT('floor-help2')
  const send = (action: MeAction) => onAction(action)
  const { profile } = model
  const team = profile?.team ?? null
  const leaderName = profile?.leader?.name ?? null

  return (
    <div className="fw-floor-stack fw-me">
      <section className="fw-me-card" aria-labelledby="fw-me-name">
        <div className="fw-me-head">
          <span className="fw-me-face" aria-hidden>
            <UserRound />
          </span>
          <div className="fw-me-who">
            <h2 id="fw-me-name" className="fw-floor-section-title">
              <bdi>{model.name}</bdi>
            </h2>
            <span className="fw-h2-chip">
              {model.role === 'LEADER' ? <UserCheck aria-hidden /> : <Users aria-hidden />}
              {t(model.role === 'LEADER' ? 'me.leaderRole' : 'me.workerRole')}
            </span>
          </div>
        </div>
        {model.state === 'loading' ? <p className="fw-floor-muted">{t('me.loading')}</p> : null}
        {model.state === 'failed' ? (
          <FloorState tone="warning" icon={<WifiOff />} title={t('me.failed')}>
            <FloorButton variant="secondary" onClick={() => send({ type: 'retry' })}>
              {t('me.retry')}
            </FloorButton>
          </FloorState>
        ) : null}
        {model.state === 'ready' ? (
          <div className="fw-me-team">
            {team ? <TeamChip team={team} /> : <p className="fw-floor-muted">{t('me.noTeam')}</p>}
            {leaderName ? (
              <p className="fw-floor-muted">
                <UserCheck aria-hidden className="fw-floor-inline-icon" />
                {t('me.leaderIs', { name: leaderName })}
              </p>
            ) : null}
          </div>
        ) : null}
        {model.state === 'ready' && model.departments.length > 0 ? (
          <div className="fw-me-can">
            <h3 className="fw-floor-subtitle">{t('me.canWork')}</h3>
            <div className="fw-me-depts">
              {model.departments.map((dept) => (
                <DeptChip key={dept.id ?? dept.no} dept={dept} />
              ))}
            </div>
          </div>
        ) : null}
      </section>

      {netStripShown(model.online, model.waiting) ? (
        <TaskLine tone="warning" icon={model.online ? <CheckCheck /> : <WifiOff />}>
          {model.online ? t('me.waiting', { count: model.waiting }) : t('me.offline', { count: model.waiting })}
        </TaskLine>
      ) : null}

      <div className="fw-me-grid" role="group" aria-label={t('me.title')}>
        <FloorButton size="lg" variant="secondary" icon={<CalendarCheck />} onClick={() => send({ type: 'myday' })}>
          {t('me.myDay')}
        </FloorButton>
        <FloorButton size="lg" variant="secondary" icon={<Lightbulb />} aria-haspopup="dialog" onClick={() => send({ type: 'tell' })}>
          {t('me.tell')}
        </FloorButton>
        <Toggle icon={<Type />} label={t('me.large')} on={model.settings.large} onPress={() => send({ type: 'large' })} t={t} />
        <Toggle icon={model.settings.sound ? <Volume2 /> : <VolumeX />} label={t('me.sound')} on={model.settings.sound} onPress={() => send({ type: 'sound' })} t={t} />
        <FloorButton size="lg" variant="secondary" icon={<ListChecks />} onClick={() => send({ type: 'record' })}>
          {t('me.record')}
        </FloorButton>
        <FloorButton size="lg" variant="secondary" icon={<Users />} onClick={() => send({ type: 'person' })}>
          {t('me.person')}
        </FloorButton>
      </div>
      <p className="fw-floor-muted">{t('me.myDayNote')}</p>

      {model.languages.length > 1 ? (
        <section className="fw-floor-section" aria-labelledby="fw-me-lang">
          <h3 id="fw-me-lang" className="fw-floor-subtitle">
            <Languages aria-hidden className="fw-floor-inline-icon" />
            {t('me.language')}
          </h3>
          <div className="fw-me-langs" role="group" aria-labelledby="fw-me-lang">
            {model.languages.map((locale) => (
              <FloorButton key={locale} size="lg" variant={locale === model.locale ? 'primary' : 'secondary'} aria-pressed={locale === model.locale} onClick={() => send({ type: 'language', locale })}>
                <span lang={locale} dir={locale === 'ur' ? 'rtl' : 'ltr'}>{FLOOR_LOCALE_NAMES[locale]}</span>
              </FloorButton>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  )
}
