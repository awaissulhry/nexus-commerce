import { BadgeCheck, Bandage, Cable, CircleDot, Droplet, Eye, Flame, Hand, Layers, ListChecks, Package, Ruler, Scissors, Shield, Spline, Stamp, Tag, ThermometerSun, TriangleAlert, UnfoldVertical, type LucideIcon } from 'lucide-react'
import { INSTRUCTION_ICONS, type InstructionIcon } from '@nexus/factory-domain/production/instructions/rules'

/**
 * The icons of a work instruction's steps (factory-domain production/instructions INSTRUCTION_ICONS: lower case keys) → the
 * lucide icon drawn. One map for every view that draws a step: the Office's Work instructions (SCR-141, its floor preview)
 * and the Floor's Spec & instructions and Steps panel (B-W2b-232). In `src/lib` because a view may not import another
 * view's files (`check-view-boundaries`), as lib/plant/symptom-icons. A step with no icon draws the plain list mark; a key
 * this build does not know draws the same.
 */
export const INSTRUCTION_ICON_MAP: Readonly<Record<InstructionIcon, LucideIcon>> = {
  needle: Spline,
  thread: Cable,
  scissors: Scissors,
  ruler: Ruler,
  check: BadgeCheck,
  eye: Eye,
  hand: Hand,
  shield: Shield,
  alert: TriangleAlert,
  flame: Flame,
  iron: ThermometerSun,
  glue: Droplet,
  zip: UnfoldVertical,
  button: CircleDot,
  label: Tag,
  layers: Layers,
  tape: Bandage,
  stamp: Stamp,
  package: Package,
}

/** The keys a step may name, in the domain's order (the editor's picker offers exactly these). */
export const INSTRUCTION_ICON_KEYS: readonly InstructionIcon[] = INSTRUCTION_ICONS

/** The icon of a step: its own, the plain list mark for none or a key this build does not know. */
export function instructionIcon(key: string | null | undefined): LucideIcon {
  return key && Object.hasOwn(INSTRUCTION_ICON_MAP, key) ? INSTRUCTION_ICON_MAP[key as InstructionIcon] : ListChecks
}
