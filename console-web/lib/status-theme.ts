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

import type { TenantLifecycleState } from "@/types/api"

interface StatusTheme {
  badge: string
  dot: string
  label: string
  activeCard: string
}

export const STATUS_THEME: Record<TenantLifecycleState, StatusTheme> = {
  Ready: {
    badge: "border-status-success/30 bg-status-success/10 text-status-success",
    dot: "bg-status-success",
    label: "text-status-success",
    activeCard: "border-status-success/40 ring-1 ring-status-success/20",
  },
  Reconciling: {
    badge: "border-status-info/30 bg-status-info/10 text-status-info",
    dot: "bg-status-info",
    label: "text-status-info",
    activeCard: "border-status-info/40 ring-1 ring-status-info/20",
  },
  Blocked: {
    badge: "border-status-blocked/30 bg-status-blocked/10 text-status-blocked",
    dot: "bg-status-blocked",
    label: "text-status-blocked",
    activeCard: "border-status-blocked/40 ring-1 ring-status-blocked/20",
  },
  Updating: {
    badge: "border-status-info/30 bg-status-info/10 text-status-info",
    dot: "bg-status-info",
    label: "text-status-info",
    activeCard: "border-status-info/40 ring-1 ring-status-info/20",
  },
  Degraded: {
    badge: "border-status-warning/30 bg-status-warning/10 text-status-warning",
    dot: "bg-status-warning",
    label: "text-status-warning",
    activeCard: "border-status-warning/40 ring-1 ring-status-warning/20",
  },
  NotReady: {
    badge: "border-status-danger/30 bg-status-danger/10 text-status-danger",
    dot: "bg-status-danger",
    label: "text-status-danger",
    activeCard: "border-status-danger/40 ring-1 ring-status-danger/20",
  },
  Unknown: {
    badge: "border-border bg-muted/60 text-muted-foreground",
    dot: "bg-muted-foreground",
    label: "text-muted-foreground",
    activeCard: "border-muted-foreground/40 ring-1 ring-muted-foreground/20",
  },
}

export function getStatusDotClass(state: string): string {
  switch (state) {
    case "Ready":
    case "Running":
      return "bg-status-success"
    case "Reconciling":
    case "Updating":
      return "bg-status-info"
    case "Blocked":
      return "bg-status-blocked"
    case "Degraded":
    case "Pending":
      return "bg-status-warning"
    case "NotReady":
    case "Failed":
      return "bg-status-danger"
    default:
      return "bg-muted-foreground"
  }
}
