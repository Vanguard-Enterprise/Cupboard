import { AcceptForm } from "./accept-form";

export default async function AcceptInvitePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-6">
      <h1 className="text-2xl font-semibold">Accept your invitation</h1>
      {token ? (
        <AcceptForm token={token} />
      ) : (
        <p className="text-sm text-red-400">
          This invite link is missing its token. Ask whoever invited you to resend it.
        </p>
      )}
    </main>
  );
}
