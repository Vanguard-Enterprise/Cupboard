"use client";

import { useRef } from "react";
import { switchOrgAction } from "@/lib/actions";

export function TenantSwitcher({
  orgs,
  current,
}: {
  orgs: { id: string; name: string }[];
  current: string;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  return (
    <form action={switchOrgAction} ref={formRef}>
      <select
        name="org_id"
        defaultValue={current}
        onChange={() => formRef.current?.requestSubmit()}
        className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm"
      >
        {orgs.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    </form>
  );
}
