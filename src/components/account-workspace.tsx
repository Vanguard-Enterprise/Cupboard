"use client";
import { useRef, useState, type FormEvent } from "react";
import { apiRequest, navigateAfterAuth, type Identity } from "@/lib/api-client";
import { CreateOrganizationDialog } from "@/components/create-organization-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function AccountWorkspace({ identity }: { identity: Identity }) {
  const [creating, setCreating] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  async function join(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    // Accept either the code itself or the invitation link already shared by owners.
    const token = code.trim().split("#").at(-1) ?? "";
    if (!/^[a-f0-9]{64}$/.test(token)) {
      setError("Enter a complete join code or invitation link.");
      input.current?.focus();
      return;
    }
    setBusy(true);
    setError("");
    try {
      await apiRequest("invitations/accept", { token });
      navigateAfterAuth("/dashboard");
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Could not join the organization.",
      );
      input.current?.focus();
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="mx-auto w-full max-w-[896px] space-y-8 p-4 md:p-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          Join or create an organization
        </h1>
        <p className="text-sm text-muted-foreground">
          Enter your join code to join a team, or create an organization of your
          own.
        </p>
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <section
          aria-labelledby="join-organization-title"
          className="space-y-6 rounded-xl border bg-card p-6"
        >
          <div className="space-y-2">
            <h2 id="join-organization-title" className="text-lg font-semibold">
              Join an organization
            </h2>
            <p className="break-words text-sm text-muted-foreground">
              Use an invitation sent to {identity.user.email}.
            </p>
          </div>
          <form onSubmit={join} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="join-code">Join code</Label>
              <Input
                ref={input}
                id="join-code"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                required
                autoComplete="off"
                spellCheck={false}
                aria-invalid={Boolean(error)}
                aria-describedby={
                  error ? "join-code-help join-code-error" : "join-code-help"
                }
              />
              <p id="join-code-help" className="text-xs text-muted-foreground">
                You can also paste the full invitation link.
              </p>
              {error && (
                <p
                  id="join-code-error"
                  role="alert"
                  className="text-sm text-destructive"
                >
                  {error}
                </p>
              )}
            </div>
            <Button type="submit" disabled={busy || !code.trim()}>
              {busy ? "Joining..." : "Join organization"}
            </Button>
          </form>
        </section>
        <section
          aria-labelledby="create-organization-title"
          className="flex flex-col items-start gap-6 rounded-xl border bg-card p-6"
        >
          <div className="space-y-2">
            <h2
              id="create-organization-title"
              className="text-lg font-semibold"
            >
              Create an organization
            </h2>
            <p className="text-sm text-muted-foreground">
              Set up your organization and invite people to join. You will be
              its Owner.
            </p>
          </div>
          <Button variant="outline" onClick={() => setCreating(true)}>
            Create organization
          </Button>
        </section>
      </div>
      <CreateOrganizationDialog open={creating} onOpenChange={setCreating} />
    </main>
  );
}
