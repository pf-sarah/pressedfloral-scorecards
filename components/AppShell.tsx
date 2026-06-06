"use client";

import * as React from "react";
import type { LucideIcon } from "lucide-react";
import { Flower2, LogOut } from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";

export type NavItem<TKey extends string> = {
  key: TKey;
  label: string;
  icon: LucideIcon;
  badge?: number;
  hidden?: boolean;
  testId?: string;
};

export type NavGroup<TKey extends string> = {
  label?: string;
  items: NavItem<TKey>[];
};

interface AppShellProps<TKey extends string> {
  brand: { title: string; subtitle?: string };
  groups: NavGroup<TKey>[];
  activeKey: TKey;
  onNavigate: (key: TKey) => void;
  user?: { primary: string; secondary?: string };
  onSignOut?: () => void;
  pageTitle?: string;
  banner?: React.ReactNode;
  children: React.ReactNode;
}

export function AppShell<TKey extends string>({
  brand,
  groups,
  activeKey,
  onNavigate,
  user,
  onSignOut,
  pageTitle,
  banner,
  children,
}: AppShellProps<TKey>) {
  return (
    <SidebarProvider>
      <Sidebar>
        <SidebarHeader>
          <div className="flex items-center gap-2 px-1.5 py-1">
            <div className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground shrink-0">
              <Flower2 className="size-4" />
            </div>
            <div className="flex flex-col min-w-0 leading-tight">
              <span className="text-[13.5px] font-semibold text-foreground truncate">
                {brand.title}
              </span>
              {brand.subtitle ? (
                <span className="text-[11px] text-muted-foreground truncate">
                  {brand.subtitle}
                </span>
              ) : null}
            </div>
          </div>
        </SidebarHeader>
        <SidebarContent>
          {groups.map((group, gi) => {
            const visibleItems = group.items.filter((item) => !item.hidden);
            if (visibleItems.length === 0) return null;
            return (
              <SidebarGroup key={group.label ?? `group-${gi}`}>
                {group.label ? (
                  <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
                ) : null}
                <SidebarGroupContent>
                  <SidebarMenu>
                    {visibleItems.map((item) => {
                      const Icon = item.icon;
                      const isActive = activeKey === item.key;
                      return (
                        <SidebarMenuItem key={item.key}>
                          <SidebarMenuButton
                            isActive={isActive}
                            onClick={() => onNavigate(item.key)}
                            data-testid={item.testId}
                          >
                            <Icon />
                            <span>{item.label}</span>
                            {item.badge && item.badge > 0 ? (
                              <SidebarMenuBadge>{item.badge}</SidebarMenuBadge>
                            ) : null}
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      );
                    })}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            );
          })}
        </SidebarContent>
        {user || onSignOut ? (
          <SidebarFooter>
            <div className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-[var(--surface2)] transition-colors">
              {user ? (
                <div className="flex size-7 items-center justify-center rounded-full bg-[var(--surface2)] text-foreground text-[11px] font-semibold shrink-0">
                  {(user.primary || "?").slice(0, 1).toUpperCase()}
                </div>
              ) : null}
              {user ? (
                <div className="flex flex-1 flex-col min-w-0 leading-tight">
                  <span className="text-[12px] font-medium text-foreground truncate">
                    {user.primary}
                  </span>
                  {user.secondary ? (
                    <span className="text-[10.5px] text-muted-foreground truncate">
                      {user.secondary}
                    </span>
                  ) : null}
                </div>
              ) : null}
              {onSignOut ? (
                <button
                  type="button"
                  onClick={onSignOut}
                  aria-label="Sign out"
                  className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-card hover:text-foreground transition-colors"
                >
                  <LogOut className="size-3.5" />
                </button>
              ) : null}
            </div>
          </SidebarFooter>
        ) : null}
      </Sidebar>
      <SidebarInset>
        {banner}
        <header className="flex items-center gap-3 border-b border-border bg-card px-5 py-3 md:px-7 md:py-4">
          <SidebarTrigger />
          {pageTitle ? (
            <h1 className="text-[15px] font-semibold text-foreground tracking-tight">
              {pageTitle}
            </h1>
          ) : null}
        </header>
        <div className="flex-1">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}
