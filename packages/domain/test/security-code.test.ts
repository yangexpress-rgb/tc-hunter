import { describe, expect, it } from "vitest";
import { pickSecurityCode, securityCodeAsked, securityCodeIn, securityCodeLength } from "../src";

/** Greenhouse's emailed security code (Yong, 2026-11-17). */
describe("emailed security codes", () => {
  const page = "A verification code was sent to yong@example.test. Enter the 8-character code to confirm you're a human.\nSecurity code";

  it("knows when a page waits for one, and how long it is", () => {
    expect(securityCodeAsked(page)).toBe(true);
    expect(securityCodeLength(page)).toBe(8);
    expect(securityCodeAsked("Thank you for applying!")).toBe(false);
  });

  it("finds the code in the email, never a plain word", () => {
    expect(securityCodeIn("Security\nCopy and paste this code into the security code field on your application:\n\nk7QmP2xZ\n\nThanks, Greenhouse", 8)).toBe("k7QmP2xZ");
    expect(securityCodeIn("<p>Your security code is: <strong>R4ND0MXY</strong></p>", 8)).toBe("R4ND0MXY");
    expect(securityCodeIn("Security\nGreenhouse\nApplying\n", 8)).toBeNull();
  });

  it("takes only Greenhouse's own mail, preferring the one that names the employer", () => {
    const mails = [
      { from: "Greenhouse <no-reply@us.greenhouse-mail.io>", text: "Security code for your application to Acme\n\nAAAA1111" },
      { from: "Greenhouse <no-reply@us.greenhouse-mail.io>", text: "Security code for your application to Dollar Shave Club\n\nk7QmP2xZ" },
      { from: "Someone <x@phish.example>", text: "Dollar Shave Club code\n\nZZZZ9999" },
    ];
    expect(pickSecurityCode(mails, "Dollar Shave Club", 8)).toBe("k7QmP2xZ");
    expect(pickSecurityCode(mails.slice(2), "Dollar Shave Club", 8)).toBeNull();
  });
});
