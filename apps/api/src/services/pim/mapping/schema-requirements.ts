import { Ajv2019 } from 'ajv/dist/2019.js'
import addFormats from 'ajv-formats'
import type { ValidateFunction } from 'ajv'
import type { ChannelSpec, ChannelFieldSpec } from '../channel-specs/types.js'
import { isPresent } from '../resolve-channel-field.js'
import { addAmazonVocabulary } from './amazon-schema-vocabulary.js'
import { isBlankValue } from '../sheet-values.js'

type Node = Record<string, any>
const serializedValue = (value: unknown) => !isBlankValue(value)
const validators = new WeakMap<object, ValidateFunction>()
const schemaEngines = new WeakMap<object, Ajv2019>()
const specs = new WeakMap<object, ChannelSpec>()
export function registerCatalogueSchema(catalogue: object, spec: ChannelSpec | null | undefined) {
  if (spec?.validationSchema) specs.set(catalogue, spec)
}

/** Rebuild the schema's attribute envelopes from its leaf paths. Selectors are
 * schema-owned constants, never copied from another market or guessed from labels. */
export function attributesFromCells(spec: ChannelSpec, values: Record<string, unknown>): Record<string, unknown> {
  const root = spec.validationSchema as Node | undefined
  if (!root) return {}
  const deref = (node: Node): Node => {
    if (typeof node?.$ref !== 'string' || !node.$ref.startsWith('#/')) return node ?? {}
    return node.$ref.slice(2).split('/').reduce((v: any, k: string) => v?.[k.replace(/~1/g, '/').replace(/~0/g, '~')], root) ?? node
  }
  const output: Record<string, unknown> = {}
  for (const attribute of Object.keys(root.properties ?? {})) {
    const fields = spec.fields.filter(f => f.attribute === attribute && serializedValue(values[f.key]))
    if (!fields.length) continue
    const build = (raw: Node, path: string[], index?: number): unknown => {
      const node = deref(raw)
      const matches = fields.filter(f => path.every((p, i) => f.path[i] === p) || (path.at(-1) === 'value' && f.path.join('/') === path.slice(0, -1).join('/')))
      const exact = fields.find(f => f.path.join('/') === path.join('/'))
      if (!matches.length && !exact) return undefined
      const read = (field: ChannelFieldSpec) => {
        const value = values[field.key]
        return index !== undefined && Array.isArray(value) ? value[index] : value
      }
      if (node.type === 'array') {
        // One flattened list cannot describe two independent nested array axes.
        if (index !== undefined && matches.some(f => Array.isArray(values[f.key]) && (values[f.key] as unknown[]).length > 1)) {
          throw new Error(`Nested repeated values in ${attribute} cannot be edited with Information’s flattened controls. The saved structure is preserved.`)
        }
        const length = Math.max(0, ...matches.map(f => Array.isArray(values[f.key]) ? (values[f.key] as unknown[]).length : 1))
        return Array.from({ length }, (_, i) => build(node.items ?? {}, path, i))
      }
      if (node.type === 'object' || node.properties) {
        const object: Record<string, unknown> = {}
        for (const [key, child] of Object.entries(node.properties ?? {})) {
          const definition = deref(child as Node)
          let value: unknown
          if (key === 'value' && exact && exact.shape !== 'measure') value = read(exact)
          else if (['marketplace_id', 'language_tag'].includes(key) || (fields.some(f => f.selectors?.includes(key)) && !fields.some(f => f.path.join('/') === [...path, key].join('/')))) {
            value = definition.const ?? (definition.enum?.length === 1 ? definition.enum[0] : definition.default)
            if (value !== undefined && definition.enum && !definition.enum.includes(value)) throw new Error(`The schema has an invalid ${key} selector for ${attribute}.`)
          } else if (exact?.shape === 'measure' && ['value', 'unit'].includes(key)) {
            const measure = read(exact) as Record<string, unknown> | null
            value = measure?.[key]
          } else if (key === 'value' && exact) value = read(exact)
          else value = build(definition, [...path, key], index)
          if (serializedValue(value)) object[key] = value
        }
        return Object.keys(object).length ? object : undefined
      }
      return exact ? read(exact) : undefined
    }
    const value = build(root.properties[attribute], [])
    if (serializedValue(value)) output[attribute] = value
  }
  return output
}

function validator(schema: Node) {
  let validate = validators.get(schema)
  if (!validate) {
    // Amazon extends draft 2019-09 with presentation annotations. Core conditional
    // semantics stay intact; no coercion, defaults, removal or network schema loads.
    const ajv = new Ajv2019({ strict: false, allErrors: true, validateSchema: false })
    addFormats(ajv)
    addAmazonVocabulary(ajv)
    const { $schema: _meta, $id: _id, ...local } = schema
    ajv.addSchema(local, 'information')
    validate = ajv.getSchema('information')!
    validators.set(schema, validate)
    schemaEngines.set(schema, ajv)
  }
  return validate
}

/** Amazon deletes identify attribute instances by their schema selector values. */
export function attributeDeleteValue(spec: ChannelSpec, attribute: string): Record<string, unknown>[] {
  const root = spec.validationSchema as Node | undefined
  const node = root?.properties?.[attribute]
  const selectors: string[] = node?.selectors ?? []
  if (!selectors.length) throw new Error(`Cannot clear ${attribute}: the category schema declares no attribute selectors.`)
  const values: Record<string, unknown> = {}
  for (const key of selectors) {
    let definition = node.items?.properties?.[key] ?? {}
    if (definition.$ref?.startsWith('#/')) definition = definition.$ref.slice(2).split('/').reduce((v: any, k: string) => v?.[k.replace(/~1/g, '/').replace(/~0/g, '~')], root) ?? {}
    const value = definition.const ?? (definition.enum?.length === 1 ? definition.enum[0] : definition.default)
    if (!serializedValue(value) || (definition.enum && !definition.enum.includes(value))) throw new Error(`Cannot clear ${attribute}: its ${key} selector needs an explicit existing attribute value.`)
    values[key] = value
  }
  return [values]
}

/** Attribute requiredness must remain present after a value is filled. AJV's
 * error list only names missing values. Required envelope members constrain an
 * existing optional attribute; they do not make that attribute mandatory. */
function applicableRequiredFields(spec: ChannelSpec, attributes: Record<string, unknown>): string[] {
  const root = spec.validationSchema as Node
  const ajv = schemaEngines.get(root)!
  const escape = (key: string) => key.replace(/~/g, '~0').replace(/\//g, '~1')
  const matches = (pointer: string) => ajv.getSchema(`information${pointer}`)?.(attributes) === true
  const visit = (node: Node, pointer: string, depth = 0): Set<string> => {
    const keys = new Set<string>()
    if (!node || typeof node !== 'object' || depth > 60) return keys
    const add = (other: Set<string>) => { for (const key of other) keys.add(key) }
    const walk = (child: Node, suffix: string) => visit(child, `${pointer}/${suffix}`, depth + 1)
    const required = (member: string) => {
      for (const field of spec.fields) {
        if (field.attribute === member && field.requiredInParent !== false) keys.add(field.key)
      }
    }
    if (typeof node.$ref === 'string' && node.$ref.startsWith('#/')) {
      const referred = node.$ref.slice(2).split('/').reduce((v: any, k: string) => v?.[k.replace(/~1/g, '/').replace(/~0/g, '~')], root)
      add(visit(referred, node.$ref, depth + 1))
    }
    for (const member of node.required ?? []) required(member)
    for (const [key, members] of Object.entries(node.dependentRequired ?? {})) if (Object.prototype.hasOwnProperty.call(attributes, key)) for (const member of members as string[]) required(member)
    for (const [key, child] of Object.entries(node.dependentSchemas ?? {})) if (Object.prototype.hasOwnProperty.call(attributes, key)) add(walk(child as Node, `dependentSchemas/${escape(key)}`))
    for (const [index, child] of (node.allOf ?? []).entries()) add(walk(child, `allOf/${index}`))
    if (node.if) {
      const branch = matches(`${pointer}/if`) ? 'then' : 'else'
      if (node[branch]) add(walk(node[branch], branch))
    }
    // Alternatives do not make every member mandatory. Only requirements common
    // to every successful branch are applicable to the current representation.
    for (const keyword of ['anyOf', 'oneOf']) {
      const alternatives = (node[keyword] ?? []).flatMap((child: Node, index: number) => matches(`${pointer}/${keyword}/${index}`) ? [walk(child, `${keyword}/${index}`)] : []) as Set<string>[]
      if (alternatives.length) for (const key of alternatives[0]) if (alternatives.every(set => set.has(key))) keys.add(key)
    }
    return keys
  }
  return [...visit(root, '#')]
}

export interface RequirementIssue { fieldKey: string; message: string; required: boolean; schemaPath: string }
/** Validate the completed envelope, including values supplied by listing owners. */
export function validateSchemaAttributes(spec: ChannelSpec, attributes: Record<string, unknown>): string[] {
  if (!spec.validationSchema) throw new Error('The category validation schema is unavailable.')
  const validate = validator(spec.validationSchema)
  validate(attributes)
  return (validate.errors ?? []).map(error => `${error.instancePath || '/'} ${error.message ?? error.keyword}`)
}
export function evaluateSchemaRequirements(catalogue: object, values: Record<string, unknown>): { issues: RequirementIssue[]; requiredFields?: string[]; unavailable?: string } {
  const spec = specs.get(catalogue)
  if (!spec?.validationSchema) return { issues: [] }
  try {
    const attributes = attributesFromCells(spec, values)
    const validate = validator(spec.validationSchema)
    validate(attributes)
    const issues: RequirementIssue[] = []
    // The full schema also owns constraints narrowed by conditions, such as an
    // enum that only applies to children. Flattened leaf metadata cannot do that.
    const unaddressable: string[] = []
    for (const error of validate.errors ?? []) {
      if (['if', 'anyOf', 'oneOf'].includes(error.keyword)) continue
      const isRequirement = ['required', 'dependentRequired'].includes(error.keyword)
      const segments = error.instancePath.split('/').slice(1).filter(p => !/^\d+$/.test(p)).map(p => p.replace(/~1/g, '/').replace(/~0/g, '~'))
      const missing = String(error.params.missingProperty ?? '')
      const attribute = segments[0] ?? missing
      const path = [...segments.slice(1), ...(segments.length && missing ? [missing] : [])].filter(p => p !== 'value')
      const attributeFields = spec.fields.filter(f => f.attribute === attribute)
      let fields = attributeFields.filter(f => path.length === 0 ? !isRequirement || f.requiredInParent !== false : f.path.join('/') === path.join('/') || (f.shape === 'measure' && [...f.path, 'unit'].join('/') === path.join('/')))
      const selectorOrEnvelope = !fields.length
      if (selectorOrEnvelope) fields = attributeFields.slice(0, 1)
      if (!fields.length) unaddressable.push(`${error.instancePath || '/'} ${error.message ?? error.keyword}`)
      for (const field of fields) {
        const conditional = /\/(then|else|dependentSchemas|dependencies)\//.test(error.schemaPath)
        const alternative = /\/(anyOf|oneOf)\//.test(error.schemaPath)
        const reason = alternative ? 'The category requires an allowed alternative; this option needs' : conditional ? `Required by the category's condition for this product` : 'Required by the category schema'
        const label = (catalogue as { fields?: { fieldKey: string; label: string }[] }).fields?.find(f => f.fieldKey === field.key)?.label ?? field.englishLabel ?? field.label
        issues.push({ fieldKey: field.key, required: isRequirement && !alternative && !selectorOrEnvelope && !['marketplace_id', 'language_tag', 'unit'].includes(missing), schemaPath: error.schemaPath,
          message: isRequirement ? selectorOrEnvelope ? `${reason}: the ${attribute} attribute${path.length ? ` needs ${missing}` : ''}.` : `${reason}: ${label}${missing && path.length ? ` (${missing})` : ''}.` : `${label}: ${error.message ?? error.keyword}${error.keyword === 'enum' ? ` (${(error.params.allowedValues as unknown[]).join(', ')})` : ''}.` })
      }
    }
    if (!issues.length && (validate.errors?.length ?? 0) > 0) unaddressable.push('The category’s alternative constraints could not be satisfied.')
    return { issues: [...new Map(issues.map(i => [`${i.fieldKey}:${i.schemaPath}`, i])).values()], requiredFields: applicableRequiredFields(spec, attributes), ...(unaddressable.length ? { unavailable: [...new Set(unaddressable)].join('; ') } : {}) }
  } catch (error) {
    return { issues: [], unavailable: error instanceof Error ? error.message : 'Schema requirements could not be evaluated' }
  }
}
