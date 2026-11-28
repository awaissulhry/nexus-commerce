'use client'

import { Banner } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import { useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { AccountCard } from '../../../shared/account/view/AccountCard'
import { EmailCard, SecurityCard, type EmailCardActions, type EmailCardModel, type SecurityCardModel } from '../../../shared/account/view/SettingsCards'
import { CompanyCard, ProfileCard, type CompanyCardModel, type ProfileCardActions, type ProfileCardModel } from './AccountCards'
import { AccountDialogs, type AccountDialog, type AccountDialogActions } from './AccountDialogs'
import { AddressesSection, type AddressesActions, type AddressesModel } from './AccountLists'
import '../../../shared/account/account.css'

/**
 * SCR-188 — the customer's Account (B-W2b-196; design portal.customer.account, archetype §2.8 portal page): the person's own
 * profile and e-mail settings, the delivery addresses (with our check), the company data we hold for invoicing (read-only;
 * "Something wrong? Ask us"), and their own sign-in and sessions. owb-po4.3 (order workflow plan § 5): the colleagues and
 * their roles moved to People › Your people — the Account's "Your team" card says so and opens it. The page fills the main
 * area: cards two by two on a wide screen, the lists across the whole width; one column on a phone. The frame draws the band
 * (title, the save status, ⋯ Ask a question).
 */

export interface AccountViewModel {
  /** Still loading after about a second: the cards say so. */
  slow: boolean
  profile: ProfileCardModel
  emails: EmailCardModel
  /** owb-po4.3: where the colleagues are now (Your people); null: that page is not built (the card says so without a link). */
  peopleHref: string | null
  addresses: AddressesModel
  company: CompanyCardModel
  security: SecurityCardModel
  /** What just happened, in words ("We e-mailed an invitation to …"). */
  receipt: { tone: 'success' | 'warning'; text: string } | null
  dialog: AccountDialog | null
}

export interface AccountActions {
  profile?: ProfileCardActions
  emails?: EmailCardActions
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
          {/* owb-po4.3: the team is on Your people now; the card keeps its place (and its #users anchor) and opens it. */}
          <AccountCard
            id="users"
            title={t('team.title')}
            description={t('people.moved')}
            state="ready"
            action={
              model.peopleHref ? (
                <Button size="sm" asChild>
                  <a href={model.peopleHref}>{t('people.open')}</a>
                </Button>
              ) : undefined
            }
          />
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
