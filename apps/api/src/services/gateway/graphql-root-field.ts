/** The first root field of a GraphQL mutation; shared by classification and request journaling. */
export function graphqlRootField(query: string): { mutation: boolean; field: string | null } {
  const text = query.replace(/#[^\n]*/g, '')
  const mutation = /^\s*mutation\b/.test(text)
  const body = text.slice(text.indexOf('{') + 1)
  return { mutation, field: /^\s*(?:\w+\s*:\s*)?(\w+)/.exec(body)?.[1] ?? null }
}
