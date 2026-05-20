"use client";

import React, { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";

// Sidebar order, top-to-bottom. Servers is intentionally NOT a
// top-level nav item — it lives as a tab under Settings (the
// `/settings?tab=servers` route). The `/servers` and
// `/servers/[id]` routes still work (the former 302-redirects into
// Settings, the latter is reached from Dashboard server cards).
const navItems = [
  {
    href: "/dashboard",
    label: "Dashboard",
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
      </svg>
    ),
  },
  {
    href: "/sessions",
    label: "Sessions",
    match: "/sessions",
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 10V3L4 14h7v7l9-11h-7z" />
      </svg>
    ),
  },
  {
    href: "/stacks",
    label: "Stacks",
    match: "/stacks",
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 6h16M4 12h16M4 18h16" />
      </svg>
    ),
  },
  {
    href: "/terminal",
    label: "Terminal",
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
      </svg>
    ),
  },
  {
    // Matches both /settings (any tab) and the legacy /servers route
    // (now a redirect into Settings) so navigating to a server detail
    // page still highlights the right top-level item.
    href: "/settings",
    label: "Settings",
    match: "/settings",
    extraMatch: "/servers",
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
      </svg>
    ),
  },
];

export function SidebarLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  // Don't render sidebar on the login page
  if (pathname === "/login") {
    return <>{children}</>;
  }

  const isActive = (item: typeof navItems[number]) => {
    if ("match" in item && typeof item.match === "string") {
      if (pathname.startsWith(item.match)) return true;
    }
    if ("extraMatch" in item && typeof item.extraMatch === "string") {
      if (pathname.startsWith(item.extraMatch)) return true;
    }
    if ("match" in item || "extraMatch" in item) return false;
    return pathname === item.href || pathname.startsWith(item.href + "/");
  };

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Sidebar */}
      <aside
        className={`flex flex-col bg-mg-bg-secondary border-r border-mg-border transition-all duration-200 ${
          sidebarCollapsed ? "w-16" : "w-60"
        }`}
      >
        {/* Logo — clicking it returns to the dashboard, matching the
            convention every web app the user already uses. */}
        <Link
          href="/dashboard"
          className="flex items-center gap-3 px-4 h-14 border-b border-mg-border hover:bg-mg-bg-hover transition-colors"
          title="Go to dashboard"
        >
          <div className="w-8 h-8 rounded-lg bg-mg-accent/20 flex items-center justify-center flex-shrink-0">
            <svg className="w-5 h-5 text-mg-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
          </div>
          {!sidebarCollapsed && (
            <span className="text-lg font-bold text-mg-text tracking-tight">ManageT</span>
          )}
        </Link>

        {/* Nav */}
        <nav className="flex-1 py-4 px-2 space-y-1">
          {navItems.map((item) => {
            const active = isActive(item);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200 ${
                  active
                    ? "text-mg-accent bg-mg-bg-active border-l-2 border-mg-accent"
                    : "text-mg-text-secondary hover:text-mg-text hover:bg-mg-bg-hover border-l-2 border-transparent"
                }`}
              >
                {item.icon}
                {!sidebarCollapsed && <span>{item.label}</span>}
              </Link>
            );
          })}
        </nav>

        {/* Sign out & Collapse toggle */}
        <div className="px-2 pb-4 space-y-1">
          <button
            onClick={() => signOut({ callbackUrl: "/login" })}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-mg-text-tertiary hover:text-red-400 hover:bg-mg-bg-hover transition-all duration-200"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
            </svg>
            {!sidebarCollapsed && <span className="text-xs">Sign Out</span>}
          </button>
          <button
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-mg-text-tertiary hover:text-mg-text hover:bg-mg-bg-hover transition-all duration-200"
          >
            <svg
              className={`w-4 h-4 transition-transform duration-200 ${sidebarCollapsed ? "rotate-180" : ""}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
            </svg>
            {!sidebarCollapsed && <span className="text-xs">Collapse</span>}
          </button>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Top bar */}
        <header className="h-14 border-b border-mg-border bg-mg-bg-secondary flex items-center justify-between px-6">
          <div className="flex items-center gap-4">
            <h1 className="text-sm font-medium text-mg-text capitalize">
              {pathname.split("/").filter(Boolean)[0] || "Dashboard"}
            </h1>
          </div>
          <div className="flex items-center gap-3">
            <div className="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.5)]" />
            <span className="text-xs text-mg-text-secondary">System Online</span>
          </div>
        </header>

        {/* Page content */}
        {/* /stacks and /groups own their own padding because they can split
            into a table + terminal mosaic layout that needs to fill the
            full content height. */}
        <main
          className={`flex-1 overflow-auto ${
            pathname.startsWith("/terminal") ||
            pathname.startsWith("/stacks") ||
            pathname.startsWith("/groups")
              ? ""
              : "p-6"
          }`}
        >
          {children}
        </main>
      </div>
    </div>
  );
}
