"use client";
import { useState, type FormEvent } from "react";
import Link from "next/link";
import { validPasswordLength, passwordLengthMessage } from "@/lib/password";
import { navigateAfterAuth, apiRequest } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldDescription,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";

export function AccountForm({
  signup = false,
  className,
}: {
  signup?: boolean;
  className?: string;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const password = String(data.get("password"));
    setError("");
    if (!validPasswordLength(password)) {
      setError(passwordLengthMessage);
      form.querySelector<HTMLInputElement>("#password")?.focus();
      return;
    }
    if (signup && password !== data.get("confirm-password")) {
      setError("Passwords do not match.");
      form.querySelector<HTMLInputElement>("#confirm-password")?.focus();
      return;
    }
    setBusy(true);
    try {
      await apiRequest(`auth/${signup ? "signup" : "login"}`, {
        email: data.get("email"),
        password,
        ...(signup ? { name: data.get("name") } : {}),
      });
      const invitation = window.location.hash.replace(/^#invite=/, "");
      navigateAfterAuth(
        /^[a-f0-9]{64}$/.test(invitation)
          ? `/join#${invitation}`
          : "/dashboard",
      );
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not sign in.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className={className ?? "flex flex-col gap-6"}
      method="post"
      action={signup ? "/signup" : "/login"}
      onSubmit={submit}
    >
      <FieldGroup>
        <div className="space-y-2">
          <h1
            className={
              signup
                ? "text-center text-2xl font-bold"
                : "text-2xl font-semibold tracking-tight"
            }
          >
            {signup ? "Create an account" : "Sign in to Cupboard"}
          </h1>
          {!signup && (
            <p className="text-sm text-muted-foreground">
              Manage your Rust servers.
            </p>
          )}
        </div>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {signup && (
          <>
            <Field>
              <FieldLabel htmlFor="name">Name</FieldLabel>
              <Input
                id="name"
                name="name"
                autoComplete="name"
                required
                maxLength={100}
              />
            </Field>
          </>
        )}
        <Field>
          <FieldLabel htmlFor="email">Email</FieldLabel>
          <Input
            id="email"
            className={signup ? undefined : "h-11"}
            name="email"
            type="email"
            autoComplete="email"
            required
            maxLength={254}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="password">Password</FieldLabel>
          <Input
            id="password"
            className={signup ? undefined : "h-11"}
            name="password"
            type="password"
            autoComplete={signup ? "new-password" : "current-password"}
            required
          />
          {signup && (
            <FieldDescription>Use 8 to 128 characters.</FieldDescription>
          )}
        </Field>
        {signup && (
          <Field>
            <FieldLabel htmlFor="confirm-password">Confirm password</FieldLabel>
            <Input
              id="confirm-password"
              name="confirm-password"
              type="password"
              autoComplete="new-password"
              required
            />
          </Field>
        )}
        <Field>
          <Button
            type="submit"
            disabled={busy}
            className={signup ? undefined : "h-11"}
          >
            {busy
              ? signup
                ? "Creating account..."
                : "Signing in..."
              : signup
                ? "Create account"
                : "Sign in"}
          </Button>
        </Field>
        <FieldDescription className={signup ? "text-center" : "text-left"}>
          {signup ? "Already have an account? " : "New to Cupboard? "}
          <Link
            href={signup ? "/login" : "/signup"}
            onClick={(event) => {
              if (window.location.hash.startsWith("#invite=")) {
                event.preventDefault();
                navigateAfterAuth(
                  `${signup ? "/login" : "/signup"}${window.location.hash}`,
                );
              }
            }}
          >
            {signup ? "Sign in" : "Create an account"}
          </Link>
        </FieldDescription>
      </FieldGroup>
    </form>
  );
}
