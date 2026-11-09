'use client'

import { createContext, useContext, type ReactNode } from 'react'
import { Clock3, Link2Off, Loader2, MailQuestion, ShieldAlert, UserX } from 'lucide-react'
import { Banner, Card, EmptyState, KeyValue } from '@nexus/ui/components'
import { EndState } from '@nexus/ui/components/EndState/index'
import { PdfViewer } from '@nexus/ui/components/PdfViewer/index'
import { SegmentedControl } from '@nexus/ui/primitives'
import { brandingAttrs, checkBranding, type BrandingTokens } from '@nexus/ui/tokens/branding'
import { densityAttrs } from '@nexus/ui/tokens/density'
import '@nexus/ui/styles/branding.css'
import { useDsLabels } from '../../../lib/i18n/ds-labels'
import { formatDateTime, formatTime } from '../../../lib/i18n/format'
import { LOCALES, LOCALE_NAMES, isLocale } from '../../../lib/i18n/locales'
import { useLocale, useLocaleSwitch, useT } from '../../../lib/i18n/provider'
import { pdfViewerLabels } from '../../../lib/pdf/labels'
import { WithMessages } from '../../../record-panels/i18n'
import { linkStateLook, type LinkState } from '../link-state'
import { useLinkRenew } from '../renew/context'
import { ASKS_FOR_NEW_LINK, renewEnd, type LinkRenew } from '../renew/model'
import '../links.css'

/**
 * SCR-028 — the link frame and the link states (SAL-099, PLT-007, GAP-005; A2 §3.2). A link page has NO chrome: no
 * navigation, no search, nothing about the factory's other records (the partner wall, PLT-007). At the top the
 * SENDER (their logo and accent through the DS branding tokens, G20), the record's title and the language; one task in
 * the middle; at the foot whom to ask and the sender's PRIVACY NOTICE (GDPR art. 13/14: one notice per company, linked
 * wherever personal data is collected — `/privacy/<company id>`, the address the API's email footer uses too).
 * Comfortable density (G1): controls and targets 44 px, body 16 px, phone first.
 */

export interface LinkSender extends BrandingTokens {
  /** For the privacy notice's address. */
  companyId?: string | null
  /** Whom to ask. */
  contact?: { name?: string | null; email?: string | null; phone?: string | null } | null
}

export type LinkFrameBody =
  | {
      kind: 'link'
      state: LinkState
      /** What the link is for (QUOTE_ACCEPT, PO_CONFIRM, DOCUMENT_VIEW, DEPOSIT_INFO); null before it opened. */
      purpose: string | null
      expiresAt: string | null
      usesLeft: number | null
      /** A document the link shows (DOCUMENT_VIEW). */
      document?: { title: string; fileName: string; data: Uint8Array } | null
    }
  /** The sender's privacy notice (`/privacy/<company>`); W0: not published here yet. */
  | { kind: 'privacy'; notice: string | null }
  /** A module's task page (accept a quote, SCR-099): the frame, and the task as the children; the page says its own states. */
  | { kind: 'task' }

/**
 * B-W2b-161: the link's sender as its company's branding gives it (LinkLanding reads `GET /link/branding` once the link
 * opened); null: none read (no link, a dead one, or the read failed: the sender's name in text, the standard colours).
 */
export const LinkBrandingContext = createContext<LinkSender | null>(null)

/** The sender the frame shows: what the page gave, each field missing there from the branding. */
export function senderOf(given: LinkSender | null, branding: LinkSender | null): LinkSender | null {
  if (!branding) return given
  if (!given) return branding
  return {
    ...given,
    name: given.name || branding.name,
    companyId: given.companyId ?? branding.companyId,
    logoUrl: given.logoUrl ?? branding.logoUrl,
    logoDarkUrl: given.logoDarkUrl ?? branding.logoDarkUrl,
    accent: given.accent ?? branding.accent,
  }
}

export interface LinkFrameViewModel {
  /** Who sent the link; null when the page cannot know (no token, or the link opened nothing). */
  sender: LinkSender | null
  /** The record's title ("Quote Q-2026-0042"); null when unknown. */
  title: string | null
  body: LinkFrameBody
  /** The site's time zone, for the expiry. */
  timeZone?: string
  /**
   * B-W2b-169: "Ask for a new link" on a used, expired or unavailable link — a design case gives it (null: none);
   * the live page leaves it out and the landing's provider gives it (renew/LinkRenew.tsx).
   */
  renew?: LinkRenew | null
}

export interface LinkFrameViewProps {
  model: LinkFrameViewModel
  /** The task of a valid link (a module's page: accept a quote, confirm a PO). */
  children?: ReactNode
}

const STATE_ICON: Record<LinkState, ReactNode> = {
  loading: <Loader2 size={28} aria-hidden className="fw-link-spin" />,
  valid: null,
  used: <Link2Off size={28} aria-hidden />,
  expired: <Clock3 size={28} aria-hidden />,
  wrong_person: <UserX size={28} aria-hidden />,
  withdrawn: <Link2Off size={28} aria-hidden />,
  unavailable: <Link2Off size={28} aria-hidden />,
  missing: <MailQuestion size={28} aria-hidden />,
  error: <ShieldAlert size={28} aria-hidden />,
}

export function LinkFrameView({ model, children }: LinkFrameViewProps) {
  const t = useT('shell')
  const locale = useLocale()
  const switchLocale = useLocaleSwitch()
  const sender = senderOf(model.sender, useContext(LinkBrandingContext))
  const brand = sender ? checkBranding(sender) : null
  // Unknown (no token, or the link opened nothing): the text then speaks of "whoever sent it" in its own words.
  const senderName = brand?.name || null
  const privacyHref = sender?.companyId ? `/privacy/${encodeURIComponent(sender.companyId)}` : null

  return (
    <div className="fw-link" {...densityAttrs('comfortable')} {...(brand ? brandingAttrs(brand) : {})}>
      <header className="fw-link-head">
        <div className="fw-link-sender">
          {/* A tenant's logo from its own address (checkBranding keeps only https, this site or an inline image). The
              theme is the `.dark` class, so the dark logo is a second image the stylesheet swaps in. */}
          {brand?.logoUrl ? (
            <>
              <img className={`fw-link-logo${brand.logoDarkUrl && brand.logoDarkUrl !== brand.logoUrl ? ' for-light' : ''}`} src={brand.logoUrl} alt={brand.name} />
              {brand.logoDarkUrl && brand.logoDarkUrl !== brand.logoUrl && <img className="fw-link-logo for-dark" src={brand.logoDarkUrl} alt={brand.name} />}
            </>
          ) : (
            senderName && <span className="fw-link-sender-name">{senderName}</span>
          )}
        </div>
        <SegmentedControl
          ariaLabel={t('links.language')}
          value={locale}
          onChange={(value) => isLocale(value) && switchLocale?.(value)}
          options={LOCALES.map((option) => ({ value: option, label: <span lang={option}>{LOCALE_NAMES[option]}</span> }))}
        />
      </header>

      <main id="main-content" className="fw-link-main" tabIndex={-1}>
        {model.title && <h1 className="fw-link-title">{model.title}</h1>}
        {model.body.kind === 'privacy' ? (
          <PrivacyBody notice={model.body.notice} senderName={senderName} />
        ) : model.body.kind === 'task' ? (
          <div className="fw-link-body">{children}</div>
        ) : (
          <LinkBody body={model.body} senderName={senderName} timeZone={model.timeZone} renew={model.renew}>
            {children}
          </LinkBody>
        )}
      </main>

      <footer className="fw-link-foot">
        {sender?.contact && (sender.contact.email || sender.contact.phone) && (
          <p className="fw-link-contact">
            {t('links.contact', { name: sender.contact.name || senderName || '' })}{' '}
            {sender.contact.email && <a href={`mailto:${sender.contact.email}`}>{sender.contact.email}</a>}
            {sender.contact.email && sender.contact.phone && ' · '}
            {sender.contact.phone && <a href={`tel:${sender.contact.phone.replace(/\s+/g, '')}`}>{sender.contact.phone}</a>}
          </p>
        )}
        <p className="fw-link-legal">
          {privacyHref && senderName && model.body.kind !== 'privacy' ? (
            <a href={privacyHref}>{t('links.privacy', { sender: senderName })}</a>
          ) : (
            model.body.kind !== 'privacy' && <span>{t('links.privacyUnknown')}</span>
          )}
          <span className="fw-link-by">{t('links.sentWith')}</span>
        </p>
      </footer>
    </div>
  )
}

function LinkBody({ body, senderName, timeZone, renew, children }: { body: Extract<LinkFrameBody, { kind: 'link' }>; senderName: string | null; timeZone?: string; renew?: LinkRenew | null; children?: ReactNode }) {
  const t = useT('shell')
  const locale = useLocale()
  const look = linkStateLook(body.state)

  if (body.state === 'valid') {
    const facts = [
      ...(body.purpose ? [{ label: t('links.facts.purpose'), value: t(`links.purpose.${body.purpose}`) }] : []),
      ...(body.expiresAt ? [{ label: t('links.facts.expires'), value: formatDateTime(body.expiresAt, { locale, timeZone }) }] : []),
      ...(body.usesLeft !== null ? [{ label: t('links.facts.usesLeft'), value: t('links.usesLeft', { count: body.usesLeft }) }] : []),
    ]
    return (
      <div className="fw-link-body">
        <Banner tone="success" title={t('links.state.valid.title')}>
          {senderName ? t('links.state.valid.body', { sender: senderName }) : t('links.state.valid.bodyAnonymous')}
        </Banner>
        {facts.length > 0 && (
          <Card padded>
            <KeyValue items={facts} labelCase="sentence" />
          </Card>
        )}
        {body.document && <PdfViewer src={body.document.data} title={body.document.title} fileName={body.document.fileName} labels={pdfViewerLabels(t)} height="min(60vh, 640px)" />}
        {children}
      </div>
    )
  }

  if (body.state === 'loading') {
    return (
      <Card padded className={`fw-link-state tone-${look.tone}`} role="status" aria-live="polite">
        <EmptyState
          icon={STATE_ICON[body.state]}
          title={t(`links.state.${body.state}.title`)}
          description={senderName ? t(`links.state.${body.state}.body`, { sender: senderName }) : t(`links.state.${body.state}.bodyAnonymous`)}
        />
      </Card>
    )
  }

  // B-W2b-169: one EndState for every end; a used, expired or unavailable link offers "Ask for a new link".
  return (
    <WithMessages namespaces={['link-frame', 'ds-words']}>
      <DeadLink state={body.state} senderName={senderName} timeZone={timeZone} renew={renew} />
    </WithMessages>
  )
}

/** B-W2b-169: a link that opens nothing (used, expired, withdrawn, wrong person, missing, error) as the DS EndState. */
function DeadLink({ state, senderName, timeZone, renew: given }: { state: LinkState; senderName: string | null; timeZone?: string; renew?: LinkRenew | null }) {
  const t = useT('shell')
  const f = useT('link-frame')
  const locale = useLocale()
  const ds = useDsLabels(timeZone)
  const look = linkStateLook(state)
  const provided = useLinkRenew(given)
  const renew = ASKS_FOR_NEW_LINK.has(state) ? provided : null
  const end = renew ? renewEnd(renew, (key) => f(key, { time: renew.waitUntil ? formatTime(renew.waitUntil, { locale, timeZone }) : '' })) : null
  return (
    <EndState
      tone={look.tone}
      icon={STATE_ICON[state]}
      title={t(`links.state.${state}.title`)}
      body={senderName ? t(`links.state.${state}.body`, { sender: senderName }) : t(`links.state.${state}.bodyAnonymous`)}
      next={end?.next}
      actions={end ? [end.action] : undefined}
      labels={ds.endState}
    />
  )
}

function PrivacyBody({ notice, senderName }: { notice: string | null; senderName: string | null }) {
  const t = useT('shell')
  return (
    <div className="fw-link-body">
      <h1 className="fw-link-title">{senderName ? t('privacy.title', { sender: senderName }) : t('privacy.titleAnonymous')}</h1>
      {notice ? (
        <Card padded>
          <div className="fw-link-notice">{notice}</div>
        </Card>
      ) : (
        <Card padded className="fw-link-state tone-info">
          <EmptyState
            icon={<MailQuestion size={28} aria-hidden />}
            title={t('privacy.pending.title')}
            description={senderName ? t('privacy.pending.body', { sender: senderName }) : t('privacy.pending.bodyAnonymous')}
          />
        </Card>
      )}
    </div>
  )
}
