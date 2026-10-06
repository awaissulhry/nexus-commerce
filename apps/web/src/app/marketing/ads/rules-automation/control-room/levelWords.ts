/**
 * CR rebuild 2 — the Control Room's ONE level scale, in words. Stored values do not change; only what the screen says.
 *
 * Before, four scales shared three words: the account dial said Off · Propose · Auto, engines and rules Off · Observe ·
 * Propose · Auto, and "Propose" meant "only count" on the dial but "queue a suggestion" on a rule (report 7 §3). Now
 * every row of the Control Room says the same four words, and each means one thing:
 *   Off     does not run
 *   Watch   runs and records what it would change; changes nothing
 *   Ask me  a person decides each change
 *   Auto    changes the ads by itself, inside the limits
 */
export type Level = 'OFF' | 'OBSERVE' | 'PROPOSE' | 'AUTO'

export const LEVEL_ORDER: readonly Level[] = ['OFF', 'OBSERVE', 'PROPOSE', 'AUTO']

export const LEVEL_WORD: Record<Level, string> = { OFF: 'Off', OBSERVE: 'Watch', PROPOSE: 'Ask me', AUTO: 'Auto' }

export const LEVEL_MEANS: Record<Level, string> = {
  OFF: 'Does not run.',
  OBSERVE: 'Runs and records what it would change. Changes nothing.',
  PROPOSE: 'A person decides each change.',
  AUTO: 'Changes your ads by itself, inside your limits.',
}

export const levelRank = (level: Level): number => LEVEL_ORDER.indexOf(level)

export const isLevel = (v: unknown): v is Level => typeof v === 'string' && (LEVEL_ORDER as readonly string[]).includes(v)

/** A server variable (NEXUS_…) or a code file name (ads-graduation.ts) — words a person should never have to read. */
const DEVELOPER_WORDS = /\bNEXUS_[A-Z0-9_]+|\b[\w-]+\.(?:ts|tsx|js|mjs|cjs)\b/

/**
 * A server sentence without developer words: the parts that name a server variable or a code file are left out (a
 * sentence, or the " — " clause of one), and when nothing is left the plain fallback is said instead. The full text
 * stays under the drawer's Technical details.
 */
export function withoutServerNames(text: string | null | undefined, fallback: string): string {
  if (!text) return fallback
  const kept = text.split(/(?<=[.!?])\s+/).flatMap((sentence) => {
    if (!DEVELOPER_WORDS.test(sentence)) return [sentence]
    // "Unclassified action — classify in ads-graduation.ts before …": keep the plain clauses BEFORE the first developer
    // one. A sentence that starts with one ("NEXUS_X is off — no engine runs") goes whole: what follows explains it.
    const clauses = sentence.split(/\s+—\s+/)
    const plain = clauses.slice(0, clauses.findIndex((c) => DEVELOPER_WORDS.test(c)))
    return plain.length ? [plain.join(' — ').replace(/[.!?]?$/, '.')] : []
  })
  return kept.length ? kept.join(' ') : fallback
}
