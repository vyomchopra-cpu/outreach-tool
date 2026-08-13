/**
 * Self-service, time-boxed console access. Before this, adding a second
 * admin meant editing ADMIN_ALLOWLIST (shared/Config.gs) and redeploying —
 * a code change for what should be a two-click decision made by whoever is
 * already trusted with the console.
 *
 * ADMIN_ALLOWLIST stays as the permanent list (people who should always have
 * access, code-reviewed like everything else in shared/Config.gs).
 * AccessGrants is the temporary list: an admin can grant someone N days of
 * the exact same access, tracked, visibly expiring, and revocable in one
 * click. isAuthorizedAdmin_ (admin/Code.gs) checks both AccessGrants and
 * ADMIN_ALLOWLIST.
 *
 * Scope check, because these two are easy to conflate: everything in this
 * file is about who may OPERATE the console. Who may have mail sent under
 * their name is a completely separate question with a completely separate
 * mechanism — admin/Delegation.gs, decided by the delegator themselves — and
 * no function here can affect it.
 *
 * A grant is full admin access for its duration — it can build and launch
 * campaigns, not just view the dashboard. There is no read-only tier yet;
 * that is the honest limit of this v1, stated rather than implied.
 */

function isAccessGrantValid_(email) {
  const row = findRow_('AccessGrants', email);
  if (!row) return false;
  if (row.revoked === true || row.revoked === 'true') return false;
  if (!row.expires_at) return false;
  return new Date(row.expires_at) > new Date();
}

/**
 * Console access only — permission to OPERATE this tool. Nothing here grants
 * permission to send as anyone: that is never an admin's to give, and lives
 * entirely in admin/Delegation.gs + the delegator's own approval page.
 *
 * An admin vouching for a colleague to use an internal tool is a normal
 * admin action and needs no approval chain. An admin deciding whose name
 * outgoing mail carries is not, and has none.
 */
function grantAccess(email, days, note) {
  const actor = requireAdmin_();
  const clean = String(email || '').toLowerCase().trim();
  if (!isValidEmail_(clean)) throw new Error('Not a valid email: ' + email);
  if (!clean.endsWith('@' + REPLY_TO_DOMAIN)) throw new Error('This console is internal-only — ' + clean + ' is not a @' + REPLY_TO_DOMAIN + ' address');

  const n = Math.floor(Number(days));
  if (!isFinite(n) || n < 1 || n > 365) throw new Error('Days must be a whole number between 1 and 365');

  const expiresAt = new Date(Date.now() + n * 24 * 60 * 60 * 1000);
  upsertRow_('AccessGrants', {
    email: clean,
    display_name: clean.split('@')[0],
    granted_by: actor,
    granted_at: new Date(),
    expires_at: expiresAt,
    revoked: false,
    note: note || '',
  });
  logEvent_(actor, 'admin_action', { detail: { action: 'grant_access', email: clean, days: n } });
  return { email: clean, expiresAt: expiresAt.toISOString() };
}

/** Immediate — the next request from that email fails auth, no waiting for expiry. */
function revokeAccess(email) {
  const admin = requireAdmin_();
  const clean = String(email || '').toLowerCase().trim();
  updateRow_('AccessGrants', clean, { revoked: true });
  logEvent_(admin, 'admin_action', { detail: { action: 'revoke_access', email: clean } });
}

/**
 * There is deliberately no setSenderExpiry here any more.
 *
 * It used to let an admin type in how many days someone else's name could be
 * used, which inverted the entire premise of the tool: the person lending
 * their identity is the only one entitled to decide for how long. That number
 * is now set exactly once, by them, on their own approval page
 * (agent/Approve.gs → gateway/AgentApi.gs approveDelegation), and extending it
 * means asking them again rather than editing a field here.
 *
 * The operator side keeps only revokeDelegation (admin/Delegation.gs), which
 * can shorten access but never lengthen it. That asymmetry is the guarantee.
 */

/** The dashboard + track view — every grant ever issued, current status, who issued it. */
function listAccessGrants() {
  requireAdmin_();
  const now = new Date();
  return readRows_('AccessGrants').map(function (r) {
    const expired = !r.expires_at || new Date(r.expires_at) <= now;
    const revoked = r.revoked === true || r.revoked === 'true';
    return {
      email: r.email,
      grantedBy: r.granted_by,
      grantedAt: r.granted_at,
      expiresAt: r.expires_at,
      note: r.note || '',
      status: revoked ? 'revoked' : (expired ? 'expired' : 'active'),
      daysLeft: (!revoked && !expired) ? Math.ceil((new Date(r.expires_at) - now) / 86400000) : 0,
    };
  }).sort(function (a, b) { return a.status === 'active' && b.status !== 'active' ? -1 : 1; });
}
