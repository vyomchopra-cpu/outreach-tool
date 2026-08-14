/**
 * A real send, to any address, with any content — not a canned script.
 *
 * The previous "test" was a fixed message to your own mailbox, which proved
 * that Apps Script could send mail and almost nothing else. It could not
 * answer the questions people actually have before a launch: does MY html
 * survive Gmail, does it look right on a phone, what does it look like
 * arriving from THIS person.
 *
 * Implemented by creating a throwaway campaign rather than a separate send
 * path, deliberately. It means a test exercises the identical render, merge,
 * MIME and transport code a live campaign uses — if a test send looks right,
 * that is evidence about the real thing. A parallel "simpler" path would
 * mostly prove that the parallel path works.
 */

const TEST_CAMPAIGN_STATUS = 'test';

/**
 * Queues one message. The agent picks it up on its next poll (about a
 * minute), so this returns immediately rather than blocking on delivery —
 * the send genuinely has not happened yet when this returns, and the UI says
 * so rather than implying otherwise.
 */
function sendTestEmail(senderEmail, toEmail, subject, html) {
  const admin = requireAdmin_();

  const sender = String(senderEmail || '').toLowerCase().trim();
  const to = String(toEmail || '').toLowerCase().trim();
  if (!isValidEmail_(to)) throw new Error('Not a valid recipient address: ' + toEmail);
  if (!String(subject || '').trim()) throw new Error('Give it a subject');
  if (!String(html || '').trim()) throw new Error('The body is empty');

  const senderRow = findRow_('Senders', sender);
  if (!senderRow) throw new Error('No such sender: ' + sender);
  if (senderRow.status !== 'active') throw new Error(sender + ' is not active (' + senderRow.status + ')');
  if (senderRow.sends_expire_at && new Date(senderRow.sends_expire_at) <= new Date()) {
    throw new Error(sender + "'s sending window has expired — ask them to approve a new one");
  }

  // Checked here as well as at poll time. A test send is still a real email
  // arriving in someone's inbox, and "it was only a test" is not a defence
  // anyone owed an unsubscribe would accept.
  if (isSuppressed_(to)) throw new Error(to + ' is on the suppression list and cannot be emailed');

  if (Utilities.newBlob(html).getBytes().length > MAX_HTML_BYTES) {
    throw new Error('Body is over ' + Math.round(MAX_HTML_BYTES / 1024) + 'KB — Gmail would clip it');
  }

  const runTag = Utilities.getUuid().split('-')[0];
  const campaignId = 'test_' + runTag;

  // status 'test' keeps these out of the campaign list, preflight, and every
  // health metric — they are not outreach and must not be counted as it.
  appendRow_('Campaigns', {
    id: campaignId,
    name: 'Test send to ' + to,
    status: TEST_CAMPAIGN_STATUS,
    subject: subject,
    preheader: '',
    body_source: html,
    sender_pool: sender,
    tz_mode: 'sender',
    send_window: '',
    interval_minutes: '',
    created_by: admin,
    created_at: new Date(),
    exec_approved_by: '',
    exec_approved_at: '',
    seed_passed_at: '',
    canary_released_at: '',
    projected_completion: '',
  });

  appendRow_('Queue', {
    id: campaignId + '-0',
    campaign_id: campaignId,
    recipient_id: 'test:' + to,
    sender_email: sender,
    due_at_utc: new Date(),
    status: 'pending',
    attempts: 0,
    idempotency_key: campaignId + '-0',
    sent_message_id: '',
    sent_at: '',
    error: '',
  });

  logEvent_(admin, 'admin_action', {
    campaignId: campaignId, senderEmail: sender,
    detail: { action: 'test_send', to: to, subject: subject },
  });

  return { campaignId: campaignId, queueId: campaignId + '-0', to: to, sender: sender };
}

/** Poll target for the UI, so an operator watches it land instead of guessing whether it worked. */
function getTestSendStatus(queueId) {
  requireAdmin_();
  const q = findRow_('Queue', queueId);
  if (!q) throw new Error('No such test send: ' + queueId);
  return {
    status: q.status,
    attempts: q.attempts,
    error: q.error || null,
    sentAt: q.sent_at || null,
  };
}

/**
 * Merge tags are supported in a test send, and resolve against the same
 * placeholder recipient a seed uses — so {{firstName}} renders as "Sam"
 * rather than failing. Surfaced to the UI so the operator knows which tags
 * are available instead of discovering it by getting a hard merge failure.
 */
function testSendMergeSample() {
  requireAdmin_();
  return {
    firstName: 'Sam', lastName: 'Prospect',
    company: 'Example Corp', title: 'VP Engineering',
    note: 'A test send resolves merge tags against these values. '
      + '{{unsubscribe}} resolves to the sending account\'s own +unsub address.',
  };
}
