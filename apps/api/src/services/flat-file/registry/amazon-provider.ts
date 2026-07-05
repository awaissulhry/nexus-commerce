// FF1.5 — Amazon manifest → FieldDefinition mapper.
// Pure transformer: no DB access, no service imports.
// Population (calling mapManifestToFields with a live manifest) is wired
// during orchestration in a later task — NOT called by buildWorkbookModel in FF1.
import type { FieldDefinition, FieldKind } from './types.js'

// The Amazon manifest column shape (subset we consume), matching the server
// manifest in apps/api/src/services/amazon/flat-file.service.ts
// (do NOT import it — keep this pure).
export interface ManifestColumn {
  id: string
  fieldRef: string
  labelEn: string
  kind: string
  options?: string[]
  selectionOnly?: boolean
  maxLength?: number
  maxUtf8ByteLength?: number
}

export interface Manifest {
  groups: Array<{ columns: ManifestColumn[] }>
}

function mapKind(k: string): FieldKind {
  if (k === 'longtext') return 'longtext'
  if (k === 'number') return 'number'
  if (k === 'boolean') return 'boolean'
  if (k === 'enum') return 'enum'
  return 'text'
}

export function mapManifestToFields(manifest: Manifest): FieldDefinition[] {
  return manifest.groups.flatMap(g => g.columns).map(c => ({
    id: c.id,
    label: c.labelEn,
    kind: mapKind(c.kind),
    cls: 'EDITABLE' as const,
    scope: 'SHARED' as const,
    channel: 'AMAZON' as const,
    source: { model: 'Product' as const, column: `categoryAttributes.${c.fieldRef}` },
    enumOptions: c.options,
    enumMode: c.selectionOnly ? ('strict' as const) : ('open' as const),
    maxLength: c.maxLength,
    maxUtf8ByteLength: c.maxUtf8ByteLength,
    forcedText: false,
  }))
}
