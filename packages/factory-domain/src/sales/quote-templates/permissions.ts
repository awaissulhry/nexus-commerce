import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Quote templates (B-W2b-294; SAL-144, SAL-252; design sales.settings ssettings.templates), in the quotes area. Office only.
 * A template of one company is checked with can() over that company; a template of every company needs a grant over every
 * company (as the sales settings' tenant-wide row).
 *
 *   quotes.view                templates are read with the quotes (the list with Company and Used, a template's lines)
 *   quotes.templates.manage    make, change and archive the saved starts of quotes: lines, sections, notes, validity, terms,
 *                              acceptance mode; save a quote as a template
 *   quotes.manage              start a quote from a template (over the company and the customer, as any new quote)
 */
export const QUOTE_TEMPLATES_DEFINITIONS = definePermissions('quotes', {
  'templates.manage': {
    risk: 'write',
    description: "Keep the quote templates: make, change, archive and restore the saved starts of quotes (lines, sections, notes, validity, terms, Incoterm, acceptance mode) of a company, or of every company with a grant over every company; save a quote as a template.",
  },
})

export const QUOTES_TEMPLATES_MANAGE = 'quotes.templates.manage' satisfies Permission

export const QUOTE_TEMPLATES_PERMISSIONS: readonly Permission[] = Object.freeze([QUOTES_TEMPLATES_MANAGE])

/**
 * Who holds it (auth/roles/templates; the owner from every(), read-only through the registry): sales, who quotes every day
 * and keeps its saved starts, and finance, who keeps the sales settings the templates sit under.
 */
export const QUOTE_TEMPLATES_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  sales: [QUOTES_TEMPLATES_MANAGE],
  finance: [QUOTES_TEMPLATES_MANAGE],
})
