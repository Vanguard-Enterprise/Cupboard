import { notFound } from "next/navigation";
import { backendUrl } from "@/lib/api-proxy";
import {
  publicMaintenance,
  publicSummary,
  statusTabTitle,
  validSlug,
  type PublicStatus,
} from "@/lib/status-page";
import { PublicStatusPage } from "@/components/public-status-page";
import { StatusUnavailable } from "../status-unavailable";

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

/** The first tab title already carries the state; the page keeps it current. */
function tabTitle(status: PublicStatus) {
  const now = status.updatedAt;
  const maintenance = publicMaintenance(
    status.maintenance,
    status.components.map((c) => c.id),
    now,
  );
  const { tone } = publicSummary(status.components, maintenance, now);
  return statusTabTitle(status.name, tone);
}

export async function generateMetadata({ params }: Params) {
  const { slug } = await params;
  const status = await loadStatus(slug);
  return {
    title:
      status === null
        ? "Status page not found"
        : status === "error"
          ? "Status page"
          : tabTitle(status),
  };
}

export default async function StatusPage({ params }: Params) {
  const { slug } = await params;
  const status = await loadStatus(slug);
  if (status === null) notFound();
  if (status === "error") return <StatusUnavailable />;
  // The page renders its own banner, main, and contentinfo landmarks.
  return <PublicStatusPage slug={slug} initial={status} />;
}
