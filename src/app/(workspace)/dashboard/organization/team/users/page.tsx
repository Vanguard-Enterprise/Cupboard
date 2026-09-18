import { OrganizationUsers } from "@/components/organization-users";

export const metadata = { title: "Users | Cupboard" };

export default function OrganizationUsersPage() {
  return (
    <div className="mx-auto w-[calc(100%-2rem)] max-w-[1240px] py-5 md:w-[calc(100%-4rem)] md:py-6">
      <OrganizationUsers />
    </div>
  );
}
