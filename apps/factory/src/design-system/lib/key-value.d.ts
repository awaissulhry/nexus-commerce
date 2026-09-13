/**
 * KeyValue root props (CX.2) — the one decision the `<dl>` makes, kept out of the .tsx so it is
 * testable in apps/web's node-only vitest.
 */
export type KeyValueColumns = 1 | 2 | 3;
export interface KeyValueRootProps {
    className: string;
    'data-columns': KeyValueColumns;
}
export declare function keyValueRootProps(opts: {
    columns?: KeyValueColumns;
    dense?: boolean;
    className?: string;
}): KeyValueRootProps;
/** A hint renders for any value React would print — `null`, `undefined` and `false` are "no hint". */
export declare function hasHint(hint: unknown): boolean;
