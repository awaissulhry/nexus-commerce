export interface RecordListField {
    key: string;
    label: string;
    kind: 'text' | 'number' | 'boolean' | 'select';
    required?: boolean;
    options?: Array<{
        value: string;
        label: string;
    }>;
    min?: number;
    max?: number;
}
export interface RecordListInputProps {
    label: string;
    fields: RecordListField[];
    value: Array<Record<string, unknown>>;
    onChange: (value: Array<Record<string, unknown>>) => void;
    disabled?: boolean;
    maxItems?: number;
}
/** Repeated typed records preserve field pairing and unrecognized saved properties. */
export declare function RecordListInput({ label, fields, value, onChange, disabled, maxItems }: RecordListInputProps): import("react/jsx-runtime").JSX.Element;
