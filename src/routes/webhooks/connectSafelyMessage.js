import { Router } from 'express';
import crypto from 'crypto';
import { supabase } from '../../db/client.js';
import { markAssetReplied } from '../../services/replyHandling.js';

const router = Router();

// ConnectSafely's docs describe HMAC signing, but the actual webhook-creation UI only offers
// Bearer Token / API Key / Basic Auth / No Authentication - no signature option. Using Bearer
// Token: configure the webhook in their dashboard with this exact secret as the bearer value.
function isAuthorized(req) {
  const secret = process.env.CONNECTSAFELY_WEBHOOK_SECRET;

  if (!secret) {
    return false;
  }

  const header = req.get('Authorization') || '';
  const expected = `Bearer ${secret}`;

  const a = Buffer.from(header);
  const b = Buffer.from(expected);

  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

router.post('/', async (req, res) => {
  if (!isAuthorized(req)) {
    // Header names only, never values - helps diagnose a real first delivery without logging secrets.
    console.warn('Rejected unauthorized ConnectSafely webhook request:', {
      headerNames: Object.keys(req.headers),
    });
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const event = req.body;
  const senderUrn = event?.data?.sender?.id;

  try {
    if (event?.event !== 'message.received') {
      return res.status(200).json({ status: 'ignored' });
    }

    if (!senderUrn) {
      return res.status(400).json({ error: 'Missing data.sender.id in payload' });
    }

    const { data: asset, error } = await supabase
      .from('assets')
      .select('id, client_id, account_id, hubspot_deal_id')
      .eq('connectsafely_profile_urn', senderUrn)
      .eq('sequence_status', 'approved')
      .is('replied_at', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      throw error;
    }

    if (!asset) {
      console.warn('No matching asset for ConnectSafely message.received:', { senderUrn });
      return res.status(200).json({ status: 'no_matching_asset' });
    }

    await markAssetReplied(asset, 'linkedin');

    return res.status(200).json({ status: 'recorded', asset_id: asset.id });
  } catch (err) {
    console.error('Error handling ConnectSafely message.received webhook:', {
      senderUrn,
      error: err.message,
      stack: err.stack,
    });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
