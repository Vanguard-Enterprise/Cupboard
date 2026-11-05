import { notFound } from "next/navigation";
import { backendUrl } from "@/lib/api-proxy";
import { validSlug, type PublicStatus } from "@/lib/status-page";
import { PublicStatusPage } from "@/components/public-status-page";

type Params = { params: Promise<{ slug: string }> };

async function loadStatus(
  slug: string,
): Promise<PublicStatus | null | "error"> {
  if (!validSlug(slug)) return null;
  try {
    const response = await fetch(backendUrl(`public/status/${slug}`), {
      cache: "no-store",
    });
    if (response.status === 404) return null;
    if (!response.ok) return "error";
    return (await response.json()) as PublicStatus;
  } catch {
    return "error";
  }
}

export async function generateMetadata({ params }: Params) {
  const { slug } = await params;
  const status = await loadStatus(slug);
  return {
    title:
      status && status !== "error" ? `${status.name} | Status` : "Status page",
  };
}

export default async function StatusPage({ params }: Params) {
  const { slug } = await params;
  const status = await loadStatus(slug);
  if (status === null) notFound();
  if (status === "error")
    return (
      <main className="flex min-h-screen items-center justify-center bg-background px-4 text-foreground">
        <div className="max-w-md rounded-xl border border-border bg-card p-6 text-center">
          <h1 className="text-lg font-semibold">Status page unavailable</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Cupboard could not load this status page. Try again in a moment.
          </p>
        </div>
      </main>
    );
  return (
    <main>
      <PublicStatusPage slug={slug} initial={status} />
    </main>
  );
}
