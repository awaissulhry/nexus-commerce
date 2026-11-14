import type { FactoryClient } from '@nexus/factory-db'
import type { LayoutTemplate } from '@nexus/factory-domain/documents/layouts'
import { isTemplateLanguage, type TemplateLanguage } from '@nexus/factory-domain/templates/language'
import { fillMail, type MailEvent, type MailWords } from '@nexus/factory-domain/templates/mail'
import type { PlaceholderValues } from '@nexus/factory-domain/templates/placeholders'
import type { CommandCaller, CommandTx } from '../../core/command'

/**
 * The templates in use, as the code that prints or mails reads them (B-W2b-422; PLT-231, PLT-232):
 *
 *   documentTemplatesIn   a company's document templates in use (ACTIVE, one per kind and language), for its legal data:
 *                         platform/documents companyLegalOf attaches them and composeDocument prints with the one of its type
 *                         and language (documents/layouts.ts layoutFor), else the code's layout. Read only by an office or a
 *                         system caller (the table has no floor or partner grant, and a refused read would end the caller's
 *                         transaction): a floor or partner caller prints the code's layout.
 *   mailWordsOf           the words of a mail: the company's version in use of the event and language, else every company's,
 *                         with the values filled; null when neither is in use (the caller sends the code's own words).
 *   mailTemplateOf        the same version's words as written, for a mail whose values come after its command (a link).
 *
 * A printed document is stored with its words: a later template never changes a document already issued.
 */

/** An office or a system context reads templates (the tables' only grants); any other reads none and gets the code's words. */
const mayRead = (context: { readonly audience: string } | null | undefined): boolean => context?.audience === 'office' || context?.audience === 'system'

export async function documentTemplatesIn(client: Pick<FactoryClient, 'documentTemplate'>, caller: Pick<CommandCaller, 'factoryContext'>, companyId: string): Promise<LayoutTemplate[]> {
  if (!mayRead(caller.factoryContext)) return []
  const rows = await client.documentTemplate.findMany({
    where: { companyId, status: 'ACTIVE' },
    select: { kind: true, language: true, revision: true, header: true, terms: true, footer: true, fieldsShown: true },
    orderBy: [{ kind: 'asc' }, { language: 'asc' }],
  })
  return rows.map((row) => ({ type: row.kind, language: row.language, revision: row.revision, header: row.header, terms: row.terms, footer: row.footer, fieldsShown: row.fieldsShown }))
}

/**
 * The template in use for a mail, its words as written (the company's own first, then every company's); null when none is
 * in use for the event and language, or the context reads none. For a mail whose values come later (a link made after the
 * command): fill them with factory-domain templates/mail.ts fillMail.
 */
export async function mailTemplateOf(
  db: Pick<CommandTx, 'emailTemplate'>,
  context: { readonly audience: string } | null | undefined,
  input: { readonly companyId: string; readonly event: MailEvent; readonly language: string },
): Promise<MailWords | null> {
  if (!mayRead(context) || !isTemplateLanguage(input.language)) return null
  const language: TemplateLanguage = input.language
  const rows = await db.emailTemplate.findMany({
    where: { event: input.event, language, status: 'ACTIVE', OR: [{ companyId: input.companyId }, { companyId: null }] },
    select: { companyId: true, subject: true, body: true },
  })
  const row = rows.find((candidate) => candidate.companyId === input.companyId) ?? rows.find((candidate) => candidate.companyId === null)
  return row ? { subject: row.subject, body: row.body } : null
}

/**
 * The mail's words from the template in use (the company's own first, then every company's), filled with the values; null
 * when no template is in use for the event and language (send the code's words). Read in the command's own transaction or
 * the caller's scope, with the command's or the caller's context: an office or system one only (else null).
 */
export async function mailWordsOf(
  db: Pick<CommandTx, 'emailTemplate'>,
  context: { readonly audience: string } | null | undefined,
  input: { readonly companyId: string; readonly event: MailEvent; readonly language: string; readonly values: PlaceholderValues },
): Promise<MailWords | null> {
  const template = await mailTemplateOf(db, context, input)
  return template ? fillMail(template, input.values) : null
}
