/*
 * TC Hunter's one click (design 5.5, Phase 5). Injected only after the applicant has
 * approved sending this exact filled form in TC Hunter, and only on Greenhouse, Lever,
 * Ashby or SmartRecruiters. It checks the form is still exactly as approved, then presses
 * that system's Submit button once. It never clicks anything else, and never twice.
 */
(() => {
  if (window.__tcHunterSubmit) return;
  let clicked = false;

  function buttonFor(selector) {
    return [...document.querySelectorAll(selector)].find((b) => !b.disabled && b.offsetParent !== null && b.closest("form")) || null;
  }

  /** Checks only, before the single-use key is spent: same filled form, and the Submit button is there. */
  async function canClick(selector, approvedHash) {
    if (!window.__tcHunter) return { ok: false, why: "not_ready" };
    if ((await window.__tcHunter.snapshot()) !== approvedHash) return { ok: false, why: "changed" };
    return buttonFor(selector) ? { ok: true } : { ok: false, why: "no_button" };
  }

  async function clickOnce(selector, approvedHash) {
    if (clicked) return { clicked: false, why: "already" };
    if (!window.__tcHunter) return { clicked: false, why: "not_ready" };
    if ((await window.__tcHunter.snapshot()) !== approvedHash) return { clicked: false, why: "changed" };
    const btn = buttonFor(selector);
    if (!btn) return { clicked: false, why: "no_button" };
    clicked = true;
    btn.click();
    return { clicked: true };
  }

  /** The page now, for TC Hunter's rules to read. Only sent to TC Hunter, never kept. */
  function pageNow() {
    return { url: location.href, text: (document.body?.innerText || "").slice(0, 20000) };
  }

  window.__tcHunterSubmit = { canClick, clickOnce, pageNow };
})();
