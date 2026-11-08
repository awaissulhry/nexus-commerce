'use client'

import { Banner } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import { useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { CompanyCard, EmailCard, ProfileCard, SecurityCard, type CompanyCardModel, type EmailCardActions, type EmailCardModel, type ProfileCardActions, type ProfileCardModel, type SecurityCardModel } from './AccountCards'
import { AccountDialogs, type AccountDialog, type AccountDialogActions } from './AccountDialogs'
import { AddressesSection, ColleaguesSection, type AddressesActions, type AddressesModel, type ColleaguesActions, type ColleaguesModel } from './AccountLists'
import '../account.css'

/**
 * SCR-188 — the customer's Account (B-W2b-196; design portal.customer.account, archetype §2.8 portal page): the person's own
 * profile and e-mail settings, the organisation's colleagues and roles (its admin invites, changes roles and deactivates
 * within our limits; everyone else reads names and roles), the delivery addresses (with our check), the company data we
 * hold for invoicing (read-only; "Something wrong? Ask us"), and their own sign-in and sessions. The page fills the main
 * area: cards two by two on a wide screen, the two lists across the whole width; one column on a phone. The frame draws
 * the band (title, the save status, Invite a colleague, ⋯ Ask a question).
 */

export interface AccountViewModel {
  /** Still loading after about a second: the cards say so. */
  slow: boolean
  profile: ProfileCardModel
  emails: EmailCardModel
  colleagues: ColleaguesModel
  addresses: AddressesModel
  company: CompanyCardModel
  security: SecurityCardModel
  /** Why "Invite a colleague" waits (seats, a preview), or null. */
  inviteHeld: string | null
  /** What just happened, in words ("We e-mailed an invitation to …"). */
  receipt: { tone: 'success' | 'warning'; text: string } | null
  dialog: AccountDialog | null
}

export interface AccountActions {
  profile?: ProfileCardActions
  emails?: EmailCardActions
  colleagues?: ColleaguesActions
  addresses?: AddressesActions
  dialogs?: AccountDialogActions
  onAskCompany?: () => void
  onRetryCompany?: () => void
  onEndOthers?: () => void
  onRetrySessions?: () => void
  onHideReceipt?: () => void
}

export function AccountView({ model, actions }: { model: AccountViewModel; actions?: AccountActions }) {
  return (
    <WithMessages namespaces={['portal', 'portal-account', 'lists']}>
      <AccountBody model={model} actions={actions} />
    </WithMessages>
  )
}

function AccountBody({ model, actions }: { model: AccountViewModel; actions?: AccountActions | undefined }) {
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
        <ProfileCard model={model.profile} slow={model.slow} actions={actions?.profile} />
        <EmailCard model={model.emails} slow={model.slow} actions={actions?.emails} />
        <div className="fw-pacc-wide">
          <ColleaguesSection model={model.colleagues} slow={model.slow} actions={actions?.colleagues} inviteHeld={model.inviteHeld} />
        </div>
        <div className="fw-pacc-wide">
          <AddressesSection model={model.addresses} slow={model.slow} actions={actions?.addresses} />
        </div>
        <CompanyCard model={model.company} slow={model.slow} onAsk={actions?.onAskCompany} onRetry={actions?.onRetryCompany} />
        <SecurityCard model={model.security} slow={model.slow} onEndOthers={actions?.onEndOthers} onRetry={actions?.onRetrySessions} />
      </div>
      <AccountDialogs dialog={model.dialog} actions={actions?.dialogs} />
    </div>
  )
}
