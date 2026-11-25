import type { Words } from './rules'

/**
 * od-s s.4 (order start, 13-backend § 1a and § 3; Owner yes 2026-11-25): the open choices of a draft's product row — "Leather: Cowhide ·
 * Kangaroo · Not decided yet", "Protection class: AA · AAA · Not decided yet". Names only (never a price, never a person), written by
 * the customer and by the office while the request is a DRAFT, frozen at Send (the line guard: PortalOrderRequestLine.choices).
 *
 *   a choice   a topic (1 to 60 trimmed), 2 to 6 distinct options (each 1 to 60 trimmed), and the pick: one of the options, or null =
 *              "Not decided yet" (an answer, never a gap: it holds neither Send nor Confirm)
 *   a row      none (null; never an empty list: one way only) or 1 to 10 choices, each topic once
 *   the carry  at Confirm the choices travel to the order line's note as words (`choicesWords`); the real options are picked later on
 *              the order (its configurator), open until a work order
 *
 * The database holds the same shape (factory_portal_draft_choices_ok); the API is at least as strict (each topic once, too).
 */

export const CHOICE_LIMITS = Object.freeze({ perLine: 10, topic: 60, optionsMin: 2, optionsMax: 6, option: 60 })

export interface DraftChoice {
  readonly topic: string
  readonly options: readonly string[]
  /** One of the options; null: "Not decided yet". */
  readonly picked: string | null
}

const sameText = (a: string, b: string): boolean => a.trim().toLocaleLowerCase('en') === b.trim().toLocaleLowerCase('en')

/** The problems of a row's choices (400 words, each with where it is), before they are written; none: the choices are well formed. */
export function choiceProblems(choices: readonly DraftChoice[] | null, at = 'body/choices'): { readonly path: string; readonly message: string }[] {
  if (choices === null) return []
  const out: { path: string; message: string }[] = []
  if (choices.length === 0) out.push({ path: at, message: 'No choice is null, not an empty list.' })
  if (choices.length > CHOICE_LIMITS.perLine) out.push({ path: at, message: `A product row holds at most ${CHOICE_LIMITS.perLine} choices.` })
  choices.forEach((choice, index) => {
    const place = `${at}/${index}`
    const topic = choice.topic.trim()
    if (topic === '' || topic.length > CHOICE_LIMITS.topic) out.push({ path: `${place}/topic`, message: `What is to choose is 1 to ${CHOICE_LIMITS.topic} characters.` })
    if (choices.slice(0, index).some((before) => sameText(before.topic, choice.topic))) out.push({ path: `${place}/topic`, message: `"${topic}" is already a choice of this row.` })
    if (choice.options.length < CHOICE_LIMITS.optionsMin || choice.options.length > CHOICE_LIMITS.optionsMax) out.push({ path: `${place}/options`, message: `A choice has ${CHOICE_LIMITS.optionsMin} to ${CHOICE_LIMITS.optionsMax} options.` })
    choice.options.forEach((option, place2) => {
      const text = option.trim()
      if (text === '' || text.length > CHOICE_LIMITS.option) out.push({ path: `${place}/options/${place2}`, message: `An option is 1 to ${CHOICE_LIMITS.option} characters.` })
      if (choice.options.slice(0, place2).some((before) => before.trim() === text)) out.push({ path: `${place}/options/${place2}`, message: `"${text}" is an option twice.` })
    })
    if (choice.picked !== null && !choice.options.some((option) => option.trim() === choice.picked!.trim())) out.push({ path: `${place}/picked`, message: 'The pick is one of the options, or "Not decided yet".' })
  })
  return out
}

/** The choices as they are stored: trimmed; none (null or an empty list) is null. */
export function choicesRow(choices: readonly DraftChoice[] | null | undefined): DraftChoice[] | null {
  if (choices === undefined || choices === null || choices.length === 0) return null
  return choices.map((choice) => ({ topic: choice.topic.trim(), options: choice.options.map((option) => option.trim()), picked: choice.picked === null ? null : choice.picked.trim() }))
}

/** The stored choices read back (a value the database holds: null, or the shape above; anything else reads as none). */
export function choicesOf(value: unknown): DraftChoice[] | null {
  if (!Array.isArray(value) || value.length === 0) return null
  const out: DraftChoice[] = []
  for (const entry of value) {
    const item = entry as { topic?: unknown; options?: unknown; picked?: unknown } | null
    if (!item || typeof item.topic !== 'string' || !Array.isArray(item.options)) continue
    out.push({ topic: item.topic, options: item.options.filter((option: unknown): option is string => typeof option === 'string'), picked: typeof item.picked === 'string' ? item.picked : null })
  }
  return out.length === 0 ? null : out
}

/** The words of the choices on the order line at Confirm: "Leather: Cowhide or Kangaroo — not decided yet · Protection class: AAA". */
export function choicesWords(choices: readonly DraftChoice[] | null): Words | null {
  if (choices === null || choices.length === 0) return null
  const en = choices.map((choice) => (choice.picked === null ? `${choice.topic}: ${choice.options.join(' or ')} — not decided yet` : `${choice.topic}: ${choice.picked}`)).join(' · ')
  const it = choices.map((choice) => (choice.picked === null ? `${choice.topic}: ${choice.options.join(' o ')} — non ancora deciso` : `${choice.topic}: ${choice.picked}`)).join(' · ')
  return { it, en }
}

/** A note with the choices' words after it (' · '), trimmed to `limit` characters (an ellipsis when cut). */
export function withChoicesWords(note: string | null, choices: readonly DraftChoice[] | null, limit: number): string | null {
  const words = choicesWords(choices)?.en ?? null
  const text = [note, words].filter((part): part is string => part !== null && part.trim() !== '').join(' · ')
  if (text === '') return null
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`
}
