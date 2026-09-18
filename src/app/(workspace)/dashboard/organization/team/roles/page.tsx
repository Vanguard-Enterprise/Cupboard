import { OrganizationRoles } from "@/components/organization-roles";

export const metadata = { title: "Roles | Cupboard" };

export default function OrganizationRolesPage() {
  return (
    <div className="mx-auto w-[calc(100%-2rem)] max-w-[1240px] py-5 md:w-[calc(100%-4rem)] md:py-6">
      <OrganizationRoles />
    </div>
  );
}
