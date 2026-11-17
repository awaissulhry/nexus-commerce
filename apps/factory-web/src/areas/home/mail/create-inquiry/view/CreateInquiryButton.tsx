'use client'

import Link from 'next/link'
import { ExternalLink, FilePlus2 } from 'lucide-react'
import { Button } from '@nexus/ui/primitives'
import { useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { incomingHref, inquiryHeld, inquiryHref, requestOfMail } from '../model'

type MailFacts = {
  readonly id: string
  readonly status: string
  readonly inquiry?: { readonly id: string; readonly number: string } | null
  readonly thread?: { readonly recordType: string; readonly recordId: string } | null
}

/**
 * "Make incoming request" in a mail's review (B-TH-224; design home.mail pop:create-from): a real link to Sales › Incoming's
 * "Make a request" dialog for this mail (⌘-click opens it in a new tab), or the button held with its reason (no right to answer
 * requests, a mail that could not be read or was thrown away). A mail that became a request offers "Open in Incoming" instead.
 */
export function CreateInquiryButton({ prefix, mail, mayManage }: { prefix: string; mail: MailFacts; mayManage: boolean }) {
  return (
    <WithMessages namespaces={['mail-depth']}>
      <Inner prefix={prefix} mail={mail} mayManage={mayManage} />
    </WithMessages>
  )
}

function Inner({ prefix, mail, mayManage }: { prefix: string; mail: MailFacts; mayManage: boolean }) {
  const t = useT('mail-depth')
  const made = requestOfMail(mail)
  if (made)
    return (
      <Button size="sm" asChild>
        <Link href={incomingHref(prefix, made.id)} title={t('inquiry.madeHint')}>
          <ExternalLink size={14} aria-hidden /> {made.number ? t('verb.openInquiry', { number: made.number }) : t('verb.openInIncoming')}
        </Link>
      </Button>
    )
  const held = inquiryHeld(mail, mayManage)
  if (held)
    return (
      <Button size="sm" heldReason={t(held)}>
        <FilePlus2 size={14} aria-hidden /> {t('verb.createInquiry')}
      </Button>
    )
  return (
    <Button size="sm" asChild>
      <Link href={inquiryHref(prefix, mail.id)}>
        <FilePlus2 size={14} aria-hidden /> {t('verb.createInquiry')}
      </Link>
    </Button>
  )
}
