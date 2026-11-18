import { describe, expect, it } from "vitest";
import { countryCode, countryFit, descriptionCountries, outsideCountries, placeCountries, scanCountries, searchQueries } from "../src";

const fit = (locationRaw: string | null, workplaceType: string | null = null, descriptionText = "") => countryFit({ locationRaw, workplaceType, descriptionText }, ["US"]);

describe("countries in goals (Yong, 2026-11-18)", () => {
  it("reads country names and codes", () => {
    expect(countryCode("United States")).toBe("US");
    expect(countryCode("usa")).toBe("US");
    expect(countryCode("UK")).toBe("GB");
    expect(countryCode("canada")).toBe("CA");
    expect(countryCode("Narnia")).toBeNull();
  });

  it("reads the country of a posting's place", () => {
    expect(placeCountries("Raleigh, NC").countries).toEqual(["US"]);
    expect(placeCountries("Raleigh NC 27601").countries).toEqual(["US"]);
    expect(placeCountries("US-NC-Durham").countries).toEqual(["US"]);
    expect(placeCountries("San Francisco, California").countries).toEqual(["US"]);
    expect(placeCountries("Toronto, ON").countries).toEqual(["CA"]);
    expect(placeCountries("Toronto, Ontario, Canada").countries).toEqual(["CA"]);
    expect(placeCountries("IND - Bangalore").countries).toEqual(["IN"]);
    expect(placeCountries("London, United Kingdom").countries).toEqual(["GB"]);
    expect(placeCountries("Remote - Latin America").countries).toEqual([]);
    expect(placeCountries("Springfield").countries).toEqual([]);
  });

  it("keeps jobs in a chosen country and rules out jobs clearly elsewhere", () => {
    expect(fit("Charlotte, NC").verdict).toBe("in");
    expect(fit("New York, NY; London, UK").verdict).toBe("in");
    expect(fit("Toronto, ON", "onsite").verdict).toBe("out");
    expect(fit("Bengaluru, India").verdict).toBe("out");
    expect(fit("Springfield").verdict).toBe("unknown");
    expect(fit(null).verdict).toBe("unknown");
    expect(countryFit({ locationRaw: "Toronto, ON", workplaceType: null }, []).verdict).toBe("any");
  });

  it("treats remote jobs as in the country only when the posting says so or names no country", () => {
    expect(fit("Remote - US", "remote").verdict).toBe("in");
    expect(fit("Remote (USA)", "remote").verdict).toBe("in");
    expect(fit("Remote (Americas)", "remote").verdict).toBe("in");
    expect(fit("Remote (Worldwide)", "remote").verdict).toBe("in");
    expect(fit("Remote - Canada", "remote").verdict).toBe("out");
    expect(fit("Remote (Europe)", "remote").verdict).toBe("out");
    expect(fit("Remote - LATAM", "remote").verdict).toBe("out");
    expect(fit("Remote", "remote").verdict).toBe("in");
    expect(fit("Remote", "remote", "You must be based in Canada to apply.").verdict).toBe("out");
    expect(fit("Remote", "remote", "Candidates must reside in the U.S.").verdict).toBe("in");
  });

  it("reads where a description says the work must be done from", () => {
    expect(descriptionCountries("This role is remote within the United States and Canada.")).toEqual(["US", "CA"]);
    expect(descriptionCountries("We work from home on Fridays.")).toEqual([]);
  });

  it("filters a scan only when every goal in use names countries", () => {
    expect(scanCountries([{ countries: ["US"] }, { countries: ["CA"] }])).toEqual(["US", "CA"]);
    expect(scanCountries([{ countries: ["US"] }, { countries: [] }])).toEqual([]);
    expect(outsideCountries({ locationRaw: "Paris, France", workplaceType: null }, ["US"])).toBe(true);
    expect(outsideCountries({ locationRaw: "Paris, France", workplaceType: null }, [])).toBe(false);
    expect(outsideCountries({ locationRaw: "Somewhere", workplaceType: null }, ["US"])).toBe(false);
  });

  it("searches each place in the goal's countries", () => {
    const base = { roles: ["Director"], occupation: null, workplaceTypes: [] as string[] };
    expect(searchQueries([{ ...base, locations: ["NC"], countries: ["US"] }])).toEqual([{ what: "Director", where: "NC", remote: false, country: "US" }]);
    expect(searchQueries([{ ...base, locations: [], countries: ["US", "CA"] }]).map((q) => q.country)).toEqual(["US", "CA"]);
    // A place that names its own country is searched there.
    expect(searchQueries([{ ...base, locations: ["Toronto"], countries: ["US", "CA"] }]).map((q) => q.country)).toEqual(["CA"]);
  });
});
