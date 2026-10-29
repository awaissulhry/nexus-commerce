'use client'

import { ArrowLeft, ArrowRight, BookOpenCheck, CircleAlert, CircleCheck, House, Languages, RotateCcw, ScrollText } from 'lucide-react'
import { FloorActionBar, FloorButton, type FloorActions } from '@nexus/ui/floor'
import { LOCALE_NAMES, isLocale } from '../../../lib/i18n/locales'
import { useT } from '../../../lib/i18n/provider'
import { FloorFrameView, type FrameAction, type FrameModel } from '../../frame/view/FloorFrameView'
import { FloorState } from '../../frame/view/FloorState'

/**
 * SCR-025 — the worker notice, the gate before the tile home (design floor.notice; PLT-208, MES-276, MES-277; GDPR
 * art. 13; Statuto dei Lavoratori art. 4 c.3): after a sign-in, while a version is in force and this worker has not
 * acknowledged it (`notice.due`), the notice opens in the worker's language, in short pages with big Next and Back
 * (no swipe). "I have read it" waits for the last page; it records the version, the language shown and the text's
 * fingerprint (POST /privacy/floor/notice/acknowledge). While the site names workers (`blocksScans`) every scan tile
 * on Home stays held until then. Only the notice's text appears here; nothing else is signed.
 */

export interface NoticeText {
  label: string
  /** The language shown (the one recorded). */
  locale: string
  /** The languages it has on screen. */
  languages: readonly string[]
  /** false: the worker's own language is not ready on screen (a paper copy comes from HR). */
  languageReady: boolean
  pages: readonly string[]
}

export type NoticeState =
  | { kind: 'loading' }
  /** "I have read it" exists only on the last page: reaching it is the only way to acknowledge. */
  | { kind: 'reading'; notice: NoticeText; page: number; busy?: boolean }
  | { kind: 'done'; label: string }
  /** No version in force: nothing to read. */
  | { kind: 'none' }
  /** A newer version came in force while reading: it opens. */
  | { kind: 'newer' }
  | { kind: 'unavailable' }

export interface NoticeViewModel {
  frame: FrameModel
  state: NoticeState
  /** The worker's scans wait for the acknowledgement (the site names workers). */
  blocksScans: boolean
}

export type NoticeAction =
  | { type: 'next' }
  | { type: 'previous' }
  | { type: 'acknowledge' }
  | { type: 'language'; locale: string }
  | { type: 'home' }
  | { type: 'reload' }

export interface NoticeViewProps {
  model: NoticeViewModel
  onAction?: (action: NoticeAction) => void
  onFrame?: (action: FrameAction) => void
}

export function NoticeView({ model, onAction, onFrame }: NoticeViewProps) {
  const t = useT('floor')
  const send = (action: NoticeAction) => onAction?.(action)
  const { state } = model

  let actions: FloorActions | null = null
  let body
  switch (state.kind) {
    case 'loading':
      body = <FloorState tone="info" icon={<ScrollText />} title={t('notice.loading')} busy />
      break
    case 'unavailable':
      body = <FloorState tone="warning" icon={<CircleAlert />} title={t('notice.unavailable.title')} text={t('notice.unavailable.body')} />
      actions = [{ label: t('notice.reload'), icon: <RotateCcw />, onPress: () => send({ type: 'reload' }) }]
      break
    case 'newer':
      body = <FloorState tone="warning" icon={<CircleAlert />} title={t('notice.newer.title')} text={t('notice.newer.body')} />
      actions = [{ label: t('notice.newer.open'), icon: <ScrollText />, onPress: () => send({ type: 'reload' }) }]
      break
    case 'none':
      body = <FloorState tone="info" icon={<ScrollText />} title={t('notice.none.title')} text={t('notice.none.body')} />
      actions = [{ label: t('notice.home'), icon: <House />, onPress: () => send({ type: 'home' }) }]
      break
    case 'done':
      body = <FloorState tone="success" icon={<CircleCheck />} title={t('notice.done.title')} text={t('notice.done.body', { label: state.label })} />
      actions = [{ label: t('notice.home'), icon: <House />, onPress: () => send({ type: 'home' }) }]
      break
    case 'reading': {
      const { notice, page } = state
      const last = page >= notice.pages.length - 1
      const others = notice.languages.filter((language) => language !== notice.locale)
      body = (
        <article className="fw-floor-notice-reader" aria-labelledby="fw-floor-notice-title" lang={notice.locale}>
          <header className="fw-floor-notice-head">
            <h1 id="fw-floor-notice-title" className="fw-floor-section-title">
              <span className="fw-floor-inline-icon" aria-hidden="true">
                <ScrollText />
              </span>
              {t('notice.heading')}
            </h1>
            <p className="fw-floor-muted">
              {t('notice.version', { label: notice.label })} · {t('notice.page', { n: page + 1, total: notice.pages.length })}
            </p>
          </header>
          {model.blocksScans ? (
            <p className="fw-floor-notice" data-tone="warning" role="note">
              <span className="fw-floor-inline-icon" aria-hidden="true">
                <CircleAlert />
              </span>
              {t('notice.blocks')}
            </p>
          ) : null}
          {!notice.languageReady ? (
            <p className="fw-floor-notice" data-tone="info" role="note">
              <span className="fw-floor-inline-icon" aria-hidden="true">
                <Languages />
              </span>
              {t('notice.languageNotReady')}
            </p>
          ) : null}
          <div className="fw-floor-notice-text" aria-live="polite">
            {notice.pages[page]?.split('\n\n').map((paragraph, index) => <p key={index}>{paragraph}</p>)}
          </div>
          {last ? (
            <p className="fw-floor-notice-means">
              <span className="fw-floor-inline-icon" aria-hidden="true">
                <BookOpenCheck />
              </span>
              {t('notice.means')}
            </p>
          ) : null}
          {others.length > 0 ? (
            <div role="group" aria-label={t('notice.otherLanguage')} className="fw-floor-locales">
              <span className="fw-floor-locales-label">{t('notice.otherLanguage')}</span>
              <div className="fw-floor-locales-buttons">
                {others.map((language) => (
                  <FloorButton key={language} size="sm" variant="secondary" lang={language} onClick={() => send({ type: 'language', locale: language })}>
                    {isLocale(language) ? LOCALE_NAMES[language] : language.toUpperCase()}
                  </FloorButton>
                ))}
              </div>
            </div>
          ) : null}
        </article>
      )
      const back = { label: t('notice.previous'), icon: <ArrowLeft />, onPress: () => send({ type: 'previous' }), heldReason: page === 0 ? t('notice.firstPage') : null }
      actions = last
        ? [back, { label: t('notice.acknowledge'), icon: <BookOpenCheck />, onPress: () => send({ type: 'acknowledge' }), variant: 'success', heldReason: state.busy ? t('notice.sending') : null }]
        : [back, { label: t('notice.next'), icon: <ArrowRight />, onPress: () => send({ type: 'next' }) }]
      break
    }
  }

  return (
    <FloorFrameView frame={model.frame} onFrame={onFrame} actions={actions ? <FloorActionBar label={t('notice.heading')} actions={actions} /> : undefined}>
      {body}
    </FloorFrameView>
  )
}
