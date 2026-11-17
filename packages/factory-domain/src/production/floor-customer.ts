/**
 * B-PR-11 (production plan §2 "Shared floor screens (tickets, travellers, Line TV, dispatch, wall screens) show the customer
 * code, never the name"; lead pick L13): THE customer label of a surface the floor shares — the work order traveller, the
 * dispatch lists and their paper, and any later ticket or wall screen that names whose work it is. The paper and the screens go
 * round the floor and hang on walls, so they carry the customer's CODE only (a code may itself read like the brand: accepted
 * by L13), never its legal or trade name. Pure.
 *
 *   one customer      its code (`SEED-C2B`)
 *   several           a work order made before the one-customer rule (B-PR-01, "Mixed brands (made before the rule)"): each
 *                     code once, sorted, side by side (`SEED-C1 · SEED-C2B`)
 *   none              a sample of a round for no customer, our own stock: null (the surface shows nothing)
 *
 * It takes the codes only: a name never reaches it.
 */
export function floorCustomer(parties: readonly { readonly code: string }[]): string | null {
  const codes = [...new Set(parties.map((party) => party.code.trim()).filter((code) => code !== ''))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return codes.length === 0 ? null : codes.join(' · ')
}
