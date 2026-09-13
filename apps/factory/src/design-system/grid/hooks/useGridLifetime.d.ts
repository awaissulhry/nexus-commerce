/** A grid can be replaced while its React host (and pending saves) stays mounted. */
export declare function useGridLifetime<T extends {
    isDestroyed(): boolean;
}>(): {
    apiRef: import("react").MutableRefObject<T | null>;
    gridApi: T | null;
    getApi: () => T | null;
    bind: (api: T) => void;
    onGridPreDestroyed: ({ api }: {
        api: T;
    }) => void;
};
