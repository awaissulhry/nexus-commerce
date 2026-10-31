import { LIST_ROWS } from '../../_demo/fixtures'

/**
 * Made-up margins for the design case of the orders list's Margin % column (SCR-038, B-W2a-72): the margin % as estimated
 * now per invented order, one below zero, one whose cost cannot be told (null) and one still being read (absent).
 * Design-only (no designScreen: the case sits in SCR-038's fixtures).
 */
const PCTS = ['38.2000', '41.5000', null, '29.7500', '-3.1000', '35.0000', '33.3333', '40.0000', '37.5000']
export const LIST_MARGINS: ReadonlyMap<string, string | null> = new Map(LIST_ROWS.slice(0, PCTS.length - 1).map((row, index) => [row.id, PCTS[index] ?? null]))
