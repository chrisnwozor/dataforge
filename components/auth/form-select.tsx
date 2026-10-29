"use client";
import { useId, useState } from "react";
import { SelectMenu } from "@/components/select-menu";
import styles from "./auth.module.css";
export function FormSelect({
  label,
  name,
  value,
  onValueChange,
  options,
  disabled = false,
  hiddenLabel = false,
}: {
  label: string;
  name?: string;
  value?: string;
  onValueChange?: (value: string) => void;
  options: { value: string; label: string }[];
  disabled?: boolean;
  hiddenLabel?: boolean;
}) {
  const id = useId(),
    [selected, setSelected] = useState(options[0]?.value ?? "");
  const current = value ?? selected;
  return (
    <div className={styles.field}>
      <label className={hiddenLabel ? "sr-only" : undefined} htmlFor={id}>
        {label}
      </label>
      <SelectMenu
        id={id}
        label={label}
        value={current}
        disabled={disabled}
        options={options}
        onValueChange={(next) => {
          setSelected(next);
          onValueChange?.(next);
        }}
      />
      {name && <input type="hidden" name={name} value={current} />}
    </div>
  );
}
