"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/** What TC Hunter desktop app offers its own window (desktop/preload.js). Absent in a browser. */
type Desktop = {
  readNow: () => Promise<ReaderState | null>;
  status: () => Promise<ReaderState | null>;
  openAtLogin: () => Promise<boolean | null>;
  setOpenAtLogin: (on: boolean) => Promise<boolean | null>;
};
type ReaderState = { state: string; running?: boolean; now?: string; done?: number; total?: number; message?: string };
const desktop = (): Desktop | null => (typeof window !== "undefined" ? ((window as unknown as { tcDesktop?: Desktop }).tcDesktop ?? null) : null);

/**
 * Workday sites and some careers portals are read by the TC Hunter desktop app, from the applicant's own computer (Yong, 2026-11-18).
 * One line of status and one "Read now"; in a plain browser, where to get the app.
 */
export function DesktopReader({ lastRead, count, downloadUrl }: { lastRead: string | null; count: number; downloadUrl: string }) {
  const router = useRouter();
  const [app, setApp] = useState<Desktop | null | undefined>(undefined);
  const [st, setSt] = useState<ReaderState | null>(null);
  const [atLogin, setAtLogin] = useState<boolean | null>(null);

  useEffect(() => {
    const d = desktop();
    setApp(d);
    if (!d) return;
    d.status().then(setSt).catch(() => {});
    d.openAtLogin().then(setAtLogin).catch(() => {});
  }, []);

  // While a read runs, follow it; when it ends, show what it brought in.
  useEffect(() => {
    if (!app || !st?.running) return;
    const t = setInterval(() => app.status().then((s) => { setSt(s); if (s && !s.running) router.refresh(); }).catch(() => {}), 3000);
    return () => clearInterval(t);
  }, [app, st?.running, router]);

  const sites = `${count} ${count === 1 ? "site" : "sites"}`;
  if (app === undefined) return null;
  if (!app) {
    return <p className="muted small" id="desktop-app">
      Workday sites, and some company careers sites with no feed we can read, are read by the TC Hunter desktop app from your own computer ({sites} for you).
      {lastRead ? ` Last read from the app: ${lastRead}.` : " Not read from the app yet."} <a href={downloadUrl} target="_blank" rel="noreferrer">Get the desktop app</a>
    </p>;
  }
  const running = !!st?.running;
  const line = running ? `Reading ${st?.now ?? "your sites"}${st?.total ? ` (${(st.done ?? 0) + 1} of ${st.total})` : ""}…`
    : st?.state === "signed_out" ? "This app isn't signed in, so it can't read your job sites. Sign in (tick Remember this device so it keeps reading)."
    : st?.state === "failed" ? `The last read didn't finish: ${st.message ?? "TC Hunter didn't answer."}`
    : lastRead ? `${sites} ${count === 1 ? "is" : "are"} read from this app. Last read: ${lastRead}.` : `${sites} ${count === 1 ? "is" : "are"} read from this app, shortly after it opens and every 6 hours.`;
  return (
    <div className="stack" id="desktop-app">
      <p className={st?.state === "failed" || st?.state === "signed_out" ? "error small" : "muted small"}>{line}{" "}
        <button className="small secondary" disabled={running} onClick={() => app.readNow().then((s) => setSt(s ? { ...s, running: true } : s))}>{running ? "Reading…" : "Read now"}</button>
      </p>
      {atLogin !== null ? <label className="small">
        <input type="checkbox" checked={atLogin} onChange={(e) => app.setOpenAtLogin(e.target.checked).then((v) => setAtLogin(!!v))} />
        {" "}Open TC Hunter when this computer starts (so the weekly search always has a fresh read)
      </label> : null}
    </div>
  );
}
