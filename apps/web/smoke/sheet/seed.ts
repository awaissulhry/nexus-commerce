import { readFileSync } from 'node:fs'

/** What scripts/ci/seed-sheet-fixture.mts wrote. */
export interface SheetSeed {
  workspace: string
  nonce: string
  families: Record<'master' | 'EBAY' | 'AMAZON' | 'ETSY', { family: string; sku: string; name: string; variations: number; channel?: string; market?: string; connection?: string }>
  /** Per channel: whether the category column can be swept (the seed made the taxonomy it searches), and why not. */
  categories: Record<string, { sweep: boolean; choices?: Array<{ id: string; name: string }>; reason?: string }>
  themes: Array<{ id: string; name: string }>
}

export function sheetSeed(): SheetSeed {
  const path = process.env.SHEET_SEED
  if (!path) throw new Error('SHEET_SEED is not set — run scripts/ci/seed-sheet-fixture.mts and point SHEET_SEED at its --out file')
  return JSON.parse(readFileSync(path, 'utf8')) as SheetSeed
}
