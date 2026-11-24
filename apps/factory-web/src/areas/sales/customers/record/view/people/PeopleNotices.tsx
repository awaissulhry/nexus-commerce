'use client'

import Link from 'next/link'
import { Banner } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import { WithMessages } from '../../../../../../record-panels/i18n'
import { NoticeLine, PortalAccessMessages } from '../../../portal/view/parts'
import { NoticeLine as DepthNoticeLine } from '../../../depth/view/parts' // F-CA-227: the personal-data windows' own notice line
import { NS as DEPTH_NS } from '../../../depth/model'
import { CP, said } from '../../people/model'
import type { PeopleNotice, PeopleNotices as Notices } from '../../people/tab'
import { usePeopleSay } from './say'

/**
 * F-CA-114 (customer page › PEOPLE & ADDRESSES tab, lane ca-; 13-backend §5.4; 18-lead-settles Z15) — the tab's notices INSIDE the
 * record's ONE notice area (the shared PartyNotices' `children`): the portal's own notice line (an invitation sent, people suspended,
 * a refusal with each refused name), the personal-data windows' (a lawful basis recorded, an objection) and the tab's (an address
 * approved or refused, a copy, new measurements, a rider added). Each draws one banner or nothing.
 */
export function PeopleNotices({ notices }: { notices: Notices }) {
  return (
    <>
      {notices.portal ? (
        <PortalAccessMessages>
          <NoticeLine notice={notices.portal} onDismiss={notices.onDismissPortal} />
        </PortalAccessMessages>
      ) : null}
      {notices.depth ? (
        <WithMessages namespaces={[DEPTH_NS]}>
          <DepthNoticeLine notice={notices.depth} onDismiss={notices.onDismissDepth} />
        </WithMessages>
      ) : null}
      {notices.own ? (
        <WithMessages namespaces={[CP, 'parties']}>
          <OwnNotice notice={notices.own} onDismiss={notices.onDismissOwn} />
        </WithMessages>
      ) : null}
    </>
  )
}

function OwnNotice({ notice, onDismiss }: { notice: PeopleNotice; onDismiss?: (() => void) | undefined }) {
  const say = usePeopleSay()
  return (
    <Banner
      tone={notice.tone}
      title={say(notice.words)}
      action={
        notice.link || onDismiss ? (
          <span className="fw-ca-acts">
            {notice.link ? (
              <Button size="sm" asChild>
                <Link href={notice.link.href}>{say(notice.link.label)}</Link>
              </Button>
            ) : null}
            {onDismiss ? (
              <Button size="sm" variant="quiet" onClick={onDismiss}>
                {say(said('parties:common.dismiss'))}
              </Button>
            ) : null}
          </span>
        ) : undefined
      }
    />
  )
}
