/** Legacy listing records are not channel observations. Presence has its own vocabulary. */
import { type ReadinessTone } from './readiness';
export interface ListingStatusMeta {
    label: string;
    tone: ReadinessTone;
    hint: string;
}
export declare const LISTING_STATUSES: string[];
export declare function listingStatusMeta(raw: string | null | undefined): ListingStatusMeta;
