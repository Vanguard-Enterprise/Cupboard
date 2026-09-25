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
        <h1 className="text-center text-2xl font-bold">
          {signup ? "Create an account" : "Login to your account"}
        </h1>
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
          <Button type="submit" disabled={busy}>
            {busy
              ? signup
                ? "Creating account..."
                : "Signing in..."
              : signup
                ? "Create account"
                : "Login"}
          </Button>
        </Field>
        <FieldDescription className="text-center">
          {signup ? "Already have an account? " : "Don't have an account? "}
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
            {signup ? "Sign in" : "Sign up"}
          </Link>
        </FieldDescription>
      </FieldGroup>
    </form>
  );
}
