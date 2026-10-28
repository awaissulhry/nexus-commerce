'use client'

import type { ReactNode } from 'react'
import { Clock3, Link2Off, Loader2, MailQuestion, ShieldAlert, UserX } from 'lucide-react'
import { Banner, Card, EmptyState, KeyValue } from '@nexus/ui/components'
import { PdfViewer } from '@nexus/ui/components/PdfViewer/index'
import { SegmentedControl } from '@nexus/ui/primitives'
import { brandingAttrs, checkBranding, type BrandingTokens } from '@nexus/ui/tokens/branding'
import { densityAttrs } from '@nexus/ui/tokens/density'
import '@nexus/ui/styles/branding.css'
import { formatDateTime } from '../../../lib/i18n/format'
import { LOCALES, LOCALE_NAMES, isLocale } from '../../../lib/i18n/locales'
import { useLocale, useLocaleSwitch, useT } from '../../../lib/i18n/provider'
import { pdfViewerLabels } from '../../../lib/pdf/labels'
import { linkStateLook, type LinkState } from '../link-state'
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

export interface LinkFrameViewModel {
  /** Who sent the link; null when the page cannot know (no token, or the link opened nothing). */
  sender: LinkSender | null
  /** The record's title ("Quote Q-2026-0042"); null when unknown. */
  title: string | null
  body: LinkFrameBody
  /** The site's time zone, for the expiry. */
  timeZone?: string
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
  const sender = model.sender
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
        {model.body.kind === 'privacy' ? <PrivacyBody notice={model.body.notice} senderName={senderName} /> : <LinkBody body={model.body} senderName={senderName} timeZone={model.timeZone}>{children}</LinkBody>}
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

function LinkBody({ body, senderName, timeZone, children }: { body: Extract<LinkFrameBody, { kind: 'link' }>; senderName: string | null; timeZone?: string; children?: ReactNode }) {
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

  return (
    <Card padded className={`fw-link-state tone-${look.tone}`} role={body.state === 'loading' ? 'status' : undefined} aria-live={body.state === 'loading' ? 'polite' : undefined}>
      <EmptyState
        icon={STATE_ICON[body.state]}
        title={t(`links.state.${body.state}.title`)}
        description={senderName ? t(`links.state.${body.state}.body`, { sender: senderName }) : t(`links.state.${body.state}.bodyAnonymous`)}
      />
    </Card>
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
