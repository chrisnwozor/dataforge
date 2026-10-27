"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "./ui/dropdown-menu";
import styles from "./ui/dropdown-menu.module.css";

const workspaces = ["Acme workspace", "Personal"];

export function WorkspaceSwitcher() {
  const [workspace, setWorkspace] = useState(workspaces[0]);
  const initials = workspace === "Personal" ? "P" : "AC";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn("workspace-switch", styles.workspaceTrigger)}
          aria-label={`Switch workspace: ${initials} ${workspace} Hobby`}
        >
          <span className="workspace-avatar" aria-hidden="true">
            {initials}
          </span>{" "}
          <span className={styles.workspaceName}>{workspace}</span>{" "}
          <span className="plan-badge" aria-hidden="true">
            Hobby
          </span>
          <ChevronDown size={13} aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" aria-label="Workspaces">
        <DropdownMenuRadioGroup value={workspace} onValueChange={setWorkspace}>
          {workspaces.map((name) => (
            <DropdownMenuRadioItem key={name} value={name}>
              {name}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
