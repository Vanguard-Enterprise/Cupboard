"use client";

import { useState } from "react";
import { flushSync } from "react-dom";
import { Button } from "@/components/ui/button";
import { Building2Icon, InfoIcon, MailIcon } from "lucide-react";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useOrganization } from "@/components/organization-provider";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { countries, regionsForCountry } from "@/lib/address-options";
import {
  validateProfile,
  type OrganizationProfile,
  type ProfileErrors,
} from "@/lib/organization-profile";

function ProfileEditor({
  saved,
  save,
}: {
  saved: OrganizationProfile;
  save: (profile: OrganizationProfile) => void;
}) {
  const [activeTab, setActiveTab] = useState("details");
  const [draft, setDraft] = useState(saved);
  const [errors, setErrors] = useState<ProfileErrors>({});
  const [saveError, setSaveError] = useState("");
  const [savedNotice, setSavedNotice] = useState(false);
  const [baseline, setBaseline] = useState(saved);
  const [conflict, setConflict] = useState(false);
  if (saved !== baseline) {
    setBaseline(saved);
    if (JSON.stringify(draft) !== JSON.stringify(saved)) setSavedNotice(false);
    if (JSON.stringify(draft) === JSON.stringify(baseline)) {
      setDraft(saved);
      setConflict(false);
    } else {
      setConflict(JSON.stringify(draft) !== JSON.stringify(saved));
    }
  }
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
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
    const isSelect =
      key === "country" || (key === "region" && options.length > 0);
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
        event: React.ChangeEvent<
          HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
        >,
      ) => {
        setDraft({
          ...draft,
          [key]: event.target.value,
          ...(key === "country" && event.target.value !== draft.country
            ? { region: "" }
            : {}),
        });
        setSaveError("");
        setSavedNotice(false);
        setErrors({
          ...errors,
          [key]: undefined,
          ...(key === "country" ? { region: undefined } : {}),
        });
      },
    };
    return (
      <div
        className={`space-y-2 ${type === "textarea" || fullWidth ? "md:col-span-2" : ""}`}
      >
        <div className="flex items-center gap-1.5">
          <Label htmlFor={key}>
            {label}
            {common.required ? " *" : ""}
          </Label>
          {key === "privateEmail" && (
            <Tooltip disableHoverableContent>
              <TooltipTrigger asChild>
                <span
                  tabIndex={0}
                  role="img"
                  aria-label="About internal contact email"
                  className="inline-flex size-5 items-center justify-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <InfoIcon className="size-3.5" />
                </span>
              </TooltipTrigger>
              <TooltipContent
                side="right"
                sideOffset={8}
                align="center"
                collisionPadding={12}
                className="max-w-[min(18rem,calc(100vw-3rem))] border border-border bg-popover text-foreground shadow-lg"
                aria-label="About internal contact email"
              >
                For staff communication. Excluded from organization search.
              </TooltipContent>
            </Tooltip>
          )}
        </div>
        {isSelect ? (
          <select
            {...common}
            className="h-10 w-full min-w-0 rounded-lg border border-input hover:border-border-strong bg-input-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="">
              {key === "country" ? "Select country" : "Select state / region"}
            </option>
            {draft[key] &&
              !options.some((option) => option.name === draft[key]) && (
                <option value={draft[key]}>{draft[key]} (saved)</option>
              )}
            {options.map((option) => (
              <option key={option.name} value={option.name}>
                {option.name}
              </option>
            ))}
          </select>
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
      className="space-y-6"
      onSubmit={(event) => {
        event.preventDefault();
        if (conflict) return;
        const normalized = Object.fromEntries(
          Object.entries(draft).map(([key, value]) => [key, value.trim()]),
        ) as OrganizationProfile;
        const nextErrors = validateProfile(normalized);
        setErrors(nextErrors);
        setSaveError("");
        setSavedNotice(false);
        const firstError = Object.keys(nextErrors)[0];
        if (firstError) {
          flushSync(() =>
            setActiveTab(
              ["name", "description", "website"].includes(firstError)
                ? "details"
                : "contacts",
            ),
          );
          document.getElementById(firstError)?.focus();
          return;
        }
        try {
          save(normalized);
          setDraft(normalized);
          setSavedNotice(true);
        } catch {
          setSaveError("Could not save your changes. Please try again.");
        }
      }}
    >
      <Tabs value={activeTab} onValueChange={setActiveTab} className="gap-4">
        <TabsList
          aria-label="Organization profile sections"
          className="h-9! gap-1 rounded-lg bg-surface-elevated p-1"
        >
          <TabsTrigger
            value="details"
            className="h-7 rounded-md px-3 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
          >
            <Building2Icon /> Details
          </TabsTrigger>
          <TabsTrigger
            value="contacts"
            className="h-7 rounded-md px-3 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
          >
            <MailIcon /> Contact info
          </TabsTrigger>
        </TabsList>
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          <TabsContent value="details" className="px-6 py-6 sm:px-7">
            <div className="grid gap-x-4 gap-y-6 md:grid-cols-2">
              {field("name", "Organization name")}
              {field("website", "Website", "url", "https://example.com")}
              {field("description", "Description", "textarea")}
            </div>
          </TabsContent>
          <TabsContent value="contacts" className="space-y-8 px-6 py-6 sm:px-7">
            <section aria-labelledby="contacts-heading" className="space-y-6">
              <h2 id="contacts-heading" className="text-base font-semibold">
                Contact information
              </h2>
              <div className="grid gap-x-4 gap-y-6 md:grid-cols-2">
                {field(
                  "publicEmail",
                  "Public email",
                  "email",
                  "hello@example.com",
                )}
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
            <section aria-labelledby="billing-heading" className="space-y-6">
              <h2 id="billing-heading" className="text-base font-semibold">
                Billing information
              </h2>
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
          </TabsContent>
          <div className="flex flex-wrap items-center justify-end gap-3 border-t border-border px-6 py-3 sm:px-7">
            {savedNotice && !dirty && (
              <p
                role="status"
                className="mr-auto text-sm text-muted-foreground"
              >
                Changes saved.
              </p>
            )}
            {conflict && (
              <p role="alert" className="w-full text-sm text-destructive">
                This profile changed in another tab. Cancel to load the latest
                version before editing again.
              </p>
            )}
            {saveError && (
              <p role="alert" className="mr-auto text-sm text-destructive">
                {saveError}
              </p>
            )}
            <Button
              type="button"
              variant="outline"
              className="h-9 px-4"
              disabled={!dirty && !conflict}
              onClick={() => {
                setDraft(saved);
                setConflict(false);
                setErrors({});
                setSaveError("");
                setSavedNotice(false);
              }}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              className="h-9 px-4"
              disabled={!dirty || conflict}
            >
              Save changes
            </Button>
          </div>
        </div>
      </Tabs>
    </form>
  );
}

export function OrganizationProfileForm() {
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
        <p role="alert" className="mb-4 text-sm text-destructive">
          {storageError}
        </p>
      )}
      <ProfileEditor saved={profile} save={save} />
    </>
  );
}
