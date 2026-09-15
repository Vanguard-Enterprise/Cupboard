import { allCountries } from "country-region-data";

export const countries = allCountries.map(([name, code]) => ({ name, code }));

const countryByCode = new Map(
  countries.map(({ name, code }) => [code.toLocaleLowerCase(), name]),
);

const countryAliases = new Map([
  ["usa", "United States"],
  ["uk", "United Kingdom"],
  ["gb", "United Kingdom"],
  ["gbr", "United Kingdom"],
  ["uae", "United Arab Emirates"],
]);

function normalizeCountryQuery(value: string) {
  return value.toLocaleLowerCase().replaceAll(".", "").trim();
}

export function countryForShortcut(query: string) {
  const normalizedQuery = normalizeCountryQuery(query);
  return (
    countryAliases.get(normalizedQuery) ?? countryByCode.get(normalizedQuery)
  );
}

export function regionsForCountry(country: string) {
  const match = allCountries.find(
    ([name, code]) => name === country || code === country,
  );
  if (
    match?.[2].length === 1 &&
    match[2][0][0] === match[0] &&
    match[2][0][1] === match[1]
  )
    return [];
  return (match?.[2] ?? []).map(([name, code]) => ({ name, code }));
}
