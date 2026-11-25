/**
 * cw fx5 (walk W-7): words that end with a time ("Waiting on customer · 16 d") wrap inside a narrow cell on a word's edge and
 * never inside the time — "· 16 d" goes to the second line whole (no-break spaces inside the tail and after its dot).
 * pg-w1: moved here from the Orders sheet's parts (they re-export it), unchanged.
 */
export function tailWhole(text: string, tail: string | null): string {
  if (!tail || !text.endsWith(tail)) return text
  const head = text.slice(0, text.length - tail.length)
  return `${head.replace(/· $/, '·\u00a0')}${tail.replace(/ /g, '\u00a0')}`
}
