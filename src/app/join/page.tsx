"use client";
import { useSyncExternalStore, useState } from "react";
import { navigateAfterAuth, apiRequest } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
function subscribeHash(callback: () => void) {
  window.addEventListener("hashchange", callback);
  return () => window.removeEventListener("hashchange", callback);
}
export default function JoinPage() {
  const token = useSyncExternalStore(
    subscribeHash,
    () => window.location.hash.slice(1),
    () => "",
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function accept() {
    setBusy(true);
    setError("");
    try {
      await apiRequest("invitations/accept", { token });
      navigateAfterAuth("/dashboard");
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Could not accept invitation.",
      );
    } finally {
      setBusy(false);
    }
  }
  const valid = /^[a-f0-9]{64}$/.test(token);
  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center gap-6 p-6">
      <h1 className="text-2xl font-semibold">Join an organization</h1>
      <p className="text-sm text-muted-foreground">
        Sign in with the invited email address, then accept this invitation. The
        link expires after seven days and works once.
      </p>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {!valid && (
        <p role="status">Open the complete invitation link to continue.</p>
      )}
      <Button disabled={!valid || busy} onClick={accept}>
        {busy ? "Joining..." : "Accept invitation"}
      </Button>
      {valid && (
        <div className="flex gap-4 text-sm">
          <a className="underline" href={`/login#invite=${token}`}>
            Sign in
          </a>
          <a className="underline" href={`/signup#invite=${token}`}>
            Create an account
          </a>
        </div>
      )}
    </main>
  );
}
