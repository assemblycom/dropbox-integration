// Date-math off the live Date.now(). Freeze with useFakeClock() for exact
// values; against real Postgres it tracks real NOW() for SQL-side tests.
const SECOND_MS = 1_000
const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

export function msAgo(n: number): Date {
  return new Date(Date.now() - n)
}

export function secondsAgo(n: number): Date {
  return new Date(Date.now() - n * SECOND_MS)
}

export function minutesAgo(n: number): Date {
  return new Date(Date.now() - n * MINUTE_MS)
}

export function hoursAgo(n: number): Date {
  return new Date(Date.now() - n * HOUR_MS)
}

export function daysAgo(n: number): Date {
  return new Date(Date.now() - n * DAY_MS)
}

export function fromNow(ms: number): Date {
  return new Date(Date.now() + ms)
}
