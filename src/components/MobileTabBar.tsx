import { Link, useLocation } from "react-router-dom";
import { Home, LayoutDashboard, Send, Plane } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";

interface TabDef {
  to: string;
  label: string;
  icon: typeof Home;
  /** If true, hide the tab when there is no session. */
  authOnly?: boolean;
  /** Treat any of these path prefixes as making the tab active. */
  match: (pathname: string) => boolean;
}

const TABS: TabDef[] = [
  { to: "/", label: "Home", icon: Home, match: (p) => p === "/" },
  { to: "/dashboard", label: "Ops", icon: LayoutDashboard, authOnly: true, match: (p) => p.startsWith("/dashboard") },
  { to: "/plan", label: "Plan", icon: Send, authOnly: true, match: (p) => p.startsWith("/plan") },
];

/**
 * Bottom tab bar — only renders on mobile, only on app routes. Sits above the
 * iOS home-indicator using safe-area-inset-bottom. Larger touch targets
 * (min 44px height per Apple HIG / Material guidelines).
 *
 * Tailwind only — no JS breakpoint sniffing, which keeps SSR/hydration clean.
 */
export default function MobileTabBar() {
  const { pathname } = useLocation();
  const { session } = useAuth();

  // Hide on landing + auth pages: TopDock covers marketing chrome there.
  if (pathname === "/" || pathname.startsWith("/auth")) return null;

  const visibleTabs = TABS.filter((t) => !t.authOnly || session);

  return (
    <nav
      className="md:hidden fixed bottom-0 inset-x-0 z-40 bg-background/85 backdrop-blur-xl border-t border-border/60"
      style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
      aria-label="Primary"
    >
      <ul className="flex items-stretch justify-around px-1">
        {visibleTabs.map((tab) => {
          const Icon = tab.icon;
          const active = tab.match(pathname);
          return (
            <li key={tab.to} className="flex-1">
              <Link
                to={tab.to}
                aria-current={active ? "page" : undefined}
                className={`flex flex-col items-center justify-center gap-0.5 min-h-[52px] py-1.5 rounded-lg text-[10px] font-medium tracking-wide transition-colors ${
                  active
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground active:bg-secondary/40"
                }`}
              >
                <Icon className={`w-5 h-5 ${active ? "text-primary" : ""}`} aria-hidden="true" />
                <span>{tab.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/**
 * Spacer that the page can render once the tab bar is visible. The tab bar is
 * `position: fixed`, so any sticky content at the bottom of the document
 * (e.g. CTAs) would otherwise be obscured by it.
 *
 *   <MobileTabBarSpacer />
 *
 * Renders ~56px (tab) + safe-area-inset-bottom on mobile, nothing on desktop.
 */
export function MobileTabBarSpacer() {
  return (
    <div
      className="md:hidden h-[56px] shrink-0"
      style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
      aria-hidden="true"
    />
  );
}

// Plane import is kept for the icon namespace tree-shaking — used elsewhere.
void Plane;
