"use client";
import { useEffect, useRef } from "react";

/**
 * One filter bar for Jobs (Yong, 2026-11-18), shaped like the reference screenshots: a search box,
 * then pill menus. Changing anything applies it at once; Enter in the search box does too.
 */

type Opt = readonly [string, string];

function Pill({ label, count, children }: { label: string; count: number; children: React.ReactNode }) {
  return (
    <details className="pill-menu">
      <summary className={count ? "is-on" : undefined}>{label}{count ? <span className="pill-count">{count}</span> : null}<span aria-hidden="true" className="caret">▾</span></summary>
      <div className="pill-pop">{children}</div>
    </details>
  );
}

export function FilterBar({ hidden, search, goals, goal, levels, levelOpts, work, workOpts, ladder, ladderOpts, sources, source, showFiltered, clearHref }: {
  hidden: Record<string, string | undefined>;
  search: string;
  goals: readonly Opt[]; goal: string;
  levels: string[]; levelOpts: readonly Opt[];
  work: string[]; workOpts: readonly Opt[];
  ladder: string; ladderOpts: readonly Opt[];
  sources: readonly Opt[]; source: string;
  showFiltered: boolean;
  clearHref: string;
}) {
  const ref = useRef<HTMLFormElement>(null);
  // Ticking several boxes in one menu applies them together when the menu closes; anything else applies at once.
  const dirty = useRef(false);
  const submit = () => { dirty.current = false; ref.current?.requestSubmit(); };
  useEffect(() => {
    const close = (e: MouseEvent) => {
      for (const d of ref.current?.querySelectorAll("details.pill-menu[open]") ?? []) if (!d.contains(e.target as Node)) d.removeAttribute("open");
    };
    const toggled = (e: Event) => { if (!(e.target as HTMLDetailsElement).open && dirty.current) submit(); };
    const form = ref.current;
    document.addEventListener("click", close);
    form?.addEventListener("toggle", toggled, true);
    return () => { document.removeEventListener("click", close); form?.removeEventListener("toggle", toggled, true); };
  }, []);
  const more = (ladder ? 1 : 0) + (source ? 1 : 0) + (showFiltered ? 1 : 0);
  const any = search || goal || levels.length || work.length || more;
  return (
    <form ref={ref} method="get" action="/jobs" className="filter-bar" onChange={(e) => {
      const el = e.target as unknown as HTMLInputElement;
      if (el.name === "q") return;
      if (el.type === "checkbox" && el.closest("details.pill-menu")) dirty.current = true; else submit();
    }}>
      {Object.entries(hidden).map(([k, v]) => (v ? <input key={k} type="hidden" name={k} value={v} /> : null))}
      <label className="search-box">
        <span className="sr-only">Search</span>
        <span aria-hidden="true" className="search-icon">⌕</span>
        <input type="search" name="q" defaultValue={search} placeholder="Search roles, companies or places" />
      </label>
      {goals.length > 1 ? (
        <Pill label="Goal" count={goal ? 1 : 0}>
          <label className="check"><input type="radio" name="goal" value="" defaultChecked={!goal} /> Any goal</label>
          {goals.map(([k, l]) => <label key={k} className="check"><input type="radio" name="goal" value={k} defaultChecked={goal === k} /> {l}</label>)}
        </Pill>
      ) : null}
      <Pill label="Level" count={levels.length}>
        {levelOpts.map(([k, l]) => <label key={k} className="check"><input type="checkbox" name="level" value={k} defaultChecked={levels.includes(k)} /> {l}</label>)}
      </Pill>
      <Pill label="Workplace" count={work.length}>
        {workOpts.map(([k, l]) => <label key={k} className="check"><input type="checkbox" name="work" value={k} defaultChecked={work.includes(k)} /> {l}</label>)}
      </Pill>
      <Pill label="More" count={more}>
        <label>Career step<select name="ladder" defaultValue={ladder}>{ladderOpts.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        {sources.length > 1 ? <label>Found at<select name="source" defaultValue={source}><option value="">Anywhere</option>{sources.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label> : null}
        <label className="check"><input type="checkbox" name="filtered" value="1" defaultChecked={showFiltered} /> Also show jobs your preferences rule out</label>
      </Pill>
      {any ? <a className="clear-filters" href={clearHref}>Clear</a> : null}
      <noscript><button className="small">Apply</button></noscript>
    </form>
  );
}
