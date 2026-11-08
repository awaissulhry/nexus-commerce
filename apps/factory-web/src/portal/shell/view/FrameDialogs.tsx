'use client'

import { AlertCircle } from 'lucide-react'
import { KeyValue } from '@nexus/ui/components'
import { Button, Kbd, SegmentedControl, Skeleton } from '@nexus/ui/primitives'
import { Countdown, Modal } from '../../../lib/i18n/ds-parts'
import { LOCALES, LOCALE_NAMES, type Locale } from '../../../lib/i18n/locales'
import { useT } from '../../../lib/i18n/provider'
import type { ThemeMode } from '../../../lib/theme/theme'

/**
 * The frame's small pop-ups (design portal.frame): Still there? (two minutes before the idle sign-out), Keyboard shortcuts
 * (`?`), Leave without sending? (typed work and a way out), My access (the person menu: the role and what it allows, who
 * the admin is) and Language and theme (the person menu: Italian or English for the person, Light / Dark / System for this
 * device). Each a DS Modal: focus moves in, Tab stays inside, Esc closes and the focus goes back; a bottom sheet on a phone.
 */

// ── Still there? ─────────────────────────────────────────────────────────────────────────────────────────────────────
export interface StillThereModel {
  open: boolean
  /** When the session ends (ISO). */
  endsAt: string
  /** "Stay signed in" moves the idle end; false: the 12 hours end it and only a new sign-in helps. */
  canStay: boolean
  busy?: boolean
  failed?: boolean
  /** The read's clock (the design cases). */
  now?: number
}

export function StillThereView({ model, onStay, onSignOut, onEnded }: { model: StillThereModel; onStay?: () => void; onSignOut?: () => void; onEnded?: () => void }) {
  const t = useT('portal')
  return (
    <Modal
      open={model.open}
      onClose={() => onStay?.()}
      sheet
      size="sm"
      title={t('still.title')}
      initialFocus="dialog"
      footer={
        <>
          <Button onClick={onSignOut}>{t('still.signOut')}</Button>
          <Button variant="primary" onClick={onStay} heldReason={model.busy ? t('still.staying') : model.canStay ? null : t('still.cannotStay')} autoFocus>
            {t('still.stay')}
          </Button>
        </>
      }
    >
      <p className="fw-pdialog-text">{t('still.body')}</p>
      <p className="fw-pdialog-text">
        <Countdown to={model.endsAt} label={(left) => t('still.left', { left })} doneLabel={t('still.ended')} onDone={onEnded} announce now={model.now} />
      </p>
      {model.failed ? (
        <p className="fw-pdialog-failed" role="alert">
          {t('still.failed')}
        </p>
      ) : null}
    </Modal>
  )
}

// ── Keyboard shortcuts ───────────────────────────────────────────────────────────────────────────────────────────────
export interface ShortcutGroup {
  title: string
  keys: readonly { keys: readonly string[]; words: string }[]
}

export function ShortcutsView({ open, groups, onClose }: { open: boolean; groups: readonly ShortcutGroup[]; onClose: () => void }) {
  const t = useT('portal')
  return (
    <Modal open={open} onClose={onClose} sheet size="md" title={t('keys.title')} footer={<Button onClick={onClose}>{t('keys.close')}</Button>}>
      <div className="fw-pkeys">
        {groups
          .filter((group) => group.keys.length > 0)
          .map((group) => (
            <section key={group.title} className="fw-pkeys-group" aria-label={group.title}>
              <h3 className="fw-pkeys-title">{group.title}</h3>
              <dl className="fw-pkeys-list">
                {group.keys.map((entry) => (
                  <div key={`${entry.keys.join('+')}-${entry.words}`} className="fw-pkeys-row">
                    <dt>
                      {entry.keys.map((key, index) => (
                        <span key={`${key}-${index}`}>
                          {index > 0 ? <span className="fw-pkeys-then"> {t('keys.then')} </span> : null}
                          <Kbd>{key}</Kbd>
                        </span>
                      ))}
                    </dt>
                    <dd>{entry.words}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
      </div>
    </Modal>
  )
}

// ── Leave without sending? ───────────────────────────────────────────────────────────────────────────────────────────
export interface UnsavedModel {
  open: boolean
  /** What would be lost, in one line. */
  what: string
  /** The page can send or save it from here. */
  canSave: boolean
  saving?: boolean
}

export function UnsavedGuardView({ model, onSave, onDiscard, onStay }: { model: UnsavedModel; onSave?: () => void; onDiscard?: () => void; onStay: () => void }) {
  const t = useT('portal')
  return (
    <Modal
      open={model.open}
      onClose={onStay}
      sheet
      size="sm"
      title={t('unsaved.title')}
      footer={
        <>
          {model.canSave ? (
            <Button onClick={onSave} heldReason={model.saving ? t('unsaved.saving') : null}>
              {t('unsaved.save')}
            </Button>
          ) : null}
          <Button variant="danger-outline" onClick={onDiscard}>
            {t('unsaved.discard')}
          </Button>
          <Button variant="primary" onClick={onStay} autoFocus>
            {t('unsaved.stay')}
          </Button>
        </>
      }
    >
      <p className="fw-pdialog-text">{model.what}</p>
    </Modal>
  )
}

// ── My access ────────────────────────────────────────────────────────────────────────────────────────────────────────
export interface MyAccessModel {
  open: boolean
  state: 'loading' | 'error' | 'ready'
  /** The role's name in the person's language; null: an office preview (no role of its own). */
  role: string | null
  /** The role sees prices. */
  prices: boolean
  /** What the person may also do (comment, upload, approve), in words. */
  capabilities: readonly string[]
  /** What the session allows, in words. */
  allows: readonly string[]
  /** The end of access, written; null: none. */
  until: string | null
  /** "Your admin is …": the organisation's admins. */
  admins: readonly string[]
  preview: boolean
}

export function MyAccessView({ model, onClose, onRetry }: { model: MyAccessModel; onClose: () => void; onRetry?: () => void }) {
  const t = useT('portal')
  return (
    <Modal open={model.open} onClose={onClose} sheet size="md" title={t('access.title')} footer={<Button onClick={onClose}>{t('access.close')}</Button>}>
      {model.state === 'loading' ? (
        <div role="status" aria-label={t('state.loading')} className="fw-pemail-loading">
          <Skeleton height={40} />
          <Skeleton height={80} />
        </div>
      ) : model.state === 'error' ? (
        <div className="fw-pstate" role="alert">
          <AlertCircle size={18} aria-hidden />
          <span>{t('access.failed')}</span>
          {onRetry ? <Button onClick={onRetry}>{t('state.retry')}</Button> : null}
        </div>
      ) : (
        <div className="fw-paccess">
          <KeyValue
            items={[
              { label: t('access.role'), value: model.preview ? t('access.preview') : (model.role ?? t('access.noRole')) },
              { label: t('access.prices'), value: model.prices ? t('access.pricesYes') : t('access.pricesNo') },
              { label: t('access.capabilities'), value: model.capabilities.length > 0 ? model.capabilities.join(', ') : t('access.readOnly') },
              { label: t('access.until'), value: model.until ?? t('access.noEnd') },
            ]}
          />
          <section aria-label={t('access.allowsTitle')}>
            <h3 className="fw-pkeys-title">{t('access.allowsTitle')}</h3>
            {model.allows.length > 0 ? (
              <ul className="fw-paccess-list">
                {model.allows.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            ) : (
              <p className="fw-pdialog-text">{t('access.allowsNone')}</p>
            )}
          </section>
          <p className="fw-pdialog-text">{model.admins.length > 0 ? t('access.admins', { names: model.admins.join(', ') }) : t('access.noAdmin')}</p>
        </div>
      )}
    </Modal>
  )
}

// ── Language and theme ───────────────────────────────────────────────────────────────────────────────────────────────
export interface DisplayModel {
  open: boolean
  locale: Locale
  theme: ThemeMode
  /** The language change is being saved. */
  saving?: boolean
  failed?: boolean
  /** An office preview: the language is the viewer's own office setting, changed in the office. */
  preview: boolean
}

export function DisplayView({ model, onLocale, onTheme, onClose }: { model: DisplayModel; onLocale?: (locale: Locale) => void; onTheme?: (theme: ThemeMode) => void; onClose: () => void }) {
  const t = useT('portal')
  return (
    <Modal open={model.open} onClose={onClose} sheet size="sm" title={t('display.title')} footer={<Button onClick={onClose}>{t('display.close')}</Button>}>
      <div className="fw-pdisplay">
        <div className="fw-pdisplay-row">
          <span className="fw-pdisplay-label" id="fw-pdisplay-lang">
            {t('display.language')}
          </span>
          {model.preview ? (
            <span className="fw-pdialog-text">{t('display.previewLanguage')}</span>
          ) : (
            <SegmentedControl ariaLabel={t('display.language')} options={LOCALES.map((locale) => ({ value: locale, label: LOCALE_NAMES[locale] }))} value={model.locale} onChange={(value) => onLocale?.(value as Locale)} disabled={model.saving} />
          )}
          <span className="fw-pdisplay-hint">{model.saving ? t('display.saving') : t('display.languageHint')}</span>
          {model.failed ? (
            <span className="fw-pdialog-failed" role="alert">
              {t('display.failed')}
            </span>
          ) : null}
        </div>
        <div className="fw-pdisplay-row">
          <span className="fw-pdisplay-label">{t('display.theme')}</span>
          <SegmentedControl
            ariaLabel={t('display.theme')}
            options={(['light', 'dark', 'system'] as const).map((mode) => ({ value: mode, label: t(`display.themes.${mode}`) }))}
            value={model.theme}
            onChange={(value) => onTheme?.(value as ThemeMode)}
          />
          <span className="fw-pdisplay-hint">{t('display.themeHint')}</span>
        </div>
      </div>
    </Modal>
  )
}
