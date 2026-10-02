import { countries as flagCodes } from 'country-flag-icons';
import { countryName } from './format';

export interface Country {
  code: string;
  name: string;
}

/** Shown first in pickers: where residential pools are deepest and our users are. */
export const SUGGESTED = ['IN', 'US', 'GB', 'CA', 'AU', 'DE', 'AE', 'SG', 'FR', 'NL', 'JP', 'BR'];

export const COUNTRIES: Country[] = flagCodes
  .filter((code) => /^[A-Z]{2}$/.test(code) && !['EU', 'XA', 'XC', 'XO', 'AC', 'TA', 'IC'].includes(code))
  .map((code) => ({ code, name: countryName(code) }))
  .filter((c) => c.name !== c.code)
  .sort((a, b) => a.name.localeCompare(b.name));

export function findCountry(code: string | undefined): Country | undefined {
  if (!code) return undefined;
  return COUNTRIES.find((c) => c.code === code.toUpperCase());
}
