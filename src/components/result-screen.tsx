"use client";

import { AlertTriangle, CheckCircle2, Loader2, XCircle } from "lucide-react";

/** Outcome panel used inside the deposit / withdraw / send dialogs. */
export function ResultScreen({
  kind,
  title,
  children,
  actions,
}: {
  kind: "success" | "error" | "attention" | "pending";
  title: React.ReactNode;
  children?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  const Icon = kind === "success" ? CheckCircle2 : kind === "error" ? XCircle : kind === "attention" ? AlertTriangle : Loader2;
  const color = kind === "success" ? "text-emerald-600" : kind === "error" ? "text-red-600" : kind === "attention" ? "text-amber-600" : "text-blue-600";
  return (
    <div className="space-y-4 text-center">
      <Icon className={`mx-auto h-10 w-10 ${color} ${kind === "pending" ? "animate-spin" : ""}`} />
      <div className="text-lg font-medium">{title}</div>
      {children && <div className="text-sm text-muted-foreground">{children}</div>}
      {actions && <div className="flex justify-center gap-2 pt-1">{actions}</div>}
    </div>
  );
}
