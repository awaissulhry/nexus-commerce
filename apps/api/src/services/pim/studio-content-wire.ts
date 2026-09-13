import type { ResolvedContent } from '@nexus/shared/content-language'
import type { ResolvedCell } from './mapping/resolve-batch.service.js'

const languageNames = new Intl.DisplayNames(['en'], { type: 'language' })

/** Carry the winning resolver answer through slot projection and mapping, without relabelling its language. */
export function studioContentFacts(content: (ResolvedContent & { follows?: boolean }) | undefined, mapped: ResolvedCell | undefined, formula: { expr: string; lastError?: string | null } | undefined, requested: string, coordinateLabel?: string): Partial<Omit<ResolvedContent, 'value'>> {
  const answer = mapped?.status === 'mapped' ? mapped.content ?? content : content
  if (!answer) return {}
  const { tier, language, provenance, translation } = answer
  const languageLabel = languageNames.of(language) ?? language
  const from = tier === 'pin' ? `${languageLabel} · ${coordinateLabel ?? 'listing'} · ${answer.follows ? 'following snapshot' : 'pin'}`
    : provenance.from ?? `${languageLabel} · ${tier === 'language' ? 'shared' : tier}`
  return { tier: formula || mapped?.status === 'mapped' && !mapped.content ? 'computed' : tier,
    language: mapped?.effectiveLocale ?? language, requested,
    provenance: formula ? { member: formula.lastError ? 'refused' : 'formula', from: formula.lastError ?? from } : { ...provenance, from },
    ...(translation ? { translation } : {}) }
}
