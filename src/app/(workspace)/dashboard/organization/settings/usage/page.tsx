import { OrganizationUsage } from "@/components/organization-usage";

export const metadata = { title: "Organization usage | Cupboard" };

export default function OrganizationUsagePage() {
  return (
    <div className="mx-auto w-full max-w-[848px] px-4 py-6 md:px-6 md:py-8">
      <div className="mb-10">
        <h1 className="text-2xl font-semibold tracking-tight">
          Organization usage
        </h1>
      </div>
      <OrganizationUsage />
    </div>
  );
}
