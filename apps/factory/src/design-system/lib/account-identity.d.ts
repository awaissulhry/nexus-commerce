/** Channel and account names for all identity surfaces; IDs are routing data only. */
export declare function channelDisplayName(channel: string): string;
export declare function accountDisplayName(a: {
    channel: string;
    label: string;
    labelIsPlaceholder?: boolean;
    labelSource?: string;
    id?: string;
}): string;
