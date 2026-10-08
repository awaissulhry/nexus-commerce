/**
 * ONE BRAIN AB-19 — the Amazon ads skills Claude follows (integrations/claude/nexus/skills/*), held against the code they
 * name. The daily run is the ads brain's supervisor (design 2026-10-08-ads-one-brain/DESIGN.md §0, §3, §8 row AB-19): for
 * a product the brain runs it never asks for a lever the brain owns, it reads the brain's map and daily product report, it
 * reports the brain's clashes and tool gaps, and it raises the Owner's decisions instead of acting. A skill is read by a
 * model, not run, so these checks hold its words to what Nexus has:
 *
 *   supervisor  the daily run's rule and its section 10; "owned" is PROPOSE or AUTO as the brain's code says (ownsLever);
 *               every lever of the brain is named; the brain's own change tools and requests are the Owner's, never asked
 *   names       every `kebab-name` the ads skills put in code marks is a registered tool, a skill, or a value some tool
 *               takes (its input schema) — a skill never sends Claude to a tool that does not exist; every ads-brain view
 *               they name is a view the tool has; every field of the brain's answers they name is one the code returns
 *   public      the repository is public: no business figure (an amount, an ASIN, a numbered id) in the ads skills
 *   plugin      the plugin's version is a version, and its description counts the skills there are
 */
import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { BRAIN_LEVELS, BRAIN_LEVERS, ownsLever } from '../advertising/brain/levers.js'
import { BRAIN_MAP_VIEWS } from '../advertising/brain/read-map.js'
import { CONTROL_TOOL } from '../advertising/brain/control.js'
import { HARVEST_TOOL } from '../advertising/brain/harvest-write.js'
import { HOURS_TOOL } from '../advertising/brain/hours-proposal.js'
import { KILL_TOOL } from './tools/ads-brain-kill.tools.js'
import { listTools } from './tool-registry.js'
import { inputJsonSchema } from './tool-loop.service.js'

const SKILLS = new URL('../../../../../integrations/claude/nexus/skills/', import.meta.url)
const PLUGIN = new URL('../../../../../integrations/claude/nexus/.claude-plugin/plugin.json', import.meta.url)
const skill = (name: string) => readFileSync(new URL(`${name}/SKILL.md`, SKILLS), 'utf8')
const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

/** The skills that ask for or explain Amazon ad changes. */
const ADS_SKILLS = ['ads-daily-manager', 'ads-weekly-review', 'ads-playbook', 'ads-strategy', 'automation-review'] as const
const DAILY = skill('ads-daily-manager')
const SECTION_10 = DAILY.slice(DAILY.indexOf('## 10. The ads brain'), DAILY.indexOf('## Setting up the routine'))

/** How the daily run names each lever of the brain in words (section 10's list). */
const LEVER_WORDS: Record<(typeof BRAIN_LEVERS)[number], string> = {
  bids: 'bids', adGroupBids: 'ad-group bids', hours: 'hours', placements: 'placements', state: 'state', budgets: 'budgets',
  portfolioCap: 'portfolio cap', negatives: 'negatives', harvest: 'harvest', structure: 'structure', biddingStrategy: 'bidding strategy', offAmazon: 'off-Amazon',
}

/** Words in code marks that name no tool, skill or input value: values a tool's answer carries. */
const ANSWER_VALUES = new Set(['can-rise', 'cannot-rise'])

/** Every string an input schema allows as a value (enums and constants), at any depth. */
function inputValues(schema: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(schema)) { for (const x of schema) inputValues(x, out); return out }
  if (!schema || typeof schema !== 'object') return out
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (k === 'enum' && Array.isArray(v)) for (const e of v) if (typeof e === 'string') out.add(e)
    if (k === 'const' && typeof v === 'string') out.add(v)
    inputValues(v, out)
  }
  return out
}

describe('AB-19 — the daily run supervises the ads brain', () => {
  it('a hard rule and a section of their own: never a lever the brain owns, read it first, a stop still goes', () => {
    expect(DAILY).toMatch(/\*\*The ads brain's levers are the brain's \(10\)\.\*\* For a product Nexus's ads brain runs, read `ads-brain` before deciding anything for it\./)
    expect(DAILY).toMatch(/this run never asks to change that lever there/)
    expect(DAILY).toMatch(/A stop that lowers bids \(stock, safety\) still goes/)
    expect(SECTION_10).toMatch(/^## 10\. The ads brain: supervise, never steer/)
    expect(SECTION_10).toMatch(/\*\*Never write a lever the brain owns\.\*\*/)
    // The decision order takes the brain's levers out before anything is decided, and the weekly day proposes none.
    expect(DAILY).toMatch(/Take out first every lever the ads brain owns \(10\): nothing below asks for one\./)
    expect(DAILY).toMatch(/no structure, playbook sync, hero or hourly-plan proposal on a lever the brain owns/)
  })

  it('"owned" is PROPOSE or AUTO, exactly as the brain\'s code says; OBSERVE and OFF are run as before', () => {
    expect(BRAIN_LEVELS.filter(ownsLever)).toEqual(['PROPOSE', 'AUTO'])
    expect(DAILY).toMatch(/that lever's `brain` in the map is `PROPOSE` or `AUTO`/)
    expect(DAILY).toMatch(/A lever in shadow \(`OBSERVE`\) or `OFF`, and a shared campaign \(`SHARED`\), are run as before\./)
    for (const level of BRAIN_LEVELS) expect(SECTION_10).toContain(`\`${level}\``)
  })

  it('every lever of the brain is named, so a new lever is not left out of the supervisor\'s rule', () => {
    const list = SECTION_10.slice(SECTION_10.indexOf('levers in one market — '), SECTION_10.indexOf(' — each at its own level'))
    for (const lever of BRAIN_LEVERS) expect(list, lever).toContain(LEVER_WORDS[lever])
    expect(list.split(', ')).toHaveLength(BRAIN_LEVERS.length)
  })

  it('reads the brain\'s daily product report and summarises it in its own words; its requests are never this run\'s', () => {
    expect(SECTION_10).toMatch(/\*\*Read its daily product report\.\*\* `view: "report"` with `market`/)
    expect(SECTION_10).toMatch(/Summarise it in the report \(7\) in your own words; never copy a figure, never decide, repeat or ask again for one of its requests\./)
    expect(DAILY).toMatch(/Never its approval ids in `waiting`: they are the brain's, not this run's\./)
  })

  it('reports the brain\'s clashes and tool gaps as problems', () => {
    expect(SECTION_10).toMatch(/\*\*Clashes and tool gaps\.\*\* `view: "clashes"` per market/)
    expect(SECTION_10).toMatch(/`view: "setup"`: tools not set up or held off/)
    expect(DAILY).toMatch(/and the ads brain's clashes and tool gaps \(10\), one line each/)
  })

  it('raises the Owner\'s decisions instead of acting: the brain\'s own change tools are never asked or decided', () => {
    expect(SECTION_10).toMatch(/\*\*Raise the Owner's decisions; never act on them\.\*\*/)
    // The tools that change the brain or carry its own requests: named in the never-rule, each a real tool.
    const tools = new Set(listTools().map((t) => t.name))
    for (const name of [CONTROL_TOOL, KILL_TOOL, HARVEST_TOOL, HOURS_TOOL]) {
      expect(tools.has(name), name).toBe(true)
      expect(DAILY, name).toContain(`\`${name}\``)
    }
    expect(DAILY).toMatch(/its kill switch \(`set-brain-kill-switch`, asked only with the Owner's word\)/)
  })

  it('the other ads skills hold the same line: weekly review, playbook and automation review', () => {
    expect(skill('ads-weekly-review')).toMatch(/Never propose a change on a lever the brain owns on a campaign/)
    expect(skill('ads-playbook')).toMatch(/\*\*Products the ads brain runs\.\*\* Read `ads-brain`/)
    expect(skill('ads-playbook')).toMatch(/STOP still goes: a stop is a safety owner\./)
    expect(skill('automation-review')).toMatch(/Never propose turning up an engine, or a rule, as the fix for a lever the brain owns there/)
  })
})

describe('AB-19 — the names the ads skills use are Nexus\'s', () => {
  const tools = listTools()
  const toolNames = new Set(tools.map((t) => t.name))
  const skillNames = new Set(readdirSync(SKILLS, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name))
  const values = new Set<string>()
  for (const t of tools) inputValues(inputJsonSchema(t), values)

  it('every `kebab-name` in code marks is a tool, a skill, or a value a tool takes', () => {
    for (const name of ADS_SKILLS) {
      const marked = [...skill(name).matchAll(/`([a-z][a-z0-9]*(?:-[a-z0-9]+)+)`/g)].map((m) => m[1])
      expect(marked.length, name).toBeGreaterThan(0)
      const unknown = [...new Set(marked)].filter((n) => !toolNames.has(n) && !skillNames.has(n) && !values.has(n) && !ANSWER_VALUES.has(n))
      expect(unknown, `${name} names what Nexus does not have`).toEqual([])
    }
  })

  it('every ads-brain view they name is a view of the tool', () => {
    for (const name of ADS_SKILLS) {
      for (const line of skill(name).split('\n').filter((l) => l.includes('`ads-brain`'))) {
        for (const [, view] of line.matchAll(/`view: "([a-z]+)"`/g)) expect(BRAIN_MAP_VIEWS as readonly string[], `${name}: ${view}`).toContain(view)
      }
    }
  })

  it('every field of the brain\'s answers the daily run names is one the code returns', () => {
    const code = ['../advertising/brain/read-map.ts', '../advertising/brain/cycle-read.ts', '../advertising/brain/cycle.ts', '../advertising/brain/off-amazon.ts', '../advertising/brain/budget-read.ts'].map(source).join('\n')
    for (const field of ['products', 'kills', 'brain', 'owner', 'ownerLock', 'lockedThings', 'clash', 'headline', 'waiting', 'clashes', 'problems', 'summary', 'waitsForOwner', 'offAmazon', 'ownerLine']) {
      expect(DAILY, field).toContain(field)
      expect(code, field).toMatch(new RegExp(`\\b${field}\\b\\s*[:?]|[{,]\\s*${field}\\s*[,}]`))
    }
  })
})

describe('AB-19 — public repository: no business figures in the ads skills', () => {
  it('no amount, no ASIN, no numbered id', () => {
    for (const name of ADS_SKILLS) {
      const text = skill(name)
      expect(text, name).not.toMatch(/[€$£] ?\d|\d ?[€£]|\d+[.,]\d{2}\b/)
      expect(text, name).not.toMatch(/\bB0[A-Z0-9]{8}\b/)
      expect(text, name).not.toMatch(/_\d{3}\b/)
    }
  })
})

describe('AB-19 — the plugin', () => {
  it('a version, and the description counts the skills there are', () => {
    const plugin = JSON.parse(readFileSync(PLUGIN, 'utf8')) as { version: string; description: string }
    expect(plugin.version).toMatch(/^\d+\.\d+\.\d+$/)
    const count = readdirSync(SKILLS, { withFileTypes: true }).filter((d) => d.isDirectory()).length
    expect(plugin.description).toContain(`adds ${count} skills`)
  })
})
