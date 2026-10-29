import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { inShell, PREFIX } from '../../shared/fixtures'
import { failed, loaded, loading, type StepUpModel } from '../../shared/model'
import { ACCOUNTS, IDENTITIES, IDENTITY_FAILED, IDENTITY_READY, IDENTITY_WAITING, MAIL_COMPANIES } from '../fixtures'
import type { MailDomainModel } from './model'
import { MailDomainView } from './view/MailDomainView'

/** SCR-015 Your mail domain (Connections & API › `#mail`) with made-up example.com domains and records. */

type Case = { mail: MailDomainModel; stepUp?: StepUpModel }

const SES = ACCOUNTS.filter((account) => account.provider === 'SES')
const mail = (over: Partial<MailDomainModel> = {}, stepUp?: StepUpModel): Case => ({
  mail: { identities: loaded(IDENTITIES), companies: MAIL_COMPANIES, sesAccounts: SES, can: { manage: true }, ...over },
  ...(stepUp ? { stepUp } : {}),
})

function MailDesign({ model }: { model: Case }) {
  return inShell('/admin/connections', createElement(MailDomainView, { model: model.mail, prefix: PREFIX, stepUp: model.stepUp }))
}

export const designScreen = defineDesignScreen<Case>({
  screen: 'SCR-015',
  title: 'Your mail domain (Connections & API)',
  view: MailDesign,
  cases: [
    { id: 'domains', label: 'Three domains: ready, waiting, not verified', model: mail(), note: 'DKIM records come from the mail service with their state; SPF, DMARC and the reply MX say "not checked by Nexus yet".' },
    { id: 'verified', label: 'One domain, verified', model: mail({ identities: loaded([IDENTITY_READY]) }) },
    { id: 'waiting', label: 'Waiting for the DNS records', model: mail({ identities: loaded([IDENTITY_WAITING]) }) },
    { id: 'failed', label: 'Not verified', model: mail({ identities: loaded([IDENTITY_FAILED]) }) },
    { id: 'none', label: 'No sending domain yet', model: mail({ identities: loaded([]) }), note: 'Connect e-mail first: everything that leaves the factory needs it.' },
    { id: 'add', label: 'Add a sending domain', model: mail({ identities: loaded([]), add: {} }), note: 'Saving asks for a fresh code (email.manage is a step-up right).' },
    {
      id: 'add-problems',
      label: 'Add: what is wrong, at each field',
      model: mail({ add: { draft: { companyId: MAIL_COMPANIES[0]!.id, kind: 'CONVERSATION', domain: 'not a domain', localPart: 'no reply', displayNamePolicy: 'COMPANY', accountId: '' } } }),
    },
    { id: 'add-refused', label: 'Add: the server refused it', model: mail({ add: { draft: { companyId: MAIL_COMPANIES[0]!.id, kind: 'CONVERSATION', domain: 'mail.officina-demo.example.com', localPart: 'noreply', displayNamePolicy: 'COMPANY', accountId: SES[0]!.id } }, dialogProblem: 'problem.invalid' }) },
    { id: 'checking', label: 'Checking a domain', model: mail({ identities: loaded([IDENTITY_WAITING]), checking: IDENTITY_WAITING.id }) },
    { id: 'step-up', label: 'Check: a fresh code is asked', model: mail({ identities: loaded([IDENTITY_WAITING]), checking: IDENTITY_WAITING.id }, { open: true, busy: false, sentence: 'mail.stepUp.check', problem: null }) },
    { id: 'checked', label: 'Checked: verified', model: mail({ identities: loaded([IDENTITY_READY]), notice: { key: 'mail.done.checked.ready', tone: 'success', params: { domain: IDENTITY_READY.domain } } }) },
    { id: 'no-manage', label: 'Someone who sends but does not manage', model: mail({ can: { manage: false } }), note: 'Add and Check now are held with the right they need.' },
    { id: 'no-mail-service', label: 'No mail service connected', model: mail({ identities: loaded([]), sesAccounts: [] }) },
    { id: 'loading', label: 'Loading', model: mail({ identities: loading() }) },
    { id: 'error', label: 'The API did not answer', model: mail({ identities: failed('problem.unavailable') }) },
  ],
})
