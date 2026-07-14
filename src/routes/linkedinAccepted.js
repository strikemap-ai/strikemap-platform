import { Router } from 'express';
import { supabase } from '../db/client.js';
import { handleConnectionAccepted } from '../services/connectSafelyService.js';

const router = Router();

// Manual/internal trigger. ConnectSafely has no "connection accepted" webhook event yet
// (only message.received) - acceptance is normally detected by the poller in
// src/jobs/linkedinAcceptancePoller.js. This stays available for manual use now and can
// become the real webhook receiver once ConnectSafely ships that event.
router.post('/', async (req, res) => {
  const { asset_id, linkedin_url } = req.body;

  try {
    let assetId = asset_id;

    if (!assetId) {
      if (!linkedin_url) {
        return res.status(400).json({ error: 'asset_id or linkedin_url is required' });
      }

      const { data: account, error: accountError } = await supabase
        .from('accounts')
        .select('id')
        .eq('primary_linkedin', linkedin_url)
        .maybeSingle();

      if (accountError) {
        throw accountError;
      }

      if (!account) {
        return res.status(404).json({ error: 'No account found for that LinkedIn URL' });
      }

      const { data: pendingAsset, error: assetLookupError } = await supabase
        .from('assets')
        .select('id')
        .eq('account_id', account.id)
        .not('linkedin_connection_sent_at', 'is', null)
        .is('linkedin_connection_accepted_at', null)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (assetLookupError) {
        throw assetLookupError;
      }

      if (!pendingAsset) {
        return res.status(404).json({ error: 'No pending LinkedIn connection found for that URL' });
      }

      assetId = pendingAsset.id;
    }

    const { data: existing, error: fetchError } = await supabase
      .from('assets')
      .select('id, client_id, account_id, linkedin_dm, accounts (primary_linkedin), clients (*)')
      .eq('id', assetId)
      .single();

    if (fetchError || !existing) {
      return res.status(404).json({ error: 'Asset not found' });
    }

    await handleConnectionAccepted(existing, existing.accounts || {}, existing.clients);

    return res.status(200).json({ status: 'recorded', asset_id: existing.id });
  } catch (err) {
    console.error('Error recording LinkedIn connection acceptance:', {
      error: err.message,
      stack: err.stack,
    });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
