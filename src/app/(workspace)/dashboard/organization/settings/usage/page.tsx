import { OrganizationUsage } from "@/components/organization-usage";

export const metadata = { title: "Organization usage | Cupboard" };

export default function OrganizationUsagePage() {
  return (
    <div className="mx-auto w-[calc(100%-2rem)] max-w-[1200px] py-6 md:w-[calc(100%-4rem)] md:py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Usage</h1>
      </div>
      <OrganizationUsage />
    </div>
  );
}
