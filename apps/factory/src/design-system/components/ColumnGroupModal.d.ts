export interface ColumnGroupProps {
    id: string;
    label: string;
    color: string;
    columns: string[];
    visible: boolean;
}
export interface ColumnGroupModalProps {
    open: boolean;
    onClose: () => void;
    groups: ColumnGroupProps[];
    onGroupsChange: (groups: ColumnGroupProps[]) => void;
}
export type { ColumnGroupProps as ColumnGroup };
export declare function ColumnGroupModal({ open, onClose, groups, onGroupsChange }: ColumnGroupModalProps): import("react/jsx-runtime").JSX.Element;
