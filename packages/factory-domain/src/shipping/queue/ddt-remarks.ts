/**
 * The customer's requirements on the DDT (B-W2b-386; follow-up LQ1:02, B-W2b-290's gap "requirements are not copied onto
 * documents"), pure. The requirements in force on the shipping checklist (the stage SHIPMENT, for the shipment's company
 * and styles; the pick & pack ones stay on the packing screen) become the DDT's printed remarks
 * (annotazioni) unless the office types its own: one line each, in the order they were written, within the remarks' 1000
 * characters (the last one cut with "…" when they do not fit).
 */

export const DDT_REMARKS_LIMIT = 1000

export function requirementRemarks(requirements: readonly { readonly words: string }[]): string | null {
  const lines = requirements.map((requirement) => requirement.words.replace(/\s+/g, ' ').trim()).filter((line) => line !== '')
  if (lines.length === 0) return null
  const text = [...new Set(lines)].join('\n')
  return text.length <= DDT_REMARKS_LIMIT ? text : `${text.slice(0, DDT_REMARKS_LIMIT - 1).trimEnd()}…`
}
