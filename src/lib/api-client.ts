export async function apiRequest<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/app-api/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers:
      body === undefined
        ? undefined
        : { "Content-Type": "application/json", "X-Cupboard-Request": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const result = await response.json().catch(() => {
    throw new Error(
      "Cupboard returned an unexpected response. Try again shortly.",
    );
  });
  if (!response.ok)
    throw new Error(
      typeof result?.error === "string"
        ? result.error
        : "The request could not be completed.",
    );
  return result as T;
}
export type Identity = {
  user: { id: string; name: string; email: string };
  organization: { id: string; name: string } | null;
  organizations: { id: string; name: string }[];
  membershipId: string | null;
  permissions: string[];
};

// Account and organization transitions discard the previous session's client router cache.
export function navigateAfterAuth(path: string) {
  window.location.assign(new URL(path, window.location.origin).href);
}
