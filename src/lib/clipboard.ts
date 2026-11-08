/**
 * Copies text in any context. `navigator.clipboard` only exists on HTTPS and
 * localhost, so plain-HTTP deployments (such as a private network address)
 * fall back to selecting a hidden field and running the copy command.
 */
export async function copyText(text: string) {
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // Fall through: the browser refused the async clipboard.
  }
  const active =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  // Stay inside an open dialog so its focus trap does not block selection.
  const host = active?.closest('[role="dialog"]') ?? document.body;
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.setAttribute("aria-hidden", "true");
  field.style.position = "fixed";
  field.style.top = "0";
  field.style.left = "0";
  field.style.opacity = "0";
  field.style.pointerEvents = "none";
  host.append(field);
  field.focus({ preventScroll: true });
  field.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  } finally {
    field.remove();
    active?.focus({ preventScroll: true });
  }
  if (!copied) throw new Error("Copy failed.");
}
