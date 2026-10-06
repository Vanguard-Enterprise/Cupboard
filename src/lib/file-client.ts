export async function fileRequest<T>(
  path: string,
  organization: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`/app-api/${path}`, {
    method: body === undefined ? "GET" : "POST",
    cache: "no-store",
    headers: {
      "X-Cupboard-Organization": organization,
      ...(body === undefined
        ? {}
        : { "Content-Type": "application/json", "X-Cupboard-Request": "1" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.error || "The file request failed. Try again.");
  return result;
}
