import { implementedPages } from "@/lib/implemented-pages";
import { OrganizationConnections } from "@/components/organization-connections";

export const metadata = {
  title: implementedPages["connections"].metadataTitle,
};

export default function OrganizationConnectionsPage() {
  return (
    <div className="mx-auto w-full max-w-[1100px] px-4 py-6 md:px-6 md:py-8">
      <OrganizationConnections />
    </div>
  );
}
