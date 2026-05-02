/**
 * Phase 5.3 step config. The wizard renders one PlaceholderStep per
 * entry until the corresponding phase fills in the real component.
 */

export interface StepConfig {
  id: number
  title: string
  shortLabel: string
  description: string
  /** Which phase ships the real content for this step. */
  filledIn: '5.4' | '5.5' | 'Phase 6'
  /** Short blurb shown inside the placeholder card so the user can see
   *  what the step will eventually do. */
  preview: string
}

export const STEPS: StepConfig[] = [
  {
    id: 1,
    title: 'Product Identifiers',
    shortLabel: 'Identifiers',
    description: 'UPC, EAN, GTIN — or apply for an exemption',
    filledIn: '5.4',
    preview:
      'Smart UPC/GTIN detection with three exemption paths: have a code, brand-registered already, or apply now.',
  },
  {
    id: 2,
    title: 'GTIN Exemption',
    shortLabel: 'Exemption',
    description: 'One-click brand exemption application',
    filledIn: '5.4',
    preview:
      'Auto-fills brand info, generates the brand letter PDF, uploads the trademark certificate, submits to Amazon SP-API, and tracks the exemption status here.',
  },
  {
    id: 3,
    title: 'Product Type',
    shortLabel: 'Type',
    description: 'Amazon product category',
    filledIn: 'Phase 6',
    preview:
      'AI-suggested category match against the live Amazon schema (already cached in CategorySchema from D.3f).',
  },
  {
    id: 4,
    title: 'Required Attributes',
    shortLabel: 'Attributes',
    description: 'Category-specific fields',
    filledIn: 'Phase 6',
    preview:
      'Renders the required-fields form built dynamically from the cached category schema; smart defaults from the master product.',
  },
  {
    id: 5,
    title: 'Variations',
    shortLabel: 'Variations',
    description: 'Size, color, etc.',
    filledIn: 'Phase 6',
    preview:
      'Pulls children from the master product, lets the user pick a variation theme, and validates against the category schema.',
  },
  {
    id: 6,
    title: 'Content',
    shortLabel: 'Content',
    description: 'Title, bullets, description',
    filledIn: '5.5',
    preview:
      'Gemini-powered SEO-optimised title, five bullets, HTML description, and 250-char backend keywords — with side-by-side review and one-click regen.',
  },
  {
    id: 7,
    title: 'Images',
    shortLabel: 'Images',
    description: 'Validate against marketplace requirements',
    filledIn: 'Phase 6',
    preview:
      'Checks the master product images against Amazon’s rules (1000px+, white background for main, etc.) and surfaces fixes.',
  },
  {
    id: 8,
    title: 'Pricing',
    shortLabel: 'Pricing',
    description: 'Set marketplace price',
    filledIn: 'Phase 6',
    preview:
      'Margin-aware price recommendation using costPrice, marketplace fees, and competitor data.',
  },
  {
    id: 9,
    title: 'Review',
    shortLabel: 'Review',
    description: 'Verify before submission',
    filledIn: 'Phase 6',
    preview:
      'Final pre-submit summary with diff against the existing listing (if any) and a publish checklist.',
  },
  {
    id: 10,
    title: 'Submission',
    shortLabel: 'Submit',
    description: 'Track listing status',
    filledIn: 'Phase 6',
    preview:
      'Pushes via SP-API or the channel’s native API and polls the live status (submitted → indexed → searchable).',
  },
]

export function findStep(id: number): StepConfig | undefined {
  return STEPS.find((s) => s.id === id)
}
