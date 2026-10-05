/**
 * Phase 1 N1 — an argument name a tool does not take is refused at Claude's door, never dropped.
 *
 * A tool's zod input strips unknown keys, so `market` sent to a tool that takes `marketplace` used to vanish and the
 * tool ran without it (a default market, or none). Claude now gets the wrong name, the name it most likely meant, and
 * every name the tool takes. Only Claude's own arguments are checked (the door, and each step of a change plan): the
 * requests Nexus builds itself (an undo's inverse) and stored approvals are parsed as before.
 */
import { PLAN_TOOL, type AgentTool } from './tool-types.js'

/** The top-level argument names a tool takes; null when its input is not a plain object (nothing to check against). */
export function argumentNames(tool: Pick<AgentTool, 'input'>): string[] | null {
  const def = (tool.input as { _zod?: { def?: { type?: string; shape?: Record<string, unknown>; catchall?: unknown } } } | undefined)?._zod?.def
  if (!def || def.type !== 'object' || def.catchall || !def.shape) return null
  return Object.keys(def.shape)
}

const plain = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '')

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0]
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const above = row[j]
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1))
      diagonal = above
    }
  }
  return row[b.length]
}

/** The name a wrong one most likely meant: the same letters, one inside the other, or a small typo. */
function meant(wrong: string, names: string[]): string | null {
  const w = plain(wrong)
  if (!w) return null
  const exact = names.find((name) => plain(name) === w)
  if (exact) return exact
  const inside = names.filter((name) => { const n = plain(name); return Math.min(n.length, w.length) >= 4 && (n.includes(w) || w.includes(n)) })
  if (inside.length === 1) return inside[0]
  const near = names.map((name) => ({ name, d: distance(plain(name), w) })).filter((x) => x.d <= 2).sort((x, y) => x.d - y.d)
  return near.length && (near.length === 1 || near[0].d < near[1].d) ? near[0].name : null
}

/** Why these arguments do not fit the tool (each unknown name, with the one it likely meant), or null. */
export function unknownArgumentsProblem(tool: Pick<AgentTool, 'name' | 'input'>, args: Record<string, unknown>): string | null {
  const names = argumentNames(tool)
  if (!names) return null
  const unknown = Object.keys(args ?? {}).filter((key) => !names.includes(key))
  if (!unknown.length) return null
  const each = unknown.map((key) => { const hint = meant(key, names); return hint ? `${key} (did you mean ${hint}?)` : key })
  return `${tool.name} does not take ${unknown.length === 1 ? 'the argument' : 'the arguments'} ${each.join(', ')}. `
    + `It takes: ${names.length ? names.join(', ') : 'no arguments'}.`
}

/**
 * The refusal for Claude's arguments to `tool`, or null: its own names, and for a change plan each step's names
 * against its step tool. An unknown step tool is left to the gate, which names it.
 */
export function argumentsRefusal(
  tool: Pick<AgentTool, 'name' | 'input' | 'readOnly'>,
  args: Record<string, unknown>,
  toolNamed: (name: string) => Pick<AgentTool, 'name' | 'input'> | undefined,
): string | null {
  const nothing = tool.readOnly ? 'Nothing was read.' : 'Nothing was queued.'
  const own = unknownArgumentsProblem(tool, args)
  if (own) return `${own} ${nothing}`
  if (tool.name !== PLAN_TOOL || !Array.isArray(args.steps)) return null
  const problems: string[] = []
  ;(args.steps as unknown[]).forEach((step, index) => {
    const s = (step ?? {}) as { tool?: unknown; args?: unknown }
    const stepTool = typeof s.tool === 'string' ? toolNamed(s.tool) : undefined
    if (!stepTool || !s.args || typeof s.args !== 'object' || Array.isArray(s.args)) return
    const problem = unknownArgumentsProblem(stepTool, s.args as Record<string, unknown>)
    if (problem) problems.push(`step ${index + 1}: ${problem}`)
  })
  if (!problems.length) return null
  return `${problems.slice(0, 5).join(' ')}${problems.length > 5 ? ` And ${problems.length - 5} more steps.` : ''} ${nothing}`
}
