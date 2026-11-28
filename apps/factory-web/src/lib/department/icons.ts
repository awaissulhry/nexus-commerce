import { CircleDot, Cylinder, Layers, Package, PenTool, Puzzle, Ruler, Scissors, Shirt, ShieldCheck, type LucideIcon } from 'lucide-react'

/**
 * owb-b4 w4.2 — a department's icon id (lucide kebab name, fixed by the seed: owb-b1 a.6) → its lucide icon. A fixed map, so the bundle
 * holds these nine and not every lucide icon. An id the map does not know (a department made later with another icon) draws a plain
 * dot, never a crash: S4 adds an id here when its route builder offers one.
 */
export const DEPARTMENT_ICONS: Readonly<Record<string, LucideIcon>> = Object.freeze({
  ruler: Ruler,
  scissors: Scissors,
  layers: Layers,
  shirt: Shirt,
  'shield-check': ShieldCheck,
  package: Package,
  'pen-tool': PenTool,
  cylinder: Cylinder,
  puzzle: Puzzle,
  // owb-pd6 (S4 settle 7): a department made in the route builder's Manage gets this icon from the server.
  'circle-dot': CircleDot,
})

/** The icon of an id, or null (the part draws a plain dot). */
export const departmentIconOf = (id: string | null | undefined): LucideIcon | null => (id && Object.hasOwn(DEPARTMENT_ICONS, id) ? DEPARTMENT_ICONS[id]! : null)
