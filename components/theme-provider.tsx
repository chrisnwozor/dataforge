"use client";
import { ThemeProvider as Provider, useTheme } from "next-themes";
import { Sun, Moon, Monitor } from "lucide-react";
import { Button } from "@/components/ui/button";
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <Provider
      attribute="class"
      defaultTheme="dark"
      enableSystem
      disableTransitionOnChange
    >
      {children}
    </Provider>
  );
}
export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Toggle color theme"
      onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
    >
      <Sun size={16} className="dark-sun" />
      <Moon size={16} className="light-moon" />
    </Button>
  );
}
export function ThemeChoice() {
  const { theme, setTheme } = useTheme();
  return (
    <div className="segmented">
      {[
        { id: "light", Icon: Sun },
        { id: "dark", Icon: Moon },
        { id: "system", Icon: Monitor },
      ].map(({ id, Icon }) => (
        <button
          key={id}
          aria-pressed={theme === id}
          onClick={() => setTheme(id)}
        >
          <Icon size={16} />
          {id[0].toUpperCase() + id.slice(1)}
        </button>
      ))}
    </div>
  );
}
