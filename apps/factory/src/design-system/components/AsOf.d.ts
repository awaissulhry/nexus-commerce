export interface AsOfProps {
    at: string | null;
    /** Omit when the caller has no provenance axis; explicit null means the source is unknown. */
    via?: string | null;
    kind?: 'check' | 'event';
    /** Pass the read's clock for a stable server/client render. No freshness timeout is invented. */
    now?: number;
}
/** An absent observation is not a measured empty value. */
export declare function AsOf({ at, via, kind, now }: AsOfProps): import("react/jsx-runtime").JSX.Element;
