import { lifecycleFinding } from '@nexus/factory-domain/sales/quote-warnings/rules'
import type { LineCheck, LineFinding } from './index'
import { findingOf, labelsOf } from './warning-facts'

/**
 * A style being phased out or discontinued (B-W2b-294; SAL-147; design quote.lines.warnings "Style or colourway being phased
 * out — warn"; Style.lifecycle, B-W2b-221): WARNING, with the style that replaces it (Style.replacedById) when known. A
 * colourway has no phase-out of its own (ACTIVE or ARCHIVED, and an archived one is not quoted: W1's lineTarget).
 */
export const lifecycleCheck: LineCheck = {
  key: 'lifecycle',
  async run(db, document) {
    const styles = await db.style.findMany({ where: { id: { in: [...new Set(document.lines.map((line) => line.styleId))] }, lifecycle: { in: ['PHASE_OUT', 'DISCONTINUED'] } }, select: { id: true, code: true, lifecycle: true, replacedById: true } })
    if (styles.length === 0) return []
    const replacements = new Map((await db.style.findMany({ where: { id: { in: styles.flatMap((style) => (style.replacedById ? [style.replacedById] : [])) } }, select: { id: true, code: true } })).map((row) => [row.id, row.code]))
    const labels = await labelsOf(db, document)
    const findings: LineFinding[] = []
    for (const line of document.lines) {
      const style = styles.find((row) => row.id === line.styleId)
      if (!style) continue
      const finding = lifecycleFinding({ seq: line.seq, label: labels.label(line) }, style, style.replacedById ? (replacements.get(style.replacedById) ?? null) : null)
      if (finding) findings.push(findingOf('lifecycle', finding, [line], { styleId: style.id, lifecycle: style.lifecycle, replacedById: style.replacedById }))
    }
    return findings
  },
}
