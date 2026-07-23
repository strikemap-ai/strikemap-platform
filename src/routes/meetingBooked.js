import { Router } from 'express';
import { supabase } from '../db/client.js';
import { logOutreachAction } from '../services/outreachLog.js';
import { stopInstantlySequence } from '../services/instantlyService.js';
import { requireAuth, getUserAccess } from '../middleware/requireAuth.js';

const router = Router();

router.use(requireAuth);

router.post('/:assetId', async (req, res) => {
  const { assetId } = req.params;

  try {
    const { data: existing, error: fetchError } = await supabase
      .from('assets')
      .select(
        `
        id, client_id, account_id, instantly_contact_id, meeting_booked_at,
        accounts ( rep_id ),
        clients ( id, instantly_api_key, instantly_campaign_id )
      `
      )
      .eq('id', assetId)
      .single();

    if (fetchError || !existing) {
      return res.status(404).json({ error: 'Asset not found' });
    }

    if (existing.meeting_booked_at) {
      return res.status(200).json({ status: 'already_booked' });
    }

    const access = await getUserAccess(req.user.id, existing.client_id);

    if (!access) {
      return res.status(403).json({ error: 'You do not have access to this client' });
    }

    const isAdmin = access.role === 'admin';
    const accountRepId = existing.accounts?.rep_id ?? null;
    const isOwnAccount = accountRepId !== null && accountRepId === access.repId;

    if (!isAdmin && !isOwnAccount) {
      return res.status(403).json({ error: 'This account is not assigned to you' });
    }

    const adminOverride = isAdmin && !isOwnAccount;
    const now = new Date().toISOString();

    const { data: asset, error: updateError } = await supabase
      .from('assets')
      .update({
        sequence_status: 'meeting_booked',
        meeting_booked_at: now,
        slot_freed_at: now,
        slot_freed_reason: 'meeting_booked',
      })
      .eq('id', assetId)
      .select()
      .single();

    if (updateError) {
      throw updateError;
    }

    if (existing.instantly_contact_id) {
      await stopInstantlySequence(asset, existing.clients);
    }

    await logOutreachAction({
      client_id: existing.client_id,
      asset_id: existing.id,
      account_id: existing.account_id,
      channel: 'dashboard',
      action: 'meeting_booked',
      outcome: 'success',
      performed_by_user_id: req.user.id,
      admin_override: adminOverride,
      target_rep_id: accountRepId,
    });

    return res.status(200).json({ asset });
  } catch (err) {
    console.error('Error marking meeting booked:', {
      asset_id: assetId,
      error: err.message,
      stack: err.stack,
    });

    await logOutreachAction({
      asset_id: assetId,
      channel: 'dashboard',
      action: 'meeting_booked',
      outcome: 'error',
      error_message: err.message,
    });

    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
