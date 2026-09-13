import type { ReactNode } from 'react';
export interface EmptyStateProps {
    icon?: ReactNode;
    title: ReactNode;
    description?: ReactNode;
    /** optional CTA (e.g. a Button) */
    action?: ReactNode;
    className?: string;
}
/** No-data state — centred icon + title + description + optional CTA. */
export declare function EmptyState({ icon, title, description, action, className }: EmptyStateProps): import("react/jsx-runtime").JSX.Element;
