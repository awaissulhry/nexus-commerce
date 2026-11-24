'use client'

import type { ReactNode } from 'react'
import { WithMessages } from '../../../../../../record-panels/i18n'
import { PortalAccessMessages, PortalStepUp } from '../../../portal/view/parts'
import { PortalDialogs } from '../../../portal/view/PortalDialogs'
import type { PortalAccessActions, PortalAccessModel } from '../../../portal/model'
import type { PeopleChip } from '../../people/answer'
import { PEOPLE_TAB_NAMESPACES } from '../../people/model'
import type { PeopleMtm, PeopleTabActions, PeopleTabModel } from '../../people/tab'
import { LinkDialog } from '../../../../mtm/view/LinkDialog' // F-CA-209: Made-to-measure's own windows, in place
import { MeasurementsDialog } from '../../../../mtm/view/MeasurementsDialog' // F-CA-209
import { RidersSection } from './RidersSection' // F-CA-209
import { AddressesSection } from './AddressesSection'
import { PeopleAnswer } from './PeopleAnswer'
import { PeopleSection } from './PeopleSection'
import { RefuseAddressDialog } from './RefuseAddressDialog'
import './people.css'

/**
 * F-CA-113 (customer page › PEOPLE & ADDRESSES tab, lane ca-; 10-design §1, §2, §8; 18-lead-settles Z2, Z13) — the tab's LAYOUT, and
 * only that. Its root is the Production kit's size container and ours (`fw-pt fw-ca`: every list chooses its columns by the ROOM it
 * has, never the screen, so the thread dock re-lays it at once). The answer line on top, then the sections STACK at every room: People
 * (#people) · Addresses (#addresses) · Riders & measurements (#riders) — Personal data (#personal-data) joins in W2.4; until then
 * today's personal-data card stands under them (`after`): nothing is lost. Made-to-measure's New measurements and Send a link open here. The windows open here in place:
 * the portal's own (PortalDialogs and its fresh code), and the NEW Refuse… window; the contact and address windows are the record's
 * (PartyDialogs, mounted by the record). Draws its model; reads nothing.
 */

export interface PeopleTabProps {
  /** null: the party is still read (the answer line reads). */
  readonly model: PeopleTabModel | null
  readonly actions?: PeopleTabActions | undefined
  /** The portal container's model and acts (its windows mount here); null: no portal right. */
  readonly portal?: { readonly model: PortalAccessModel; readonly actions?: PortalAccessActions | undefined } | null | undefined
  /** The customer's own page (Portal settings ›). */
  readonly recordHref: string
  /** Today's personal-data card, drawn under the new sections until W2.4 moves its acts onto each person's ⋯. */
  readonly after?: ReactNode
  /** F-CA-209: Made-to-measure's windows (New measurements, Send a measurement link); null: none mounted. */
  readonly mtm?: PeopleMtm | null | undefined
}

/** The section a chip opens. */
const SECTION_OF: Readonly<Record<PeopleChip, 'people' | 'addresses'>> = { check: 'addresses', basis: 'people', expired: 'people', ends: 'people', seats: 'people', noQuotes: 'people', noInvoices: 'people', registered: 'addresses', noRegistered: 'addresses' }

export function PeopleTab(props: PeopleTabProps) {
  return (
    <WithMessages namespaces={PEOPLE_TAB_NAMESPACES}>
      <PeopleTabBody {...props} />
    </WithMessages>
  )
}

function PeopleTabBody({ model, actions, portal, recordHref, after, mtm }: PeopleTabProps) {
  if (!model)
    return (
      <div className="fw-pt fw-ca">
        <PeopleAnswer answer={null} filter={null} reading />
      </div>
    )
  const refused = model.refuse ? model.addresses.all.find((row) => row.id === model.refuse!.addressId) : undefined
  // A chip opens its section at once, filtered to exactly its rows (pressed again: the filter leaves).
  const onChip = (chip: PeopleChip | null) => {
    actions?.onChip?.(chip)
    if (chip && typeof document !== 'undefined') requestAnimationFrame(() => document.getElementById(SECTION_OF[chip])?.scrollIntoView({ block: 'start', behavior: 'smooth' }))
  }
  return (
    <div className="fw-pt fw-ca">
      <PeopleAnswer answer={model.answer} filter={model.filter} onChip={onChip} />
      <PeopleSection model={model} actions={actions} recordHref={recordHref} />
      <AddressesSection model={model} actions={actions} />
      <RidersSection model={model} actions={actions} />
      {after}
      {portal && portal.model.access ? (
        <PortalAccessMessages>
          <PortalDialogs model={portal.model} actions={portal.actions} />
          <PortalStepUp model={portal.model.stepUp} onSubmit={portal.actions?.onStepUp} onClose={portal.actions?.onStepUpClose} />
        </PortalAccessMessages>
      ) : null}
      {mtm?.measurements ? <MeasurementsDialog model={mtm.measurements} actions={mtm.measurementsActions} /> : null}
      {mtm?.link ? <LinkDialog model={mtm.link} can={mtm.can} actions={mtm.linkActions} /> : null}
      {model.refuse && refused ? <RefuseAddressDialog dialog={model.refuse} address={refused.address} customer={model.name} actions={actions} /> : null}
    </div>
  )
}
