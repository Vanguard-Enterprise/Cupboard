import { describe, expect, it } from "vitest";
import {
  countries,
  countryForShortcut,
  regionsForCountry,
} from "./address-options";

describe("address options", () => {
  it("provides country choices and matching subdivisions", () => {
    expect(countries).toContainEqual({ name: "United States", code: "US" });
    expect(regionsForCountry("United States")).toContainEqual({
      name: "California",
      code: "CA",
    });
    expect(regionsForCountry("CA")).toContainEqual({
      name: "Ontario",
      code: "ON",
    });
    expect(regionsForCountry("Canada")).not.toContainEqual({
      name: "California",
      code: "CA",
    });
  });
  it("allows a text field when there is no predefined region list", () => {
    expect(regionsForCountry("")).toEqual([]);
    expect(regionsForCountry("Antarctica")).toEqual([]);
    expect(regionsForCountry("unknown saved country")).toEqual([]);
  });

  it("resolves ISO codes and common abbreviations", () => {
    expect(countryForShortcut("UK")).toBe("United Kingdom");
    expect(countryForShortcut("U.K.")).toBe("United Kingdom");
    expect(countryForShortcut("USA")).toBe("United States");
    expect(countryForShortcut("US")).toBe("United States");
    expect(countryForShortcut("UAE")).toBe("United Arab Emirates");
    expect(countryForShortcut("CA")).toBe("Canada");
    expect(countryForShortcut("United")).toBeUndefined();
  });
});
