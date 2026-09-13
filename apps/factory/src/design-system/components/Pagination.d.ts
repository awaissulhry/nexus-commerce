export interface PaginationProps {
    page: number;
    pageCount: number;
    onPage: (page: number) => void;
    className?: string;
}
/** Pager (H10 `.h10-am-pager` look). Controlled via `page` / `onPage`. */
export declare function Pagination({ page, pageCount, onPage, className }: PaginationProps): import("react/jsx-runtime").JSX.Element;
