import type { LabelLayout } from '@nexus/ui/components/LabelPreview/index'

/**
 * A badge's face (design people.employees pop:badges "LabelPreview per person (name shown on floor, QR / barcode)", the
 * badge sheet tab): a card of 86 × 54 mm with the company, the name shown on the floor in large letters, the employee
 * code, the site and the team, and a QR that opens this person's record in the Office (a person signed in with
 * people.view). The badge's SIGN-IN code is never printed here: Admin › Users issues it once with a fresh authenticator
 * code and keeps only its hash. No photo, no date of birth (what Nexus does not keep).
 */

export interface BadgePerson {
  id: string
  displayName: string
  name: string
  employeeCode: string | null
  siteCode: string
  team: string | null
}

export interface BadgeWords {
  /** What the label is, for a screen reader ("Badge"). */
  name: string
  company: string
  code: string
  site: string
  team: string
  none: string
}

export const BADGE_SIZE_MM = { width: 86, height: 54 } as const

export function badgeLayout(person: BadgePerson, words: BadgeWords, recordUrl: string): LabelLayout {
  return {
    name: `${words.name} · ${person.displayName}`,
    widthMm: BADGE_SIZE_MM.width,
    heightMm: BADGE_SIZE_MM.height,
    paddingMm: 3,
    blocks: [
      { kind: 'text', text: words.company, size: 'sm', bold: true },
      { kind: 'rule' },
      {
        kind: 'row',
        blocks: [
          {
            kind: 'fields',
            columns: 1,
            fields: [
              { label: person.name, value: person.displayName, size: 'xl' },
              { label: words.code, value: person.employeeCode ?? words.none, size: 'md' },
            ],
          },
          { kind: 'qr', value: recordUrl, sizeMm: 20 },
        ],
      },
      { kind: 'fill' },
      { kind: 'fields', columns: 2, fields: [{ label: words.site, value: person.siteCode, size: 'sm' }, { label: words.team, value: person.team ?? words.none, size: 'sm' }] },
    ],
  }
}

/** The badge sheet's address (a new tab): the people by id, at most 200 in one sheet. */
export const BADGE_SHEET_MAX = 200
export const badgeSheetHref = (prefix: string, ids: readonly string[]): string => `${prefix}/people/employees/badges?ids=${ids.slice(0, BADGE_SHEET_MAX).map(encodeURIComponent).join(',')}`
