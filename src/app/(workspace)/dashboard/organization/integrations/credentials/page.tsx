import { implementedPages } from "@/lib/implemented-pages";
import { OrganizationIntegrations } from "@/components/organization-integrations";

export const metadata = {
  title: implementedPages["credentials"].metadataTitle,
};

export default function CredentialsAndWebhooksPage() {
  return (
    <div className="mx-auto w-full max-w-[900px] px-4 py-6 md:px-6 md:py-8">
      <h1 className="mb-6 text-2xl font-semibold tracking-tight">
        Credentials &amp; webhooks
      </h1>
      <OrganizationIntegrations />
    </div>
  );
}
