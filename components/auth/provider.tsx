"use client";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
export type WorkspaceRole = "viewer" | "editor" | "admin" | "owner";
export interface Identity {
  user: {
    id: string;
    email: string;
    name: string;
    emailVerifiedAt: string | null;
  } | null;
  workspaces: { id: string; name: string; slug: string; role: WorkspaceRole }[];
  workspaceId: string | null;
  local: boolean;
}
const initial: Identity = {
  user: null,
  workspaces: [],
  workspaceId: null,
  local: false,
};
const Context = createContext<
  Identity & { loading: boolean; refresh: () => Promise<void> }
>({ ...initial, loading: true, refresh: async () => {} });
export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState(initial),
    [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/auth/me", { cache: "no-store" });
      if (r.ok) setState(await r.json());
    } catch {
      setState(initial);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/auth/me", { cache: "no-store", signal: controller.signal })
      .then(async (r) => {
        if (r.ok) {
          const identity = await r.json();
          if (!controller.signal.aborted) setState(identity);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);
  return (
    <Context.Provider value={{ ...state, loading, refresh }}>
      {children}
    </Context.Provider>
  );
}
export const useIdentity = () => useContext(Context);
export function useWorkspaceRole() {
  const identity = useIdentity();
  return identity.workspaces.find((w) => w.id === identity.workspaceId)?.role;
}
export function canEdit(role?: WorkspaceRole) {
  return !!role && role !== "viewer";
}
export function canAdmin(role?: WorkspaceRole) {
  return role === "admin" || role === "owner";
}
export async function accountRequest(
  path: string,
  method = "POST",
  body?: unknown,
) {
  const r = await fetch(path, {
    method,
    headers:
      body === undefined ? undefined : { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await r.json();
  if (!r.ok)
    throw new Error(result.error || "The request could not be completed.");
  return result;
}
/** Clear the Next client route cache when identity/tenant changes. */
export function navigateFresh(path: string): void {
  window.location.assign(new URL(path, window.location.origin).href);
}
