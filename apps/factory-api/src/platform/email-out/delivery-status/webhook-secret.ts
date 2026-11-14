import { EMAIL_MANAGE } from '@nexus/factory-domain/auth/permissions/catalogue'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { eventFor } from '@nexus/factory-domain/events/define'
import { events as mailDepthEvents } from '@nexus/factory-domain/mail-depth/events'
import { secretEndOf, webhookSecretProblem } from '@nexus/factory-domain/mail-depth/rules'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import type { SecretsService } from '../../secrets/envelope'
import { SECRET_PURPOSES, storeSecret } from '../../secrets/store'
import { officeOf } from '../../email-in/team-inbox/store'

/**
 * The FAKE mail account's webhook secret (B-W2b-394; follow-up ML1:01 of B-W2b-359: "the FAKE SES account's webhook secret
 * gets its route (set and rotate, step-up), so delivery events can be tested end to end"; design admin.connections "Replace the
 * secret": a write-only value, "Saved · ends in …4F2A", a fresh code, the old one stops at once):
 *
 *   PUT /email/ses-accounts/:accountId/webhook-secret {version, value}   email.manage (step-up, the route asks a fresh code)
 *
 * Only an SES account in FAKE mode (local and test: its deliveries are signed with this secret by the fakes and the tests,
 * platform/inbound/verifiers.ts); a live account's secret comes with its connection once the mail domain is chosen (Q5). ONE
 * command at the account's version: the value sealed as a new SecretValue (purpose integration.webhook), the account pointed
 * at it, the old one deleted; the audit row, the receipt and email.webhook_secret_changed never hold the value (its last four
 * characters are answered from the request). A tenant-wide account
 * reaches every company's mail: its secret needs email.manage over every active company.
 */

const secretChanged = mailDepthEvents[4]

export async function setWebhookSecret(secrets: SecretsService, caller: CommandCaller, accountId: string, body: { readonly version: number; readonly value: string }, idempotencyKey?: string) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  const account = await caller.withClient(async (db) => {
    const row = isUuid(accountId) ? await db.integrationAccount.findFirst({ where: { id: accountId, provider: 'SES' }, select: { id: true, companyId: true, mode: true, webhookSecretId: true } }) : null
    if (!row || (row.companyId !== null && !can(actor, EMAIL_MANAGE, { companyId: row.companyId }))) throw new NotFoundError('Mail account not found.')
    if (row.companyId === null) {
      const companies = await db.company.findMany({ where: { status: 'ACTIVE' }, select: { id: true } })
      if (companies.some((company) => !can(actor, EMAIL_MANAGE, { companyId: company.id }))) throw new ForbiddenError('A mail account of every company: its secret is set by a role over every company.')
    }
    return row
  })
  if (account.mode !== 'FAKE') throw new ConflictError('Only a test (FAKE) mail account’s webhook secret is set here; a live account’s comes with its connection, once the mail domain is chosen.')
  const problem = webhookSecretProblem(body.value)
  if (problem) throw new ValidationError(problem, [{ path: 'body/value', message: problem }])
  const { result } = await command(caller, { name: 'email.setWebhookSecret', idempotencyKey, input: { accountId, version: body.version }, record: { type: 'IntegrationAccount', id: accountId, expectedVersion: body.version } }, async (tools) => {
    const { tx, now } = tools
    const current = await tx.integrationAccount.findUniqueOrThrow({ where: { id: accountId }, select: { webhookSecretId: true, mode: true, version: true } })
    if (current.mode !== 'FAKE') throw new ConflictError('This mail account is no longer a test account.')
    const stored = await storeSecret(tools, secrets, { purpose: SECRET_PURPOSES.webhook, plaintext: body.value })
    await tx.integrationAccount.update({ where: { id: accountId }, data: { webhookSecretId: stored.id }, select: { id: true } })
    if (current.webhookSecretId) await tx.secretValue.delete({ where: { id: current.webhookSecretId }, select: { id: true } })
    const replaced = current.webhookSecretId !== null
    tools.audit({ recordType: 'IntegrationAccount', recordId: accountId, companyId: account.companyId, before: { webhookSecret: replaced ? 'set' : 'none' }, after: { webhookSecret: 'set', replaced } })
    tools.emit(eventFor(secretChanged, { subject: accountId, companyId: account.companyId, payload: { accountId, replaced } }))
    return { accountId, replaced, savedAt: toUtcIso(now), version: current.version }
  })
  // Its last four characters are answered from the request, never kept (not even in the command's receipt).
  return { ...result, endsIn: secretEndOf(body.value) }
}
