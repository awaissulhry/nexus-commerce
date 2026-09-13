import type { DetailsHTMLAttributes, ReactNode } from 'react';
import type { Tone } from '../primitives/tone';
export interface DisclosureProps extends Omit<DetailsHTMLAttributes<HTMLDetailsElement>, 'children'> {
    /** Visible toggle label. Keep interactive controls in the body, outside the summary. */
    tone?: Tone;
    summary: ReactNode;
    children: ReactNode;
}
/** Collapsible supporting content. Native details supplies keyboard and expanded-state semantics. */
export declare function Disclosure({ summary, children, tone, className, ...rest }: DisclosureProps): import("react/jsx-runtime").JSX.Element;
