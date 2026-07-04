import { Router } from 'express';
import { supabase } from '../db/client.js';
import { logOutreachAction } from '../services/outreachLog.js';

const router = Router();

router.post('/:assetId', async (req, res) => {
  const { assetId } = req.params;
  const { reason } = req.body;

  try {
    const { data: existing, error: fetchError } = await supabase
      .from('assets')
      .select('id, client_id, account_id')
      .eq('id', assetId)
      .single();

    if (fetchError || !existing) {
      return res.status(404).json({ error: 'Asset not found' });
    }

    const updates = {
      sequence_status: 'rejected',
      rejected_at: new Date().toISOString(),
    };

    if (reason !== undefined) {
      updates.rejection_reason = reason;
    }

    const { data: asset, error: updateError } = await supabase
      .from('assets')
      .update(updates)
      .eq('id', assetId)
      .select()
      .single();

    if (updateError) {
      throw updateError;
    }

    await logOutreachAction({
      client_id: existing.client_id,
      asset_id: existing.id,
      account_id: existing.account_id,
      channel: 'dashboard',
      action: 'reject',
      outcome: 'success',
    });

    return res.status(200).json({ asset });
  } catch (err) {
    console.error('Error rejecting asset:', {
      asset_id: assetId,
      error: err.message,
      stack: err.stack,
    });

    await logOutreachAction({
      asset_id: assetId,
      channel: 'dashboard',
      action: 'reject',
      outcome: 'error',
      error_message: err.message,
    });

    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
