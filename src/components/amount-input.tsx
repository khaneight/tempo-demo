"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function AmountInput({
  value,
  onChange,
  label = "Amount",
  hint,
  max,
  onMax,
}: {
  value: string;
  onChange: (v: string) => void;
  label?: string;
  hint?: string;
  max?: string;
  onMax?: () => void;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label htmlFor="amount">{label}</Label>
        {max !== undefined && (
          <button type="button" onClick={onMax} className="text-xs text-muted-foreground underline decoration-dotted">
            Max {max}
          </button>
        )}
      </div>
      <div className="relative">
        <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-muted-foreground">$</span>
        <Input
          id="amount"
          inputMode="decimal"
          placeholder="0.00"
          className="pl-7 text-lg tabular-nums"
          value={value}
          onChange={(e) => onChange(e.target.value.replace(/[^\d.]/g, ""))}
          autoComplete="off"
        />
      </div>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
