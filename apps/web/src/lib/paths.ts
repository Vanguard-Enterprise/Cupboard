const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

/** Prefix destinations used outside Next's Link component (redirect/window.location). */
export function appPath(path: string): string {
  if (!path.startsWith("/")) throw new Error("appPath requires an absolute path");
  return `${BASE_PATH}${path}`;
}
