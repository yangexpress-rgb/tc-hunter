/**
 * App navigation: the left sidebar sections and the tabs inside each one.
 * Pure data and matching, so it can be tested without a browser.
 */
export type NavTab = { href: string; label: string; /** Other paths that belong to this tab, e.g. detail pages. */ also?: string[] };
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
    { href: "/jobs/paste", label: "Add a job" },
    { href: "/jobs/sources", label: "Where we look" },
  ] },
  { key: "applications", label: "Applications", icon: "✓", tabs: [
    { href: "/applications", label: "Tracker" },
    { href: "/reports", label: "Reports" },
  ] },
  { key: "documents", label: "Documents", icon: "▤", tabs: [
    { href: "/documents", label: "Resumes and letters" },
  ] },
  { key: "settings", label: "Settings", icon: "⚙", tabs: [
    { href: "/settings#security", label: "Sign-in" },
    { href: "/settings#devices", label: "Devices" },
    { href: "/settings#email", label: "Email" },
    { href: "/settings#browser", label: "Browser" },
    { href: "/settings#data", label: "Your data" },
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
