"use client"

import { useEffect, useState } from "react"
import Image from "next/image"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { useTranslation } from "react-i18next"
import { Dialog } from "radix-ui"
import {
  RiCloseLine,
  RiDashboardLine,
  RiGithubLine,
  RiLogoutBoxLine,
  RiMenuLine,
  RiServerLine,
  RiTwitterXLine,
  RiUser3Line,
} from "@remixicon/react"

import { AuthGuard } from "@/components/auth-guard"
import { LanguageSwitcher } from "@/components/language-switcher"
import { ThemeSwitcher } from "@/components/theme-switcher"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { useAuth } from "@/contexts/auth-context"
import { routes } from "@/lib/routes"
import { cn } from "@/lib/utils"

const navItems = [
  { href: routes.dashboard, icon: RiDashboardLine, labelKey: "Dashboard" },
  { href: routes.tenants, icon: RiServerLine, labelKey: "Tenants" },
]
const GITHUB_URL = "https://github.com/rustfs/operator"
const X_URL = "https://x.com/rustfsofficial"

function isNavItemActive(pathname: string, href: string) {
  return pathname === href || (href !== routes.dashboard && pathname.startsWith(href))
}

function SidebarNavigation({
  pathname,
  onNavigate,
  showExternalLinks = false,
}: {
  pathname: string
  onNavigate?: () => void
  showExternalLinks?: boolean
}) {
  const { t } = useTranslation()

  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex min-w-0 items-baseline gap-2 px-4 py-6">
        <Link href="/" prefetch={false} className="inline-flex items-center gap-2" onClick={onNavigate}>
          <Image src="/logo.svg" width={64} height={16} alt="RustFS" className="h-4 w-auto shrink-0" />
        </Link>
      </div>
      <nav className="flex flex-col gap-0.5 px-2" aria-label={t("Navigation")}>
        {navItems.map((item) => {
          const Icon = item.icon
          const active = isNavItemActive(pathname, item.href)
          return (
            <Link
              key={item.href}
              href={item.href}
              prefetch={false}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex min-h-11 items-center gap-3 rounded-none px-2.5 py-2 text-xs font-medium transition-colors lg:min-h-0",
                active
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
              )}
            >
              <Icon className="size-4 shrink-0" />
              {t(item.labelKey)}
            </Link>
          )
        })}
      </nav>
      {showExternalLinks && (
        <div className="mt-auto border-t border-sidebar-border p-2">
          <Button asChild variant="ghost" className="h-11 w-full justify-start gap-3 px-2.5">
            <Link href={GITHUB_URL} prefetch={false} target="_blank" rel="noopener noreferrer">
              <RiGithubLine className="size-4" />
              GitHub
            </Link>
          </Button>
          <Button asChild variant="ghost" className="h-11 w-full justify-start gap-3 px-2.5">
            <Link href={X_URL} prefetch={false} target="_blank" rel="noopener noreferrer">
              <RiTwitterXLine className="size-4" />X
            </Link>
          </Button>
        </div>
      )}
    </div>
  )
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation()
  const { logout } = useAuth()
  const pathname = usePathname()
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false)
  const activeItem = navItems.find((item) => isNavItemActive(pathname, item.href)) ?? navItems[0]
  const ActiveIcon = activeItem.icon

  useEffect(() => {
    const desktopMediaQuery = window.matchMedia("(min-width: 1024px)")
    const closeMobileNavigation = (event: MediaQueryListEvent) => {
      if (event.matches) setMobileNavigationOpen(false)
    }

    desktopMediaQuery.addEventListener("change", closeMobileNavigation)
    return () => desktopMediaQuery.removeEventListener("change", closeMobileNavigation)
  }, [])

  return (
    <AuthGuard>
      <div className="flex h-dvh overflow-hidden">
        <aside className="hidden h-full w-64 shrink-0 overflow-hidden border-r border-sidebar-border lg:block">
          <SidebarNavigation pathname={pathname} />
        </aside>
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <header className="flex h-16 shrink-0 items-center justify-between gap-2 border-b border-border bg-background px-3 sm:px-4">
            <div className="flex min-w-0 items-center gap-2 sm:gap-3">
              <Dialog.Root open={mobileNavigationOpen} onOpenChange={setMobileNavigationOpen}>
                <Dialog.Trigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="-ml-1 size-11 lg:hidden"
                    aria-label={t("Open navigation")}
                  >
                    <RiMenuLine className="size-5" />
                  </Button>
                </Dialog.Trigger>
                <Dialog.Portal>
                  <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
                  <Dialog.Content className="fixed inset-y-0 left-0 z-50 w-72 max-w-[85vw] border-r border-sidebar-border bg-sidebar shadow-xl outline-none">
                    <Dialog.Title className="sr-only">{t("Navigation")}</Dialog.Title>
                    <Dialog.Description className="sr-only">{t("Primary navigation")}</Dialog.Description>
                    <Dialog.Close asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="absolute right-2 top-2 z-10 size-11"
                        aria-label={t("Close navigation")}
                      >
                        <RiCloseLine className="size-5" />
                      </Button>
                    </Dialog.Close>
                    <SidebarNavigation
                      pathname={pathname}
                      onNavigate={() => setMobileNavigationOpen(false)}
                      showExternalLinks
                    />
                  </Dialog.Content>
                </Dialog.Portal>
              </Dialog.Root>
              <ActiveIcon className="size-5 shrink-0 text-muted-foreground" />
              <span className="truncate text-xs font-medium">{t(activeItem.labelKey)}</span>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <LanguageSwitcher />
              <ThemeSwitcher />
              <div className="hidden items-center gap-1 sm:flex">
                <Button asChild variant="ghost" size="icon-sm" aria-label="GitHub">
                  <Link href={GITHUB_URL} prefetch={false} target="_blank" rel="noopener noreferrer">
                    <RiGithubLine className="size-4" />
                  </Link>
                </Button>
                <Button asChild variant="ghost" size="icon-sm" aria-label="X">
                  <Link href={X_URL} prefetch={false} target="_blank" rel="noopener noreferrer">
                    <RiTwitterXLine className="size-4" />
                  </Link>
                </Button>
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="icon-sm" className="size-11 sm:size-7" aria-label={t("User menu")}>
                    <RiUser3Line className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-40">
                  <DropdownMenuItem onSelect={logout}>
                    <RiLogoutBoxLine className="me-2 size-4" />
                    {t("Logout")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </header>
          <main className="flex-1 overflow-auto px-4 pb-6 pt-4 sm:px-6">{children}</main>
        </div>
      </div>
    </AuthGuard>
  )
}
