import { Router } from 'express';
import { supabase } from '../db/client.js';
import { logOutreachAction } from '../services/outreachLog.js';
import { executeOutreachChannels } from '../services/outreachExecution.js';
import { requireAuth, requireClientAccess } from '../middleware/requireAuth.js';

const router = Router();

router.use(requireAuth);

const EDITABLE_ASSET_FIELDS = [
  'account_brief',
  'cold_call_script',
  'linkedin_request',
  'linkedin_dm',
  'email_subject_1',
  'email_step_1',
  'email_subject_2',
  'email_step_2',
  'email_subject_3',
  'email_step_3',
];

router.post('/:assetId', async (req, res) => {
  const { assetId } = req.params;

  try {
    const { data: existing, error: fetchError } = await supabase
      .from('assets')
      .select(
        `
        id,
        client_id,
        account_id,
        accounts (
          company_name,
          primary_first_name,
          primary_last_name,
          primary_email,
          primary_title,
          primary_linkedin
        ),
        clients (
          id,
          hubspot_access_token,
          hubspot_pipeline_id,
          instantly_api_key,
          instantly_campaign_id,
          connectsafely_api_key,
          connectsafely_account_id
        )
      `
      )
      .eq('id', assetId)
      .single();

    if (fetchError || !existing) {
      return res.status(404).json({ error: 'Asset not found' });
    }

    if (!(await requireClientAccess(req.user.id, existing.client_id))) {
      return res.status(403).json({ error: 'You do not have access to this client' });
    }

    const edits = {};
    for (const field of EDITABLE_ASSET_FIELDS) {
      if (req.body[field] !== undefined) {
        edits[field] = req.body[field];
      }
    }

    const { data: asset, error: updateError } = await supabase
      .from('assets')
      .update({
        ...edits,
        sequence_status: 'approved',
        approved_at: new Date().toISOString(),
      })
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
      action: 'approve',
      outcome: 'success',
    });

    await executeOutreachChannels(asset, existing.accounts || {}, existing.clients);

    return res.status(200).json({ asset });
  } catch (err) {
    console.error('Error approving asset:', {
      asset_id: assetId,
      error: err.message,
      stack: err.stack,
    });

    await logOutreachAction({
      asset_id: assetId,
      channel: 'dashboard',
      action: 'approve',
      outcome: 'error',
      error_message: err.message,
    });

    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
