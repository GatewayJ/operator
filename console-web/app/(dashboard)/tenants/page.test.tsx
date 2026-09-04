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

import type { AnchorHTMLAttributes } from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import TenantsListPage from "./page"

type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; prefetch?: boolean }

const navigation = vi.hoisted(() => ({ push: vi.fn() }))

vi.mock("next/link", () => ({
  default: ({ children, href, prefetch: _prefetch, ...props }: LinkProps) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}))

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: navigation.push }),
}))

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}))

vi.mock("@/lib/api", () => ({
  listNamespaces: vi.fn().mockResolvedValue({ namespaces: [] }),
  listTenantStateCounts: vi.fn().mockResolvedValue({ total: 0 }),
  listTenantStateCountsByNamespace: vi.fn().mockResolvedValue({ total: 0 }),
  listTenants: vi.fn().mockResolvedValue({ tenants: [] }),
  listTenantsByNamespace: vi.fn().mockResolvedValue({ tenants: [] }),
  getTenant: vi.fn(),
  listPools: vi.fn(),
  deleteTenant: vi.fn(),
}))

describe("TenantsListPage", () => {
  beforeEach(() => navigation.push.mockReset())

  it("opens namespace management from the namespace filter", async () => {
    render(<TenantsListPage />)

    fireEvent.pointerDown(screen.getByRole("button", { name: "All Namespaces" }), { button: 0, ctrlKey: false })
    fireEvent.click(await screen.findByRole("menuitem", { name: "Manage Namespaces" }))

    expect(navigation.push).toHaveBeenCalledWith("/?tab=namespaces#cluster")
  })

  it("keeps the tenants title available to assistive technology", () => {
    render(<TenantsListPage />)

    expect(screen.getByRole("heading", { level: 1, name: "Tenants" })).toHaveClass("sr-only")
  })
})
