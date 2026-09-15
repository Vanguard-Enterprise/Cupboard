import { describe, expect, it } from "vitest";
import { countries, regionsForCountry } from "./address-options";

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
});
