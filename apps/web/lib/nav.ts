/**
 * App navigation: the left sidebar sections and the tabs inside each one.
 * Pure data and matching, so it can be tested without a browser.
 */
export type NavTab = { href: string; label: string; /** Other paths that belong to this tab, e.g. detail pages. */ also?: string[]; /** Shown only to admins (the page checks again, and so does the database). */ adminOnly?: boolean };
export type NavSection = { key: string; label: string; icon: string; tabs: NavTab[] };

export const NAV: NavSection[] = [
  { key: "home", label: "Home", icon: "⌂", tabs: [
    { href: "/", label: "Today" },
    { href: "/reports/weekly", label: "Weekly look back" },
  ] },
  { key: "me", label: "Me", icon: "◉", tabs: [
    { href: "/profile", label: "About you" },
    { href: "/profile/stories", label: "Stories" },
    { href: "/profile/answers", label: "Saved answers" },
    { href: "/profile/goals", label: "Goals", also: ["/profile/preferences"] },
    { href: "/profile/import", label: "Initial Input", also: ["/profile/resumes", "/profile/review"] },
  ] },
  { key: "jobs", label: "Jobs", icon: "◎", tabs: [
    { href: "/jobs", label: "Matches" },
    { href: "/jobs/sources", label: "Where we look" },
  ] },
  { key: "applications", label: "Applications", icon: "✓", tabs: [
    { href: "/applications", label: "Tracker" },
    // Documents lives under Applications (Yong, 2026-11-24: fewer top-level tabs). Its pages keep /documents/... links.
    { href: "/documents", label: "Documents" },
    { href: "/reports", label: "Reports" },
  ] },
  { key: "settings", label: "Settings", icon: "⚙", tabs: [
    // One page each (Yong, 2026-11-15: "different settings can be separated").
    { href: "/settings", label: "Sign-in and security" },
    { href: "/settings/email", label: "Email" },
    { href: "/settings/job-sites", label: "Job sites" },
    { href: "/settings/applying", label: "Applying for you" },
    { href: "/settings/data", label: "Your data" },
    // Invitations and an admin (Yong, 2026-11-25): only the person who runs TC Hunter sees it.
    { href: "/settings/people", label: "People", adminOnly: true },
  ] },
];

const under = (path: string, base: string) => base === "/" ? path === "/" : path === base || path.startsWith(base + "/");

/** The section and tab for a path (and optional #hash). The longest matching path wins. */
export function locate(pathname: string, hash = ""): { section: NavSection; tab: NavTab } | undefined {
  let best: { section: NavSection; tab: NavTab; len: number } | undefined;
  for (const section of NAV) {
    for (const tab of section.tabs) {
      const base = tab.href.split("#")[0]!;
      for (const p of [base, ...(tab.also ?? [])]) {
        if (under(pathname, p) && (!best || p.length > best.len)) best = { section, tab, len: p.length };
      }
    }
  }
  if (!best) return undefined;
  // Tabs that are #anchors on one page (Settings): pick the one named by the hash, else the first.
  const base = best.tab.href.split("#")[0]!;
  const anchors = best.section.tabs.filter((t) => t.href.startsWith(base + "#"));
  if (anchors.length) return { section: best.section, tab: anchors.find((t) => t.href === base + hash) ?? anchors[0]! };
  return { section: best.section, tab: best.tab };
}

/** The tabs this person sees: admin-only ones are left out for everyone else. */
export function visibleTabs(section: NavSection, isAdmin: boolean): NavTab[] {
  return section.tabs.filter((t) => isAdmin || !t.adminOnly);
}
