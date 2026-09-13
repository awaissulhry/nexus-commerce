import { type ReactNode } from 'react';
export interface BuilderSection {
    id: string;
    label: ReactNode;
    title?: ReactNode;
    content: ReactNode;
}
export interface BuilderProps {
    open: boolean;
    onClose: () => void;
    title: ReactNode;
    sections: BuilderSection[];
    primaryLabel?: ReactNode;
    onPrimary?: () => void;
    busy?: boolean;
    className?: string;
}
/**
 * Full-screen builder (H10 RuleBuilder / AiGoalBuilder): top bar (close + title
 * + primary action), a scroll-spy left nav, and a scrolling section body.
 * Portaled to <body>; Esc closes. The spine for the rule/goal/campaign builders.
 */
export declare function Builder({ open, onClose, title, sections, primaryLabel, onPrimary, busy, className }: BuilderProps): import("react").ReactPortal | null;
