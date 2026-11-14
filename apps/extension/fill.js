/*
 * TC Hunter form helper (design 5.5, Phase 4b). Injected into the current tab only
 * when the applicant clicks the TC Hunter button. It can read the form's questions,
 * type answers the applicant approved, and look for a confirmation number.
 *
 * It never clicks a button, never submits, never touches a password field, and never
 * answers a question that is the applicant's own (statements, personal
 * questions, consents, signatures, "are you a person" checks): those are only outlined.
 */
(() => {
  if (window.__tcHunter) return;

  // The same rules as the app (packages/domain/src/packet/map.ts); repeated here as a second guard.
  // Right-to-work questions are not here: the app fills them only from the applicant's approved saved answer (decision 13.7).
  const STEP_RULES = [
    ["eeo", /\b(gender|sex\b|race|racial|ethnicity|hispanic|latino|veteran|disabilit|sexual orientation|transgender|demographic|self[- ]identif)/i],
    ["signature", /\b(signature|sign (here|below)|e-?sign|electronic(ally)? sign)/i],
    ["consent", /\b(consent|background check|privacy (policy|notice)|data (processing|protection)|gdpr|terms (and|&) conditions|i agree)\b/i],
    ["attestation", /\b(certify|attest|declare|true(,)? (correct )?and complete|accurate and complete|i (confirm|acknowledge|understand) that)\b/i],
  ];
  const stepFor = (label) => { for (const [k, re] of STEP_RULES) if (re.test(label)) return k; return null; };
  const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, "\\$&"));

  function visible(el) {
    if (el.type === "hidden" || el.disabled) return false;
    if (el.type === "file") return true; // file inputs are often styled away
    const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    return cs.display !== "none" && cs.visibility !== "hidden" && (r.width > 0 || r.height > 0);
  }

  function labelOf(el) {
    const by = el.getAttribute("aria-labelledby");
    if (by) { const t = by.split(/\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" "); if (clean(t)) return clean(t); }
    if (el.id) { const l = document.querySelector(`label[for="${esc(el.id)}"]`); if (l && clean(l.textContent)) return clean(l.textContent); }
    const wrap = el.closest("label"); if (wrap && clean(wrap.textContent)) return clean(wrap.textContent);
    if (el.getAttribute("aria-label")) return clean(el.getAttribute("aria-label"));
    if (el.placeholder) return clean(el.placeholder);
    return clean(el.name || el.id);
  }

  function groupLabel(el) {
    const fs = el.closest("fieldset"); const lg = fs && fs.querySelector("legend");
    if (lg && clean(lg.textContent)) return clean(lg.textContent);
    const grp = el.closest("[role=radiogroup],[role=group]");
    if (grp) { const by = grp.getAttribute("aria-labelledby"); if (by && document.getElementById(by)) return clean(document.getElementById(by).textContent); if (grp.getAttribute("aria-label")) return clean(grp.getAttribute("aria-label")); }
    return labelOf(el);
  }

  function keyOf(el) {
    if (el.id) return `#${el.id}`;
    if (el.name) return el.type === "radio" ? `radio:${el.name}` : `name:${el.name}`;
    return null;
  }
  function find(key) {
    if (key.startsWith("#")) return document.getElementById(key.slice(1));
    if (key.startsWith("name:")) return document.querySelector(`[name="${esc(key.slice(5))}"]`);
    if (key.startsWith("radio:")) return document.querySelector(`input[type=radio][name="${esc(key.slice(6))}"]`);
    return null;
  }
  const TYPES = new Set(["text", "email", "tel", "url", "number", "date", "textarea", "select", "radio", "checkbox", "file"]);

  function hasCaptcha() {
    return !!document.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"], iframe[src*="captcha"], .g-recaptcha, .h-captcha, .cf-turnstile, [data-sitekey]');
  }

  /** The form's questions, in page order. */
  function readForm() {
    const out = [], seen = new Set();
    for (const el of document.querySelectorAll("input, select, textarea")) {
      const tag = el.tagName.toLowerCase();
      const type = tag === "select" ? "select" : tag === "textarea" ? "textarea" : (el.type || "text").toLowerCase();
      if (type === "password" || !TYPES.has(type) || !visible(el)) continue;
      if (type === "radio") {
        const key = keyOf(el); if (!key || !el.name) continue;
        const k = `radio:${el.name}`; if (seen.has(k)) continue; seen.add(k);
        const radios = [...document.querySelectorAll(`input[type=radio][name="${esc(el.name)}"]`)];
        out.push({ key: k, label: groupLabel(el), type, options: radios.map((r) => labelOf(r)), required: radios.some((r) => r.required) });
        continue;
      }
      const key = keyOf(el); if (!key || seen.has(key)) continue; seen.add(key);
      const f = { key, label: labelOf(el), type, required: !!el.required || el.getAttribute("aria-required") === "true" };
      if (type === "select") f.options = [...el.options].filter((o) => o.value !== "").map((o) => clean(o.textContent));
      if (f.label) out.push(f);
    }
    return { url: location.href, fields: out, captcha: hasCaptcha() };
  }

  function setValue(el, value) {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  function setChecked(el, on) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked").set.call(el, on);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  function mark(el, text, kind) {
    const target = el.closest("fieldset, .field, label") || el;
    target.style.outline = kind === "yours" ? "3px solid #c25e00" : "2px solid #2f7d32";
    target.style.outlineOffset = "2px";
    if (kind === "yours" && !target.querySelector?.(":scope > .tc-hunter-note")) {
      const n = document.createElement("div"); n.className = "tc-hunter-note"; n.textContent = text;
      n.style.cssText = "color:#c25e00;font:600 13px system-ui,sans-serif;margin:4px 0";
      target.after ? target.after(n) : null;
    }
  }

  /** Types only the approved answers. Returns what was typed; never clicks or submits. */
  function fillForm(plan) {
    const results = [];
    for (const f of plan.fill || []) {
      const el = find(f.key);
      if (!el || el.type === "password") { results.push({ key: f.key, status: "not_found" }); continue; }
      const label = el.type === "radio" ? groupLabel(el) : labelOf(el);
      if (stepFor(label)) { mark(el, "TC Hunter: this one is yours to answer", "yours"); results.push({ key: f.key, status: "left_for_applicant" }); continue; }
      try {
        if (f.file) {
          const bytes = Uint8Array.from(atob(f.file.base64), (c) => c.charCodeAt(0));
          const dt = new DataTransfer(); dt.items.add(new File([bytes], f.file.name, { type: f.file.mime }));
          el.files = dt.files; el.dispatchEvent(new Event("change", { bubbles: true }));
        } else if (el.tagName === "SELECT") {
          const opt = [...el.options].find((o) => clean(o.textContent) === f.value || o.value === f.value);
          if (!opt) { results.push({ key: f.key, status: "no_match" }); continue; }
          setValue(el, opt.value);
        } else if (el.type === "radio") {
          const r = [...document.querySelectorAll(`input[type=radio][name="${esc(el.name)}"]`)].find((x) => labelOf(x) === f.value || x.value === f.value);
          if (!r) { results.push({ key: f.key, status: "no_match" }); continue; }
          setChecked(r, true);
        } else if (el.type === "checkbox") {
          results.push({ key: f.key, status: "left_for_applicant" }); mark(el, "TC Hunter: tick this yourself if it's right", "yours"); continue;
        } else {
          setValue(el, f.value ?? "");
        }
        mark(el, "", "filled");
        results.push({ key: f.key, status: "filled" });
      } catch (_) { results.push({ key: f.key, status: "failed" }); }
    }
    for (const y of plan.yours || []) {
      const el = find(y.key);
      if (el) mark(el, y.step ? "TC Hunter: this one is always yours to answer" : "TC Hunter: please answer this one yourself", "yours");
    }
    return { results, captcha: hasCaptcha() };
  }

  /** A confirmation number exactly as the employer's page shows it, or null. Never made up. */
  function findConfirmation() {
    const re = /\b(?:confirmation|reference|application|submission)\s*(?:number|no\.?|id|#|code)?\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{3,40})\b/gi;
    for (const m of (document.body.innerText || "").matchAll(re)) if (/\d/.test(m[1])) return m[1];
    return null;
  }

  /** A fingerprint of the form exactly as it is filled now (every answer, tick and attached file name). Nothing leaves the page but the hash. */
  async function snapshot() {
    const pairs = [];
    for (const el of document.querySelectorAll("input, select, textarea")) {
      const key = keyOf(el); if (!key || el.type === "password" || el.type === "hidden" || el.type === "submit" || el.type === "button") continue;
      const v = el.type === "checkbox" || el.type === "radio" ? `${el.value}:${el.checked}` : el.type === "file" ? [...(el.files || [])].map((f) => `${f.name}:${f.size}`).join(",") : el.value;
      pairs.push([el.type === "radio" ? `${key}=${el.value}` : key, v]);
    }
    const bytes = new TextEncoder().encode(JSON.stringify(pairs));
    const d = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  window.__tcHunter = { readForm, fillForm, findConfirmation, stepFor, snapshot };
})();
