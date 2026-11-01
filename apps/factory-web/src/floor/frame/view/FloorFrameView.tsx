'use client'

import type { ReactNode } from 'react'
import { House, Languages, LogOut, ScanLine, X } from 'lucide-react'
import { FloorButton, FloorFrame, FloorHeader, FloorHelpButton, IdleOverlay, OfflineBanner, OperatorChip } from '@nexus/ui/floor'
import { Modal } from '../../../lib/i18n/ds-parts'
import { LOCALES, LOCALE_NAMES, type Locale } from '../../../lib/i18n/locales'
import { formatTime } from '../../../lib/i18n/format'
import { useLocale, useT } from '../../../lib/i18n/provider'
import '../../floor.css'

/**
 * SCR-022 — the floor frame of every floor screen (design 02-sections-floor "The floor frame"; anatomy 2.7): the
 * header (Home on every screen but Home · the operator chip, which opens the operator menu · the screen's title and
 * the station · language before a sign-in · Help), the offline banner (online or offline, the person's actions waiting on
 * this tablet as a big number, the refused ones in red, the last send's time, "Open queue": the offline queue, B-W0-30),
 * the one job, the big action bar, and the idle overlay above all. No rail, no
 * Pages button, no palette. Pop-ups: the operator menu, Help, and the language before a sign-in (frame.operator-menu,
 * frame.help, signin.language); nothing else covers the job.
 */

export interface FrameModel {
  /** The signed-in operator; null before a sign-in (enrolment, sign-in). */
  operator: { name: string } | null
  /** The device's station (null: none) and site, for the title line. */
  station: { name: string | null; site: string } | null
  /** The screen's title, a `floor` message key. */
  titleKey: string
  online: boolean
  /** The person's actions saved on this tablet and not yet recorded by the office (floor/shell/banner.ts). */
  pending: number
  /** The person's actions the office refused. */
  refused?: number
  /** The server's last answer to a send (an instant): "Last sent 10:42". */
  lastSentAt?: string | null
  /** The banner offers "Open queue" (every screen but the queue's own). */
  queueButton?: boolean
  /** Keep a quiet "Everything is recorded" line when nothing waits (the queue's own screen). */
  showSynced?: boolean
  /** The Home button (every screen but Home, when someone is signed in). */
  showHome?: boolean
  /** Before a sign-in: the language button (the screen's language, for this screen only). */
  showLanguage?: boolean
  menuOpen?: boolean
  helpOpen?: boolean
  languageOpen?: boolean
  idle?: { warning: boolean; secondsLeft: number }
}

export type FrameAction =
  | { type: 'home' }
  | { type: 'menu'; open: boolean }
  | { type: 'help'; open: boolean }
  | { type: 'language'; open: boolean }
  | { type: 'locale'; locale: Locale }
  | { type: 'sign-out' }
  | { type: 'stay' }
  | { type: 'queue' }

export interface FloorFrameViewProps {
  frame: FrameModel
  onFrame?: (action: FrameAction) => void
  /** The bottom bar: a `FloorActionBar`. */
  actions?: ReactNode
  children?: ReactNode
}

export function FloorFrameView({ frame, onFrame, actions, children }: FloorFrameViewProps) {
  const t = useT('floor')
  const locale = useLocale()
  const send = (action: FrameAction) => onFrame?.(action)
  const title = t(frame.titleKey)
  const where = frame.station ? (frame.station.name ? t('frame.where', { station: frame.station.name, site: frame.station.site }) : frame.station.site) : null

  const start = frame.operator ? (
    <>
      {frame.showHome ? (
        <FloorButton size="sm" variant="secondary" icon={<House />} aria-label={t('frame.home')} className="fw-floor-home" onClick={() => send({ type: 'home' })}>
          {t('frame.home')}
        </FloorButton>
      ) : null}
      {/* The station is on the title line, under the screen's name: the chip says who. */}
      <OperatorChip
        name={frame.operator.name}
        label={t('frame.operatorLabel', { name: frame.operator.name })}
        expanded={Boolean(frame.menuOpen)}
        onPress={() => send({ type: 'menu', open: !frame.menuOpen })}
      />
    </>
  ) : (
    <span className="fw-floor-brand">
      <span className="fw-floor-mark" aria-hidden="true">
        F
      </span>
      <span className="fw-floor-brand-name">{t('brand')}</span>
    </span>
  )

  const end = (
    <>
      {frame.showLanguage ? (
        <FloorButton size="sm" variant="secondary" icon={<Languages />} aria-haspopup="dialog" aria-expanded={Boolean(frame.languageOpen)} onClick={() => send({ type: 'language', open: true })}>
          <span lang={locale}>{LOCALE_NAMES[locale]}</span>
        </FloorButton>
      ) : null}
      <FloorHelpButton label={t('frame.help')} hasPopup="dialog" expanded={Boolean(frame.helpOpen)} onPress={() => send({ type: 'help', open: true })} />
    </>
  )

  return (
    <FloorFrame
      label={title}
      header={
        <FloorHeader
          start={start}
          title={
            <span className="fw-floor-title">
              <span className="fw-floor-title-main">{title}</span>
              {where ? <span className="fw-floor-title-where">{where}</span> : null}
            </span>
          }
          end={end}
        />
      }
      banner={
        frame.operator ? (
          <OfflineBanner
            online={frame.online}
            pending={frame.pending}
            refused={frame.refused ?? 0}
            offlineLabel={t('frame.offline')}
            sendingLabel={t('frame.sending')}
            pendingLabel={(count) => t('frame.pending', { count })}
            refusedLabel={(count) => t('frame.refused', { count })}
            syncedLabel={t('frame.synced')}
            showWhenSynced={frame.showSynced}
            lastSyncLabel={frame.lastSentAt ? t('frame.lastSent', { time: formatTime(frame.lastSentAt, { locale }) }) : undefined}
            onOpenQueue={frame.queueButton ? () => send({ type: 'queue' }) : undefined}
            queueLabel={t('frame.openQueue')}
          />
        ) : undefined
      }
      actions={actions}
      overlay={
        frame.idle ? (
          <IdleOverlay
            open={frame.idle.warning}
            secondsLeft={frame.idle.secondsLeft}
            title={t('frame.idle.title')}
            message={t('frame.idle.message')}
            secondsLabel={(count) => t('frame.idle.seconds', { count })}
            stayLabel={t('frame.idle.stay')}
            onStay={() => send({ type: 'stay' })}
            signOutLabel={t('frame.idle.signOut')}
            onSignOut={() => send({ type: 'sign-out' })}
          />
        ) : undefined
      }
    >
      <div id="main-content" tabIndex={-1} className="fw-floor-job">
        {children}
      </div>
      <Modal
        open={Boolean(frame.menuOpen && frame.operator)}
        onClose={() => send({ type: 'menu', open: false })}
        title={frame.operator?.name ?? ''}
        size="sm"
        className="fw-floor-dialog"
      >
        <div className="fw-floor-dialog-body">
          <p className="fw-floor-dialog-line">
            <span className="fw-floor-inline-icon" aria-hidden="true">
              <ScanLine />
            </span>
            {t('frame.menu.switch')}
          </p>
          <LocalePicker label={t('frame.menu.language')} locale={locale} onPick={(next) => send({ type: 'locale', locale: next })} />
          <div className="fw-floor-dialog-actions">
            <FloorButton size="lg" variant="secondary" icon={<X />} onClick={() => send({ type: 'menu', open: false })}>
              {t('frame.close')}
            </FloorButton>
            <FloorButton size="lg" variant="primary" icon={<LogOut />} onClick={() => send({ type: 'sign-out' })}>
              {t('frame.menu.signOut')}
            </FloorButton>
          </div>
        </div>
      </Modal>
      <Modal open={Boolean(frame.helpOpen)} onClose={() => send({ type: 'help', open: false })} title={t('frame.helpDialog.title')} size="sm" className="fw-floor-dialog">
        <div className="fw-floor-dialog-body">
          <p className="fw-floor-dialog-line">{t('frame.helpDialog.body')}</p>
          <p className="fw-floor-dialog-line fw-floor-muted">{t('frame.helpDialog.later')}</p>
          <div className="fw-floor-dialog-actions">
            <FloorButton size="lg" variant="primary" icon={<X />} onClick={() => send({ type: 'help', open: false })}>
              {t('frame.close')}
            </FloorButton>
          </div>
        </div>
      </Modal>
      <Modal open={Boolean(frame.languageOpen)} onClose={() => send({ type: 'language', open: false })} title={t('frame.languageDialog.title')} size="sm" className="fw-floor-dialog">
        <div className="fw-floor-dialog-body">
          <p className="fw-floor-dialog-line fw-floor-muted">{t('frame.languageDialog.body')}</p>
          <LocalePicker
            label={t('frame.languageDialog.title')}
            hideLabel
            locale={locale}
            onPick={(next) => {
              send({ type: 'locale', locale: next })
              send({ type: 'language', open: false })
            }}
          />
        </div>
      </Modal>
    </FloorFrame>
  )
}

/** Each language named in its own words, never by a flag (A2 §3.1): big buttons, the current one pressed. */
function LocalePicker({ label, hideLabel, locale, onPick }: { label: string; hideLabel?: boolean; locale: Locale; onPick: (locale: Locale) => void }) {
  return (
    <div role="group" aria-label={label} className="fw-floor-locales">
      {hideLabel ? null : (
        <span className="fw-floor-locales-label" aria-hidden="true">
          {label}
        </span>
      )}
      <div className="fw-floor-locales-buttons">
        {LOCALES.map((option) => (
          <FloorButton key={option} size="md" variant={option === locale ? 'primary' : 'secondary'} aria-pressed={option === locale} lang={option} onClick={() => onPick(option)}>
            {LOCALE_NAMES[option]}
          </FloorButton>
        ))}
      </div>
    </div>
  )
}
