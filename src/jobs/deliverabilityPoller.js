import { supabase } from '../db/client.js';
import { checkClientDeliverability } from '../services/deliverabilityService.js';

const POLL_INTERVAL_MS = Number(process.env.DELIVERABILITY_POLL_INTERVAL_MINUTES || 60) * 60 * 1000;
const DELAY_BETWEEN_CLIENTS_MS = 2000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function checkAllClientsDeliverability() {
  // Only clients with a real Instantly campaign configured - skips Pallet gracefully, same
  // pattern as every other per-client integration in this codebase.
  const { data: clients, error } = await supabase
    .from('clients')
    .select('*')
    .not('instantly_api_key', 'is', null)
    .not('instantly_campaign_id', 'is', null);

  if (error) {
    console.error('Deliverability poll failed to load clients:', error.message);
    return;
  }

  if (!clients || clients.length === 0) {
    return;
  }

  console.log(`Checking deliverability for ${clients.length} client(s)`);

  for (const client of clients) {
    try {
      const snapshot = await checkClientDeliverability(client);
      console.log('Deliverability snapshot recorded:', {
        client_id: client.id,
        campaign_id: snapshot.campaign_id,
        emails_sent_count: snapshot.emails_sent_count,
        bounced_count: snapshot.bounced_count,
      });
    } catch (err) {
      console.error('Deliverability check failed for client:', {
        client_id: client.id,
        error: err.message,
      });
    }

    await sleep(DELAY_BETWEEN_CLIENTS_MS);
  }
}

export function startDeliverabilityPolling() {
  console.log(`Starting deliverability polling every ${POLL_INTERVAL_MS / 60000} minute(s)`);

  checkAllClientsDeliverability().catch((err) => {
    console.error('Deliverability poll crashed:', err.message);
  });

  setInterval(() => {
    checkAllClientsDeliverability().catch((err) => {
      console.error('Deliverability poll crashed:', err.message);
    });
  }, POLL_INTERVAL_MS);
}
