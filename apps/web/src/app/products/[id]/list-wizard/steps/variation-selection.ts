type Bag = Record<string, unknown>
const owns = (value: Bag, key: string) => Object.prototype.hasOwnProperty.call(value, key)
/** Preserve explicit blanks/null/false; only absence inherits a common theme. */
export function effectiveVariationTheme(byChannel: Bag, commonTheme: unknown, key: string): unknown {
  return owns(byChannel, key) ? byChannel[key] : commonTheme
}
/** An untouched rendered default is not an operator edit. Preserve the original JSON value. */
export function changedVariationSelection(original: Bag, initial: Bag, current: Bag): Bag {
  const next = { ...original }
  for (const [key, value] of Object.entries(current)) {
    if (JSON.stringify(value) !== JSON.stringify(initial[key])) next[key] = value
  }
  return next
}
