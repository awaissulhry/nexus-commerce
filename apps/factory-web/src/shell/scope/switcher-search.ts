import type { CompanyRef } from '../../lib/session/session'

/**
 * B-W2b-05 (design shell.scope sec:switcher): the switcher lists the companies itself up to 7; with more, it shows the
 * current one and "Find a company…", which opens the finder with a search field.
 */
export const COMPANY_LIST_MAX = 7

export const needsCompanySearch = (companies: readonly CompanyRef[]): boolean => companies.length > COMPANY_LIST_MAX

/** The companies whose name or code holds every word typed (any case, any accent), in their order. */
export function matchCompanies(companies: readonly CompanyRef[], query: string): CompanyRef[] {
  const fold = (text: string) => text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
  const words = fold(query).split(/\s+/).filter(Boolean)
  if (words.length === 0) return [...companies]
  return companies.filter((company) => {
    const text = fold(`${company.name} ${company.code}`)
    return words.every((word) => text.includes(word))
  })
}
