"use client";

import { useState } from "react";
import { toast } from "sonner";
import { useOrganizationLogo } from "@/hooks/use-organization-logo";
import { OrganizationLogoPicker } from "./organization-logo-picker";
import { Building2Icon } from "lucide-react";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useOrganization } from "@/components/organization-provider";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  useComboboxFilter,
} from "@/components/ui/combobox";
import {
  countries,
  countryForShortcut,
  regionsForCountry,
} from "@/lib/address-options";
import {
  validateProfile,
  type OrganizationProfile,
  type ProfileErrors,
} from "@/lib/organization-profile";

function LogoPreview({ url }: { url: string }) {
  const [failed, setFailed] = useState(false);
  const src = url.startsWith("blob:") ? url : undefined;
  return (
    <div className="space-y-2">
      <Avatar className="size-20 rounded-xl after:rounded-xl">
        <AvatarImage
          src={src}
          alt="Organization logo"
          referrerPolicy="no-referrer"
          className="rounded-xl border border-border bg-input-background object-contain p-2"
          onLoadingStatusChange={(status) => setFailed(status === "error")}
        />
        <AvatarFallback className="rounded-xl border border-border bg-input-background">
          <Building2Icon className="size-7" aria-label="No organization logo" />
        </AvatarFallback>
      </Avatar>
      {src && failed && (
        <p className="max-w-48 text-xs text-muted-foreground" role="status">
          Image could not be loaded. Choose another image.
        </p>
      )}
    </div>
  );
}

function ProfileEditor({
  saved,
  save,
  organizationId,
  canManage,
}: {
  organizationId: string;
  canManage: boolean;
  saved: OrganizationProfile;
  save: (profile: OrganizationProfile) => void;
}) {
  const logo = useOrganizationLogo(organizationId);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState(saved);
  const [errors, setErrors] = useState<ProfileErrors>({});
  const [saveError, setSaveError] = useState("");
  const [baseline, setBaseline] = useState(saved);
  const [conflict, setConflict] = useState(false);
  const { contains: countryNameContains } = useComboboxFilter();
  const filterCountry = (countryName: string, query: string) => {
    const shortcut = countryForShortcut(query);
    return shortcut
      ? countryName === shortcut
      : countryNameContains(countryName, query);
  };
  if (saved !== baseline) {
    setBaseline(saved);
    if (JSON.stringify(draft) === JSON.stringify(baseline)) {
      setDraft(saved);
      setConflict(false);
    } else {
      setConflict(JSON.stringify(draft) !== JSON.stringify(saved));
    }
  }
  const dirty = logo.dirty || JSON.stringify(draft) !== JSON.stringify(saved);
  function field(
    key: keyof OrganizationProfile,
    label: string,
    type = "text",
    placeholder?: string,
    helper?: string,
    fullWidth = false,
  ) {
    const options =
      key === "country"
        ? countries
        : key === "region"
          ? regionsForCountry(draft.country)
          : [];
    const isCombobox =
      key === "country" || (key === "region" && options.length > 0);
    const optionNames = options.map((option) => option.name);
    const comboboxItems =
      draft[key] && !optionNames.includes(draft[key])
        ? [draft[key], ...optionNames]
        : optionNames;
    const updateValue = (value: string) => {
      setDraft({
        ...draft,
        [key]: value,
        ...(key === "country" && value !== draft.country ? { region: "" } : {}),
      });
      setSaveError("");
      setErrors({
        ...errors,
        [key]: undefined,
        ...(key === "country" ? { region: undefined } : {}),
      });
    };
    const common = {
      id: key,
      name: key,
      value: draft[key],
      required: key === "name",
      maxLength: ["description", "addressLine1", "addressLine2"].includes(key)
        ? 1000
        : 200,
      autoComplete: (
        {
          addressLine1: "billing address-line1",
          addressLine2: "billing address-line2",
          city: "billing address-level2",
          region: "billing address-level1",
          postalCode: "billing postal-code",
          country: "billing country-name",
        } as Partial<Record<keyof OrganizationProfile, string>>
      )[key],
      "aria-invalid": !!errors[key],
      "aria-describedby":
        [helper ? `${key}-help` : "", errors[key] ? `${key}-error` : ""]
          .filter(Boolean)
          .join(" ") || undefined,
      onChange: (
        event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
      ) => updateValue(event.target.value),
    };
    return (
      <div
        className={`scroll-mt-6 space-y-2 ${type === "textarea" || fullWidth ? "md:col-span-2" : ""}`}
      >
        <div className="flex items-center gap-1.5">
          <Label htmlFor={key}>
            {label}
            {common.required ? " *" : ""}
          </Label>
        </div>
        {isCombobox ? (
          <Combobox
            items={comboboxItems}
            value={draft[key] || null}
            onValueChange={(value) => updateValue(value ?? "")}
            name={key}
            autoComplete={common.autoComplete}
            autoHighlight
            filter={key === "country" ? filterCountry : undefined}
          >
            <ComboboxInput
              id={key}
              placeholder={
                key === "country"
                  ? "Select or search country"
                  : "Select or search state / region"
              }
              aria-invalid={common["aria-invalid"]}
              aria-describedby={common["aria-describedby"]}
              showClear={Boolean(draft[key])}
              className="h-10 w-full border-input bg-input-background hover:border-border-strong dark:bg-input-background"
            />
            <ComboboxContent className="border border-border">
              <ComboboxEmpty>
                {key === "country"
                  ? "No countries found."
                  : "No states or regions found."}
              </ComboboxEmpty>
              <ComboboxList>
                {(option: string) => (
                  <ComboboxItem key={option} value={option}>
                    {option}
                    {option === draft[key] && !optionNames.includes(option)
                      ? " (saved)"
                      : ""}
                  </ComboboxItem>
                )}
              </ComboboxList>
            </ComboboxContent>
          </Combobox>
        ) : type === "textarea" ? (
          <Textarea
            {...common}
            rows={3}
            className="border-input hover:border-border-strong focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring dark:bg-input-background"
          />
        ) : (
          <Input
            {...common}
            type={type}
            placeholder={placeholder}
            className={`h-10 border-input hover:border-border-strong focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring dark:bg-input-background ${key === "website" ? "placeholder:text-text-muted" : ""}`}
          />
        )}
        {helper && (
          <p
            id={`${key}-help`}
            className="text-xs leading-5 text-muted-foreground"
          >
            {helper}
          </p>
        )}
        {errors[key] && (
          <p id={`${key}-error`} className="text-sm text-destructive">
            {errors[key]}
          </p>
        )}
      </div>
    );
  }
  return (
    <form
      noValidate
      className="space-y-8"
      onSubmit={async (event) => {
        event.preventDefault();
        if (conflict || saving) return;
        const normalized = Object.fromEntries(
          Object.entries(draft).map(([key, value]) => [key, value.trim()]),
        ) as OrganizationProfile;
        const nextErrors = validateProfile(normalized);
        setErrors(nextErrors);
        setSaveError("");
        if (Object.keys(nextErrors).length) {
          const firstInvalidControl = Array.from(
            event.currentTarget.querySelectorAll<
              HTMLInputElement | HTMLTextAreaElement
            >("input, textarea"),
          ).find(
            (control) => nextErrors[control.id as keyof OrganizationProfile],
          );
          firstInvalidControl?.focus();
          return;
        }
        setSaving(true);
        try {
          await logo.save();
          try {
            save(normalized);
          } catch {
            throw new Error(
              logo.dirty
                ? "The logo was saved, but organization details could not be saved in this browser. Try saving again."
                : "Could not save your changes. Please try again.",
            );
          }
          setDraft(normalized);
          toast.success("Changes saved.");
        } catch (error) {
          setSaveError(
            error instanceof Error
              ? error.message
              : "Could not save your changes. Please try again.",
          );
        } finally {
          setSaving(false);
        }
      }}
    >
      <fieldset disabled={saving} className="divide-y divide-border">
        <section aria-labelledby="details-heading" className="space-y-6 pb-8">
          <div className="space-y-1">
            <h2 id="details-heading" className="text-base font-semibold">
              Organization
            </h2>
          </div>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:gap-6">
            <LogoPreview key={logo.preview} url={logo.preview} />
            <div className="min-w-0 flex-1 space-y-2">
              <OrganizationLogoPicker
                disabled={!canManage || !logo.ready || saving || logo.loading}
                hasLogo={logo.hasLogo}
                error={logo.error}
                loading={logo.loading || logo.processing}
                onRetry={logo.dirty ? undefined : () => void logo.reload()}
                onRemove={() => {
                  logo.select(null);
                  setSaveError("");
                }}
                onSelect={(file) => {
                  if (logo.select(file)) {
                    setSaveError("");
                  }
                }}
              />
              {!canManage && (
                <p className="text-xs text-muted-foreground">
                  Organization management permission is required to change the
                  uploaded logo.
                </p>
              )}
            </div>
          </div>
          <div className="grid gap-x-4 gap-y-6 md:grid-cols-2">
            {field(
              "name",
              "Organization name",
              "text",
              undefined,
              undefined,
              true,
            )}
            {field(
              "website",
              "Website",
              "url",
              "https://example.com",
              undefined,
              true,
            )}
            {field("description", "Description", "textarea")}
          </div>
        </section>
        <section aria-labelledby="contacts-heading" className="space-y-6 py-8">
          <div className="space-y-1">
            <h2 id="contacts-heading" className="text-base font-semibold">
              Contact
            </h2>
          </div>
          <div className="grid gap-x-4 gap-y-6 md:grid-cols-2">
            {field("publicEmail", "Public email", "email", "hello@example.com")}
            {field(
              "supportUrl",
              "Support URL",
              "url",
              "https://example.com/support",
            )}
            {field(
              "privateEmail",
              "Internal contact email",
              "email",
              undefined,
              undefined,
              true,
            )}
          </div>
        </section>
        <section aria-labelledby="billing-heading" className="space-y-6 pt-8">
          <div className="space-y-1">
            <h2 id="billing-heading" className="text-base font-semibold">
              Billing
            </h2>
          </div>
          <div className="grid gap-x-4 gap-y-6 md:grid-cols-2">
            {field("legalName", "Legal name")}
            {field("billingEmail", "Billing email", "email")}
            {field(
              "addressLine1",
              "Address line 1",
              "text",
              undefined,
              undefined,
              true,
            )}
            {field(
              "addressLine2",
              "Address line 2 (optional)",
              "text",
              undefined,
              undefined,
              true,
            )}
            {field("country", "Country")}
            {field("city", "City")}
            {field("region", "State / region")}
            {field("postalCode", "ZIP / postal code")}
          </div>
        </section>
      </fieldset>
      <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-end gap-3 border-t border-border bg-background py-4">
        {conflict && (
          <Alert variant="destructive" className="w-full">
            <AlertDescription>
              This profile changed in another tab. Cancel to load the latest
              version before editing again.
            </AlertDescription>
          </Alert>
        )}
        {saveError && (
          <Alert variant="destructive" className="mr-auto w-auto max-w-full">
            <AlertDescription>{saveError}</AlertDescription>
          </Alert>
        )}
        {dirty && !conflict && !saveError && (
          <p className="mr-auto text-sm text-muted-foreground">
            Unsaved changes
          </p>
        )}
        <Button
          type="button"
          variant="outline"
          className="min-h-11 px-4 sm:h-10 sm:min-h-0 [@media(any-pointer:coarse)]:min-h-11"
          disabled={saving || (!dirty && !conflict)}
          onClick={() => {
            logo.cancel();
            setDraft(saved);
            setConflict(false);
            setErrors({});
            setSaveError("");
          }}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          className="min-h-11 px-4 sm:h-10 sm:min-h-0 [@media(any-pointer:coarse)]:min-h-11"
          disabled={
            saving ||
            !dirty ||
            conflict ||
            (logo.dirty && (!canManage || !logo.ready || !logo.validPreview))
          }
        >
          {saving ? "Saving changes..." : "Save changes"}
        </Button>
      </div>
    </form>
  );
}

export function OrganizationProfileForm({
  organizationId,
  canManage,
}: {
  organizationId: string;
  canManage: boolean;
}) {
  const { profile, ready, save, storageError } = useOrganization();
  if (!ready)
    return (
      <p className="text-sm text-muted-foreground" role="status">
        Loading organization profile...
      </p>
    );
  return (
    <>
      {storageError && (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription>{storageError}</AlertDescription>
        </Alert>
      )}
      <ProfileEditor
        key={organizationId}
        saved={profile}
        save={save}
        organizationId={organizationId}
        canManage={canManage}
      />
    </>
  );
}
