// Copyright 2026 RustFS Team
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import type { AnchorHTMLAttributes, ReactNode } from "react"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import DashboardLayout from "./layout"

type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; prefetch?: boolean }

vi.mock("next/image", () => ({
  default: ({ alt }: { alt: string }) => <span role="img" aria-label={alt} />,
}))

vi.mock("next/link", () => ({
  default: ({ children, href, prefetch: _prefetch, ...props }: LinkProps) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}))

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
}))

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("@/components/auth-guard", () => ({
  AuthGuard: ({ children }: { children: ReactNode }) => children,
}))

vi.mock("@/components/language-switcher", () => ({ LanguageSwitcher: () => null }))
vi.mock("@/components/theme-switcher", () => ({ ThemeSwitcher: () => null }))
vi.mock("@/contexts/auth-context", () => ({ useAuth: () => ({ logout: vi.fn() }) }))

describe("DashboardLayout", () => {
  let desktopListener: ((event: MediaQueryListEvent) => void) | undefined

  beforeEach(() => {
    desktopListener = undefined
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
          desktopListener = listener
        },
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    })
  })

  it("closes the mobile navigation when the viewport reaches the desktop breakpoint", () => {
    render(<DashboardLayout>content</DashboardLayout>)

    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }))
    expect(screen.getByRole("dialog", { name: "Navigation" })).toBeInTheDocument()

    act(() => desktopListener?.({ matches: true } as MediaQueryListEvent))

    expect(screen.queryByRole("dialog", { name: "Navigation" })).not.toBeInTheDocument()
  })
})
