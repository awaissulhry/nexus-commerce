/**
 * Why a template change is refused (B-W2b-422): a code (the 409's issue path `refusal/<CODE>`, which the screens say in
 * their own words) and the API's words. `databaseTemplateRefusal` reads the database's own refusals (the
 * …_config_templates_w2b_guards triggers' `templates: …` check_violation words and the one-in-use indexes), reached only in a
 * race past the API's checks. Pure.
 */

export const TEMPLATE_REFUSALS = ['NOT_A_DRAFT', 'NOT_IN_USE', 'DRAFT_OPEN', 'ANOTHER_IN_USE', 'VERSION_TAKEN', 'NOT_OFFERED', 'DATABASE'] as const
export type TemplateRefusal = (typeof TEMPLATE_REFUSALS)[number]

export const TEMPLATE_REFUSAL_WORDS: Readonly<Record<TemplateRefusal, string>> = Object.freeze({
  NOT_A_DRAFT: 'This version was published: its words never change and it is never deleted. Write a new version.',
  NOT_IN_USE: 'Only the version in use can be retired.',
  DRAFT_OPEN: 'A draft of this template is already open: change that one, or delete it first.',
  ANOTHER_IN_USE: 'Another version was published at the same time: load the template again.',
  VERSION_TAKEN: 'Another version was written at the same time: load the template again.',
  NOT_OFFERED: 'This template is not one the code reads.',
  DATABASE: 'The template cannot be changed like this: load it again.',
})

/** The refusal of a database message (`templates: …`, or a unique index's name), or null when it is not a template's. */
export function databaseTemplateRefusal(code: unknown, message: string): TemplateRefusal | null {
  if (code === '23505') {
    if (message.includes('_one_active')) return 'ANOTHER_IN_USE'
    if (message.includes('DocumentTemplate') || message.includes('EmailTemplate') || message.includes('MessageTemplate')) return 'VERSION_TAKEN'
    return null
  }
  if (code !== '23514' || !message.includes('templates: ')) return null
  if (/was published|never removed|is RETIRED/.test(message)) return 'NOT_A_DRAFT'
  return 'DATABASE'
}
