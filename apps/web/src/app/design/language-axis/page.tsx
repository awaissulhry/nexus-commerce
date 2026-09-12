/**
 * /design/language-axis — the language-axis design for the Product Edit Studio, MOCKED.
 *
 * Decides nothing and writes nothing. Every scenario renders from a frozen fixture so the Owner can
 * see each proposed surface at true size, in both themes, on the running dev server. The design and
 * the implementation plan: `docs/2026-09-11-language-axis-design.md`; the audit that led to it:
 * the 2026-09-11 "Studio Language Audit" artifact.
 */
import { LanguageAxisClient } from './LanguageAxisClient'

export const metadata = { title: 'Language axis · design mock' }

export default function LanguageAxisPage() {
  return <LanguageAxisClient />
}
