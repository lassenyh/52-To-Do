/**
 * Centralized "current" date for the app. In development, can be overridden
 * via ?devDate=YYYY-MM-DD or localStorage "dev:dateOverride" (same format).
 * In production, overrides are ignored.
 */

const DEV_DATE_OVERRIDE_KEY = "dev:dateOverride";

function parseDateOverride(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [, y, m, d] = match;
  const year = parseInt(y!, 10);
  const month = parseInt(m!, 10) - 1;
  const day = parseInt(d!, 10);
  if (month < 0 || month > 11 || day < 1 || day > 31) return null;
  const date = new Date(year, month, day);
  if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) {
    return null;
  }
  return date;
}

function getDevOverride(): string | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  const fromQuery = params.get("devDate");
  if (fromQuery) return fromQuery;
  try {
    return window.localStorage.getItem(DEV_DATE_OVERRIDE_KEY);
  } catch {
    return null;
  }
}

/**
 * Returns the current date. In development only, respects devDate query param
 * or localStorage "dev:dateOverride" (YYYY-MM-DD). In production always
 * returns the real current date.
 */
export function getNow(): Date {
  if (import.meta.env.PROD) {
    return new Date();
  }
  const override = getDevOverride();
  if (!override) return new Date();
  const parsed = parseDateOverride(override);
  return parsed ?? new Date();
}

/**
 * Development only. Set the date override to Jan 1 of the next calendar year
 * and return that date string (YYYY-MM-DD).
 */
export function setDevDateToNextYear(): string {
  if (import.meta.env.PROD) return "";
  const real = new Date();
  const nextYear = real.getFullYear() + 1;
  const value = `${nextYear}-01-01`;
  try {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(DEV_DATE_OVERRIDE_KEY, value);
    }
  } catch {
    // ignore
  }
  return value;
}

/**
 * Development only. Clear the localStorage date override (query param still
 * applies until page is navigated without it).
 */
export function clearDevDateOverride(): void {
  if (import.meta.env.PROD) return;
  try {
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(DEV_DATE_OVERRIDE_KEY);
    }
  } catch {
    // ignore
  }
}

export const __DEV_DATE_OVERRIDE_KEY = DEV_DATE_OVERRIDE_KEY;
