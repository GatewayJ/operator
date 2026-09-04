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

import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import DashboardPage from "./page"

const navigation = vi.hoisted(() => ({
  search: "tab=namespaces",
  replace: vi.fn(),
}))

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: navigation.replace }),
  useSearchParams: () => new URLSearchParams(navigation.search),
}))

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}))

vi.mock("@/lib/api", () => ({
  listNodes: vi.fn().mockResolvedValue({ nodes: [] }),
  listNamespaces: vi.fn().mockResolvedValue({ namespaces: [] }),
  getClusterResources: vi.fn().mockResolvedValue(null),
  getTopologyOverview: vi.fn().mockResolvedValue(null),
  createNamespace: vi.fn(),
}))

describe("DashboardPage", () => {
  beforeEach(() => {
    navigation.search = "tab=namespaces"
    navigation.replace.mockReset()
  })

  it("uses the URL as the cluster tab source of truth", () => {
    const { rerender } = render(<DashboardPage />)

    expect(screen.getByRole("button", { name: "Namespaces" })).toHaveAttribute("aria-pressed", "true")

    navigation.search = "tab=resources"
    rerender(<DashboardPage />)
    expect(screen.getByRole("button", { name: "Resources" })).toHaveAttribute("aria-pressed", "true")

    navigation.search = ""
    rerender(<DashboardPage />)
    expect(screen.getByRole("button", { name: "Nodes" })).toHaveAttribute("aria-pressed", "true")
  })

  it("updates the URL when a cluster tab is selected", () => {
    render(<DashboardPage />)

    fireEvent.click(screen.getByRole("button", { name: "Resources" }))

    expect(navigation.replace).toHaveBeenCalledWith("/?tab=resources#cluster", { scroll: false })
  })

  it("keeps the dashboard title available to assistive technology", () => {
    render(<DashboardPage />)

    expect(screen.getByRole("heading", { level: 1, name: "Dashboard" })).toHaveClass("sr-only")
  })
})
