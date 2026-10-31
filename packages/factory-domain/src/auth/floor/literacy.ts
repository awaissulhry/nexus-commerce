import type { Issue } from '../../core/errors'

/**
 * The low-literacy rules of the floor screens (B-W2b-52; MES-188; design floor.home "icon + word", floor.mywork
 * "confirm by scan, not by reading", floor.notice and floor.reasons "Read aloud (D27)"; anatomy 2.7). A floor choice is
 * told apart without reading: an icon and a tone first, then a short word in the person's language; reading never decides
 * an action (a scan confirms it); a page holds six tiles at most; and where the device has a voice for the person's
 * language, the words of a notice, a reason list or an instruction can be read aloud (the design system's
 * ReadAloudButton draws nothing without a voice).
 *
 * The domain names icons by the design system's icon ids (lower case with hyphens) and tones by the design system's
 * semantic tones; the screens map them and say the words. Pure: tested here, used by the floor answers of
 * apps/factory-api (modes, crews, conflicts) so every list they send passes `choiceProblems`.
 */

export const FLOOR_TONES = ['neutral', 'info', 'success', 'warning', 'danger'] as const
export type FloorTone = (typeof FLOOR_TONES)[number]

/** How a floor choice looks before anyone reads it. */
export interface FloorLook {
  /** A design-system icon id (lower case, hyphens): `tablet`, `users`, `alert-triangle` … */
  readonly icon: string
  readonly tone: FloorTone
}

export const LOW_LITERACY = Object.freeze({
  /** Tiles on one page (floor.home "six tiles at most"; more go behind a More tile). */
  maxTilesPerPage: 6,
  /** Words of a tile's label: short enough to take in at a glance. */
  maxLabelWords: 3,
})

const ICON_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

/** A choice a floor screen offers (a tile, a reason, a decision). */
export interface FloorChoice {
  readonly code: string
  readonly look: Partial<FloorLook> | null | undefined
  /** Its word in the screen's language, when the check should judge it too. */
  readonly label?: string | null | undefined
}

/**
 * What breaks the low-literacy rules in a set of choices shown together: a choice without an icon or a tone (it would be
 * a word only), a label too long to take in at a glance, or two choices that look the same (the same icon and tone:
 * they could only be told apart by reading). Paths are `<index>/look/icon`, `<index>/look/tone`, `<index>/label`.
 */
export function choiceProblems(choices: readonly FloorChoice[]): Issue[] {
  const issues: Issue[] = []
  const seen = new Map<string, number>()
  choices.forEach((choice, index) => {
    const icon = choice.look?.icon
    const tone = choice.look?.tone
    if (typeof icon !== 'string' || !ICON_ID.test(icon)) issues.push({ path: `${index}/look/icon`, message: `${choice.code} has no icon: a floor choice is an icon first.` })
    if (typeof tone !== 'string' || !(FLOOR_TONES as readonly string[]).includes(tone)) issues.push({ path: `${index}/look/tone`, message: `${choice.code} has no tone: a floor choice has a colour before a word.` })
    if (choice.label !== undefined) {
      const words = (choice.label ?? '').trim().split(/\s+/).filter((word) => word !== '')
      if (words.length === 0) issues.push({ path: `${index}/label`, message: `${choice.code} has no word.` })
      else if (words.length > LOW_LITERACY.maxLabelWords) issues.push({ path: `${index}/label`, message: `${choice.code}'s label has ${words.length} words; at most ${LOW_LITERACY.maxLabelWords}.` })
    }
    if (typeof icon === 'string' && typeof tone === 'string') {
      const key = `${icon}|${tone}`
      const first = seen.get(key)
      if (first !== undefined) issues.push({ path: `${index}/look`, message: `${choice.code} looks the same as ${choices[first]!.code}: they could only be told apart by reading.` })
      else seen.set(key, index)
    }
  })
  return issues
}

/** The pages a set of tiles needs at six a page (a More tile opens the next). */
export const tilePages = (tiles: number): number => Math.max(1, Math.ceil(Math.max(0, tiles) / LOW_LITERACY.maxTilesPerPage))

/**
 * The language a device's voice reads in (BCP 47, for the design system's ReadAloudButton `lang`), from a floor language
 * (`it`, `ro`, `ur` … or already `pt-BR`). A language with a usual country gets it; any other is passed as it is (the
 * browser picks a voice of that language, or none: the button then draws nothing).
 */
const SPEECH_REGION: Readonly<Record<string, string>> = Object.freeze({
  it: 'it-IT',
  en: 'en-GB',
  ro: 'ro-RO',
  ur: 'ur-PK',
  hi: 'hi-IN',
  pa: 'pa-IN',
  bn: 'bn-BD',
  ta: 'ta-IN',
  si: 'si-LK',
  zh: 'zh-CN',
  ar: 'ar-SA',
  sq: 'sq-AL',
  uk: 'uk-UA',
  ru: 'ru-RU',
  pl: 'pl-PL',
  es: 'es-ES',
  pt: 'pt-PT',
  fr: 'fr-FR',
  de: 'de-DE',
  tl: 'fil-PH',
  ml: 'ml-IN',
  ne: 'ne-NP',
  vi: 'vi-VN',
  tr: 'tr-TR',
})

export function speechLang(locale: string): string {
  const clean = locale.trim()
  if (/^[a-z]{2,3}-[A-Z]{2}$/.test(clean)) return clean
  const base = clean.toLowerCase()
  return SPEECH_REGION[base] ?? base
}
