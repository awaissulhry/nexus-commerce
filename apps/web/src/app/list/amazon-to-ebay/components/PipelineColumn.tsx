'use client';

export interface PipelineItem {
  id: string;
  name: string;
  sku: string;
  price?: number;
  status?: string;
  error?: string;
  progress?: {
    current: number;
    total: number;
  };
}

interface PipelineColumnProps {
  title: string;
  count: number;
  children: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
}

export const PipelineColumn: React.FC<PipelineColumnProps> = ({
  title,
  count,
  children,
  footer,
  className = '',
}) => {
  return (
    <div className={`flex flex-col rounded-lg border bg-white shadow-sm ${className}`}>
      {/* Header */}
      <div className="border-b px-4 py-3">
        <h3 className="font-semibold text-sm uppercase tracking-wide text-gray-900">
          {title} <span className="text-gray-500">({count})</span>
        </h3>
      </div>

      {/* Content - scrollable */}
      <div className="flex-1 overflow-y-auto">
        <div className="divide-y">
          {children}
        </div>
      </div>

      {/* Footer */}
      {footer && (
        <div className="border-t px-4 py-3 bg-gray-50">
          {footer}
        </div>
      )}
    </div>
  );
};
