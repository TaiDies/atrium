/**
 * Who may accept an invitation. Anyone can make an account with any address, so with email set up an
 * invitation only goes to someone who has confirmed the address with an emailed code ('confirm').
 * Servers without email can't check: members may join, but joining as an owner needs the administrator
 * to have confirmed the address (Admin panel → Accounts) — 'admin'. null: nothing stands in the way.
 */
export function invitationBlock({ mail, verified, role }: { mail: boolean; verified: boolean; role: string | null }): 'confirm' | 'admin' | null {
  if (verified) return null;
  if (mail) return 'confirm';
  return role === 'owner' ? 'admin' : null;
}
