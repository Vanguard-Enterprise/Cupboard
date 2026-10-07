"use client";
import { useState, type FormEvent } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { validPasswordLength, passwordLengthMessage } from "@/lib/password";
import { navigateAfterAuth, apiRequest } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldDescription,
  FieldError,
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
  const [fieldErrors, setFieldErrors] = useState<{
    name?: string;
    confirmPassword?: string;
    email?: string;
    password?: string;
  }>({});
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const password = String(data.get("password"));
    setError("");
    const emailInput = form.querySelector<HTMLInputElement>("#email")!;
    const errors = {
      name:
        signup && !String(data.get("name")).trim()
          ? "Enter your name."
          : undefined,
      email: !emailInput.value.trim()
        ? "Enter your email."
        : !emailInput.validity.valid
          ? "Enter a valid email address."
          : undefined,
      password: !password ? "Enter your password." : undefined,
      confirmPassword:
        signup && !data.get("confirm-password")
          ? "Confirm your password."
          : undefined,
    };
    setFieldErrors(errors);
    const firstInvalid = errors.name
      ? "name"
      : errors.email
        ? "email"
        : errors.password
          ? "password"
          : errors.confirmPassword
            ? "confirm-password"
            : undefined;
    if (firstInvalid) {
      form.querySelector<HTMLInputElement>(`#${firstInvalid}`)?.focus();
      return;
    }
    if (!validPasswordLength(password)) {
      toast.error(passwordLengthMessage);
      form.querySelector<HTMLInputElement>("#password")?.focus();
      return;
    }
    if (signup && password !== data.get("confirm-password")) {
      setFieldErrors({ confirmPassword: "Passwords do not match." });
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
      noValidate
    >
      <FieldGroup>
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">
            {signup ? "Create an account" : "Sign in to Cupboard"}
          </h1>
          <p className="text-sm text-muted-foreground">
            Manage your Rust servers.
          </p>
        </div>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {signup && (
          <>
            <Field data-invalid={!!fieldErrors.name}>
              <FieldLabel htmlFor="name">Name</FieldLabel>
              <Input
                id="name"
                className="h-11"
                name="name"
                autoComplete="name"
                required
                maxLength={100}
                aria-invalid={!!fieldErrors.name}
                aria-describedby={fieldErrors.name ? "name-error" : undefined}
                onChange={() =>
                  setFieldErrors((current) => ({ ...current, name: undefined }))
                }
              />
              {fieldErrors.name && (
                <FieldError id="name-error">{fieldErrors.name}</FieldError>
              )}
            </Field>
          </>
        )}
        <Field data-invalid={!!fieldErrors.email}>
          <FieldLabel htmlFor="email">Email</FieldLabel>
          <Input
            id="email"
            className="h-11"
            name="email"
            type="email"
            autoComplete="email"
            required
            maxLength={254}
            aria-invalid={!!fieldErrors.email}
            aria-describedby={fieldErrors.email ? "email-error" : undefined}
            onChange={() =>
              setFieldErrors((current) => ({ ...current, email: undefined }))
            }
          />
          {fieldErrors.email && (
            <FieldError id="email-error">{fieldErrors.email}</FieldError>
          )}
        </Field>
        <Field data-invalid={!!fieldErrors.password}>
          <FieldLabel htmlFor="password">Password</FieldLabel>
          <Input
            id="password"
            className="h-11"
            name="password"
            type="password"
            autoComplete={signup ? "new-password" : "current-password"}
            required
            aria-invalid={!!fieldErrors.password}
            aria-describedby={
              fieldErrors.password ? "password-error" : undefined
            }
            onChange={() =>
              setFieldErrors((current) => ({ ...current, password: undefined }))
            }
          />
          {fieldErrors.password && (
            <FieldError id="password-error">{fieldErrors.password}</FieldError>
          )}
          {signup && (
            <FieldDescription>Use 8 to 128 characters.</FieldDescription>
          )}
        </Field>
        {signup && (
          <Field data-invalid={!!fieldErrors.confirmPassword}>
            <FieldLabel htmlFor="confirm-password">Confirm password</FieldLabel>
            <Input
              id="confirm-password"
              className="h-11"
              name="confirm-password"
              type="password"
              autoComplete="new-password"
              required
              aria-invalid={!!fieldErrors.confirmPassword}
              aria-describedby={
                fieldErrors.confirmPassword
                  ? "confirm-password-error"
                  : undefined
              }
              onChange={() =>
                setFieldErrors((current) => ({
                  ...current,
                  confirmPassword: undefined,
                }))
              }
            />
            {fieldErrors.confirmPassword && (
              <FieldError id="confirm-password-error">
                {fieldErrors.confirmPassword}
              </FieldError>
            )}
          </Field>
        )}
        <Field>
          <Button type="submit" disabled={busy} className="h-11">
            {busy
              ? signup
                ? "Creating account..."
                : "Signing in..."
              : signup
                ? "Create account"
                : "Sign in"}
          </Button>
        </Field>
        <FieldDescription className="text-left">
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
