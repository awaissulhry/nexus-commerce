import { beforeEach, expect, it, vi } from 'vitest'

/**
 * P1 (`value-verdict.ts`) — the bulk save's channel check judges each CELL. Report 6 I-14 / report 2 I-8: one resolver error
 * on a product refused every channel change of that product, and anything but an off-list value was refused. Now a value
 * the field's type cannot hold refuses that change alone; every other finding is stored and answered as a warning.
 * The resolver is replaced by the cells it would answer, so the verdict is the only thing under test.
 */
const m = vi.hoisted(() => ({ resolve: vi.fn() }))
vi.mock('./mapping/resolve-batch.service.js', () => ({ resolveBatch: m.resolve }))
import { informationChangeErrors } from './information-validation.js'
import { finding } from './value-verdict.js'

const cell = (fieldKey: string, value: unknown, found: Array<ReturnType<typeof finding>> = []) =>
  ({ fieldKey, label: fieldKey.toUpperCase(), value, errors: found.map(f => f.message), findings: found })
const run = (changes: Array<{ id: string; field: string; value: unknown }>) =>
  informationChangeErrors({ channel: 'EBAY', marketplace: 'IT', changes, listings: [], columns: new Map() })

beforeEach(() => { m.resolve.mockReset() })

it('a type finding refuses only its own cell; a schema finding on the same product is a warning, and nothing else is refused', async () => {
  m.resolve
    .mockResolvedValueOnce({ products: [{ productId: 'p', cells: { subtitle: cell('subtitle', 'old'), handlingTime: cell('handlingTime', 1), title: cell('title', 'Titolo') } }] })
    .mockResolvedValueOnce({ products: [{ productId: 'p', cells: {
      subtitle: cell('subtitle', 'S'.repeat(70), [finding('length', 'Subtitle exceeds 55 characters (70).')]),
      handlingTime: cell('handlingTime', 'three', [finding('type', 'Handling time needs a number')]),
      title: cell('title', 'Titolo'),
    } }] })
  const out = await run([{ id: 'p', field: 'attr_subtitle', value: 'S'.repeat(70) }, { id: 'p', field: 'attr_handlingTime', value: 'three' }, { id: 'p', field: 'ebay_title', value: 'Titolo' }])
  expect(out.errors).toEqual([{ id: 'p', field: 'attr_handlingTime', error: 'HANDLINGTIME: Handling time needs a number' }])
  expect(out.warnings).toEqual([{ id: 'p', field: 'attr_subtitle', warning: 'SUBTITLE: Subtitle exceeds 55 characters (70).' }])
})

it('the findings that refused a whole product before (schema, Nexus rules, requirements) are all warnings now', async () => {
  const found = [finding('schema', 'must match pattern'), finding('nexus', 'Conflicting shared categories: a; b.'), finding('offList', 'Season contains an unaccepted value. Allowed values: Estate.')]
  m.resolve
    .mockResolvedValueOnce({ products: [{ productId: 'p', cells: { season: cell('season', 'x') } }] })
    .mockResolvedValueOnce({ products: [{ productId: 'p', cells: { season: cell('season', 'Tutte le stagioni', found) } }] })
  const out = await run([{ id: 'p', field: 'attr_season', value: 'Tutte le stagioni' }])
  expect(out.errors).toEqual([])
  expect(out.warnings.map(w => w.warning)).toEqual(found.map(f => `SEASON: ${f.message}`))
})

it('a NEW problem on a cell this save did not write (derived from it) is a warning, never a refusal', async () => {
  m.resolve
    .mockResolvedValueOnce({ products: [{ productId: 'p', cells: { brand: cell('brand', 'A'), derived: cell('derived', 'ok') } }] })
    .mockResolvedValueOnce({ products: [{ productId: 'p', cells: { brand: cell('brand', 'B'), derived: cell('derived', 'x', [finding('type', 'Derived needs a number')]) } }] })
  const out = await run([{ id: 'p', field: 'attr_brand', value: 'B' }])
  expect(out.errors).toEqual([])
  // P1 review (6) — under the DERIVED cell's own key, never the first change's: it must not land on (or replace the
  // warning of) the cell the operator edited.
  expect(out.warnings).toEqual([{ id: 'p', field: 'derived', warning: 'DERIVED: Derived needs a number' }])
})

it('P1 review (6) — a finding names the change that wrote the cell, not the product\'s first change; a type refusal removes only that one', async () => {
  m.resolve
    .mockResolvedValueOnce({ products: [{ productId: 'p', cells: { brand: cell('brand', 'A'), quantita: cell('quantita', '1') } }] })
    .mockResolvedValueOnce({ products: [{ productId: 'p', cells: { brand: cell('brand', 'B'), quantita: cell('quantita', 'x', [finding('type', 'Quantità needs a number')]) } }] })
  const out = await run([{ id: 'p', field: 'attr_brand', value: 'B' }, { id: 'p', field: 'attr_quantita', value: 'x' }])
  expect(out.errors).toEqual([{ id: 'p', field: 'attr_quantita', error: 'QUANTITA: Quantità needs a number' }])
  expect(out.warnings).toEqual([])
})

it('one sentence per rule and cell (the resolver and the schema both state one over-length value)', async () => {
  m.resolve
    .mockResolvedValueOnce({ products: [{ productId: 'p', cells: { color: cell('color', 'a') } }] })
    .mockResolvedValueOnce({ products: [{ productId: 'p', cells: { color: cell('color', 'TOOLONG', [finding('length', 'Color exceeds 5 characters (7).'), finding('length', 'Color: must NOT have more than 5 characters.')]) } }] })
  expect((await run([{ id: 'p', field: 'attr_color', value: 'TOOLONG' }])).warnings).toEqual([{ id: 'p', field: 'attr_color', warning: 'COLOR: Color exceeds 5 characters (7).' }])
})

it('a cell this save CLEARED answers the channel\'s requirement as a warning (stored empty, blocked at publish)', async () => {
  const required = finding('required', "Field 'Condition' is required.")
  m.resolve
    .mockResolvedValueOnce({ products: [{ productId: 'p', cells: { conditionId: cell('conditionId', 'NEW'), other: cell('other', null, [required]) } }] })
    .mockResolvedValueOnce({ products: [{ productId: 'p', cells: { conditionId: cell('conditionId', null, [required]), other: cell('other', null, [required]) } }] })
  const out = await run([{ id: 'p', field: 'attr_conditionId', value: null }])
  expect(out.errors).toEqual([])
  // Only the cleared cell speaks; an empty cell this save did not touch stays out of its answer.
  expect(out.warnings).toEqual([{ id: 'p', field: 'attr_conditionId', warning: "CONDITIONID: Field 'Condition' is required." }])
})
