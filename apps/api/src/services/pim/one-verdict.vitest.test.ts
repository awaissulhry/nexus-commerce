/**
 * Audit 2026-09-30 (WP6) — ONE verdict for every path (plan P1 item 1, decision D1). The same inputs go through every path
 * that judges a value in-process, and each must answer the same: STORED, WARNED (stored, with the exact reason) or
 * REFUSED (only that cell) at edit time, and BLOCK or WARN at publish, in the same words.
 *
 * Paths, each by the function it really runs:
 *   editor   — the bulk save (sheet editor, paste, fill): the column's shape check (`checkForStorage`), then the channel
 *              check (`informationChangeErrors`), whose verdict on a cell replaces the shape check's sentence.
 *   shopify  — the bulk save's Shopify branch (`shopifyValueFinding` + `editVerdict`, bulk-edit.service.ts).
 *   import   — xlsx catalogue import, sheet import and channel-file import (`channelImportVerdict`).
 *   formula  — a formula's own value check (`evaluateAgainstContext`); with the writer's answer it takes the save's
 *              warnings (cell-formula-save-verdict.vitest.test.ts).
 *   publish  — the review (`readPublicationFacts`: `publishVerdict` over the resolver's findings); readiness and the cell
 *              mark take the same list (`mapped.blocking`, studio-sheet-verdict.vitest.test.ts).
 *
 * The resolver is replaced by its own value rules (`validateChannelValue` and the required rule of resolve-batch), run on
 * the listing the channel check builds, so the verdict is the only thing under test.
 */
import { describe, expect, it, vi } from 'vitest'
import type { CatalogueField } from './mapping/field-catalogue.service.js'

const m = vi.hoisted(() => ({ fields: [] as unknown[] }))
vi.mock('./mapping/resolve-batch.service.js', async () => {
  const { validateChannelValue, requiredFinding } = await import('./mapping/validate-channel-value.js')
  const { storedChannelState } = await import('./channel-value-mutation.js')
  const { isBlankValue } = await import('./sheet-values.js')
  return {
    resolveBatch: async (input: { productIds: string[]; listingChangesByProduct?: Record<string, Record<string, unknown>> }) => ({
      products: input.productIds.map(productId => ({ productId, cells: Object.fromEntries((m.fields as CatalogueField[]).map(field => {
        const stored = storedChannelState(input.listingChangesByProduct?.[productId] ?? {}, field.channelStore, [field.fieldKey])
        const checked = validateChannelValue(field, stored.state === 'stored' ? stored.value : null)
        const findings = [...checked.findings]
        if (isBlankValue(checked.value) && field.priority === 'required') findings.push(requiredFinding(field, `Field '${field.label}' is required.`))
        return [field.fieldKey, { fieldKey: field.fieldKey, label: field.label, value: checked.value, errors: findings.map(f => f.message), findings }]
      })) })),
    }),
  }
})

import { informationChangeErrors } from './information-validation.js'
import { channelImportVerdict } from './catalog-transfer-plan.js'
import { shopifyValueFinding, validateChannelValue, requiredFinding } from './mapping/validate-channel-value.js'
import { checkForStorage, isBlankValue } from './sheet-values.js'
import { cellFindings, editVerdict, publishVerdict, type ValueFinding } from './value-verdict.js'
import { evaluateAgainstContext } from './mapping/cell-formula.service.js'

type Answer = { edit: 'stored' | 'warned' | 'refused'; message: string | null }
const aspect = (name: string) => ({ kind: 'platformAttributes' as const, path: ['itemSpecifics', name] })
const field = (f: Partial<CatalogueField> & Pick<CatalogueField, 'fieldKey' | 'label'>): CatalogueField => ({
  helpText: null, group: 'Item specifics', groupOrder: 1, priority: 'optional', prioritySource: 'channelSchema', maxLength: null, maxBytes: null,
  options: null, optionLabels: null, selectionOnly: false, editable: true, deprecatedOptions: null, rule: null, ruleKind: 'none', ruleSummary: null,
  ruleRef: null, overlay: false, shape: 'scalar', kind: 'text', ...f,
} as CatalogueField)

const STAGIONE = field({ fieldKey: 'stagione', label: 'Stagione', kind: 'select', options: ['Tutte le stagione', 'Estate'], selectionOnly: true, channelStore: aspect('Stagione') })
const COLORE = field({ fieldKey: 'colore', label: 'Colore', kind: 'select', options: ['Rosso', 'Blu'], selectionOnly: false, channelStore: aspect('Colore') })
const TEAM = field({ fieldKey: 'team', label: 'Team name', maxLength: 65, channelStore: aspect('Team name') })
const TITLE = field({ fieldKey: 'title', label: 'Title', maxLength: 80, channelStore: { kind: 'listingColumn', column: 'title' } as never })
const GENERE = field({ fieldKey: 'genere', label: 'Genere', channelStore: aspect('Genere') })
const MARCA = field({ fieldKey: 'marca', label: 'Marca', priority: 'required', channelStore: aspect('Marca') })
const shopifyDefinition = (validations: Array<{ name: string; value: string }>, required = false) => ({ type: 'single_line_text_field', validations, required })
const COLOUR_METAFIELD = field({ fieldKey: 'couleur', label: 'Couleur', shopifyField: { id: 'mf1', definition: shopifyDefinition([{ name: 'choices', value: '["Rouge","Bleu"]' }]) } as never,
  channelStore: { kind: 'platformAttributes', path: ['_shopifyMetafields', 'couleur'] } as never })
const REQUIRED_METAFIELD = field({ fieldKey: 'matiere', label: 'Matière', priority: 'required', shopifyField: { id: 'mf2', definition: shopifyDefinition([], true) } as never,
  channelStore: { kind: 'platformAttributes', path: ['_shopifyMetafields', 'matiere'] } as never })

/** The editor: the column's shape check first; the channel check's verdict on the cell replaces its sentence. */
async function editor(channel: string, f: CatalogueField, value: unknown): Promise<Answer> {
  const shaped = checkForStorage({ key: f.fieldKey, label: f.label, kind: f.kind, shape: f.shape, options: f.options ?? undefined, mode: f.selectionOnly ? 'strict' : 'open' }, value)
  if (shaped.ok === false) return { edit: 'refused', message: (shaped as { error: string }).error }
  m.fields = [f]
  const out = await informationChangeErrors({ channel, marketplace: 'IT', changes: [{ id: 'p', field: `attr_${f.fieldKey}`, value }], listings: [],
    columns: new Map([['p', new Map([[f.fieldKey, { key: f.fieldKey, label: f.label, channels: { x: { key: f.fieldKey, store: f.channelStore } } } as never]])]]) })
  if (out.errors.length) return { edit: 'refused', message: out.errors[0].error.replace(`${f.label}: `, '') }
  const shapeWarning = shaped.findings[0]?.message ?? null
  if (out.warnings.length) return { edit: 'warned', message: out.warnings[0].warning.replace(`${f.label}: `, '') }
  return shapeWarning ? { edit: 'warned', message: shapeWarning } : { edit: 'stored', message: null }
}
/** The bulk save's Shopify branch. */
function shopifyEditor(f: CatalogueField, value: unknown): Answer {
  const raw = value == null ? null : String(value)
  const found = shopifyValueFinding(f.shopifyField as never, raw)
  return !found ? { edit: 'stored', message: null } : { edit: editVerdict(found) === 'refuse' ? 'refused' : 'warned', message: found.message }
}
function importer(f: CatalogueField, value: unknown): Answer {
  const out = channelImportVerdict(f, value === null ? 'CLEAR' : 'SET', value)
  if (out.refused) return { edit: 'refused', message: out.refused }
  return out.findings.length ? { edit: 'warned', message: out.findings[0].message } : { edit: 'stored', message: null }
}
/** A formula's own check of its result (the writer's answer then replaces it with the save's). */
function formula(f: CatalogueField, value: unknown): Answer {
  const ctx = { flat: {}, product: {}, parent: null, contentListing: null, locale: 'it', resolved: {} }
  const out = evaluateAgainstContext({ expr: JSON.stringify(value), ctx: ctx as never, expressions: {}, field: f })
  const own = out.warnings[0]
  return own ? { edit: 'warned', message: own.replace(`${f.label}: `, '') } : { edit: out.error ? 'refused' : 'stored', message: out.error }
}
/** Publish: the resolver's findings on the STORED value, through the verdict. */
function publish(channel: string, f: CatalogueField, value: unknown): { verdict: 'block' | 'warn' | null; message: string | null } {
  const checked = validateChannelValue(f, value)
  const findings: ValueFinding[] = [...checked.findings]
  if (isBlankValue(value) && f.priority === 'required' && !findings.some(x => x.rule === 'required')) findings.push(requiredFinding(f, `Field '${f.label}' is required.`))
  const found = cellFindings({ errors: findings.map(x => x.message), findings })
  if (!found.length) return { verdict: null, message: null }
  const blocking = found.find(x => publishVerdict(channel, x) === 'block')
  return blocking ? { verdict: 'block', message: blocking.message } : { verdict: 'warn', message: found[0].message }
}

const OFF_LIST = 'Stagione contains an unaccepted value. Allowed values: Tutte le stagione · Estate.'
const CASES: Array<{ name: string; channel: string; field: CatalogueField; value: unknown; edit: Answer; publish: ReturnType<typeof publish>; paths: Array<'editor' | 'shopify' | 'import' | 'formula'> }> = [
  { name: '(a) off-list on a strict eBay list', channel: 'EBAY', field: STAGIONE, value: 'Tutte le stagioni',
    edit: { edit: 'warned', message: OFF_LIST }, publish: { verdict: 'warn', message: OFF_LIST }, paths: ['editor', 'import'] },
  { name: '(a) off-list on a strict Amazon list', channel: 'AMAZON', field: STAGIONE, value: 'Tutte le stagioni',
    edit: { edit: 'warned', message: OFF_LIST }, publish: { verdict: 'block', message: OFF_LIST }, paths: ['editor', 'import'] },
  { name: '(a) off-list on a Shopify metafield\'s choices', channel: 'SHOPIFY', field: COLOUR_METAFIELD, value: 'Red',
    edit: { edit: 'warned', message: 'Choose one of these values: Rouge, Bleu.' }, publish: { verdict: 'block', message: 'Choose one of these values: Rouge, Bleu.' }, paths: ['shopify', 'import'] },
  { name: '(b) off-list on an open eBay list', channel: 'EBAY', field: COLORE, value: 'Bordeaux',
    edit: { edit: 'stored', message: null }, publish: { verdict: null, message: null }, paths: ['editor', 'import', 'formula'] },
  { name: '(c) a 70-character eBay aspect value', channel: 'EBAY', field: TEAM, value: 'T'.repeat(70),
    edit: { edit: 'warned', message: 'Team name exceeds 65 characters (70).' }, publish: { verdict: 'block', message: 'Team name exceeds 65 characters (70).' }, paths: ['editor', 'import', 'formula'] },
  { name: '(c) a 92-character eBay title', channel: 'EBAY', field: TITLE, value: 'x'.repeat(92),
    edit: { edit: 'warned', message: 'Title exceeds 80 characters (92).' }, publish: { verdict: 'block', message: 'Title exceeds 80 characters (92).' }, paths: ['editor', 'import', 'formula'] },
  { name: '(d) a list on a single-value field', channel: 'EBAY', field: GENERE, value: ['Uomo', 'Donna'],
    edit: { edit: 'refused', message: 'Genere takes ONE value — a list was sent' }, publish: { verdict: 'block', message: 'Genere takes one value; 2 are set.' }, paths: ['editor', 'import'] },
  { name: '(e) an explicit clear of a required eBay field', channel: 'EBAY', field: MARCA, value: null,
    edit: { edit: 'warned', message: "Field 'Marca' is required." }, publish: { verdict: 'block', message: "Field 'Marca' is required." }, paths: ['editor', 'import', 'formula'] },
  { name: '(e) an explicit clear of a required Shopify metafield', channel: 'SHOPIFY', field: REQUIRED_METAFIELD, value: null,
    edit: { edit: 'warned', message: 'Enter a value. Shopify needs this field.' }, publish: { verdict: 'block', message: 'Enter a value. Shopify needs this field.' }, paths: ['shopify', 'import'] },
]

describe('one verdict for every path', () => {
  it.each(CASES)('$name', async ({ channel, field: f, value, edit, publish: atPublish, paths }) => {
    const answers: Record<string, Answer> = {}
    for (const path of paths) {
      answers[path] = path === 'editor' ? await editor(channel, f, value) : path === 'shopify' ? shopifyEditor(f, value)
        : path === 'import' ? importer(f, value) : formula(f, value)
    }
    expect(answers).toEqual(Object.fromEntries(paths.map(path => [path, edit])))
    expect(publish(channel, f, value)).toEqual(atPublish)
  })
})
