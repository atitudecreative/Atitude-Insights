import { cn } from "@/lib/cn";

export function BrandMark({ name, logoUrl, className }: { name: string; logoUrl?: string | null; className?: string }) {
  const initials = name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  return (
    <span className={cn("flex items-center gap-2.5", className)}>
      {logoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={logoUrl} alt="" className="size-8 rounded-lg object-contain" />
      ) : (
        <span aria-hidden className="flex size-8 items-center justify-center rounded-lg bg-brand text-[13px] font-bold text-brand-contrast shadow-sm">
          {initials}
        </span>
      )}
      <span className="truncate text-[15px] font-semibold tracking-tight">{name}</span>
    </span>
  );
}
