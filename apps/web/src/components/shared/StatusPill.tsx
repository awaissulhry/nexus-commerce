"use client";

import {
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
  Clock,
  Zap,
  XCircle,
} from "lucide-react";

type StatusType =
  | "success"
  | "warning"
  | "error"
  | "info"
  | "pending"
  | "processing";

interface StatusPillProps {
  status: StatusType;
  label: string;
  size?: "sm" | "md" | "lg";
  showIcon?: boolean;
  className?: string;
}

const STATUS_CONFIG: Record<
  StatusType,
  {
    bg: string;
    text: string;
    border: string;
    icon: React.ReactNode;
  }
> = {
  success: {
    bg: "bg-green-100",
    text: "text-green-700",
    border: "border-green-300",
    icon: <CheckCircle2 className="w-4 h-4" />,
  },
  warning: {
    bg: "bg-yellow-100",
    text: "text-yellow-700",
    border: "border-yellow-300",
    icon: <AlertTriangle className="w-4 h-4" />,
  },
  error: {
    bg: "bg-red-100",
    text: "text-red-700",
    border: "border-red-300",
    icon: <XCircle className="w-4 h-4" />,
  },
  info: {
    bg: "bg-blue-100",
    text: "text-blue-700",
    border: "border-blue-300",
    icon: <AlertCircle className="w-4 h-4" />,
  },
  pending: {
    bg: "bg-slate-100",
    text: "text-slate-700",
    border: "border-slate-300",
    icon: <Clock className="w-4 h-4" />,
  },
  processing: {
    bg: "bg-purple-100",
    text: "text-purple-700",
    border: "border-purple-300",
    icon: <Zap className="w-4 h-4 animate-spin" />,
  },
};

const SIZE_CONFIG: Record<
  "sm" | "md" | "lg",
  {
    px: string;
    py: string;
    text: string;
  }
> = {
  sm: {
    px: "px-2",
    py: "py-0.5",
    text: "text-xs",
  },
  md: {
    px: "px-3",
    py: "py-1",
    text: "text-sm",
  },
  lg: {
    px: "px-4",
    py: "py-1.5",
    text: "text-base",
  },
};

export default function StatusPill({
  status,
  label,
  size = "md",
  showIcon = true,
  className = "",
}: StatusPillProps) {
  const config = STATUS_CONFIG[status];
  const sizeConfig = SIZE_CONFIG[size];

  return (
    <span
      className={`
        inline-flex items-center gap-1.5 rounded-full border font-medium
        ${sizeConfig.px} ${sizeConfig.py} ${sizeConfig.text}
        ${config.bg} ${config.text} ${config.border}
        ${className}
      `}
    >
      {showIcon && config.icon}
      {label}
    </span>
  );
}
