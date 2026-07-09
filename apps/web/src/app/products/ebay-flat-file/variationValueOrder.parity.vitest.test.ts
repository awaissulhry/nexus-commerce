/**
 * EFX P3 — synonym-table parity guard.
 *
 * The client synonym table (variationValueOrder.pure.ts → AXIS_SYNONYM_GROUPS)
 * MUST stay byte-identical to the server's canonical table, which lives in
 *   apps/api/src/services/ebay-theme-axes.ts  (AXIS_SYNONYM_GROUPS)
 * — the single source of truth since EFX Phase 2. axisSynonymKey on either side
 * derives its __dim<i>__ mapping from these rows, so any drift (a new alias added
 * on one side only) would silently mis-key value orders across the modal, the
 * cockpit card, and the push service.
 *
 * This fixture is a hand-mirrored copy of the SERVER table. If you edit the
 * server's AXIS_SYNONYM_GROUPS, update this fixture in the same commit — the
 * assertion below will fail until you do.
 *
 * Run: npx vitest run apps/web/src/app/products/ebay-flat-file/variationValueOrder.parity.vitest.test.ts
 */
import { describe, it, expect } from 'vitest'
import { AXIS_SYNONYM_GROUPS as CLIENT_GROUPS, axisSynonymKey } from './variationValueOrder.pure'

// ── Fixture: verbatim copy of the SERVER table ──────────────────────────────
// Source of truth: apps/api/src/services/ebay-theme-axes.ts  (AXIS_SYNONYM_GROUPS)
const SERVER_AXIS_SYNONYM_GROUPS: ReadonlyArray<ReadonlyArray<string>> = [
  ['colore', 'color', 'colour', 'color name', 'color_name', 'couleur', 'farbe', 'kleur', 'colour name', 'colori'],
  ['taglia', 'size', 'size name', 'size_name', 'misura', 'größe', 'grosse', 'taille', 'maat', 'maten', 'koko'],
  ['stile', 'style', 'style name', 'style_name'],
  ['materiale', 'material', 'material name', 'material_name'],
  ['genere', 'gender', 'department', 'target audience', 'target_audience'],
]

describe('AXIS_SYNONYM_GROUPS parity (client ↔ server)', () => {
  it('client table deep-equals the server fixture (row-for-row, alias-for-alias)', () => {
    // Deep equality catches: added/removed rows, added/removed aliases, and any
    // reorder (row index IS the __dim<i>__ key, so order is load-bearing).
    expect(CLIENT_GROUPS.map((g) => [...g])).toEqual(
      SERVER_AXIS_SYNONYM_GROUPS.map((g) => [...g]),
    )
  })

  it('every server alias keys identically on the client', () => {
    SERVER_AXIS_SYNONYM_GROUPS.forEach((group, i) => {
      for (const alias of group) {
        expect(axisSynonymKey(alias)).toBe(`__dim${i}__`)
      }
    })
  })
})
