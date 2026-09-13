/**
 * Banner — an inline, page-level status message (info / warning / danger / success).
 * A soft tinted surface with a strong left accent and a tone-tinted icon, plus an
 * optional title, description, trailing action slot, and dismiss control. The console
 * was hand-rolling these ad-hoc; this is the one tokenized callout. Distinct from Toast
 * (transient, floating) — Banner is persistent and lives in the layout flow.
 * Requires `styles/components.css`.
 */
import type { ReactNode } from 'react';
import type { Tone } from '../primitives/tone';
export interface BannerProps {
    tone?: Tone;
    /** @deprecated use `tone`. Retained for the untouchable flat-file consumer. */
    variant?: Tone | 'error';
    /** Bold lead line. */
    title?: ReactNode;
    /** Description body — the explanatory copy under the title. */
    children?: ReactNode;
    /** Override the default per-tone lucide icon. */
    icon?: ReactNode;
    /** Trailing action slot (e.g. a Button or link). */
    action?: ReactNode;
    /** Show a dismiss (×) control and call this when clicked. */
    onDismiss?: () => void;
    className?: string;
}
export declare function Banner({ tone, variant, title, children, icon, action, onDismiss, className }: BannerProps): import("react/jsx-runtime").JSX.Element;
