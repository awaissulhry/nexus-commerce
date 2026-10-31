/**
 * Read-aloud's rules (B-W2b-28, D27 / A2 G21, design part ReadAloudButton): a screen's short text read in the person's
 * language by the browser's own speech (Web Speech, on the device: nothing is sent anywhere by this part).
 *
 * - **A voice for the language or no button**: an exact match ("it-IT") first, then the same language in another
 *   region ("it-CH" for "it"); among equals the device's default voice, then a voice on the device (works offline),
 *   then the first. No voice for the language → no button (never a voice reading Italian words in English).
 * - **Short pieces**: some browsers stop a long utterance after about 15 s, so the text is read sentence by sentence;
 *   a sentence longer than `max` characters is cut at a space.
 */

/** What the part needs from a `SpeechSynthesisVoice`. */
export interface SpeechVoiceLike {
  name: string
  lang: string
  default?: boolean
  localService?: boolean
}

const norm = (lang: string) => lang.trim().replace(/_/g, '-').toLowerCase()

/** 2 the same language and region, 1 the same language, 0 another language. */
export function voiceLangScore(voiceLang: string, lang: string): 0 | 1 | 2 {
  const v = norm(voiceLang)
  const want = norm(lang)
  if (!v || !want) return 0
  if (v === want) return 2
  return v.split('-')[0] === want.split('-')[0] ? 1 : 0
}

/** The voice to read `lang` with, or null when the device has none for that language. */
export function pickVoice<V extends SpeechVoiceLike>(voices: readonly V[], lang: string): V | null {
  let best: V | null = null
  let bestRank = -1
  for (const v of voices) {
    const score = voiceLangScore(v.lang, lang)
    if (score === 0) continue
    const rank = score * 4 + (v.default ? 2 : 0) + (v.localService ? 1 : 0)
    if (rank > bestRank) {
      best = v
      bestRank = rank
    }
  }
  return best
}

/** The text in pieces a browser reads without stopping: by sentence, a long sentence cut at a space. */
export function speechChunks(text: string, max = 180): string[] {
  const sentences = text
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.!?…;:])\s+|\n+/u)
    .map((s) => s.trim())
    .filter(Boolean)
  const out: string[] = []
  for (const s of sentences) {
    if (s.length <= max) {
      out.push(s)
      continue
    }
    let rest = s
    while (rest.length > max) {
      const cut = rest.lastIndexOf(' ', max)
      const at = cut > max / 2 ? cut : max
      out.push(rest.slice(0, at).trim())
      rest = rest.slice(at).trim()
    }
    if (rest) out.push(rest)
  }
  return out
}
