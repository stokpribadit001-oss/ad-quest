// Typed RPC client for the standalone deploy. Types come straight from
// `server/src/actions.ts` — no codegen. Every call POSTs `{action, args}`
// to `/actions` (same-origin; the Express server hosts both API and client)
// and either returns the typed result or throws an Error carrying the
// server's Indonesian error message.
//
// `import type { Actions }` is type-only by design: the client bundle never
// pulls in any server runtime (pg, express, etc.).

import type { Actions } from "../../server/src/actions";

export type ApiResponse<_Client, Name extends keyof Actions> = Awaited<
  ReturnType<Actions[Name]>
>;

type ApiClient = { [K in keyof Actions]: Actions[K] };

async function callAction(name: string, args: unknown): Promise<unknown> {
  const res = await fetch("/actions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: name, args: args ?? {} }),
  });
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const msg =
      data && typeof data === "object" && "error" in data
        ? String((data as { error: unknown }).error)
        : `Gagal menghubungi server (${res.status}).`;
    throw new Error(msg);
  }
  return data;
}

export const api: ApiClient = new Proxy(
  {},
  {
    get: (_target, prop) => {
      if (typeof prop !== "string") return undefined;
      return (args: unknown) => callAction(prop, args);
    },
  },
) as ApiClient;
