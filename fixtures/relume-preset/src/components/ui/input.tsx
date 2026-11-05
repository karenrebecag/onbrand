"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

function Input({
  className,
  type,
  icon,
  iconPosition = "left",
  prefix,
  prefixPosition = "left",
  variant = "primary",
  ...props
}: React.ComponentProps<"input"> & {
  icon?: React.ReactNode;
  iconPosition?: "left" | "right";
  prefix?: string;
  prefixPosition?: "left" | "right";
  variant?: "primary" | "secondary";
}) {
  return (
    <div className="relative flex w-full items-center">
      {icon && iconPosition === "left" && <div className="absolute left-3">{icon}</div>}
      {prefix && prefixPosition === "left" && (
        <div className="min-h-11 shrink-0 border-y border-l border-scheme-border px-3 py-2">
          {prefix}
        </div>
      )}
      <input
        type={type}
        data-slot="input"
        className={cn(
          "flex size-full rounded-form align-middle transition-all duration-200 file:border-0 file:bg-transparent file:text-sm file:font-medium focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
          "border border-scheme-border",
          variant === "secondary" && "border-white placeholder:text-white/60",
          "min-h-11 px-3 py-2",
          icon && (iconPosition === "left" ? "pr-3 pl-11" : "pr-11 pl-3"),
          prefix && "grow-1",
          className,
        )}
        {...props}
      />
      {icon && iconPosition === "right" && <div className="absolute right-3">{icon}</div>}
      {prefix && prefixPosition === "right" && (
        <div className="min-h-11 shrink-0 border-y border-r border-scheme-border px-3 py-2">
          {prefix}
        </div>
      )}
    </div>
  );
}

export { Input };
