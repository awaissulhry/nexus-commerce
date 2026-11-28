import type { Locale } from '../../../lib/i18n/locales'
import type { FactoryPeople } from './api'

/**
 * owb-po4.3 — Your people without a screen (pure; people.vitest.test.ts). The card "Factory people for your brand": each person's
 * name, role in the reader's language and picture (letters, or one of the people-picture icons, on its tone). No read: no card.
 */

export interface FactoryPersonRow {
  id: string
  name: string
  role: string
  picture: { kind: 'LETTERS' | 'ICON'; icon: string | null; colour: string | null; letters: string | null }
}

/** The card's rows, or null when the read did not answer (not built yet, or failed): then the card is not drawn. */
export function factoryRowsOf(answer: FactoryPeople | null, locale: Locale): FactoryPersonRow[] | null {
  if (!answer) return null
  return answer.people.map((person) => ({
    id: person.id,
    name: person.name,
    role: locale === 'it' ? person.role.it : person.role.en,
    picture: { kind: person.picture?.kind ?? 'LETTERS', icon: person.picture?.icon ?? null, colour: person.picture?.colour ?? null, letters: person.picture?.letters || null },
  }))
}
