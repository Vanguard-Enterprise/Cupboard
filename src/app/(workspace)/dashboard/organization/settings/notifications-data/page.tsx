import { OrganizationNotificationsData } from "@/components/organization-notifications-data";

export const metadata = { title: "Notifications and data | Cupboard" };

export default function OrganizationNotificationsDataPage() {
  return (
    <div className="mx-auto w-full max-w-[896px] px-4 py-6 md:px-6 md:py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">
          Notifications &amp; data
        </h1>
      </div>
      <OrganizationNotificationsData />
    </div>
  );
}
