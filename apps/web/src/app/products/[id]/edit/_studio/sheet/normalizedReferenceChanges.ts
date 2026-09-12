import { isReferenceField } from '@nexus/shared/reference-values'

/** Apply server-resolved IDs only to the submitted cell, without replacing a newer local edit. */
export function applyNormalizedReferenceChanges(
  body: { normalizedChanges?: unknown; errors?: unknown },
  row: { id: string; values: Record<string, { value: unknown }> },
  submitted: Array<{ colId: string; field: string; value: unknown }>,
) {
  if (!Array.isArray(body.normalizedChanges)) return
  const errors = Array.isArray(body.errors) ? body.errors : []
  for (const change of body.normalizedChanges) {
    if (!change || change.id !== row.id || change.value !== null && typeof change.value !== 'string') continue
    const sent = submitted.find(cell => cell.field === change.field && isReferenceField(cell.colId))
    if (!sent || errors.some(error => error?.field === sent.field && (error.id == null || error.id === row.id))) continue
    const cell = row.values[sent.colId]
    if (cell && cell.value === sent.value) row.values[sent.colId] = { ...cell, value: change.value }
  }
}
