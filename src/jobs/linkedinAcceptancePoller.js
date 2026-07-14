import { supabase } from '../db/client.js';
import {
  extractProfileSlug,
  checkRelationshipStatus,
  handleConnectionAccepted,
  backfillProfileUrn,
} from '../services/connectSafelyService.js';

const POLL_INTERVAL_MS = Number(process.env.LINKEDIN_POLL_INTERVAL_MINUTES || 30) * 60 * 1000;
const DELAY_BETWEEN_CHECKS_MS = 2000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function pollPendingConnections() {
  const { data: pending, error } = await supabase
    .from('assets')
    .select('id, client_id, account_id, linkedin_dm, accounts (primary_linkedin)')
    .not('linkedin_connection_sent_at', 'is', null)
    .is('linkedin_connection_accepted_at', null);

  if (error) {
    console.error('LinkedIn acceptance poll failed to load pending connections:', error.message);
    return;
  }

  if (!pending || pending.length === 0) {
    return;
  }

  console.log(`Polling ConnectSafely for ${pending.length} pending LinkedIn connection(s)`);

  const clientIds = [...new Set(pending.map((asset) => asset.client_id))];
  const { data: clients, error: clientsError } = await supabase
    .from('clients')
    .select('*')
    .in('id', clientIds);

  if (clientsError) {
    console.error('LinkedIn acceptance poll failed to load clients:', clientsError.message);
    return;
  }

  const clientsById = new Map((clients || []).map((client) => [client.id, client]));

  for (const asset of pending) {
    const profileId = extractProfileSlug(asset.accounts?.primary_linkedin);

    if (!profileId) {
      continue;
    }

    const client = clientsById.get(asset.client_id);

    try {
      const relationship = await checkRelationshipStatus(profileId, client);

      // Backfills the URN for in-flight assets that were sent before this column existed,
      // not just ones connected through the current code.
      await backfillProfileUrn(asset.id, relationship.profileUrn);

      if (relationship.status === 'CONNECTED') {
        await handleConnectionAccepted(asset, asset.accounts || {}, client);
        console.log('LinkedIn connection accepted:', { asset_id: asset.id, profileId });
      }

      if (relationship.rateLimitRemaining === 0) {
        console.warn('ConnectSafely rate limit reached mid-poll, stopping this cycle early');
        break;
      }
    } catch (err) {
      console.error('Failed to check LinkedIn relationship status:', {
        asset_id: asset.id,
        profileId,
        error: err.message,
      });
    }

    await sleep(DELAY_BETWEEN_CHECKS_MS);
  }
}

export function startLinkedInAcceptancePolling() {
  console.log(`Starting LinkedIn acceptance polling every ${POLL_INTERVAL_MS / 60000} minute(s)`);

  pollPendingConnections().catch((err) => {
    console.error('LinkedIn acceptance poll crashed:', err.message);
  });

  setInterval(() => {
    pollPendingConnections().catch((err) => {
      console.error('LinkedIn acceptance poll crashed:', err.message);
    });
  }, POLL_INTERVAL_MS);
}
