'use client'

import { CheckCircle2, Eye, ShieldAlert } from 'lucide-react'
import Link from 'next/link'
import type { MenuItemDef } from '@nexus/ui/components'
import { Button, Tag } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../../lib/i18n/format'
import { useLocale } from '../../../../../../lib/i18n/provider'
import { copyLinkTo } from '../../../../orders/record/shipments/view/hrefs'
import { LineMenuButton } from '../../../../orders/record/view/LineMenu'
import { PartFailed, PartReading, Quiet, Section } from '../../../../orders/record/view/production/Kit'
import { peopleKitId, personAnchor, said } from '../../people/model'
import type { PeopleTabActions, PeopleTabModel } from '../../people/tab'
import { sentenceOf, usePeopleSay } from './say'

/**
 * F-CA-220 (customer page › PEOPLE & ADDRESSES tab, lane ca- ca-w2 W2.4; 10-design §5.4; Z8, Z14) — section 4, Personal data
 * (#personal-data): the summary ("Lawful basis recorded for 4 of 5 contacts · no objection · nothing erased.") and ONLY the people who
 * need a look — no lawful basis (Record the lawful basis…, the depth provider's own window), an objection (recorded once, never lifted),
 * an erasure (who and when; what the law keeps in general words: per contact is a later job). Every other act is on the person's ⋯ in
 * People. The foot names who reads contact details (on purpose) and opens a full data request in Admin › Privacy. Draws its model.
 */

export function PrivacySection({ model, actions }: { model: PeopleTabModel; actions?: PeopleTabActions | undefined }) {
  const say = usePeopleSay()
  const locale = useLocale()
  const privacy = model.privacy
  const title = say(said('privacy.title'))
  const day = (at: string) => formatDate(at, { locale })
  const more: MenuItemDef[] = [
    ...(privacy.requestsHref ? [{ id: 'request', label: say(said('privacy.request')), href: privacy.requestsHref }] : []),
    { id: 'link', label: say(said('linkTo', { params: { section: title } })), onSelect: () => copyLinkTo('personal-data') },
  ]
  const info = (
    <>
      <p>{say(said('privacy.info'))}</p>
      <p>{say(said('sales-customers-depth:privacy.rule'))}</p>
    </>
  )
  const head = { id: peopleKitId('personal-data'), title, info, more: <LineMenuButton label={say(said('privacy.more'))} items={more} /> }
  if (privacy.reading)
    return (
      <Section {...head} answer={say(said('privacy.reading'))}>
        <PartReading rows={2} height={30} />
      </Section>
    )
  const acts = privacy.mayRecord && privacy.exceptions.some((entry) => entry.kind === 'basis')
  return (
    <Section {...head} answer={privacy.problem ? undefined : sentenceOf(privacy.answer.map(say), locale)}>
      {privacy.problem ? <PartFailed part={say(said('part.privacy'))} problem={privacy.problem} onRetry={actions?.onRetryPrivacy} /> : null}
      {!privacy.problem && privacy.exceptions.length > 0 ? (
        <div className={`fw-ca-ls${acts ? '' : ' no-act'}`} role="list" aria-label={say(said('privacy.listLabel'))}>
          {privacy.exceptions.map(({ row, kind }) => {
            const data = row.privacy!
            const name = row.erased ? say(said('sales-customers-depth:privacy.erasedName')) : (row.contact?.name ?? '')
            return (
              <div key={`${kind}-${row.id}`} className="fw-ca-ex" role="listitem">
                <div>
                  <b className={row.erased ? 'fw-ca-erased' : undefined}>{name}</b>
                  {!row.erased ? (
                    <a className="fw-ca-lk" href={`#${personAnchor(row.id)}`}>
                      {say(said('privacy.inPeople'))}
                    </a>
                  ) : null}
                </div>
                <div className="is-w">
                  {kind === 'basis' ? (
                    <>
                      <Tag tone="warning">
                        <ShieldAlert size={12} aria-hidden /> {say(said('privacy.basisMissing'))}
                      </Tag>
                      <span>{say(said('privacy.ex.basis'))}</span>
                    </>
                  ) : kind === 'objected' ? (
                    <>
                      <Tag tone="warning">{say(said('sales-customers-depth:privacy.objectedOn', { params: { date: day(data.objectedAt!) } }))}</Tag>
                      <span className="fw-ca-sub">{say(said('privacy.ex.objected'))}</span>
                    </>
                  ) : (
                    <>
                      <Tag tone="neutral">{data.erasedAt ? say(said('privacy.ex.erasedOn', { params: { date: day(data.erasedAt) } })) : say(said('sales-customers-depth:privacy.erased'))}</Tag>
                      <span>{say(said('privacy.ex.erasedBy', { params: { name: data.erasedBy ?? say(said('sales-customers-depth:hold.system')) } }))}</span>
                      <span className="fw-ca-sub">{say(said('privacy.ex.kept'))}</span>
                    </>
                  )}
                </div>
                <div className="fw-ca-ex-a">
                  {kind === 'basis' && privacy.mayRecord ? (
                    <Button size="sm" heldReason={privacy.recordHeld ? say(privacy.recordHeld) : null} onClick={() => actions?.onPersonAct?.('basis', row)}>
                      {say(said('sales-customers-depth:privacy.act.basis'))}
                    </Button>
                  ) : null}
                </div>
              </div>
            )
          })}
        </div>
      ) : !privacy.problem && privacy.exceptions.length === 0 && privacy.answer.length > 1 ? (
        <Quiet>
          <CheckCircle2 size={14} aria-hidden /> {say(said('privacy.allGood'))}
        </Quiet>
      ) : null}
      <p className="fw-ca-foot">
        <Eye size={13} aria-hidden />
        <span>
          {say(said('privacy.foot'))}
          {privacy.requestsHref ? (
            <>
              {' '}
              <Link className="fw-ca-lk" href={privacy.requestsHref}>
                {say(said('privacy.request'))}
              </Link>
            </>
          ) : null}
        </span>
      </p>
    </Section>
  )
}
