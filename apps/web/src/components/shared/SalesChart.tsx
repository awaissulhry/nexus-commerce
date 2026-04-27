"use client";

import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

export interface SalesDataPoint {
  date: string;
  revenue: number;
  orders: number;
  units: number;
}

interface SalesChartProps {
  data: SalesDataPoint[];
  metric?: "revenue" | "orders" | "units";
  title?: string;
}

const METRIC_CONFIG = {
  revenue: {
    key: "revenue" as const,
    label: "Revenue",
    color: "#3b82f6",
    format: (v: number) =>
      new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 0,
      }).format(v),
  },
  orders: {
    key: "orders" as const,
    label: "Orders",
    color: "#10b981",
    format: (v: number) => v.toLocaleString(),
  },
  units: {
    key: "units" as const,
    label: "Units Sold",
    color: "#8b5cf6",
    format: (v: number) => v.toLocaleString(),
  },
};

export default function SalesChart({
  data,
  metric = "revenue",
  title,
}: SalesChartProps) {
  const config = METRIC_CONFIG[metric];

  return (
    <div className="bg-white rounded-lg shadow border border-gray-200 p-6">
      {title && (
        <h3 className="text-sm font-semibold text-gray-900 mb-4">{title}</h3>
      )}
      <div className="h-[300px]">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart
            data={data}
            margin={{ top: 5, right: 20, left: 10, bottom: 5 }}
          >
            <defs>
              <linearGradient id={`gradient-${metric}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={config.color} stopOpacity={0.15} />
                <stop offset="95%" stopColor={config.color} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 12, fill: "#6b7280" }}
              tickLine={false}
              axisLine={{ stroke: "#e5e7eb" }}
            />
            <YAxis
              tick={{ fontSize: 12, fill: "#6b7280" }}
              tickLine={false}
              axisLine={false}
              tickFormatter={config.format}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: "#fff",
                border: "1px solid #e5e7eb",
                borderRadius: "8px",
                fontSize: "13px",
              }}
              formatter={(value) => [config.format(Number(value)), config.label]}
              labelStyle={{ fontWeight: 600, color: "#111827" }}
            />
            <Area
              type="monotone"
              dataKey={config.key}
              stroke={config.color}
              strokeWidth={2}
              fill={`url(#gradient-${metric})`}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
