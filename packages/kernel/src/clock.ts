/** Time source port. Domain code never calls `Date.now()` directly so tests stay deterministic. */
export interface ClockPort {
  now(): Date;
}

export const systemClock: ClockPort = { now: () => new Date() };

export function fixedClock(at: Date): ClockPort {
  const ms = at.getTime();
  return { now: () => new Date(ms) };
}
