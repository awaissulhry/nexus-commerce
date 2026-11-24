'use client'

import { useMemo, useState } from 'react'
import { CheckCircle2, CircleAlert, CircleHelp, ImageOff } from 'lucide-react'
import { Banner } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import { Modal } from '../../../i18n/ds-parts'
import { formatDateTime } from '../../../i18n/format'
import { useLocale, useT } from '../../../i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { checkWords, ORIGINAL_SANDBOX, originalDocument, remotePictures, SENDER_CHECKS, type MailVerdict, type SenderCheck } from '../model'
import { POPUPS_NS } from './FileViewer'
import '../popups.css'

export interface OriginalEmailModel {
  /** "Name <address>" as the mail had it (our email: who of ours sent it). */
  from: string
  to: readonly string[]
  cc: readonly string[]
  subject: string | null
  /** When it arrived (or, `sent`, when we sent it). */
  receivedAt: string
  /** The API's sanitised HTML (remote pictures wait in `data-remote-src`), or null: the plain text is shown. */
  bodyHtml: string | null
  bodyText: string | null
  /** The sender checks of an inbound mail; null: none to say (our own email, or an inbound one whose mail row was not read). */
  verdicts: Readonly<Record<SenderCheck, MailVerdict>> | null
  timeZone?: string
  // ---- tw- W2.2 (B7, Z2): the ONE Email details window for our email too — "Sent" instead of "Received", and its delivery state in
  // words (never "read"). An empty To (an inbound mail whose headers were not read) is not drawn.
  sent?: boolean
  status?: string | null
  // ---- end tw- W2.2
}

/**
 * tw- W2.2 (B7, Z2; 10-design §9): the ONE "Email details" window of a message's menu — From · To · Cc · Subject · the date · (our
 * email) its state · (an inbound one) the sender checks · "The email as it came" — for our email and an inbound one alike.
 *
 * "Show original e-mail" (B-TH-211, T-POP-F02): what arrived, proved without running anything — the sanitised mail in a
 * frame sandboxed with nothing allowed (no script, no same origin, no form, no pop-up), its links as plain text, remote
 * pictures only after "Show pictures", and the sender checks (SPF, DKIM, DMARC) in words. Office only: the portal and a
 * link never offer it. Centred, titled, Esc closes, focus returns.
 */
export function OriginalEmail({ model, onClose }: { model: OriginalEmailModel; onClose: () => void }) {
  return (
    <WithMessages namespaces={[POPUPS_NS]}>
      <Original model={model} onClose={onClose} />
    </WithMessages>
  )
}

function Original({ model, onClose }: { model: OriginalEmailModel; onClose: () => void }) {
  const t = useT(POPUPS_NS)
  const locale = useLocale()
  const [allow, setAllow] = useState(false)
  const pictures = remotePictures(model.bodyHtml)
  const srcDoc = useMemo(() => (model.bodyHtml ? originalDocument(model.bodyHtml, { allowPictures: allow }) : null), [model.bodyHtml, allow])
  const verdicts = model.verdicts
  const failed = verdicts ? SENDER_CHECKS.filter((check) => verdicts[check] === 'FAIL') : []
  return (
    <Modal open onClose={onClose} size="xl" title={t('original.title')}>
      <div className="fw-rtp-original">
        <dl className="fw-rtp-meta">
          <dt>{t('original.from')}</dt>
          <dd>{model.from}</dd>
          {model.to.length > 0 && (
            <>
              <dt>{t('original.to')}</dt>
              <dd>{model.to.join(', ')}</dd>
            </>
          )}
          {model.cc.length > 0 && (
            <>
              <dt>{t('original.cc')}</dt>
              <dd>{model.cc.join(', ')}</dd>
            </>
          )}
          {model.subject !== null && (
            <>
              <dt>{t('original.subject')}</dt>
              <dd>{model.subject || t('original.noSubject')}</dd>
            </>
          )}
          <dt>{t(model.sent ? 'original.sent' : 'original.received')}</dt>
          <dd>{formatDateTime(model.receivedAt, { locale, ...(model.timeZone ? { timeZone: model.timeZone } : {}) })}</dd>
          {model.status && (
            <>
              <dt>{t('original.status')}</dt>
              <dd>{model.status}</dd>
            </>
          )}
        </dl>
        {failed.length > 0 && <Banner tone="warning" title={t('original.failedTitle')} />}
        {verdicts && (
        <ul className="fw-rtp-checks" aria-label={t('original.checks')}>
          {SENDER_CHECKS.map((check) => {
            const words = checkWords(check, verdicts[check])
            const Icon = words.tone === 'success' ? CheckCircle2 : words.tone === 'danger' ? CircleAlert : CircleHelp
            return (
              <li key={check} className={`fw-rtp-check is-${words.tone}`}>
                <Icon size={14} aria-hidden /> {t(words.key, { name: check.toUpperCase() })}
              </li>
            )
          })}
        </ul>
        )}
        <h3 className="fw-rtp-astitle">{t('original.asItCame')}</h3>
        {pictures > 0 && !allow && (
          <p className="fw-rtp-pictures">
            <ImageOff size={14} aria-hidden /> {t('original.picturesBlocked', { count: pictures })}
            <Button size="sm" onClick={() => setAllow(true)}>
              {t('original.showPictures')}
            </Button>
          </p>
        )}
        {srcDoc ? (
          <iframe className="fw-rtp-frame" title={t('original.frame')} sandbox={ORIGINAL_SANDBOX} referrerPolicy="no-referrer" srcDoc={srcDoc} />
        ) : (
          <pre className="fw-rtp-plain">{model.bodyText ?? t('original.empty')}</pre>
        )}
      </div>
    </Modal>
  )
}
