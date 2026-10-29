"use client";

import { useState, type RefObject } from "react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown } from "lucide-react";
import styles from "@/components/ui/dropdown-menu.module.css";

/** Native modal dialogs make body-level portals inert. Keep these menus in the dialog's top layer. */
export function SourceDialogMenu({ dialog, label, value, options, onValueChange, disabled = false }: {
  dialog: RefObject<HTMLDialogElement | null>; label: string; value: string;
  options: readonly { value: string; label: string }[]; onValueChange: (value: string) => void; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.value === value)?.label ?? value;
  return <Menu.Root modal={false} open={open} onOpenChange={setOpen}><Menu.Trigger asChild><button type="button" className={styles.trigger} aria-label={`${label}: ${selected}`} disabled={disabled}>{selected}<ChevronDown size={12} aria-hidden="true" /></button></Menu.Trigger><Menu.Portal container={dialog.current ?? undefined}><div role="region" aria-label={`${label} menu`}><Menu.Content className={styles.content} sideOffset={6} collisionPadding={8} align="start" aria-label={label}><Menu.RadioGroup value={value} onValueChange={onValueChange}>{options.map((option) => <Menu.RadioItem className={styles.item} value={option.value} key={option.value}>{option.label}<span className={styles.indicator}><Menu.ItemIndicator><Check size={13} aria-hidden="true" /></Menu.ItemIndicator></span></Menu.RadioItem>)}</Menu.RadioGroup></Menu.Content></div></Menu.Portal></Menu.Root>;
}
