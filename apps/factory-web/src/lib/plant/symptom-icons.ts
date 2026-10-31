import { Activity, Droplet, Flame, Hand, HelpCircle, Layers, Power, Printer, Scissors, ShieldOff, Spline, Stamp, Volume2, Wind, Wrench, Zap, type LucideIcon } from 'lucide-react'

/**
 * The icons of the plant's machine classes and symptoms (factory-domain plant/starter: design-system icon ids, lower case
 * with hyphens, PLANT_ICON) → the lucide icon drawn. One map for every view that draws a symptom: the Office's Plant pages
 * (Machine requests, Plant settings › Symptoms on the floor, SCR-241) and the Floor's machine problem (SCR-179). In
 * `src/lib` because a view may not import another view's files (`check-view-boundaries`). The settings' icon picker
 * offers exactly these ids, in this order; an id the group stored that is not here draws the wrench, none the question.
 */
export const SYMPTOM_ICONS: Readonly<Record<string, LucideIcon>> = {
  power: Power,
  volume: Volume2,
  droplet: Droplet,
  'shield-off': ShieldOff,
  scissors: Scissors,
  needle: Spline,
  hand: Hand,
  zap: Zap,
  stamp: Stamp,
  flame: Flame,
  layers: Layers,
  wind: Wind,
  printer: Printer,
  activity: Activity,
}

/** The ids the icon picker offers, in order. */
export const SYMPTOM_ICON_IDS: readonly string[] = Object.keys(SYMPTOM_ICONS)

/** The icon of a symptom or class: its own, the question for none (null), the wrench for an id this build does not know. */
export function iconOf(id: string | null | undefined): LucideIcon {
  return (id && SYMPTOM_ICONS[id]) || (id === null ? HelpCircle : Wrench)
}
