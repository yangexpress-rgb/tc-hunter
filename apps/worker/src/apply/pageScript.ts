/**
 * Runs inside the employer's page in TC Hunter's own browser. Kept as plain text so
 * nothing from the build step leaks into the page. It only reads: the questions, their
 * labels, whether they already have a value, error messages shown, and whether a
 * "you're a person" check is on screen. Typing and the single Submit press are done by
 * the driver (browser.ts) through the browser itself, like a person would.
 *
 * It looks inside open shadow roots too (SmartRecruiters' form is built from them), and
 * reads Workday's own drop-downs (buttons that open a list) as choices.
 */
export const PAGE_SCRIPT = String.raw`
(() => {
  if (window.__tcApply) return;
  var TYPES = { text: 1, email: 1, tel: 1, url: 1, number: 1, date: 1, textarea: 1, select: 1, radio: 1, checkbox: 1, file: 1 };
  function clean(s) { return String(s || "").replace(/\s+/g, " ").trim(); }
  function esc(s) { return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/["\\]/g, "\\$&"); }

  // Every element matching, in page order, including inside open shadow roots.
  function deepAll(selector, root) {
    var out = [];
    (function walk(r) {
      var found = r.querySelectorAll(selector);
      for (var i = 0; i < found.length; i++) out.push(found[i]);
      var all = r.querySelectorAll("*");
      for (var j = 0; j < all.length; j++) if (all[j].shadowRoot) walk(all[j].shadowRoot);
    })(root || document);
    return out;
  }
  function rootOf(el) { var r = el.getRootNode(); return r && r.querySelector ? r : document; }
  function byId(el, id) { var r = rootOf(el); return (r.getElementById ? r.getElementById(id) : r.querySelector("#" + esc(id))) || document.getElementById(id); }

  function visible(el) {
    if (el.type === "hidden" || el.disabled) return false;
    if (el.type === "file") return true;
    var r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    return cs.display !== "none" && cs.visibility !== "hidden" && (r.width > 0 || r.height > 0);
  }
  function textOf(ids, el) {
    return clean(ids.split(/\s+/).map(function (id) { var n = byId(el, id); return n ? n.textContent : ""; }).join(" "));
  }
  function labelOf(el) {
    var by = el.getAttribute("aria-labelledby");
    if (by) { var t = textOf(by, el); if (t) return t; }
    if (el.id) { var l = rootOf(el).querySelector('label[for="' + esc(el.id) + '"]'); if (l && clean(l.textContent)) return clean(l.textContent); }
    var wrap = el.closest("label"); if (wrap && clean(wrap.textContent)) return clean(wrap.textContent);
    if (el.getAttribute("aria-label")) return clean(el.getAttribute("aria-label"));
    // Workday: the question's own label sits in the same form field box.
    var box = el.closest("[data-automation-id^='formField'], .field, .application-question, .form-group");
    if (box) { var lb = box.querySelector("label, legend, [data-automation-id='formLabel']"); if (lb && clean(lb.textContent)) return clean(lb.textContent); }
    if (el.placeholder) return clean(el.placeholder);
    return clean(el.name || el.id || el.getAttribute("data-automation-id"));
  }
  function groupLabel(el) {
    var fs = el.closest("fieldset"); var lg = fs && fs.querySelector("legend");
    if (lg && clean(lg.textContent)) return clean(lg.textContent);
    var grp = el.closest("[role=radiogroup],[role=group]");
    if (grp) {
      var by = grp.getAttribute("aria-labelledby"); if (by && textOf(by, grp)) return textOf(by, grp);
      if (grp.getAttribute("aria-label")) return clean(grp.getAttribute("aria-label"));
    }
    var box = el.closest("[data-automation-id^='formField'], .field, .application-question, .form-group");
    if (box) { var lb = box.querySelector("legend, label:not([for]), [data-automation-id='formLabel']"); if (lb && clean(lb.textContent)) return clean(lb.textContent); }
    return labelOf(el);
  }
  function keyOf(el) {
    if (el.id) return "#" + el.id;
    if (el.name) return el.type === "radio" ? "radio:" + el.name : "name:" + el.name;
    var da = el.getAttribute("data-automation-id"); if (da) return "wd:" + da;
    return null;
  }
  function isRequired(el, label) {
    return !!el.required || el.getAttribute("aria-required") === "true" || /\*\s*$/.test(label) || /\(required\)/i.test(label);
  }

  function captchaVisible() {
    var frames = deepAll("iframe");
    for (var i = 0; i < frames.length; i++) {
      var f = frames[i], src = f.src || "";
      if (!/recaptcha|hcaptcha|turnstile|challenges\.cloudflare|captcha|arkoselabs|funcaptcha/i.test(src)) continue;
      if (/size=invisible/.test(src) || f.closest(".grecaptcha-badge")) continue;
      var r = f.getBoundingClientRect(), cs = getComputedStyle(f);
      if (cs.visibility === "hidden" || cs.display === "none" || r.width < 30 || r.height < 30) continue;
      return true;
    }
    return false;
  }

  /** The form's questions, in page order. */
  function readForm() {
    var out = [], seen = {};
    var els = deepAll("input, select, textarea, button[aria-haspopup='listbox']");
    for (var i = 0; i < els.length; i++) {
      var el = els[i], tag = el.tagName.toLowerCase();
      var role = el.getAttribute("role");
      var type = tag === "select" || tag === "button" || role === "combobox" ? "select" : tag === "textarea" ? "textarea" : (el.type || "text").toLowerCase();
      if (type === "password" || !TYPES[type] || !visible(el)) continue;
      if (type === "radio") {
        if (!el.name) continue;
        var k = "radio:" + el.name; if (seen[k]) continue; seen[k] = 1;
        var radios = deepAll('input[type=radio][name="' + esc(el.name) + '"]', rootOf(el));
        var gl = groupLabel(el);
        out.push({ key: k, label: gl, type: type, options: radios.map(labelOf), required: radios.some(function (r) { return r.required; }) || /\*\s*$/.test(gl),
          hasValue: radios.some(function (r) { return r.checked; }) });
        continue;
      }
      var key = keyOf(el); if (!key || seen[key]) continue; seen[key] = 1;
      var label = type === "checkbox" ? labelOf(el) : labelOf(el);
      var f = { key: key, label: label, type: type, required: isRequired(el, label), hasValue: false };
      if (tag === "select") {
        f.options = Array.prototype.filter.call(el.options, function (o) { return o.value !== ""; }).map(function (o) { return clean(o.textContent); });
        f.hasValue = el.value !== "";
      } else if (tag === "button") {
        var shown = clean(el.textContent);
        f.hasValue = !!shown && !/^select( one)?$|^choose/i.test(shown);
      } else if (type === "checkbox") f.hasValue = el.checked;
      else if (type === "file") f.hasValue = !!(el.files && el.files.length);
      else f.hasValue = !!clean(el.value);
      if (f.label) out.push(f);
    }
    return { url: location.href, fields: out, captcha: captchaVisible() };
  }

  /** Error messages the page shows now (a field the site says is missing or wrong). */
  function errors() {
    var sel = "[role=alert], .error, .error-message, .field-error, .invalid-feedback, [data-automation-id='errorMessage'], [data-automation-id='inputAlert'], [class*='error' i][id*='error' i]";
    var seen = {}, out = [];
    deepAll(sel).forEach(function (e) {
      var t = clean(e.textContent);
      if (!t || t.length > 200 || seen[t]) return;
      var r = e.getBoundingClientRect(); if (r.width === 0 && r.height === 0) return;
      seen[t] = 1; out.push(t);
    });
    return out.slice(0, 10);
  }

  /** A fingerprint of the form exactly as it is filled now: every value, tick and attached file name. */
  function snapshot() {
    var pairs = [];
    deepAll("input, select, textarea").forEach(function (el) {
      var key = keyOf(el);
      if (!key || el.type === "password" || el.type === "hidden" || el.type === "submit" || el.type === "button") return;
      var v = el.type === "checkbox" || el.type === "radio" ? el.value + ":" + el.checked
        : el.type === "file" ? Array.prototype.map.call(el.files || [], function (f) { return f.name + ":" + f.size; }).join(",") : el.value;
      pairs.push([el.type === "radio" ? key + "=" + el.value : key, v]);
    });
    deepAll("button[aria-haspopup='listbox']").forEach(function (el) { var k = keyOf(el); if (k) pairs.push([k, clean(el.textContent)]); });
    return JSON.stringify(pairs);
  }

  window.__tcApply = { readForm: readForm, errors: errors, snapshot: snapshot, captchaVisible: captchaVisible };
})();
`;
