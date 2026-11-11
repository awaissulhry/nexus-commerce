/**
 * The warehouse rules the database holds for every stock move (factory-db …_warehouse_depth_w2b_guards, W2b-5 schema wave
 * 36/44, B-W2b-277; SCM-181, SCM-220, SCM-226), read back from the database's own words, pure: a blocked location takes no
 * move in or out, a frozen count line holds its item's moves at its place, and a transit location moves only with its
 * transfer. A command checks these first in words (B-W2b-289, -292, -299, -326); when a write reaches the rule without that
 * check (W1's move routes, a race), the API answers 409 in these words instead of a 500 (apps/factory-api core/errors).
 */

/** The issue paths of the three refusals. */
export const WAREHOUSE_REFUSAL_ISSUES = Object.freeze({
  blocked: 'warehouse/LOCATION_BLOCKED',
  frozen: 'warehouse/COUNT_FROZEN',
  transit: 'warehouse/TRANSIT_ONLY_TRANSFER',
} as const)

const BLOCK_WORDS: Readonly<Record<string, string>> = Object.freeze({ COUNT: 'a count', DAMAGE: 'damage', CLEAN_UP: 'clean-up', OTHER: 'see the location' })

const BLOCKED = /^inventory: location (\S+) is blocked \(([A-Z_]+)\)/
const FROZEN = /^inventory: count (\S+) is counting this material at location (\S+) \(a frozen line\)/
const TRANSIT = /^inventory: stock move \S+ enters or leaves a transit location without its transfer/

/** The words and issue path of a warehouse refusal of the database, or null when the message is another one. */
export function databaseWarehouseRefusal(message: string): { readonly path: string; readonly message: string } | null {
  const blocked = BLOCKED.exec(message)
  if (blocked) {
    return {
      path: WAREHOUSE_REFUSAL_ISSUES.blocked,
      message: `Location ${blocked[1]} is blocked (${BLOCK_WORDS[blocked[2]!] ?? blocked[2]}): nothing moves in or out of it until it is unblocked.`,
    }
  }
  const frozen = FROZEN.exec(message)
  if (frozen) {
    return { path: WAREHOUSE_REFUSAL_ISSUES.frozen, message: `Count ${frozen[1]} is counting this material at ${frozen[2]}: its moves there wait until the line is counted.` }
  }
  if (TRANSIT.test(message)) {
    return { path: WAREHOUSE_REFUSAL_ISSUES.transit, message: 'Goods in transit move only with their transfer: the ship, the receipt, or a difference written off.' }
  }
  return null
}
