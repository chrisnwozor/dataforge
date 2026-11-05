/** Keyboard behavior shared by the real screenshot viewer and its DOM fixture. */
export function wrapScreenshotIndex(index: number, length: number): number {
  if (length < 1) return 0;
  return ((index % length) + length) % length;
}

export function trapDialogFocus(
  event: Pick<KeyboardEvent, "key" | "shiftKey" | "preventDefault">,
  dialog: HTMLDialogElement,
  activeElement: Element | null,
) {
  if (event.key !== "Tab") return;
  const controls = Array.from(
    dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  );
  const first = controls[0];
  const last = controls.at(-1);
  if (!first || !last) {
    event.preventDefault();
    dialog.focus();
    return;
  }
  if (event.shiftKey && (activeElement === first || activeElement === dialog)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
