import { Kind, parse, type DefinitionNode, type DocumentNode, type FragmentDefinitionNode, type SelectionSetNode } from 'graphql'

/**
 * What a GraphQL document does, from the parsed document (graphql-js), never from its text.
 *
 * Review of PR #54 (2026-09-26): the text reading cut from `#` to the end of the line even inside a string,
 * and looked only at the first definition and the first root field. So a mutation behind a fragment
 * (`fragment F on Mutation { productDelete(input:{id:"x#"}) … } mutation { ...F }`), behind a leading query,
 * or behind a harmless first root field was classified as a read and skipped the publish mode.
 *
 * - `readOnly`: the document parses, has at least one operation, every operation is a `query`, and no fragment
 *   is on the Mutation or Subscription root. Anything else — including a document that does not parse — is
 *   treated as a change (fail closed): Shopify refuses a document it cannot parse, so nothing is lost.
 * - `fields`: the root fields of every mutation / subscription (fragments followed), or of the queries when
 *   the document only reads. Aliases resolve to the real field; `__typename` is not a root field.
 * - `field`: the first of them, for the call ledger's operation name.
 */
export interface GraphqlDocumentInfo { readOnly: boolean; field: string | null; fields: string[] }

const CHANGE_ROOT = /^(mutation|subscription)(root|type)?$/i

export function graphqlDocumentInfo(query: string): GraphqlDocumentInfo {
  let doc: DocumentNode
  try {
    doc = parse(query, { noLocation: true })
  } catch {
    return { readOnly: false, field: null, fields: [] }
  }
  const fragments = new Map<string, FragmentDefinitionNode>()
  for (const def of doc.definitions) if (def.kind === Kind.FRAGMENT_DEFINITION) fragments.set(def.name.value, def)

  const rootFields = (set: SelectionSetNode, seen = new Set<string>()): string[] => set.selections.flatMap((selection) => {
    if (selection.kind === Kind.FIELD) return selection.name.value.startsWith('__') ? [] : [selection.name.value]
    if (selection.kind === Kind.INLINE_FRAGMENT) return rootFields(selection.selectionSet, seen)
    const name = selection.name.value
    const fragment = fragments.get(name)
    if (!fragment || seen.has(name)) return []
    return rootFields(fragment.selectionSet, new Set([...seen, name]))
  })

  const operations = doc.definitions.filter((def: DefinitionNode) => def.kind === Kind.OPERATION_DEFINITION)
  const changeOperations = operations.filter((op) => op.operation !== 'query')
  const changeFragments = [...fragments.values()].filter((f) => CHANGE_ROOT.test(f.typeCondition.name.value))
  const readOnly = operations.length > 0 && changeOperations.length === 0 && changeFragments.length === 0
  const fields = readOnly
    ? operations.flatMap((op) => rootFields(op.selectionSet))
    : [...new Set([...changeOperations.flatMap((op) => rootFields(op.selectionSet)), ...changeFragments.flatMap((f) => rootFields(f.selectionSet))])]
  return { readOnly, field: fields[0] ?? null, fields }
}

/** The first root field of a GraphQL document, and whether it may change anything; shared by classification and request journaling. */
export function graphqlRootField(query: string): { mutation: boolean; field: string | null } {
  const info = graphqlDocumentInfo(query)
  return { mutation: !info.readOnly, field: info.field }
}
