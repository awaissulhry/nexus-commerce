/** Required fit is measured against the exact Information coordinate, including canonical keys. */
export function requiredColumnKeys(columns) {
  if (!Array.isArray(columns)) throw new Error('Required-column metadata is absent')
  const keys = columns.filter(column => (column.requiredBy ?? []).length > 0).map(column => column.key)
  if (keys.some(key => typeof key !== 'string' || !key) || new Set(keys).size !== keys.length) {
    throw new Error('Required-column metadata has invalid or duplicate keys')
  }
  return keys
}

export function sameRequiredSet(left, right) {
  return left.length === right.length && left.every(key => right.includes(key))
}

export function compareRequiredColumns(columns, sheetColumns) {
  const declared = requiredColumnKeys(columns)
  const rendered = requiredColumnKeys(sheetColumns)
  return {
    ok: declared.length > 0 && sameRequiredSet(declared, rendered),
    declared,
    rendered,
    missing: declared.filter(key => !rendered.includes(key)),
    extra: rendered.filter(key => !declared.includes(key)),
  }
}
