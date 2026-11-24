'use client'

import { Banner } from '@nexus/ui/components'
import { WithMessages } from '../../../../../../record-panels/i18n'
import { NS as DEPTH_NS } from '../../../depth/model'
import { NoticeLine as DepthNoticeLine } from '../../../depth/view/parts'
import { CT } from '../../terms/model'
import type { TermsNotice } from '../../terms/tab'
import { useTermsSay } from './say'

/**
 * F-CT-308 (customer page › TERMS & REQUIREMENTS tab, lane ct-; 10-design §1, §7 row 0b; 18-lead-settles Z5) — the tab's notices INSIDE
 * the record's ONE notice area (the shared PartyNotices' `children`): the depth provider's notice of the hold and requirement acts made
 * on THIS tab (its own line; People's notice is then privacy's only) and the tab's own (a window saved, a link copied). Each draws one
 * banner or nothing. The props are the container's `notices`, as they are.
 */

export interface TermsNoticesProps {
  readonly own: TermsNotice | null
  readonly onDismissOwn?: (() => void) | undefined
  /** The depth provider's notice (its own words, `sales-customers-depth`). */
  readonly depth: Parameters<typeof DepthNoticeLine>[0]['notice']
  readonly onDismissDepth?: (() => void) | undefined
}

export function TermsNotices({ notices }: { notices: TermsNoticesProps }) {
  return (
    <>
      {notices.depth ? (
        <WithMessages namespaces={[DEPTH_NS]}>
          <DepthNoticeLine notice={notices.depth} onDismiss={notices.onDismissDepth} />
        </WithMessages>
      ) : null}
      {notices.own ? (
        <WithMessages namespaces={[CT, 'parties', 'sales-customers-depth', 'customer-money']}>
          <OwnNotice notice={notices.own} onDismiss={notices.onDismissOwn} />
        </WithMessages>
      ) : null}
    </>
  )
}

function OwnNotice({ notice, onDismiss }: { notice: TermsNotice; onDismiss?: (() => void) | undefined }) {
  const say = useTermsSay()
  return <Banner tone={notice.tone} title={say(notice.words)} onDismiss={onDismiss} />
}
