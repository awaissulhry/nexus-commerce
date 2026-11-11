import type { TemplateRef } from './api'

/**
 * The measurement template a product type names as its default (B-W2b-283, FU1:03; design psettings.types "Per type:
 * required fields, defaults"), pure: what the pick offers — the active templates of the type's kind of garment, of the
 * type's company or every company (a type of every company: every company's only), the API's own rule
 * (modules/product/types draftProblems) — and the words of one.
 */

export const NS = 'products-followups-w2b4'

export function templateChoices(templates: readonly TemplateRef[], draft: { readonly productType: string; readonly companyId: string | null }): TemplateRef[] {
  return templates.filter((template) => template.status === 'ACTIVE' && template.productType === draft.productType && (template.companyId === null || template.companyId === draft.companyId))
}

/** The template's name in the reader's language, else its name. */
export const templateName = (template: Pick<TemplateRef, 'name' | 'nameI18n'>, locale: string): string => template.nameI18n[locale] ?? template.name
