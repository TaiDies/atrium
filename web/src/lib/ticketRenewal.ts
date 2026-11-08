/** Why the app wants a fresh live-editing ticket. */
export type RenewReason = 'timer' | 'focus' | 'online' | 'refused';

/**
 * How long since the last renewal before each reason asks for another: the hourly timer always does;
 * coming back to the window does once the ticket is half an hour old (it lasts 4 hours, and a computer
 * that slept past that comes back with an expired one); getting back online after a minute; and a live
 * connection being refused after 15 seconds, so a server that refuses for another reason isn't asked
 * over and over.
 */
const MIN_GAP_MS: Record<RenewReason, number> = { timer: 0, focus: 30 * 60_000, online: 60_000, refused: 15_000 };

export function shouldRenewTicket(reason: RenewReason, lastRenewedAt: number, now: number): boolean {
  return now - lastRenewedAt >= MIN_GAP_MS[reason];
}
