import { supabase } from '../db/client.js';
import { logOutreachAction } from './outreachLog.js';

const CONNECTSAFELY_API_BASE = 'https://api.connectsafely.ai/linkedin';

function isDryRun() {
  return process.env.DRY_RUN === 'true';
}

function validateCredentials(client) {
  if (!client?.connectsafely_api_key || !client?.connectsafely_account_id) {
    throw new Error(`ConnectSafely credentials not configured for client ${client?.id || 'unknown'}`);
  }

  return { apiKey: client.connectsafely_api_key, accountId: client.connectsafely_account_id };
}

// /connect and /relationship/{accountId}/{profileId} both take the LinkedIn vanity slug, not the full URL.
export function extractProfileSlug(linkedinUrl) {
  const match = linkedinUrl?.match(/linkedin\.com\/in\/([^/?]+)/i);
  return match ? match[1] : null;
}

async function sendConnectionRequest(payload, credentials) {
  const res = await fetch(`${CONNECTSAFELY_API_BASE}/connect`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${credentials.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const responseBody = await res.json().catch(() => null);

  if (!res.ok) {
    const message = responseBody?.error || res.statusText;
    const error = new Error(`ConnectSafely API error (${res.status}): ${message}`);
    error.status = res.status;
    // "Already connected" / "Connection request already sent" come back as 400s with this set.
    error.existingStatus = responseBody?.status;
    throw error;
  }

  return responseBody;
}

// The X-RateLimit-* headers ConnectSafely documents are attached to POST /connect (the
// action that consumes the 90/week quota) - empirically this GET does not return them, but
// we still read defensively in case that changes.
export async function checkRelationshipStatus(profileId, client) {
  const credentials = validateCredentials(client);

  const res = await fetch(
    `${CONNECTSAFELY_API_BASE}/relationship/${credentials.accountId}/${encodeURIComponent(profileId)}`,
    { headers: { Authorization: `Bearer ${credentials.apiKey}` } }
  );

  const rateLimitRemaining = res.headers.get('x-ratelimit-remaining');
  const body = await res.json().catch(() => null);

  if (!res.ok) {
    const message = body?.error || res.statusText;
    const error = new Error(`ConnectSafely API error (${res.status}): ${message}`);
    error.status = res.status;
    throw error;
  }

  return { ...body, rateLimitRemaining: rateLimitRemaining !== null ? Number(rateLimitRemaining) : null };
}

export async function backfillProfileUrn(assetId, profileUrn) {
  if (!profileUrn) {
    return;
  }

  await supabase.from('assets').update({ connectsafely_profile_urn: profileUrn }).eq('id', assetId);
}

export async function recordConnectionAccepted(asset) {
  await supabase
    .from('assets')
    .update({ linkedin_connection_accepted_at: new Date().toISOString() })
    .eq('id', asset.id);

  await logOutreachAction({
    client_id: asset.client_id,
    asset_id: asset.id,
    account_id: asset.account_id,
    channel: 'connectsafely',
    action: 'accepted',
    outcome: 'success',
  });
}

async function sendConversationMessage(payload, credentials) {
  const res = await fetch(`${CONNECTSAFELY_API_BASE}/conversations/send`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${credentials.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const responseBody = await res.json().catch(() => null);

  if (!res.ok) {
    const message = responseBody?.error || res.statusText;
    const error = new Error(`ConnectSafely API error (${res.status}): ${message}`);
    error.status = res.status;
    throw error;
  }

  return responseBody;
}

export async function runConnectSafelyDmChannel(asset, account, client) {
  try {
    const profileId = extractProfileSlug(account.primary_linkedin);

    if (!profileId) {
      throw new Error('Cannot send LinkedIn DM without a valid LinkedIn profile URL');
    }

    if (!asset.linkedin_dm) {
      throw new Error('Cannot send LinkedIn DM without approved DM text');
    }

    const payload = {
      accountId: client?.connectsafely_account_id,
      recipientProfileId: profileId,
      message: asset.linkedin_dm,
      messagingChannel: 'auto',
    };

    if (isDryRun()) {
      console.log('[DRY RUN] Would send ConnectSafely LinkedIn DM:', {
        asset_id: asset.id,
        endpoint: 'POST /linkedin/conversations/send',
        payload,
      });

      await logOutreachAction({
        client_id: asset.client_id,
        asset_id: asset.id,
        account_id: asset.account_id,
        channel: 'connectsafely',
        action: 'dm',
        outcome: 'dry_run',
      });

      return;
    }

    const credentials = validateCredentials(client);
    await sendConversationMessage(payload, credentials);

    await supabase
      .from('assets')
      .update({ linkedin_dm_sent_at: new Date().toISOString() })
      .eq('id', asset.id);

    await logOutreachAction({
      client_id: asset.client_id,
      asset_id: asset.id,
      account_id: asset.account_id,
      channel: 'connectsafely',
      action: 'dm',
      outcome: 'success',
    });
  } catch (err) {
    console.error('ConnectSafely LinkedIn DM send failed:', {
      asset_id: asset.id,
      error: err.message,
    });

    await logOutreachAction({
      client_id: asset.client_id,
      asset_id: asset.id,
      account_id: asset.account_id,
      channel: 'connectsafely',
      action: 'dm',
      outcome: 'error',
      error_message: err.message,
    });
  }
}

export async function handleConnectionAccepted(asset, account, client) {
  await recordConnectionAccepted(asset);
  await runConnectSafelyDmChannel(asset, account, client);
}

export async function runConnectSafelyChannel(asset, account, client) {
  try {
    const profileId = extractProfileSlug(account.primary_linkedin);

    if (!profileId) {
      throw new Error('Cannot send LinkedIn connection request without a valid LinkedIn profile URL');
    }

    if (!asset.linkedin_request) {
      throw new Error('Cannot send LinkedIn connection request without approved request text');
    }

    const payload = {
      accountId: client?.connectsafely_account_id,
      profileId,
      customMessage: asset.linkedin_request,
    };

    if (isDryRun()) {
      console.log('[DRY RUN] Would send ConnectSafely connection request:', {
        asset_id: asset.id,
        endpoint: 'POST /linkedin/connect',
        payload,
      });

      await logOutreachAction({
        client_id: asset.client_id,
        asset_id: asset.id,
        account_id: asset.account_id,
        channel: 'connectsafely',
        action: 'connect',
        outcome: 'dry_run',
      });

      return;
    }

    const credentials = validateCredentials(client);

    try {
      const result = await sendConnectionRequest(payload, credentials);

      await supabase
        .from('assets')
        .update({
          linkedin_connection_sent_at: new Date().toISOString(),
          connectsafely_profile_urn: result?.profileUrn || null,
        })
        .eq('id', asset.id);

      await logOutreachAction({
        client_id: asset.client_id,
        asset_id: asset.id,
        account_id: asset.account_id,
        channel: 'connectsafely',
        action: 'connect',
        outcome: 'success',
      });
    } catch (err) {
      if (err.existingStatus === 'CONNECTED' || err.existingStatus === 'PENDING') {
        await supabase
          .from('assets')
          .update({ linkedin_connection_sent_at: new Date().toISOString() })
          .eq('id', asset.id);

        await logOutreachAction({
          client_id: asset.client_id,
          asset_id: asset.id,
          account_id: asset.account_id,
          channel: 'connectsafely',
          action: 'connect',
          outcome: 'skipped',
          error_message: err.message,
        });
        return;
      }

      throw err;
    }
  } catch (err) {
    console.error('ConnectSafely connection request failed:', {
      asset_id: asset.id,
      error: err.message,
    });

    await logOutreachAction({
      client_id: asset.client_id,
      asset_id: asset.id,
      account_id: asset.account_id,
      channel: 'connectsafely',
      action: 'connect',
      outcome: 'error',
      error_message: err.message,
    });
  }
}
