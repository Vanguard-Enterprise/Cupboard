// Machine authentication stays separate from browser session forwarding.
export async function proxyNode(request: Request, path: string) {
  const headers = { "Cache-Control": "no-store" };
  if (!["enroll", "heartbeat"].includes(path))
    return Response.json({ error: "Not found." }, { status: 404, headers });
  const authorization = request.headers.get("authorization") ?? "";
  if (!/^Bearer [0-9a-fA-F]{64}$/.test(authorization))
    return Response.json(
      { error: "Machine credential is required." },
      { status: 401, headers },
    );
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > 8192) {
        await reader.cancel();
        return Response.json(
          { error: "Request is too large." },
          { status: 413, headers },
        );
      }
      chunks.push(chunk.value);
    }
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    const base = process.env.CUPBOARD_API_URL ?? "http://127.0.0.1:8080";
    const upstream = await fetch(
      `${base.replace(/\/$/, "")}/node-api/${path}`,
      {
        method: "POST",
        headers: { authorization, "Content-Type": "application/json" },
        body,
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(15000),
      },
    );
    if (upstream.status >= 500) throw new Error("Unavailable");
    const result: unknown = await upstream.json();
    return Response.json(result, { status: upstream.status, headers });
  } catch {
    return Response.json(
      { error: "Cupboard is unavailable. Try again shortly." },
      { status: 503, headers },
    );
  }
}
