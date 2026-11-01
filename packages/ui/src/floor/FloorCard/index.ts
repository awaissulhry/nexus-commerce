/**
 * FloorCard (B-W2b-28) — an entry point of its own, NOT re-exported by the floor barrel (`floor/`): no Commerce page and
 * no existing floor screen carries it until it imports this folder (`@/design-system/floor/FloorCard` in the web,
 * `@nexus/ui/floor/FloorCard/index` by package path). Its stylesheet comes with the component.
 */
export { FloorCard, type FloorCardProps } from './FloorCard'
export { FLOOR_CARD_LABELS, type FloorCardLabels } from './FloorCardLabels'
export { FLOOR_CARD_MAX_FACTS, floorCardFacts, floorFlagIcon, type FloorCardFact, type FloorCardFlag } from './floorCardModel'
