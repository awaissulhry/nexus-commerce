import { materialFindings, type MaterialFacts } from '@nexus/factory-domain/sales/quote-warnings/rules'
import type { LineCheck, LineFinding } from './index'
import { findingOf, labelsOf } from './warning-facts'

/**
 * A blocked material on a line (B-W2b-294; SAL-147 "a blocked material"): WARNING. The line's materials are its style revision's
 * BOM (the line's revision, else the style's released one) and the materials chosen on it as options (leather by article),
 * as the minimums rule reads them; a material is blocked when its approval is BLOCKED (Item.approval, B-W2b-238: a revision
 * naming it is not released) or its compliance profile is BLOCKED (MaterialComplianceProfile.state, B-W2b-256: it may not be
 * used). The release and the cutting room refuse it on their own; the quote is told before it is promised.
 */
export const materialsCheck: LineCheck = {
  key: 'materials',
  async run(db, document) {
    const styleIds = [...new Set(document.lines.map((line) => line.styleId))]
    const released = await db.styleRevision.findMany({ where: { styleId: { in: styleIds }, status: 'RELEASED' }, select: { id: true, styleId: true }, orderBy: [{ revision: 'desc' }, { id: 'asc' }] })
    const revisionOf = (line: (typeof document.lines)[number]): string | null => line.styleRevisionId ?? released.find((row) => row.styleId === line.styleId)?.id ?? null
    const revisionIds = [...new Set(document.lines.flatMap((line) => { const id = revisionOf(line); return id ? [id] : [] }))]
    const bom = revisionIds.length === 0 ? [] : await db.bomLine.findMany({ where: { revisionId: { in: revisionIds } }, select: { revisionId: true, itemId: true } })
    const itemIds = [...new Set([...bom.map((row) => row.itemId), ...document.lines.flatMap((line) => line.optionItemIds)])]
    if (itemIds.length === 0) return []
    const blockedItems = await db.item.findMany({ where: { id: { in: itemIds }, approval: 'BLOCKED' }, select: { id: true } })
    const blockedProfiles = await db.materialComplianceProfile.findMany({ where: { itemId: { in: itemIds }, state: 'BLOCKED' }, select: { itemId: true, state: true, stateReason: true } })
    const blockedIds = [...new Set([...blockedItems.map((row) => row.id), ...blockedProfiles.map((row) => row.itemId)])]
    if (blockedIds.length === 0) return []
    const items = await db.item.findMany({ where: { id: { in: blockedIds } }, select: { id: true, code: true, approval: true, approvalNote: true }, orderBy: [{ code: 'asc' }, { id: 'asc' }] })
    const facts = new Map<string, MaterialFacts>(
      items.map((item) => {
        const profile = blockedProfiles.find((row) => row.itemId === item.id)
        return [item.id, { id: item.id, code: item.code, approval: item.approval, approvalNote: item.approvalNote, complianceState: profile?.state ?? null, complianceReason: profile?.stateReason ?? null }]
      }),
    )
    const labels = await labelsOf(db, document)
    const findings: LineFinding[] = []
    for (const line of document.lines) {
      const revisionId = revisionOf(line)
      const own = new Set([...bom.filter((row) => row.revisionId === revisionId).map((row) => row.itemId), ...line.optionItemIds])
      const materials = [...own].flatMap((itemId) => (facts.has(itemId) ? [facts.get(itemId)!] : [])).sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
      for (const finding of materialFindings({ seq: line.seq, label: labels.label(line) }, materials)) findings.push(findingOf('materials', finding, [line], { itemId: finding.open?.recordId ?? null }))
    }
    return findings
  },
}
