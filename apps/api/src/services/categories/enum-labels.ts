/**
 * VL.1 — pure enum-label extraction from an Amazon JSON schema.
 *
 * Amazon wraps each attribute in `items.properties.value` with paired
 * `enum` (canonical wire values) + `enumNames` (display labels in the fetch
 * locale). This pairs them by index → { fieldKey: { wireValue: label } }.
 * Pure (no deps) so it's unit-testable on its own.
 */

export function extractEnumLabels(schema: Record<string, unknown>): Record<string, Record<string, string>> {
  const props = (schema?.properties ?? {}) as Record<string, any>
  const out: Record<string, Record<string, string>> = {}
  for (const [name, fs] of Object.entries(props)) {
    const v = (fs?.items?.properties ?? {})?.value
    const en = v?.enum
    const names = v?.enumNames
    if (Array.isArray(en) && Array.isArray(names) && en.length === names.length && en.length > 0) {
      const m: Record<string, string> = {}
      for (let i = 0; i < en.length; i++) m[String(en[i])] = String(names[i])
      out[name] = m
    }
  }
  return out
}
