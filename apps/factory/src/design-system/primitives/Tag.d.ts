import type { ReactNode } from 'react';
import type { Tone } from './tone';
/**
 * Tag — the neutral / semantic metadata chip the console was missing.
 * Pill encodes entity *status* (Active/Paused/Archived/Error); Badge encodes the
 * ad *program* (SP/SD/SB/Auto/Manual). Tag is for everything else you label inline:
 * marketplace, entity type, a rule trigger, a proposed-action sentiment, a filter chip.
 * Requires `styles/primitives.css`.
 */
/** @deprecated use 'success' */
export type LegacyTagTone = 'positive';
export type TagTone = Tone | LegacyTagTone;
export interface TagProps {
    tone?: TagTone;
    className?: string;
    children: ReactNode;
}
export declare function Tag({ tone, className, children }: TagProps): import("react/jsx-runtime").JSX.Element;
