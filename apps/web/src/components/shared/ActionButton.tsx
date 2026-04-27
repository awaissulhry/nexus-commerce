"use client";

import { ReactNode } from "react";
import { Loader2 } from "lucide-react";

type ButtonVariant = "sync" | "master" | "primary" | "secondary" | "danger";
type ButtonSize = "sm" | "md" | "lg";

interface ActionButtonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
  children: ReactNode;
  loading?: boolean;
  disabled?: boolean;
  onClick?: () => void | Promise<void>;
  className?: string;
  fullWidth?: boolean;
  type?: "button" | "submit" | "reset";
}

const VARIANT_CONFIG: Record<
  ButtonVariant,
  {
    bg: string;
    hover: string;
    text: string;
    border: string;
  }
> = {
  sync: {
    bg: "bg-blue-600",
    hover: "hover:bg-blue-700",
    text: "text-white",
    border: "border-blue-700",
  },
  master: {
    bg: "bg-amber-600",
    hover: "hover:bg-amber-700",
    text: "text-white",
    border: "border-amber-700",
  },
  primary: {
    bg: "bg-indigo-600",
    hover: "hover:bg-indigo-700",
    text: "text-white",
    border: "border-indigo-700",
  },
  secondary: {
    bg: "bg-slate-200",
    hover: "hover:bg-slate-300",
    text: "text-slate-900",
    border: "border-slate-300",
  },
  danger: {
    bg: "bg-red-600",
    hover: "hover:bg-red-700",
    text: "text-white",
    border: "border-red-700",
  },
};

const SIZE_CONFIG: Record<
  ButtonSize,
  {
    px: string;
    py: string;
    text: string;
    gap: string;
  }
> = {
  sm: {
    px: "px-3",
    py: "py-1.5",
    text: "text-sm",
    gap: "gap-1.5",
  },
  md: {
    px: "px-4",
    py: "py-2",
    text: "text-sm",
    gap: "gap-2",
  },
  lg: {
    px: "px-6",
    py: "py-3",
    text: "text-base",
    gap: "gap-2.5",
  },
};

export default function ActionButton({
  variant = "primary",
  size = "md",
  icon,
  children,
  loading = false,
  disabled = false,
  onClick,
  className = "",
  fullWidth = false,
  type = "button",
}: ActionButtonProps) {
  const variantConfig = VARIANT_CONFIG[variant];
  const sizeConfig = SIZE_CONFIG[size];

  const isDisabled = disabled || loading;

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={isDisabled}
      className={`
        inline-flex items-center justify-center rounded-lg font-medium
        transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2
        ${sizeConfig.px} ${sizeConfig.py} ${sizeConfig.text} ${sizeConfig.gap}
        ${variantConfig.bg} ${variantConfig.text}
        ${!isDisabled ? variantConfig.hover : "opacity-60 cursor-not-allowed"}
        ${fullWidth ? "w-full" : ""}
        ${className}
      `}
    >
      {loading ? (
        <Loader2 className="w-4 h-4 animate-spin" />
      ) : (
        icon && <span className="flex-shrink-0">{icon}</span>
      )}
      {children}
    </button>
  );
}
