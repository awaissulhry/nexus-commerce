'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { FileX, ImageOff, Play, ShieldOff } from 'lucide-react'
import { Banner, Card, EmptyState, Tabs, type TabItem } from '@nexus/ui/components'
import { DetailHeader } from '@nexus/ui/patterns'
import { Button, Kbd, Pill, Skeleton, Spinner, Tag } from '@nexus/ui/primitives'
import { Modal } from '../../../../lib/i18n/ds-parts'
import { formatTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { instructionIcon } from '../../../../lib/production/instruction-icons'
import { WithMessages } from '../../../../record-panels/i18n'
import type { VersionStatus } from '../api'
import { NAMESPACES, NS, languageName, type Notice, type Phrase } from '../model'
import '../instructions.css'

/**
 * The parts Work instructions draws (the list, the record, its floor preview and PDF tabs), from design-system parts only;
 * nothing here fetches. The shell has no slot for a page's status and actions (`usePageBand`, design 00 §6.3: a DS gap), so
 * the list draws a head row and the record its band with the DS DetailHeader, as the product libraries do.
 */

/** The page's catalogue plus the list frame's words. */
export function InstructionsMessages({ children }: { children?: ReactNode }) {
  return <WithMessages namespaces={[...NAMESPACES, 'shell']}>{children}</WithMessages>
}

/** A phrase in the page's words ('' for none). */
export function useSay(): (phrase: Phrase | null | undefined) => string {
  const t = useT(NS)
  return (phrase) => (phrase ? t(phrase.key, phrase.params) : '')
}

export const STATUS_TONE: Readonly<Record<VersionStatus, 'success' | 'info' | 'neutral' | 'warning'>> = { DRAFT: 'info', PUBLISHED: 'success', SUPERSEDED: 'neutral', DISCARDED: 'warning' }

/** A version's state as a pill: its word and a tone (never colour alone). */
export function VersionPill({ status, number }: { status: VersionStatus; number?: number }) {
  const t = useT(NS)
  return (
    <Pill tone={STATUS_TONE[status]} size="sm">
      {number === undefined ? t(`status.${status}`) : t('version.pill', { number, status: t(`status.${status}`) })}
    </Pill>
  )
}

/** "Updated 10:42" (or "Not read yet"), announced politely. */
export function Freshness({ asOf }: { asOf: string | null }) {
  const t = useT(NS)
  const locale = useLocale()
  return (
    <span className="fw-wi-hint" role="status">
      {asOf ? t('common.updated', { time: formatTime(asOf, { locale }) }) : t('common.notYet')}
    </span>
  )
}

/** A list page's head: one plain sentence, the freshness, the actions (primary last). */
export function PageHead({ intro, status, actions }: { intro: ReactNode; status?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="fw-wi-head">
      <div className="fw-wi-head-text">
        <p className="fw-wi-hint">{intro}</p>
        {status}
      </div>
      {actions && <div className="fw-wi-actions">{actions}</div>}
    </div>
  )
}

/** One notice at a time (the most serious first), with Dismiss. */
export function NoticeBanner({ notice, onDismiss }: { notice: Notice | null | undefined; onDismiss?: () => void }) {
  const t = useT(NS)
  if (!notice) return null
  return (
    <Banner
      tone={notice.tone}
      title={t(notice.key, notice.params)}
      action={
        onDismiss ? (
          <Button size="sm" variant="quiet" onClick={onDismiss}>
            {t('common.dismiss')}
          </Button>
        ) : undefined
      }
    />
  )
}

export interface RecordTabItem {
  id: string
  label: ReactNode
  count?: number | null
}

/**
 * The record's band (design 00 §2.2; Owner L1: the tabs always in view): ‹ back (a real link), the record's name, its meta,
 * its state, the actions (primary first, ⋯ last), a row of facts and the link tabs (`?tab=`).
 */
export function RecordFrame({
  back,
  title,
  meta,
  status,
  actions,
  facts,
  tabs,
  active,
  tabHref,
  children,
}: {
  back: { href: string; label: string }
  title: ReactNode
  meta?: ReactNode
  status?: ReactNode
  actions?: ReactNode
  facts?: ReactNode
  tabs: readonly RecordTabItem[]
  active: string
  tabHref: (tab: string) => string
  children?: ReactNode
}) {
  const t = useT(NS)
  const items: TabItem[] = tabs.map((tab) => ({ id: tab.id, label: tab.label, count: tab.count ?? null, href: tabHref(tab.id) }))
  return (
    <div className="fw-wi">
      <div className="fw-wi-band">
        <DetailHeader backAsChild backLabel={<Link href={back.href}>{back.label}</Link>} title={title} meta={meta} status={status} actions={actions ? <span className="fw-wi-actions">{actions}</span> : undefined} />
        {facts && <div className="fw-wi-facts">{facts}</div>}
        <Tabs ariaLabel={t('record.tabsLabel')} tabs={items} active={active} size="sm" overflow="scroll" />
      </div>
      {children}
    </div>
  )
}

/** A record that is loading, missing, refused or failed: the band with ‹ back, then the state in words. */
export function RecordState({ back, state, problem, onRetry }: { back: { href: string; label: string }; state: 'loading' | 'error' | 'notFound' | 'forbidden'; problem?: string | null; onRetry?: () => void }) {
  const t = useT(NS)
  return (
    <div className="fw-wi">
      <div className="fw-wi-band">
        <DetailHeader backAsChild backLabel={<Link href={back.href}>{back.label}</Link>} title={state === 'loading' ? <Skeleton width={240} height={22} /> : t(`record.state.${state}.title`)} />
      </div>
      {state === 'loading' ? (
        <Card padded aria-busy="true">
          <p className="fw-wi-hint fw-wi-inline" role="status">
            <Spinner size={14} /> {t('record.loading')}
          </p>
          <div className="fw-wi-skeleton">
            {Array.from({ length: 6 }, (_, index) => (
              <Skeleton key={index} height={22} />
            ))}
          </div>
        </Card>
      ) : (
        <Card padded>
          <EmptyState
            icon={state === 'forbidden' ? <ShieldOff size={24} aria-hidden /> : <FileX size={24} aria-hidden />}
            title={t(`record.state.${state}.title`)}
            description={state === 'error' && problem ? t(problem) : t(`record.state.${state}.body`)}
            action={
              state === 'error' ? (
                <Button size="sm" onClick={onRetry}>
                  {t('common.retry')}
                </Button>
              ) : (
                <Button size="sm" asChild>
                  <Link href={back.href}>{t('record.backToList')}</Link>
                </Button>
              )
            }
          />
        </Card>
      )}
    </div>
  )
}

/** The page's keys in one dialog (`?`): a `lists` key (`keys.open`) or the page's own words. */
export function KeysDialog({ keys, onClose }: { keys: ReadonlyArray<{ keys: readonly string[]; does: string }>; onClose: () => void }) {
  const t = useT(NS)
  const lists = useT('lists')
  return (
    <Modal open onClose={onClose} title={t('keys.title')} size="sm">
      <dl className="fw-wi-keymap">
        {keys.map((entry) => (
          <div key={entry.does} className="fw-wi-keymap-row">
            <dt>
              {entry.keys.map((key) => (
                <Kbd key={key}>{key}</Kbd>
              ))}
            </dt>
            <dd>{entry.does.startsWith('keys.') ? lists(entry.does) : entry.does}</dd>
          </div>
        ))}
      </dl>
    </Modal>
  )
}

/** A step's icon (its word beside it for a screen reader), the plain mark for none. */
export function StepIcon({ icon, size = 18 }: { icon: string | null; size?: number }) {
  const t = useT(NS)
  const Icon = instructionIcon(icon)
  return (
    <span className="fw-wi-icon" data-none={icon ? undefined : 'true'}>
      <Icon size={size} aria-hidden />
      <span className="fw-wi-sr">{icon ? t(`icon.${icon}`) : t('icon.none')}</span>
    </span>
  )
}

/** The languages written, each a chip; the floor languages missing marked (word and mark, never colour alone). */
export function LanguageChips({ written, missing }: { written: readonly string[]; missing: readonly string[] }) {
  const t = useT(NS)
  const locale = useLocale()
  if (written.length === 0 && missing.length === 0) return <span className="fw-wi-hint">—</span>
  return (
    <span className="fw-wi-chips">
      {written.map((language) => (
        <Tag key={language} tone="neutral" title={languageName(language, locale)}>
          {language.toUpperCase()}
        </Tag>
      ))}
      {missing.map((language) => (
        <Tag key={`missing-${language}`} tone="warning" title={t('language.missingTitle', { language: languageName(language, locale) })}>
          {t('language.missingChip', { code: language.toUpperCase() })}
        </Tag>
      ))}
    </span>
  )
}

/**
 * A photo or a short video of a step: the picture whole (never cropped), a video muted and looping; without an address (no
 * files.read, still uploading, not read yet) its kind and name in words.
 */
export function MediaThumb({ kind, src, name, caption, large }: { kind: 'PHOTO' | 'VIDEO'; src: string | null | undefined; name: string; caption?: string | null; large?: boolean }) {
  const t = useT(NS)
  const label = caption || name
  return (
    <figure className="fw-wi-media" data-size={large ? 'large' : 'small'}>
      <div className="fw-wi-media-frame">
        {src ? (
          kind === 'VIDEO' ? (
            <video src={src} muted loop autoPlay playsInline aria-label={t('media.videoOf', { name: label })} />
          ) : (
            <img src={src} alt={t('media.photoOf', { name: label })} />
          )
        ) : (
          <span className="fw-wi-media-none">
            {kind === 'VIDEO' ? <Play size={20} aria-hidden /> : <ImageOff size={20} aria-hidden />}
            <span>{t(kind === 'VIDEO' ? 'media.kind.VIDEO' : 'media.kind.PHOTO')}</span>
          </span>
        )}
      </div>
      {(caption || !src) && <figcaption className="fw-wi-hint">{caption || name}</figcaption>}
    </figure>
  )
}
