import { proxyNode } from "@/lib/node-proxy";
export const dynamic = "force-dynamic";
export async function POST(
  request: Request,
  context: { params: Promise<{ path: string }> },
) {
  return proxyNode(request, (await context.params).path);
}
