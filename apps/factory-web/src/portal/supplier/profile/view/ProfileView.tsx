'use client'

import type { ReactNode } from 'react'
import { Banner } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import { EditModeBar } from '../../../../lib/i18n/ds-parts'
import { useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { ColleaguesSection, type ColleaguesActions, type ColleaguesModel } from '../../../shared/account/view/ColleaguesSection'
import { EmailCard, SecurityCard, type EmailCardActions, type EmailCardModel, type SecurityCardModel } from '../../../shared/account/view/SettingsCards'
import { NS, type Words } from '../model'
import { ProfileDialogs, type ProfileDialog, type ProfileDialogActions } from './ProfileDialogs'
import { ChangesCard, CompanyCard, ContactsCard, heldWords, type ChangesModel, type CompanyActions, type CompanyModel, type ContactsActions, type ContactsModel } from './ProfileSections'
import '../../../shared/account/account.css'
import '../profile.css'

/**
 * SCR-191 — the supplier's Profile (B-W2b-193; design portal.supplier.profile, archetype portal-page): the company (legal
 * name and VAT read-only, website, registered office and pickup addresses) and the contacts, changed here and sent for our
 * check together (the page's one EditModeBar "Send changes for our check", ⌘S; nothing changes on our side until a buyer
 * approves — "Waiting for our check since …", Withdraw), the portal users (the supplier admin invites, changes roles and
 * deactivates behind a fresh e-mail code; never a price, C2), the person's e-mail settings and their sign-in and sessions.
 * The page fills the main area: the company, the contacts and the users across the width, the two personal cards side by
 * side from 1100 px; one column on a phone. The frame draws the band (title, the save status and "Changes waiting for
 * our check", Invite a colleague, ⋯ Ask a question). Bank details join with W2b-5 (SCM-007).
 */

export interface ProfileViewModel {
  /** Still loading after about a second. */
  slow: boolean
  company: CompanyModel
  contacts: ContactsModel
  changes: ChangesModel
  colleagues: ColleaguesModel
  /** Why "Invite a colleague" waits, or null. */
  inviteHeld: string | null
  emails: EmailCardModel
  security: SecurityCardModel
  /** The changes typed for our check: how many, sending, why Send waits, a refusal. */
  edit: { count: number; sending: boolean; held: Words | null; failed: string | null }
  /** What just happened, in words. */
  receipt: { tone: 'success' | 'warning'; text: string } | null
  dialog: ProfileDialog | null
}

export interface ProfileActions {
  company?: CompanyActions
  contacts?: ContactsActions
  onWithdraw?: Parameters<typeof ChangesCard>[0]['onWithdraw']
  colleagues?: ColleaguesActions
  emails?: EmailCardActions
  onSend?: () => void
  onDiscard?: () => void
  onEndOthers?: () => void
  onRetrySessions?: () => void
  onHideReceipt?: () => void
  dialogs?: ProfileDialogActions
}

export function ProfileView({ model, actions, bank }: { model: ProfileViewModel; actions?: ProfileActions; bank?: ReactNode }) {
  return (
    // B-W2b-334: `purchasing-suppliers-depth` holds the Bank details' words (portalBank.*).
    <WithMessages namespaces={[NS, 'portal', 'portal-account', 'lists', 'ds-words', 'purchasing-suppliers-depth']}>
      <ProfileBody model={model} actions={actions} bank={bank} />
    </WithMessages>
  )
}

function ProfileBody({ model, actions, bank }: { model: ProfileViewModel; actions?: ProfileActions | undefined; bank?: ReactNode }) {
  const t = useT(NS)
  const edit = model.edit.held
  const held = !edit ? null : edit.key === 'held.adminChanges' ? heldWords(t, edit.key, model.company.admins) : t(edit.key, edit.params)
  return (
    <div className="fw-pacc fw-psprof">
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
          <CompanyCard model={model.company} slow={model.slow} actions={actions?.company} />
        </div>
        {model.changes.pending.length > 0 || model.changes.decided.length > 0 ? (
          <div className="fw-pacc-wide">
            <ChangesCard model={model.changes} onWithdraw={actions?.onWithdraw} />
          </div>
        ) : null}
        <div className="fw-pacc-wide">
          <ContactsCard model={model.contacts} slow={model.slow} actions={actions?.contacts} />
        </div>
        {model.edit.count > 0 ? (
          <div className="fw-pacc-wide fw-psprof-send">
            {model.edit.failed ? <Banner tone="danger">{t(model.edit.failed)}</Banner> : null}
            <EditModeBar count={model.edit.count} busy={model.edit.sending} message={t('profile.changesTyped', { count: model.edit.count })} applyLabel={t('profile.send')} applyHeldReason={held} saveShortcut onApply={() => actions?.onSend?.()} onDiscard={() => actions?.onDiscard?.()} />
          </div>
        ) : null}
        {/* B-W2b-334: Bank details (SCM-007). */}
        {bank ? <div className="fw-pacc-wide">{bank}</div> : null}
        <div className="fw-pacc-wide">
          <ColleaguesSection model={model.colleagues} slow={model.slow} actions={actions?.colleagues} inviteHeld={model.inviteHeld} prices={false} title={t('profile.users.title')} hint={t('profile.users.onlyYouHint')} />
        </div>
        <EmailCard model={model.emails} slow={model.slow} actions={actions?.emails} />
        <SecurityCard model={model.security} slow={model.slow} onEndOthers={actions?.onEndOthers} onRetry={actions?.onRetrySessions} />
      </div>
      <ProfileDialogs dialog={model.dialog} actions={actions?.dialogs} />
    </div>
  )
}
