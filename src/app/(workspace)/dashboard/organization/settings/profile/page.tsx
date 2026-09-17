import { implementedPages } from "@/lib/implemented-pages";
import { OrganizationProfileForm } from "@/components/organization-profile-form";

export const metadata = {
  title: implementedPages["organization"].metadataTitle,
};

export default function OrganizationProfilePage() {
  return (
    <div className="mx-auto w-full max-w-[848px] px-4 py-6 md:px-6 md:py-8">
      <div className="mb-10">
        <h1 className="text-2xl font-semibold tracking-tight">
          Organization profile
        </h1>
      </div>
      <OrganizationProfileForm />
    </div>
  );
}
