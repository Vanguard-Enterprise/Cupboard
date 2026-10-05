// Rust always uses the canonical name. The web boundary isolates browser cookies
// for development worktrees sharing a host, since cookies are not scoped by port.
export const backendSessionCookieName = "cupboard_session";
export function browserSessionCookieName() {
  return process.env.CUPBOARD_SESSION_COOKIE_NAME ?? backendSessionCookieName;
}
export function browserSetCookie(cookie: string) {
  const prefix = `${backendSessionCookieName}=`;
  return cookie.startsWith(prefix)
    ? `${browserSessionCookieName()}=${cookie.slice(prefix.length)}`
    : null;
}
