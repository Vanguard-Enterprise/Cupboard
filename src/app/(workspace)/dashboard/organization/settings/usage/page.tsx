import { OrganizationUsage } from "@/components/organization-usage";

export const metadata = { title: "Billing & usage | Cupboard" };

export default function OrganizationUsagePage() {
  return (
    <div className="mx-auto w-full max-w-[848px] px-4 py-6 md:px-6 md:py-8">
      <div className="mb-10 space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          Billing &amp; usage
        </h1>
        <p className="text-sm text-muted-foreground">
          Review resource usage, activity, and billing details.
        </p>
      </div>
      <OrganizationUsage />
    </div>
  );
}
