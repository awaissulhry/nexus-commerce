'use client'

import { Lock } from 'lucide-react'
import { Banner } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import { PeoplePicture } from '../../../../lib/people-picture/view/PeoplePicture'
import { useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { AccountCard } from '../../../shared/account/view/AccountCard'
import { ColleaguesSection, type ColleaguesActions, type ColleaguesModel } from '../../../shared/account/view/ColleaguesSection'
import { PeopleDialogs, type PeopleDialog, type PeopleDialogActions } from '../../../shared/account/view/PeopleDialogs'
import type { FactoryPersonRow } from '../model'
import '../../../shared/account/account.css'
import '../people.css'

/**
 * SCR-188-people — People › Your people (owb-po4.3; order workflow plan § 5 "Customer portal", design `portalTeam`): the customer's
 * own people from today's team cards — each one's role and what that role does, the admin's acts (invite, change a role, pause,
 * give back, add to a project, deactivate, each behind the e-mail code) — and, once the server reads it, "Factory people for your
 * brand" (the office people the factory gave the brand: names and roles, never a worker). Account keeps the profile, the e-mail
 * settings, the delivery addresses, the company data and the sessions. The frame draws the band (Your people, Invite a colleague).
 */

export interface PeopleViewModel {
  /** Still loading after about a second: the cards say so. */
  slow: boolean
  colleagues: ColleaguesModel
  /** Why "Invite a colleague" waits (seats, a preview, not the admin), or null. */
  inviteHeld: string | null
  /** The factory's people for the brand; null: no card (the read is not built yet, or it failed). */
  factory: readonly FactoryPersonRow[] | null
  /** What just happened, in words ("We e-mailed an invitation to …"). */
  receipt: { tone: 'success' | 'warning'; text: string } | null
  dialog: PeopleDialog | null
}

export interface PeopleActions {
  colleagues?: ColleaguesActions
  dialogs?: PeopleDialogActions
  onHideReceipt?: () => void
}

export function PeopleView({ model, actions }: { model: PeopleViewModel; actions?: PeopleActions }) {
  return (
    <WithMessages namespaces={['portal', 'portal-account', 'lists']}>
      <PeopleBody model={model} actions={actions} />
    </WithMessages>
  )
}

function PeopleBody({ model, actions }: { model: PeopleViewModel; actions?: PeopleActions | undefined }) {
  const t = useT('portal-account')
  return (
    <div className="fw-pacc">
      {model.receipt ? (
        <div role="status">
          <Banner
            tone={model.receipt.tone}
            action={
              <Button size="sm" variant="quiet" onClick={() => actions?.onHideReceipt?.()}>
                {t('receipt.hide')}
              </Button>
            }
          >
            {model.receipt.text}
          </Banner>
        </div>
      ) : null}
      <div className="fw-pacc-grid">
        <div className="fw-pacc-wide">
          <ColleaguesSection model={model.colleagues} slow={model.slow} actions={actions?.colleagues} inviteHeld={model.inviteHeld} title={t('people.ours')} does />
        </div>
        {model.factory ? (
          <div className="fw-pacc-wide">
            <AccountCard id="factory-people" title={t('people.factory.title')} description={t('people.factory.who')} state="ready">
              {model.factory.length > 0 ? (
                <ul className="fw-ppeople-list">
                  {model.factory.map((person) => (
                    <li key={person.id} className="fw-ppeople-person">
                      <PeoplePicture source={{ name: person.name, kind: person.picture.kind, icon: person.picture.icon, colour: person.picture.colour }} nameBeside />
                      <span className="fw-ppeople-text">
                        <span className="fw-pacc-strong">{person.name}</span>
                        <span className="fw-pacc-muted">{person.role}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="fw-pacc-muted">{t('people.factory.none')}</p>
              )}
            </AccountCard>
          </div>
        ) : null}
        <p className="fw-pacc-wide fw-ppeople-wall">
          <Lock size={14} aria-hidden />
          <span>{t('people.wall')}</span>
        </p>
      </div>
      <PeopleDialogs dialog={model.dialog} actions={actions?.dialogs} />
    </div>
  )
}
