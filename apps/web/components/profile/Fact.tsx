import type { FieldSpec } from "@/lib/profile";
import { monthValue } from "@/lib/profile";
import { t } from "@tc-hunter/domain/messages";

const PROFILE_LINKS: Array<[string, string]> = [
  ["/profile", "About you"], ["/profile/experience", "Experience"], ["/profile/education", "Education"],
  ["/profile/skills", "Skills"], ["/profile/credentials", "Certifications"], ["/profile/stories", "Stories"],
  ["/profile/answers", "Saved answers"], ["/profile/preferences", "What you want"], ["/profile/import", "Bring in a resume"],
];

export function ProfileNav({ current }: { current: string }) {
  return (
    <nav className="subnav" aria-label="Profile sections">
      {PROFILE_LINKS.map(([href, label]) => (
        <a key={href} href={href} aria-current={href === current ? "page" : undefined}>{label}</a>
      ))}
    </nav>
  );
}

export function Chip({ checked }: { checked: boolean }) {
  return <span className={`chip ${checked ? "ok" : "draft"}`}>{checked ? t("profile.checked") : t("profile.draft")}</span>;
}

export function Flash({ saved, error }: { saved?: boolean; error?: string }) {
  if (error) return <p className="error" role="alert">{error}</p>;
  if (saved) return <p className="status" role="status">{t("profile.saved")}</p>;
  return null;
}

/** Inputs for one row, from its field spec. */
export function FactFields({ spec, values = {} }: { spec: FieldSpec[]; values?: Record<string, any> }) {
  return (
    <div className="fields">
      {spec.map((f) => {
        const v = values[f.name];
        const def = f.type === "month" ? monthValue(v) : Array.isArray(v) ? v.join(", ") : v ?? "";
        return (
          <label key={f.name}>
            {f.label}
            {f.type === "select" ? (
              <select name={f.name} defaultValue={String(def)} required={f.required}>
                {f.options!.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            ) : f.type === "textarea" ? (
              <textarea name={f.name} defaultValue={String(def)} required={f.required} rows={2} />
            ) : (
              <input name={f.name} type={f.type === "list" ? "text" : f.type} step={f.type === "number" ? "any" : undefined}
                defaultValue={String(def)} required={f.required} />
            )}
            {f.hint ? <span className="hint">{f.hint}</span> : null}
          </label>
        );
      })}
    </div>
  );
}

/** Hidden fields every row action carries: which row, and where to come back to. */
export function RowRef({ table, id, back }: { table: string; id?: string; back: string }) {
  return (
    <>
      <input type="hidden" name="table" value={table} />
      {id ? <input type="hidden" name="id" value={id} /> : null}
      <input type="hidden" name="back" value={back} />
    </>
  );
}
