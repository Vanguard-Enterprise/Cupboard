import { apiFetch, getSession } from "@/lib/api";
import { can, Permission } from "@/lib/permissions";
import { revokeApiKeyAction } from "@/lib/actions";
import { CreateKey } from "./create-key";

type ApiKey = {
  id: string;
  name: string;
  token_prefix: string;
  scopes: string[];
  created_by: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
};

async function fetchKeys(): Promise<ApiKey[]> {
  const res = await apiFetch("/auth/api-keys");
  if (!res.ok) return [];
  return res.json();
}

type KeyStatus = "active" | "revoked" | "expired";

function statusOf(key: ApiKey): KeyStatus {
  if (key.revoked_at) return "revoked";
  if (key.expires_at && new Date(key.expires_at).getTime() <= Date.now()) return "expired";
  return "active";
}

const STATUS_STYLES: Record<KeyStatus, string> = {
  active: "bg-green-900 text-green-300",
  revoked: "bg-neutral-800 text-neutral-400",
  expired: "bg-yellow-900 text-yellow-300",
};

export default async function ApiKeysPage() {
  const session = await getSession();
  if (!session) return null;
  if (!can(session.permissions, Permission.ApiManage)) {
    return <p className="text-sm text-neutral-400">You don&apos;t have access to API keys.</p>;
  }
  const keys = await fetchKeys();

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-semibold">API keys</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Scoped keys for programmatic access. Each key carries a subset of your own
          permissions; the plaintext token is shown once at creation and never again.
        </p>
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium text-neutral-300">Create a key</h2>
        <CreateKey scopes={session.permissions} />
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-neutral-300">Keys</h2>
        {keys.length === 0 ? (
          <p className="text-sm text-neutral-500">No API keys yet.</p>
        ) : (
          <div className="overflow-hidden rounded border border-neutral-800">
            <table className="w-full text-start text-sm">
              <thead className="bg-neutral-900 text-neutral-400">
                <tr>
                  <th className="px-3 py-2">Name</th>
                  <th className="px-3 py-2">Prefix</th>
                  <th className="px-3 py-2">Scopes</th>
                  <th className="px-3 py-2">Created</th>
                  <th className="px-3 py-2">Expires</th>
                  <th className="px-3 py-2">Last used</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {keys.map((key) => {
                  const status = statusOf(key);
                  const muted = status === "revoked";
                  return (
                    <tr
                      key={key.id}
                      className={`border-t border-neutral-800 ${muted ? "opacity-50" : ""}`}
                    >
                      <td className="px-3 py-2">{key.name}</td>
                      <td className="px-3 py-2 text-neutral-400">
                        <code>{key.token_prefix}</code>
                      </td>
                      <td className="px-3 py-2 text-neutral-400">
                        <div className="flex max-w-80 flex-wrap gap-1">
                          {key.scopes.map((scope) => (
                            <code
                              key={scope}
                              className="rounded bg-neutral-900 px-1.5 py-0.5 text-xs"
                            >
                              {scope}
                            </code>
                          ))}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-neutral-400">
                        {new Date(key.created_at).toLocaleString()}
                      </td>
                      <td className="px-3 py-2 text-neutral-400">
                        {key.expires_at ? new Date(key.expires_at).toLocaleString() : "never"}
                      </td>
                      <td className="px-3 py-2 text-neutral-400">
                        {key.last_used_at ? new Date(key.last_used_at).toLocaleString() : "never"}
                      </td>
                      <td className="px-3 py-2">
                        <span className={`rounded px-2 py-0.5 text-xs ${STATUS_STYLES[status]}`}>
                          {status}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-end">
                        {!key.revoked_at && (
                          <form action={revokeApiKeyAction}>
                            <input type="hidden" name="key_id" value={key.id} />
                            <button className="text-xs text-red-400 hover:text-red-300">
                              Revoke
                            </button>
                          </form>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
