import { presenceLine, type Presence } from '../grid/renderers/presence';
export type PresenceMarkProps = {
    via?: string | null;
    axis?: 'intent' | 'fact' | 'both';
    compact?: boolean;
} & ({
    presence: Presence;
    line?: ReturnType<typeof presenceLine>;
    now?: never;
} | {
    line: ReturnType<typeof presenceLine>;
    now: number;
    presence?: never;
});
/** Intent and observation remain separate. A canonical aggregate line needs no invented member. */
export declare function PresenceMark(props: PresenceMarkProps): import("react/jsx-runtime").JSX.Element;
