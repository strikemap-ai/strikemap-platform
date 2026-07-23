import { supabase } from '../db/client.js';
import { getInstantlyLeadStatus, INSTANTLY_EMAIL_TERMINAL_STATUSES } from '../services/instantlyService.js';
import { resolveDeliveryContact } from '../services/deliveryContact.js';

const POLL_INTERVAL_MS = Number(process.env.SEQUENCE_COMPLETION_POLL_INTERVAL_MINUTES || 60) * 60 * 1000;
const DELAY_BETWEEN_CHECKS_MS = 2000;
const LINKEDIN_ACCEPTANCE_TIMEOUT_DAYS = 30;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function daysSince(isoString) {
  return (Date.now() - new Date(isoString).getTime()) / (1000 * 60 * 60 * 24);
}

async function isEmailChannelDone(asset) {
  if (asset.replied_at) {
    return true;
  }

  if (!asset.instantly_contact_id) {
    // Either never had an email to enroll with, or enrollment permanently failed - either way
    // nothing more is going to send on this channel, so it shouldn't block the seat forever.
    return true;
  }

  const client = asset.clients;
  const { found, status } = await getInstantlyLeadStatus(asset.instantly_contact_id, client);

  if (!found) {
    return true;
  }

  return INSTANTLY_EMAIL_TERMINAL_STATUSES.includes(status);
}

function isLinkedinChannelDone(asset, targetContact) {
  if (!targetContact.primary_linkedin) {
    return true;
  }

  if (asset.linkedin_dm_sent_at) {
    return true;
  }

  if (
    asset.linkedin_connection_sent_at &&
    !asset.linkedin_connection_accepted_at &&
    daysSince(asset.linkedin_connection_sent_at) >= LINKEDIN_ACCEPTANCE_TIMEOUT_DAYS
  ) {
    return true;
  }

  return false;
}

export async function pollSequenceCompletion() {
  const { data: pending, error } = await supabase
    .from('assets')
    .select(
      `
      id, client_id, account_id, contact_ref, replied_at, instantly_contact_id,
      linkedin_dm_sent_at, linkedin_connection_sent_at, linkedin_connection_accepted_at,
      accounts ( primary_linkedin, additional_contacts ),
      clients ( id, instantly_api_key, instantly_campaign_id )
    `
    )
    .eq('sequence_status', 'approved')
    .is('slot_freed_at', null);

  if (error) {
    console.error('Sequence completion poll failed to load pending assets:', error.message);
    return;
  }

  if (!pending || pending.length === 0) {
    return;
  }

  console.log(`Checking sequence completion for ${pending.length} active asset(s)`);

  for (const asset of pending) {
    try {
      const account = asset.accounts || {};
      const targetContact = resolveDeliveryContact(account, asset.contact_ref);

      const emailDone = await isEmailChannelDone(asset);
      const linkedinDone = isLinkedinChannelDone(asset, targetContact);

      if (emailDone && linkedinDone) {
        await supabase
          .from('assets')
          .update({ slot_freed_at: new Date().toISOString(), slot_freed_reason: 'sequence_complete' })
          .eq('id', asset.id);

        console.log('Sequence complete, seat freed:', { asset_id: asset.id, account_id: asset.account_id });
      }
    } catch (err) {
      console.error('Failed to check sequence completion:', {
        asset_id: asset.id,
        error: err.message,
      });
    }

    await sleep(DELAY_BETWEEN_CHECKS_MS);
  }
}

export function startSequenceCompletionPolling() {
  console.log(`Starting sequence completion polling every ${POLL_INTERVAL_MS / 60000} minute(s)`);

  pollSequenceCompletion().catch((err) => {
    console.error('Sequence completion poll crashed:', err.message);
  });

  setInterval(() => {
    pollSequenceCompletion().catch((err) => {
      console.error('Sequence completion poll crashed:', err.message);
    });
  }, POLL_INTERVAL_MS);
}
