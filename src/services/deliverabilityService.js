import { supabase } from '../db/client.js';

const INSTANTLY_API_BASE = 'https://api.instantly.ai/api/v2';

// 2% bounce rate is the industry/bulk-sender-enforcement danger threshold (Google/Yahoo rules).
// Spam-complaint rate (<0.3%, the more critical threshold) can't be computed here at all -
// confirmed against Instantly's live API docs that no complaint/abuse-report field exists on
// this or any other endpoint. That has to stay a manual check outside this system for now.
const BOUNCE_RATE_DANGER_THRESHOLD = 0.02;

function validateCredentials(client) {
  if (!client?.instantly_api_key || !client?.instantly_campaign_id) {
    throw new Error(`Instantly credentials not configured for client ${client?.id || 'unknown'}`);
  }

  return { apiKey: client.instantly_api_key, campaignId: client.instantly_campaign_id };
}

async function fetchCampaignAnalytics(campaignId, apiKey) {
  const res = await fetch(`${INSTANTLY_API_BASE}/campaigns/analytics?ids=${campaignId}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  const responseBody = await res.json().catch(() => null);

  if (!res.ok) {
    const message = responseBody?.message || res.statusText;
    const error = new Error(`Instantly API error (${res.status}): ${message}`);
    error.status = res.status;
    throw error;
  }

  return Array.isArray(responseBody) ? responseBody[0] : responseBody;
}

export function computeBounceRate(snapshot) {
  if (!snapshot || !snapshot.emails_sent_count) {
    return null;
  }

  return snapshot.bounced_count / snapshot.emails_sent_count;
}

export async function checkClientDeliverability(client) {
  const credentials = validateCredentials(client);
  const analytics = await fetchCampaignAnalytics(credentials.campaignId, credentials.apiKey);

  if (!analytics) {
    throw new Error(`No analytics returned for campaign ${credentials.campaignId}`);
  }

  const { data: snapshot, error } = await supabase
    .from('deliverability_snapshots')
    .insert({
      client_id: client.id,
      campaign_id: credentials.campaignId,
      campaign_name: analytics.campaign_name || null,
      emails_sent_count: analytics.emails_sent_count ?? 0,
      bounced_count: analytics.bounced_count ?? 0,
      unsubscribed_count: analytics.unsubscribed_count ?? 0,
      reply_count: analytics.reply_count ?? 0,
      open_count: analytics.open_count ?? 0,
    })
    .select()
    .single();

  if (error) {
    throw error;
  }

  const bounceRate = computeBounceRate(snapshot);

  if (bounceRate !== null && bounceRate > BOUNCE_RATE_DANGER_THRESHOLD) {
    console.warn('Bounce rate exceeded danger threshold:', {
      client_id: client.id,
      campaign_id: credentials.campaignId,
      bounce_rate: bounceRate,
      threshold: BOUNCE_RATE_DANGER_THRESHOLD,
    });
  }

  return snapshot;
}
