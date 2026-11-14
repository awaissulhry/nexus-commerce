'use client'

import Link from 'next/link'
import { FilePlus2 } from 'lucide-react'
import { Button } from '@nexus/ui/primitives'
import { useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { inquiryHeld, inquiryHref } from '../model'

/**
 * "Create an inquiry" in a mail's review (design home.mail pop:create-from, W2b part): a real link to Sales › Inquiries'
 * "Make an inquiry" dialog for this mail (⌘-click opens it in a new tab), or the button held with its reason (no right to
 * manage inquiries, a mail that could not be read or was thrown away).
 */
export function CreateInquiryButton({ prefix, mail, mayManage }: { prefix: string; mail: { readonly id: string; readonly status: string }; mayManage: boolean }) {
  return (
    <WithMessages namespaces={['mail-depth']}>
      <Inner prefix={prefix} mail={mail} mayManage={mayManage} />
    </WithMessages>
  )
}

function Inner({ prefix, mail, mayManage }: { prefix: string; mail: { readonly id: string; readonly status: string }; mayManage: boolean }) {
  const t = useT('mail-depth')
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
