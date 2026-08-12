/**
 * Self-service, time-boxed console access. Before this, adding a second
 * admin meant editing ADMIN_ALLOWLIST (shared/Config.gs) and redeploying —
 * a code change for what should be a two-click decision made by whoever is
 * already trusted with the console.
 *
 * ADMIN_ALLOWLIST stays as the permanent list (people who should always have
 * access, code-reviewed like everything else in shared/Config.gs).
 * AccessGrants is the temporary list: anyone already on the console can grant
 * someone else N days of the exact same access, tracked, visibly expiring,
 * and revocable in one click. isAuthorizedAdmin_ (admin/Code.gs) checks both.
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
 * Grants `days` of console access to `email`. Restricted to REPLY_TO_DOMAIN —
 * this console is an internal moveinsync.com tool, and the domain check
 * elsewhere in the codebase (isAuthorizedAdmin_ itself) would reject an
 * external address anyway; failing here gives a clear reason instead of a
 * silent no-op grant nobody can use.
 */
function grantAccess(email, days, note) {
  const admin = requireAdmin_();
  const clean = String(email || '').toLowerCase().trim();
  if (!isValidEmail_(clean)) throw new Error('Not a valid email: ' + email);
  if (!clean.endsWith('@' + REPLY_TO_DOMAIN)) throw new Error('This console is internal-only — ' + clean + ' is not a @' + REPLY_TO_DOMAIN + ' address');

  const n = Math.floor(Number(days));
  if (!isFinite(n) || n < 1 || n > 365) throw new Error('Days must be a whole number between 1 and 365');

  const expiresAt = new Date(Date.now() + n * 24 * 60 * 60 * 1000);
  upsertRow_('AccessGrants', {
    email: clean,
    display_name: clean.split('@')[0],
    granted_by: admin,
    granted_at: new Date(),
    expires_at: expiresAt,
    revoked: false,
    note: note || '',
  });
  logEvent_(admin, 'admin_action', { detail: { action: 'grant_access', email: clean, days: n } });
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
 * Time-boxed SENDING capability — distinct from console access above. A
 * sender authorizes their own agent exactly once (a real Google OAuth
 * consent screen — no way around that, and no reason to want one, since it's
 * the whole reason this architecture never holds anyone's credentials). What
 * this controls is how many days an admin allows that authorization to keep
 * actually sending; gateway/AgentApi.gs's pollDueJobs and heartbeat check it
 * on every poll, not just at registration.
 *
 * days === '' clears the expiry (permanent — today's default for every
 * existing sender). A positive integer sets/extends it from NOW, not from
 * whatever the previous expiry was — calling this twice with 7 gives 7 more
 * days from the moment of the second call, not 14 from the first.
 */
function setSenderExpiry(email, days) {
  const admin = requireAdmin_();
  const clean = String(email || '').toLowerCase().trim();
  const sender = findRow_('Senders', clean);
  if (!sender) throw new Error('No such sender: ' + email + ' — they need to onboard first');

  if (days === '' || days === null || days === undefined) {
    updateRow_('Senders', clean, { sends_expire_at: '' });
    logEvent_(admin, 'admin_action', { senderEmail: clean, detail: { action: 'sender_expiry_cleared' } });
    return { email: clean, expiresAt: null };
  }

  const n = Math.floor(Number(days));
  if (!isFinite(n) || n < 1 || n > 365) throw new Error('Days must be a whole number between 1 and 365, or blank for permanent');
  const expiresAt = new Date(Date.now() + n * 24 * 60 * 60 * 1000);
  updateRow_('Senders', clean, { sends_expire_at: expiresAt });
  logEvent_(admin, 'admin_action', { senderEmail: clean, detail: { action: 'sender_expiry_set', days: n } });
  return { email: clean, expiresAt: expiresAt.toISOString() };
}

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
