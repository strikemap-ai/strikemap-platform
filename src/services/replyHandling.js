import { supabase } from '../db/client.js';
import { logOutreachAction } from './outreachLog.js';
import { moveDealToStage } from './hubspotService.js';

export async function markAssetReplied(asset, channel, client) {
  await supabase
    .from('assets')
    .update({
      sequence_status: 'replied',
      replied_at: new Date().toISOString(),
      reply_channel: channel,
    })
    .eq('id', asset.id);

  await logOutreachAction({
    client_id: asset.client_id,
    asset_id: asset.id,
    account_id: asset.account_id,
    channel,
    action: 'reply',
    outcome: 'success',
  });

  await moveDealToStage(asset, client, 'Replied');
}
