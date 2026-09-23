import { proxyApi } from "@/lib/api-proxy";
export const dynamic = "force-dynamic";
async function handle(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
) {
  return proxyApi(request, (await context.params).path.join("/"));
}
export const GET = handle;
export const POST = handle;
