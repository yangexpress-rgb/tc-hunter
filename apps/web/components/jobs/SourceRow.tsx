"use client";
import type { ReactNode } from "react";
import { useRouter } from "next/navigation";

/**
 * A row of Where we look (Yong, 2026-11-23): double-clicking it opens that source's jobs as
 * company cards. Double-clicks on the row's own buttons, menus, links and folded text are left alone.
 */
export function SourceRow({ href, name, children }: { href?: string; name: string; children: ReactNode }) {
  const router = useRouter();
  if (!href) return <tr>{children}</tr>;
  return (
    <tr className="row-link" title={`Double-click to see the jobs found at ${name}`}
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).closest("a, button, input, select, textarea, summary, label, form")) return;
        window.getSelection()?.removeAllRanges();
        router.push(href);
      }}>
      {children}
    </tr>
  );
}
