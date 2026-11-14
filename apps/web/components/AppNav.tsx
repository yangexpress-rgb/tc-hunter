"use client";

import { useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { NAV, locate } from "@/lib/nav";

/**
 * Signed-in navigation: a left sidebar of sections on desktop (a scrolling row on phones),
 * and the tabs of the current section above the page.
 */
export function AppNav({ brand, tagline, footer }: { brand: string; tagline: string; footer?: ReactNode }) {
  const pathname = usePathname() ?? "/";
  const [hash, setHash] = useState("");
  useEffect(() => {
    const read = () => setHash(window.location.hash);
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, [pathname]);
  const here = locate(pathname, hash);
  return (
    <>
      <aside className="side">
        <a className="brand" href="/">{brand}</a>
        <span className="tagline">{tagline}</span>
        <nav className="side-nav" aria-label="Sections">
          {NAV.map((s) => (
            <a key={s.key} href={s.tabs[0]!.href} aria-current={here?.section.key === s.key ? "page" : undefined}>
              <span className="side-icon" aria-hidden="true">{s.icon}</span>{s.label}
            </a>
          ))}
        </nav>
        {footer ? <div className="side-foot">{footer}</div> : null}
      </aside>
      {here && here.section.tabs.length > 1 ? (
        <nav className="section-tabs" aria-label={`${here.section.label} tabs`}>
          {here.section.tabs.map((tab) => (
            <a key={tab.href} href={tab.href} aria-current={here.tab.href === tab.href ? "page" : undefined}>{tab.label}</a>
          ))}
        </nav>
      ) : null}
    </>
  );
}
