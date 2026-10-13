"use client";

import { ChevronRight, type LucideIcon } from "lucide-react";
import { createContext, useContext, useState } from "react";

/** Set by the side menu. In the narrow form only the icons show, and a click on one opens the menu. */
export const MenuContext = createContext<{ collapsed: boolean; expand: () => void }>({ collapsed: false, expand: () => {} });

/** One row of the side menu: an icon, a label and a short value. A click opens the details under it. */
export function MenuItem({ icon: Icon, label, value, badge, defaultOpen = false, children }: {
  icon: LucideIcon;
  label: string;
  /** Short text at the right of the row, for example a balance. */
  value?: React.ReactNode;
  /** A count. It shows only when above zero. */
  badge?: number;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const { collapsed, expand } = useContext(MenuContext);
  if (collapsed)
    return (
      <button
        onClick={() => { setOpen(true); expand(); }}
        title={value !== undefined ? `${label}: ${value}` : label}
        aria-label={label}
        className="relative mx-auto grid size-10 place-items-center rounded-lg text-dim hover:bg-raised hover:text-ink"
      >
        <Icon className="size-[18px]" />
        {badge ? <span className="absolute right-1 top-1 size-2 rounded-full bg-accent" /> : null}
      </button>
    );
  return (
    <section>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={`group flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-[14px] hover:bg-raised ${open ? "bg-raised/60" : ""}`}
      >
        <span className={`grid size-7 shrink-0 place-items-center rounded-md ${open ? "bg-accent text-white" : "bg-raised text-dim group-hover:text-ink"}`}>
          <Icon className="size-4" />
        </span>
        <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
        {badge ? <span className="rounded-full bg-accent/15 px-1.5 text-[11px] font-medium tabular-nums text-accent">{badge}</span> : null}
        {value !== undefined && <span className="font-mono text-[12.5px] tabular-nums text-dim">{value}</span>}
        <ChevronRight className={`size-3.5 shrink-0 text-faint transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open && <div className="mb-1 ml-5 mt-1 border-l border-line pl-3 pr-1">{children}</div>}
    </section>
  );
}

/** A row that does something at once, for example opens a window. It has no details under it. */
export function MenuButton({ icon: Icon, label, onClick }: { icon: LucideIcon; label: string; onClick: () => void }) {
  const { collapsed } = useContext(MenuContext);
  if (collapsed)
    return (
      <button onClick={onClick} title={label} aria-label={label} className="mx-auto grid size-10 place-items-center rounded-lg text-dim hover:bg-raised hover:text-ink">
        <Icon className="size-[18px]" />
      </button>
    );
  return (
    <button onClick={onClick} className="group flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-[14px] hover:bg-raised">
      <span className="grid size-7 shrink-0 place-items-center rounded-md bg-raised text-dim group-hover:text-ink">
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
    </button>
  );
}
