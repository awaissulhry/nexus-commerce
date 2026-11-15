'use client'

import { AlarmClock } from 'lucide-react'
import { Button } from '@nexus/ui/primitives'
import { useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { askRemindMe } from '../model'

/**
 * A message's "Remind me" (design shell.panels popup remind-me, opened from "a message's ⋯"): a quiet button in the message's
 * head that asks the record's Remind me control (RecordRemindMe, beside Follow) to open about this message.
 */
export function MessageRemindMe({ record, messageId }: { record: { readonly type: string; readonly id: string }; messageId: string }) {
  return (
    <WithMessages namespaces={['home-mywork']}>
      <RemindButton record={record} messageId={messageId} />
    </WithMessages>
  )
}

function RemindButton({ record, messageId }: { record: { readonly type: string; readonly id: string }; messageId: string }) {
  const t = useT('home-mywork')
  return (
    <Button size="sm" variant="quiet" aria-label={t('remind.aboutMessage')} title={t('remind.aboutMessage')} onClick={() => askRemindMe({ recordType: record.type, recordId: record.id, messageId })}>
      <AlarmClock size={13} aria-hidden />
    </Button>
  )
}
