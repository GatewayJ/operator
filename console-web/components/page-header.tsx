import { cn } from "@/lib/utils"

export function PageHeader({
  children,
  description,
  actions,
  className,
  sticky = true,
}: {
  children: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
  className?: string
  sticky?: boolean
}) {
  return (
    <div
      className={cn(
        "flex flex-col justify-between gap-4 bg-background py-1 lg:flex-row lg:items-start",
        sticky && "lg:sticky lg:top-0 lg:z-10 lg:bg-background/95 lg:py-2 lg:backdrop-blur",
        className,
      )}
    >
      <div className="min-w-0 space-y-2 [&_h1]:font-heading [&_h1]:text-lg [&_h1]:font-semibold">
        {children}
        {description}
      </div>
      {actions && (
        <div className="-mx-1 flex max-w-full flex-none items-center gap-2 overflow-x-auto px-1 pb-1 [&_[data-slot=button]]:min-h-11 sm:[&_[data-slot=button]]:min-h-0 lg:justify-end lg:pb-0">
          {actions}
        </div>
      )}
    </div>
  )
}
