const paths = new Set([
  "auth/signup",
  "auth/login",
  "auth/logout",
  "auth/me",
  "auth/organization",
  "team",
  "servers",
  "organizations",
  "invitations/accept",
]);
export function backendUrl(path: string) {
  const base = process.env.CUPBOARD_API_URL ?? "http://127.0.0.1:8080";
  return `${base.replace(/\/$/, "")}/app-api/${path}`;
}
export async function proxyApi(
  request: Request,
  path: string,
): Promise<Response> {
  if (!paths.has(path))
    return Response.json({ error: "Not found." }, { status: 404 });
  const headers = new Headers();
  const cookie = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("cupboard_session="));
  if (cookie) headers.set("cookie", cookie);
  let body: Uint8Array | undefined;
  if (request.method !== "GET") {
    const origin = request.headers.get("origin");
    const host = request.headers.get("host") ?? new URL(request.url).host;
    let sameHost = false;
    try {
      sameHost = Boolean(origin && new URL(origin).host === host);
    } catch {
      /* Reject malformed origins. */
    }
    if (
      !sameHost ||
      request.headers.get("x-cupboard-request") !== "1" ||
      !request.headers.get("content-type")?.startsWith("application/json")
    ) {
      return Response.json(
        { error: "This request is not allowed." },
        { status: 403 },
      );
    }
    headers.set("origin", origin!);
    headers.set("x-cupboard-request", "1");
    headers.set("content-type", "application/json");
    const reader = request.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > 65536) {
          await reader.cancel();
          return Response.json(
            { error: "Request is too large." },
            { status: 413 },
          );
        }
        chunks.push(chunk.value);
      }
    }
    body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.length;
    }
  }
  try {
    const upstream = await fetch(backendUrl(path), {
      method: request.method,
      headers,
      body: body as BodyInit | undefined,
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
    const resultHeaders = new Headers({
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    for (const cookie of upstream.headers.getSetCookie())
      resultHeaders.append("Set-Cookie", cookie);
    if (upstream.status >= 500)
      return Response.json(
        { error: "Cupboard is unavailable. Try again shortly." },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    let result: unknown;
    try {
      result = await upstream.json();
    } catch {
      return Response.json(
        {
          error:
            upstream.status === 400 || upstream.status === 422
              ? "The request could not be accepted. Refresh the page and try again."
              : "Cupboard returned an unexpected response. Try again shortly.",
        },
        {
          status: upstream.ok ? 502 : upstream.status,
          headers: { "Cache-Control": "no-store" },
        },
      );
    }
    return new Response(JSON.stringify(result), {
      status: upstream.status,
      headers: resultHeaders,
    });
  } catch {
    return Response.json(
      { error: "Cupboard is unavailable. Try again shortly." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
