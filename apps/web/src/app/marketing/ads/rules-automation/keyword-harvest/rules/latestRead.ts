/**
 * Keyword Harvest page (release review RS5) — only the NEWEST read may show. The Rules and Sources views read one market;
 * a person who switches market (or a refresh that starts while another read is still out) must never see the older
 * answer land on top: market A's rules or sources, and their tiles, under market B. Pure, tested in Node.
 *
 *   const begin = latestRead()
 *   const current = begin()            // at the start of each read
 *   const a = await read()
 *   if (!current()) return             // a newer read began: drop this answer
 */
export function latestRead(): () => () => boolean {
  let newest = 0
  return () => {
    const mine = ++newest
    return () => mine === newest
  }
}
