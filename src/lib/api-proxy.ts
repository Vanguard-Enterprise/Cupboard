const paths = new Set([
  "auth/signup",
  "auth/login",
  "auth/logout",
  "auth/me",
  "auth/organization",
  "team",
  "servers",
  "files",
  "servers/health",
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
  const fileUpload = path === "files" && request.method === "POST";
  const fileDownload =
    /^files\/[0-9a-f-]{36}$/.test(path) && request.method === "GET";
  if (
    !paths.has(path) &&
    !/^servers\/[0-9a-f-]{36}\/check$/.test(path) &&
    !/^files\/[0-9a-f-]{36}(?:\/delete)?$/.test(path)
  )
    return Response.json({ error: "Not found." }, { status: 404 });
  const headers = new Headers();
  const cookie = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("cupboard_session="));
  if (cookie) headers.set("cookie", cookie);
  if (path === "files" || path.startsWith("files/")) {
    const organization = request.headers.get("x-cupboard-organization");
    if (organization) headers.set("x-cupboard-organization", organization);
  }
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
      !(fileUpload
        ? request.headers.get("content-type") === "application/octet-stream"
        : request.headers.get("content-type")?.startsWith("application/json"))
    ) {
      return Response.json(
        { error: "This request is not allowed." },
        { status: 403 },
      );
    }
    headers.set("origin", origin!);
    headers.set("x-cupboard-request", "1");
    headers.set(
      "content-type",
      fileUpload ? "application/octet-stream" : "application/json",
    );
    if (fileUpload) {
      const name = request.headers.get("x-cupboard-filename");
      if (name) headers.set("x-cupboard-filename", name);
    }
    const reader = request.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > (fileUpload ? 10 * 1024 * 1024 : 65536)) {
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
      signal: AbortSignal.timeout(
        fileUpload || fileDownload || path.startsWith("files/") ? 60000 : 15000,
      ),
    });
    const resultHeaders = new Headers({
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    for (const cookie of upstream.headers.getSetCookie())
      resultHeaders.append("Set-Cookie", cookie);
    if (upstream.status >= 500)
      return Response.json(
        {
          error:
            path.startsWith("files/") && path.endsWith("/delete")
              ? "File deletion could not be confirmed. Refresh the list; cleanup will retry if deletion was queued."
              : path === "files" || fileDownload
                ? "File storage is unavailable. Try again shortly."
                : "Cupboard is unavailable. Try again shortly.",
        },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    if (fileDownload && upstream.ok) {
      resultHeaders.set("Content-Type", "application/octet-stream");
      resultHeaders.set("X-Content-Type-Options", "nosniff");
      resultHeaders.set(
        "Content-Disposition",
        upstream.headers.get("content-disposition") ??
          'attachment; filename="download"',
      );
      const length = upstream.headers.get("content-length");
      if (length) resultHeaders.set("Content-Length", length);
      return new Response(upstream.body, {
        status: upstream.status,
        headers: resultHeaders,
      });
    }
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
