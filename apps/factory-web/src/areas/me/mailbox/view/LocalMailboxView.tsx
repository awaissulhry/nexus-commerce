'use client'

import { Inbox, RefreshCw, ServerCrash } from 'lucide-react'
import { Banner, Card, EmptyState, KeyValue } from '@nexus/ui/components'
import { PageHeader } from '@nexus/ui/patterns'
import { Button } from '@nexus/ui/primitives'
import { formatDateTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { addresses, type LocalMailboxModel, type MailboxMessage } from '../model'
import '../mailbox.css'

/**
 * SCR-007-mailbox — Local mailbox (B-W2b-F58; the Owner's local test server only, from the person menu): the mail the FAKE
 * provider "sent" — invitations, password resets, portal sign-in codes, quote links — newest first: who to, the subject,
 * when, the text and its links (each opens in a new tab). Nothing here reached anyone. A link that signs someone in ends this
 * browser's session, so the page says to open it in a private window.
 */
export function LocalMailboxView({ model, onRefresh }: { model: LocalMailboxModel; onRefresh?: () => void }) {
  const t = useT('me')
  const refresh = (
    <Button size="sm" onClick={() => onRefresh?.()}>
      <RefreshCw size={14} aria-hidden /> {t('mailbox.refresh')}
    </Button>
  )
  return (
    <div className="fw-mailbox">
      <PageHeader title={t('mailbox.title')} subtitle={t('mailbox.subtitle')} actions={refresh} />
      {model.state === 'failed' ? (
        <EmptyState icon={<ServerCrash size={28} aria-hidden />} title={t('mailbox.failed.title')} description={t('mailbox.failed.body', { code: model.code })} />
      ) : model.messages.length === 0 ? (
        <EmptyState icon={<Inbox size={28} aria-hidden />} title={t('mailbox.empty.title')} description={t('mailbox.empty.body')} />
      ) : (
        <>
          <Banner tone="info">{t('mailbox.privateWindow')}</Banner>
          <p className="fw-mailbox-count">{t('mailbox.count', { count: model.messages.length })}</p>
          <ol className="fw-mailbox-list" aria-label={t('mailbox.title')}>
            {model.messages.map((message) => (
              <li key={message.id}>
                <MailCard message={message} />
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  )
}

function MailCard({ message }: { message: MailboxMessage }) {
  const t = useT('me')
  const locale = useLocale()
  const items = [
    { label: t('mailbox.to'), value: addresses(message.to) },
    ...(message.cc.length > 0 ? [{ label: t('mailbox.cc'), value: addresses(message.cc) }] : []),
    ...(message.bcc.length > 0 ? [{ label: t('mailbox.bcc'), value: addresses(message.bcc) }] : []),
    { label: t('mailbox.from'), value: message.from },
    { label: t('mailbox.sentAt'), value: formatDateTime(message.sentAt, { locale }) },
  ]
  return (
    <Card header={message.subject || t('mailbox.noSubject')} description={addresses(message.to)} headingLevel={2}>
      <div className="fw-mailbox-mail">
        <KeyValue dense labelCase="sentence" columns={2} items={items} />
        {message.links.length > 0 && (
          <section aria-label={t('mailbox.links')}>
            <h3 className="fw-mailbox-h3">{t('mailbox.links')}</h3>
            <ul className="fw-mailbox-links">
              {message.links.map((link) => (
                <li key={link}>
                  <a href={link} target="_blank" rel="noopener noreferrer">
                    {link}
                  </a>
                </li>
              ))}
            </ul>
          </section>
        )}
        <section aria-label={t('mailbox.text')}>
          <h3 className="fw-mailbox-h3">{t('mailbox.text')}</h3>
          <p className="fw-mailbox-text">{message.text}</p>
        </section>
      </div>
    </Card>
  )
}
