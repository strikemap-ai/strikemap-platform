import { supabase } from '../db/client.js';
import { logOutreachAction } from './outreachLog.js';

const INSTANTLY_API_BASE = 'https://api.instantly.ai/api/v2';

function isDryRun() {
  return process.env.DRY_RUN === 'true';
}

function validateCredentials(client) {
  if (!client?.instantly_api_key || !client?.instantly_campaign_id) {
    throw new Error(`Instantly credentials not configured for client ${client?.id || 'unknown'}`);
  }

  return { apiKey: client.instantly_api_key, campaignId: client.instantly_campaign_id };
}

function buildLeadPayload(asset, account, campaignId) {
  return {
    campaign: campaignId,
    email: account.primary_email,
    first_name: account.primary_first_name || undefined,
    last_name: account.primary_last_name || undefined,
    company_name: account.company_name || undefined,
    skip_if_in_campaign: true,
    custom_variables: {
      email_subject_1: asset.email_subject_1 || undefined,
      email_body_1: asset.email_step_1 || undefined,
      email_subject_2: asset.email_subject_2 || undefined,
      email_body_2: asset.email_step_2 || undefined,
      email_subject_3: asset.email_subject_3 || undefined,
      email_body_3: asset.email_step_3 || undefined,
    },
  };
}

async function addLeadToCampaign(payload, apiKey) {
  const res = await fetch(`${INSTANTLY_API_BASE}/leads`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const responseBody = await res.json().catch(() => null);

  if (!res.ok) {
    const message = responseBody?.message || res.statusText;
    const error = new Error(`Instantly API error (${res.status}): ${message}`);
    error.status = res.status;
    throw error;
  }

  return responseBody;
}

async function deleteLead(leadId, apiKey) {
  const res = await fetch(`${INSTANTLY_API_BASE}/leads/${leadId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  const responseBody = await res.json().catch(() => null);

  if (!res.ok) {
    const message = responseBody?.message || res.statusText;
    const error = new Error(`Instantly API error (${res.status}): ${message}`);
    error.status = res.status;
    throw error;
  }

  return responseBody;
}

// Instantly has no per-lead "pause" action - the lead's status field is read-only, and the
// only pause endpoints pause an entire campaign, subsequence, or sending account. Removing
// the lead outright is the only way to guarantee no further sequence emails go out to them.
export async function stopInstantlySequence(asset, client) {
  if (!asset.instantly_contact_id) {
    await logOutreachAction({
      client_id: asset.client_id,
      asset_id: asset.id,
      account_id: asset.account_id,
      channel: 'instantly',
      action: 'stop_sequence',
      outcome: 'skipped',
      error_message: 'No Instantly lead associated with this asset',
    });
    return;
  }

  try {
    if (isDryRun()) {
      console.log('[DRY RUN] Would remove Instantly lead from campaign:', {
        asset_id: asset.id,
        endpoint: `DELETE /api/v2/leads/${asset.instantly_contact_id}`,
      });

      await logOutreachAction({
        client_id: asset.client_id,
        asset_id: asset.id,
        account_id: asset.account_id,
        channel: 'instantly',
        action: 'stop_sequence',
        outcome: 'dry_run',
      });

      return;
    }

    const credentials = validateCredentials(client);
    await deleteLead(asset.instantly_contact_id, credentials.apiKey);

    await logOutreachAction({
      client_id: asset.client_id,
      asset_id: asset.id,
      account_id: asset.account_id,
      channel: 'instantly',
      action: 'stop_sequence',
      outcome: 'success',
    });
  } catch (err) {
    console.error('Failed to remove Instantly lead from campaign:', {
      asset_id: asset.id,
      lead_id: asset.instantly_contact_id,
      error: err.message,
    });

    await logOutreachAction({
      client_id: asset.client_id,
      asset_id: asset.id,
      account_id: asset.account_id,
      channel: 'instantly',
      action: 'stop_sequence',
      outcome: 'error',
      error_message: err.message,
    });
  }
}

export async function runInstantlyChannel(asset, account, client) {
  try {
    if (!account.primary_email) {
      throw new Error('Cannot enroll Instantly lead without an email address');
    }

    const payload = buildLeadPayload(asset, account, client?.instantly_campaign_id);

    if (isDryRun()) {
      console.log('[DRY RUN] Would enroll Instantly lead:', {
        asset_id: asset.id,
        endpoint: 'POST /api/v2/leads',
        payload,
      });

      await logOutreachAction({
        client_id: asset.client_id,
        asset_id: asset.id,
        account_id: asset.account_id,
        channel: 'instantly',
        action: 'enroll',
        outcome: 'dry_run',
      });

      return;
    }

    const credentials = validateCredentials(client);
    const result = await addLeadToCampaign(payload, credentials.apiKey);

    if (result?.id) {
      await supabase.from('assets').update({ instantly_contact_id: result.id }).eq('id', asset.id);
    }

    await logOutreachAction({
      client_id: asset.client_id,
      asset_id: asset.id,
      account_id: asset.account_id,
      channel: 'instantly',
      action: 'enroll',
      outcome: 'success',
    });
  } catch (err) {
    console.error('Instantly enrollment failed:', {
      asset_id: asset.id,
      error: err.message,
    });

    await logOutreachAction({
      client_id: asset.client_id,
      asset_id: asset.id,
      account_id: asset.account_id,
      channel: 'instantly',
      action: 'enroll',
      outcome: 'error',
      error_message: err.message,
    });
  }
}
