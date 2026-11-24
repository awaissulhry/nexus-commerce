'use client'

import { Banner } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import { formatDateTime } from '../../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { RecordNotices } from '../../../../../_shared/record-frame/RecordNotices'
import type { Party } from '../../../../../parties/_shared/api'
import type { PartyRecordModel } from '../../../../../parties/_shared/model'
import type { PartyRecordActions } from '../../../../../parties/_shared/view/PartyRecordView'
import { NoticeBanner } from '../../../../../parties/_shared/view/parts'

/**
 * F-CO-103 (customer page › Overview; 13-backend §3.4; plan §6.7) — the record's ONE notice area on the Overview tab: the receipt of
 * a write, "someone else changed this record" with Reload, and "You can view, not change…" — the shared notice area's own banners
 * and words (areas/parties/_shared/view/cards.tsx PartyNotices, which every other tab and the supplier's page keep whole).
 * The Blocked and the Archived banners are NOT drawn on this tab: the headline and the first strip say it (once, not three times).
 */
export function OverviewNotices({ model, party, actions }: { model: PartyRecordModel; party: Party; actions?: PartyRecordActions | undefined }) {
  const t = useT('parties')
  const locale = useLocale()
  return (
    <RecordNotices>
      {model.notice ? <NoticeBanner notice={model.notice} onDismiss={actions?.onDismissNotice} /> : null}
      {model.changedAt && (
        <Banner
          tone="warning"
          title={t('record.changed', { time: formatDateTime(model.changedAt, { locale }) })}
          action={
            <Button size="sm" onClick={() => actions?.onReload?.()}>
              {t('record.reload')}
            </Button>
          }
        />
      )}
      {!model.can.manage && party.status !== 'ARCHIVED' && <Banner tone="info" title={t('record.readOnly')} />}
    </RecordNotices>
  )
}
