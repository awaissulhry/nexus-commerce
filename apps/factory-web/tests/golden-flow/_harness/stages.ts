import { readdirSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Flow } from './flow'

/**
 * The stages of the one end-to-end W1 test (PLAN §4.7), in order. Each lives in `tests/golden-flow/<name>.ts` and
 * default-exports `defineStage({ proves, run })`. The runner (golden-flow.spec.ts) loads them by name: a stage of the
 * plan without its file is reported "not built yet"; a stage that cannot go through its screens yet says why in
 * `blocked` and does its part through the API instead (`run`), so the stages after it still run, and the report names it.
 */
export const PLAN_STAGES = [
  '01-customer',
  '02-style',
  '03-certificate',
  '04-cost',
  '05-quote',
  '06a-accept',
  '06b-deposit',
  '07-order',
  '08-buy',
  '09a-receive',
  '09b-cr6',
  '10-work-order',
  '11a-issue',
  '11b-cut',
  '12-scans',
  '13a-labels',
  '13b-release',
  '14-ship',
  '15-invoice',
  '16-close',
] as const

export interface StageSpec {
  /** What the stage proves, in the plan's words. */
  readonly proves: string
  /** Set when a part cannot go through the screens yet: why, and what `run` does instead. */
  readonly blocked?: string
  run(flow: Flow): Promise<void>
}

export function defineStage(spec: StageSpec): StageSpec {
  return spec
}

const DIR = fileURLToPath(new URL('../', import.meta.url))
const FILE = /^(\d{2}[a-z]?-[a-z0-9-]+)\.ts$/

/** The plan's stages and any other stage file of the folder, in name order. */
export function stageNames(): string[] {
  const files = readdirSync(DIR).map((name) => FILE.exec(name)?.[1]).filter((name): name is string => Boolean(name))
  return [...new Set<string>([...PLAN_STAGES, ...files])].sort()
}

export type Loaded = { readonly kind: 'missing' } | { readonly kind: 'stage'; readonly stage: StageSpec }

export async function loadStage(name: string): Promise<Loaded> {
  const files = readdirSync(DIR)
  if (!files.includes(`${name}.ts`)) return { kind: 'missing' }
  const module = (await import(pathToFileURL(`${DIR}${name}.ts`).href)) as { default?: StageSpec }
  if (!module.default || typeof module.default.run !== 'function') throw new Error(`tests/golden-flow/${name}.ts does not default-export defineStage({ proves, run })`)
  return { kind: 'stage', stage: module.default }
}
