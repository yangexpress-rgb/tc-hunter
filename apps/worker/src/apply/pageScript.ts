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
  // A drop-down's own words before a choice ("Select One Required"), not its question (Premier's Application Questions).
  var NOT_A_LABEL = /^(select one|choose one|select|choose|please select|select\.\.\.)\s*(required)?\s*\*?$/i;
  function ok(t) { return !!t && !NOT_A_LABEL.test(t); }
  function labelOf(el) {
    // A Workday list button names itself by its chosen value: "No Required" is the answer, not the question.
    var own = clean(el.tagName === "BUTTON" ? el.textContent : el.value);
    function okFor(t) {
      if (!ok(t)) return false;
      if (!own) return true;
      var rest = t.indexOf(own) === 0 ? t.slice(own.length).trim() : null;
      return rest === null || !/^(required)?\s*\*?$/i.test(rest);
    }
    var by = el.getAttribute("aria-labelledby");
    if (by) { var t = textOf(by, el); if (okFor(t)) return t; }
    if (el.id) { var l = rootOf(el).querySelector('label[for="' + esc(el.id) + '"]'); if (l && ok(clean(l.textContent))) return clean(l.textContent); }
    var wrap = el.closest("label"); if (wrap && ok(clean(wrap.textContent))) return clean(wrap.textContent);
    if (okFor(clean(el.getAttribute("aria-label")))) return clean(el.getAttribute("aria-label"));
    // Workday: the question's own label sits in the same form field box.
    var box = el.closest("[data-automation-id^='formField'], .field, .application-question, .form-group");
    if (box) { var lb = box.querySelector("legend, [data-automation-id='formLabel'], label"); if (lb && ok(clean(lb.textContent))) return clean(lb.textContent); }
    if (el.placeholder) return clean(el.placeholder);
    return clean(el.name || el.id || el.getAttribute("data-automation-id"));
  }
  // A radio button's own words, as the driver reads them: its label first. Pinpoint also names each button by a
  // hidden "question + yes" text, which isn't the choice's own word.
  function radioText(el) {
    var l = (el.id && rootOf(el).querySelector('label[for="' + esc(el.id) + '"]')) || el.closest("label");
    return l && clean(l.textContent) ? clean(l.textContent) : labelOf(el);
  }
  function groupLabel(el) {
    // Pinpoint: the question's label sits above its Yes / No buttons, in the same box.
    var pq = el.closest(".pad-v-3"); var pl = pq && pq.querySelector(".external-form__label");
    if (pl && clean(pl.textContent)) return clean(pl.textContent);
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
  // A file box's own label is often just its button ("Attach", "Upload"); the question
  // ("Resume/CV *") is the box's heading (newer Greenhouse boards, Lever, Ashby).
  var GENERIC = /^(attach|upload|choose( a)? files?|browse|select( a)? files?|add( a)? files?|drop( your)? files? here|attach,? ?dropbox.*|or drag and drop.*|enter manually)$/i;
  function fileLabel(el) {
    var own = labelOf(el);
    if (own && !GENERIC.test(own) && own !== clean(el.name || el.id)) return own;
    var grp = el.closest("[role=group]");
    if (grp) {
      var by = grp.getAttribute("aria-labelledby"); if (by && textOf(by, grp)) return textOf(by, grp);
      if (grp.getAttribute("aria-label")) return clean(grp.getAttribute("aria-label"));
    }
    for (var box = el.parentElement, depth = 0; box && depth < 5; box = box.parentElement, depth++) {
      var heads = box.querySelectorAll(".label, .upload-label, [class*='label' i], legend, label, h3, h4");
      for (var i = 0; i < heads.length; i++) {
        var t = clean(heads[i].textContent);
        if (t && !GENERIC.test(t) && t.length <= 120) return t;
      }
    }
    return own;
  }
  function keyOf(el) {
    if (el.id) return "#" + el.id;
    if (el.name) return el.type === "radio" ? "radio:" + el.name : "name:" + el.name;
    var da = el.getAttribute("data-automation-id"); if (da) return "wd:" + da;
    return null;
  }
  function isRequired(el, label) {
    return !!el.required || el.getAttribute("aria-required") === "true" || /\*\s*$/.test(label) || /\(required\)/i.test(label) || markedRequired(el);
  }
  // A question whose label the site marks required by its look, not by a "*" in the words (Pinpoint's
  // "external-form__label--required", Align Technology 2026-11-26): the question's own label says so.
  function markedRequired(el) {
    function marks(l) { return !!l && (/(^|[-_\s])label--required\b/.test(String(l.className || "")) || !!l.querySelector("[class*='label--required']")); }
    if (el.id && el.type !== "radio" && marks(rootOf(el).querySelector('label[for="' + esc(el.id) + '"]'))) return true;
    // The question's heading in the box around it (its file box, its Yes / No, its drawn drop-down), the nearest box with one.
    for (var box = el.parentElement, depth = 0; box && depth < 6; box = box.parentElement, depth++) {
      var heads = box.querySelectorAll(".external-form__label");
      if (heads.length > 1) return false;
      if (heads.length === 1 && !heads[0].contains(el)) return marks(heads[0]);
    }
    return false;
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

  /** A Workday search list: a text box that opens a list of choices (prompt or multiselect). */
  function isWorkdayList(el) {
    if (el.getAttribute("data-automation-id") === "searchBox" || el.getAttribute("data-uxi-widget-type") === "selectinput") return true;
    if (el.closest("[data-automation-id='multiSelectContainer'], [data-automation-id='multiselectInputContainer'], [data-uxi-widget-type='multiselect'], [data-uxi-widget-type='selectinput']")) return true;
    return !!el.closest("[data-automation-id^='formField']") && /^search$/i.test(el.placeholder || "");
  }

  /**
   * The chosen item a site-drawn drop-down (React Select) shows beside its typing box. It sits beside the
   * box, not inside it: on Greenhouse's job-boards forms the box is wrapped in "select__input-container",
   * whose name also says "container", so looking only in the nearest "container" never found the choice
   * and every picked answer read as empty (GitLab, 2026-11-19). Looks outward from the box, a few levels,
   * stopping before a level that holds another question's box.
   */
  var CHOSEN = "[class*='single-value' i], [class*='singleValue' i], [class*='multi-value__label' i]";
  function listChoice(el) {
    for (var box = el.parentElement, depth = 0; box && depth < 5; box = box.parentElement, depth++) {
      var boxes = box.querySelectorAll("input[role=combobox], select, textarea");
      if (boxes.length > 1) break;
      var picked = box.querySelectorAll(CHOSEN);
      if (picked.length) return Array.prototype.map.call(picked, function (x) { return clean(x.textContent); }).filter(Boolean).join(", ");
    }
    return "";
  }

  /** The form's questions, in page order. */
  function readForm() {
    var out = [], seen = {};
    var els = deepAll("input, select, textarea, button[aria-haspopup='listbox']");
    for (var i = 0; i < els.length; i++) {
      var el = els[i], tag = el.tagName.toLowerCase();
      var role = el.getAttribute("role");
      var wdList = tag === "input" && isWorkdayList(el);
      var type = tag === "select" || tag === "button" || role === "combobox" || wdList ? "select" : tag === "textarea" ? "textarea" : (el.type || "text").toLowerCase();
      if (type === "password" || !TYPES[type] || !visible(el)) continue;
      if (type === "radio") {
        if (!el.name) continue;
        var k = "radio:" + el.name; if (seen[k]) continue; seen[k] = 1;
        var radios = deepAll('input[type=radio][name="' + esc(el.name) + '"]', rootOf(el));
        var gl = groupLabel(el);
        out.push({ key: k, label: gl, type: type, options: radios.map(radioText), required: radios.some(function (r) { return r.required; }) || /\*\s*$/.test(gl) || markedRequired(el),
          hasValue: radios.some(function (r) { return r.checked; }) });
        continue;
      }
      var key = keyOf(el); if (!key || seen[key]) continue; seen[key] = 1;
      var label = type === "file" ? fileLabel(el) : labelOf(el);
      // One choice of a tick-all-that-apply question ("Full-Time"), or one part of a date ("Month"): say which question.
      var qbox = el.closest("[data-automation-id^='formField'], fieldset");
      if (qbox && (type === "checkbox" && qbox.querySelectorAll("input[type=checkbox]").length > 1 || /^(month|day|year)$/i.test(label))) {
        var ql = qbox.querySelector("legend, [data-automation-id='formLabel'], label:not([for])");
        var qt = ql ? clean(ql.textContent) : "";
        qt = qt.replace(/\s*\*\s*$/, "");
        if (qt && qt !== label && ok(qt)) label = qt + ": " + label;
      }
      var f = { key: key, label: label, type: type, required: isRequired(el, label), hasValue: false };
      var ml = (tag === "textarea" || tag === "input") ? Number(el.getAttribute("maxlength")) : 0;
      if (ml > 0) f.maxLength = ml;
      if (tag === "select") {
        f.options = Array.prototype.filter.call(el.options, function (o) { return o.value !== ""; }).map(function (o) { return clean(o.textContent); });
        f.hasValue = el.value !== "";
      } else if (tag === "button") {
        var shown = clean(el.textContent);
        f.hasValue = !!shown && !/^select( one)?$|^choose/i.test(shown);
      } else if (type === "checkbox") f.hasValue = el.checked;
      else if (type === "file") f.hasValue = fileHeld(el);
      else if (wdList) {
        // Workday's search lists ("How Did You Hear About Us?", "Country Phone Code") show the chosen item beside the box.
        var fb = el.closest("[data-automation-id^='formField']") || el.parentElement;
        f.hasValue = !!(fb && fb.querySelector("[data-automation-id='selectedItem'], [data-automation-id='selectedItemList'] li"));
      }
      else if (role === "combobox") {
        // Site-drawn drop-downs show the chosen value next to the box, not in it.
        f.hasValue = !!clean(el.value) || !!listChoice(el);
      }
      else f.hasValue = !!clean(el.value);
      if (f.label) out.push(f);
    }
    return { url: location.href, fields: out, captcha: captchaVisible() };
  }

  /**
   * Whether a file box holds a file. Upload boxes that send the file straight to the site's storage
   * (Pinpoint's, Align Technology 2026-11-26) can empty the box once it's sent and keep the file as a hidden
   * value under the same name, or show the file's name where "Attach" was.
   */
  function fileHeld(el) {
    if (!el) return false;
    if (el.files && el.files.length) return true;
    if (el.name && deepAll('input[type=hidden][name="' + esc(el.name) + '"]', rootOf(el)).some(function (h) { return !!h.value && h.value !== "0"; })) return true;
    var box = el.parentElement;
    return !!(box && /\.(pdf|docx?|rtf|odt|txt)\b/i.test(clean(box.textContent)));
  }
  function fileHeldByKey(key) { return fileHeld(byKey(key)); }

  /** The element a key names (as keyOf made it). */
  function byKey(key) {
    var v = key.slice(key.indexOf(key.charAt(0) === "#" ? "#" : ":") + 1);
    if (key.charAt(0) === "#") return deepAll('[id="' + esc(v) + '"]')[0] || null;
    if (key.indexOf("radio:") === 0) return deepAll('input[type=radio][name="' + esc(v) + '"]')[0] || null;
    if (key.indexOf("name:") === 0) return deepAll('[name="' + esc(v) + '"]')[0] || null;
    if (key.indexOf("wd:") === 0) return deepAll('[data-automation-id="' + esc(v) + '"]')[0] || null;
    return null;
  }

  /** What a person sees as the answer to a question now: the chosen item's words, the box's text, "" when empty. */
  function shown(key) {
    var el = byKey(key); if (!el) return null;
    var tag = el.tagName.toLowerCase();
    if (key.indexOf("radio:") === 0) {
      var on = deepAll('input[type=radio][name="' + esc(el.name) + '"]', rootOf(el)).filter(function (r) { return r.checked; })[0];
      return on ? (radioText(on) || on.value || "") : "";
    }
    if (tag === "select") {
      if (el.multiple) return Array.prototype.map.call(el.selectedOptions, function (o) { return clean(o.textContent); }).join(", ");
      var o = el.selectedOptions && el.selectedOptions[0];
      return o && o.value !== "" ? clean(o.textContent) : "";
    }
    if (el.type === "checkbox") return el.checked ? "checked" : "";
    if (tag === "button") { var t = clean(el.textContent); return /^select( one)?$|^choose|^-+$/i.test(t) ? "" : t; }
    if (tag === "input" && isWorkdayList(el)) {
      var fb = el.closest("[data-automation-id^='formField']") || el.parentElement;
      return fb ? Array.prototype.map.call(fb.querySelectorAll("[data-automation-id='selectedItem'], [data-automation-id='selectedItemList'] li"), function (x) { return clean(x.textContent); }).join(", ") : "";
    }
    if (el.getAttribute("role") === "combobox") return listChoice(el) || clean(el.value);
    return clean(el.value);
  }

  /** The questions the site marks as wrong or missing now (aria-invalid, or an error message in the question's own box). */
  function flagged() {
    var out = {};
    deepAll("input, select, textarea, button[aria-haspopup='listbox']").forEach(function (el) {
      if (!visible(el) && el.type !== "radio") return;
      var bad = el.getAttribute("aria-invalid") === "true";
      if (!bad) {
        var box = el.closest("[data-automation-id^='formField'], fieldset, .form-group, .field, [class*='question' i]");
        bad = !!(box && box.querySelector("[data-automation-id='errorMessage'], [data-automation-id='inputAlert'], .error-message, .field-error, .invalid-feedback, [role=alert]"));
      }
      var k = bad && (el.type === "radio" && el.name ? "radio:" + el.name : keyOf(el)); if (k) out[k] = 1;
    });
    return Object.keys(out).slice(0, 40);
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

  /** What a page shows when Next neither moved on nor showed an error: pop-ups, flagged fields, error parts, buttons, and the top of its text (digits and emails masked). */
  function stuck() {
    function vis(e) { var r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; }
    function txt(e) { return clean(e.innerText || e.textContent); }
    function mask(x) { return String(x).replace(/[^\s@]+@[^\s@]+/g, "[email]").replace(/\d/g, "#"); }
    var dialog = deepAll("[role=dialog], [role=alertdialog], [data-automation-id*='popup' i], [data-automation-id*='modal' i]").filter(vis).map(txt).filter(Boolean).join(" / ");
    var invalid = deepAll("[aria-invalid=true]").filter(vis).map(function (e) { var f = e.closest("[data-automation-id^='formField']"); return (f && f.getAttribute("data-automation-id")) || e.getAttribute("aria-label") || e.id || ""; }).filter(Boolean);
    var parts = deepAll("[data-automation-id*='error' i], [data-automation-id*='alert' i], [data-automation-id*='warning' i]").filter(vis).map(function (e) { return e.getAttribute("data-automation-id") + ": " + txt(e).slice(0, 120); });
    var buttons = deepAll("button").filter(vis).map(function (e) { return (e.getAttribute("data-automation-id") || "") + "=" + txt(e).slice(0, 30); }).slice(0, 20);
    var main = document.querySelector("main, [role=main]") || document.body;
    return { dialog: mask(dialog).slice(0, 400), invalid: invalid.join(" | "), errors: mask(parts.join(" | ")).slice(0, 600), buttons: mask(buttons.join(" | ")), text: mask(txt(main)).slice(0, 500) };
  }

  window.__tcApply = { isWorkdayList: isWorkdayList, shown: shown, flagged: flagged, readForm: readForm, errors: errors, snapshot: snapshot, captchaVisible: captchaVisible, stuck: stuck, fileHeld: fileHeldByKey };
})();
`;
