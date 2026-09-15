import { allCountries } from "country-region-data";

export const countries = allCountries.map(([name, code]) => ({ name, code }));

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
