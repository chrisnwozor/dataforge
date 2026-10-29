"use client";
import Link from "next/link";
import { ChevronDown } from "lucide-react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { navigateFresh, accountRequest, useIdentity } from "./auth/provider";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "./ui/dropdown-menu";
import styles from "./ui/dropdown-menu.module.css";
export function WorkspaceSwitcher() {
  const identity = useIdentity(),
    [error, setError] = useState("");
  const active = identity.workspaces.find((w) => w.id === identity.workspaceId);
  if (!identity.user)
    return (
      <Link className="docs-link" href="/sign-in">
        {identity.loading ? "Workspace" : "Sign in"}
      </Link>
    );
  const name = active?.name || "Choose a workspace",
    initials = name
      .split(/\s+/)
      .slice(0, 2)
      .map((s) => s[0])
      .join("")
      .toUpperCase();
  async function change(id: string) {
    try {
      await accountRequest(`/api/workspaces/${id}/switch`);
      navigateFresh("/projects");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not switch workspace.");
    }
  }
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn("workspace-switch", styles.workspaceTrigger)}
            aria-label={`Switch workspace: ${initials} ${name} ${identity.local ? "Local" : active?.role || "Member"}`}
          >
            <span className="workspace-avatar" aria-hidden="true">
              {initials}
            </span>{" "}
            <span className={styles.workspaceName}>{name}</span>{" "}
            <span className="plan-badge">
              {identity.local ? "Local" : active?.role || "Member"}
            </span>
            <ChevronDown size={13} aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" aria-label="Workspaces">
          <DropdownMenuRadioGroup
            value={identity.workspaceId || ""}
            onValueChange={(id) => void change(id)}
          >
            {identity.workspaces.map((w) => (
              <DropdownMenuRadioItem key={w.id} value={w.id}>
                {w.name}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <Menu.Separator
            style={{ height: 1, background: "var(--line)", margin: "6px 0" }}
          />
          <Menu.Item asChild className={styles.item}>
            <Link href="/workspaces">Manage workspaces…</Link>
          </Menu.Item>
        </DropdownMenuContent>
      </DropdownMenu>
      {error && (
        <span role="alert" style={{ fontSize: 11 }}>
          {error}
        </span>
      )}
    </>
  );
}
