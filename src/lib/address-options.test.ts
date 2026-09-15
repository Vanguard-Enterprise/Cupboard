import { describe, expect, it } from "vitest";
import {
  countries,
  countryMatchesQuery,
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

  it("matches country names, ISO codes, and common abbreviations", () => {
    expect(countryMatchesQuery("United Kingdom", "United")).toBe(true);
    expect(countryMatchesQuery("United Kingdom", "UK")).toBe(true);
    expect(countryMatchesQuery("United Kingdom", "U.K.")).toBe(true);
    expect(countryMatchesQuery("United States", "USA")).toBe(true);
    expect(countryMatchesQuery("United States", "US")).toBe(true);
    expect(countryMatchesQuery("United Arab Emirates", "UAE")).toBe(true);
    expect(countryMatchesQuery("Canada", "CA")).toBe(true);
    expect(countryMatchesQuery("Cambodia", "CA")).toBe(false);
    expect(countryMatchesQuery("United States", "UK")).toBe(false);
  });
});
