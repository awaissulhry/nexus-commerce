/**
 * The ads console's read ticket — only the NEWEST read may show. Keyword Harvest (release review RS5) read one market: a
 * person who switches market (or a refresh that starts while another read is still out) must never see the older answer
 * land on top: market A's rules or sources, and their tiles, under market B. Editing correctness (group 3): the same for
 * every re-read after a save (the Campaigns grid, the campaign and ad-group pages, the Bid page): a read that started
 * before the save and answers after it never paints the old values over the saved ones. Pure, tested in Node.
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
