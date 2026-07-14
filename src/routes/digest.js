import { Router } from 'express';
import { supabase } from '../db/client.js';
import { requireAuth, requireClientAccess } from '../middleware/requireAuth.js';

const router = Router();

router.use(requireAuth);

router.get('/:clientId', async (req, res) => {
  const { clientId } = req.params;

  try {
    const { data: client, error: clientError } = await supabase
      .from('clients')
      .select('id, ae_name')
      .eq('id', clientId)
      .single();

    if (clientError || !client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    if (!(await requireClientAccess(req.user.id, clientId))) {
      return res.status(403).json({ error: 'You do not have access to this client' });
    }

    const { data: assets, error: assetsError } = await supabase
      .from('assets')
      .select(
        `
        id,
        account_id,
        account_brief,
        cold_call_script,
        linkedin_request,
        linkedin_dm,
        email_subject_1,
        email_step_1,
        email_subject_2,
        email_step_2,
        email_subject_3,
        email_step_3,
        sequence_status,
        created_at,
        accounts (
          trigger_score,
          trigger_type,
          company_name,
          primary_first_name,
          primary_last_name,
          primary_title,
          primary_email,
          primary_linkedin,
          primary_direct_dial
        )
      `
      )
      .eq('client_id', clientId)
      .eq('sequence_status', 'pending_ae_review')
      .order('trigger_score', { foreignTable: 'accounts', ascending: false });

    if (assetsError) {
      throw assetsError;
    }

    const accounts = (assets || []).map((asset) => {
      const account = asset.accounts || {};
      const primaryName = [account.primary_first_name, account.primary_last_name]
        .filter(Boolean)
        .join(' ');

      return {
        asset_id: asset.id,
        account_id: asset.account_id,
        trigger_score: account.trigger_score,
        trigger_type: account.trigger_type,
        company_name: account.company_name,
        primary_name: primaryName,
        primary_title: account.primary_title,
        primary_email: account.primary_email,
        primary_linkedin: account.primary_linkedin,
        primary_direct_dial: account.primary_direct_dial,
        account_brief: asset.account_brief,
        cold_call_script: asset.cold_call_script,
        linkedin_request: asset.linkedin_request,
        linkedin_dm: asset.linkedin_dm,
        email_subject_1: asset.email_subject_1,
        email_step_1: asset.email_step_1,
        email_subject_2: asset.email_subject_2,
        email_step_2: asset.email_step_2,
        email_subject_3: asset.email_subject_3,
        email_step_3: asset.email_step_3,
        sequence_status: asset.sequence_status,
        created_at: asset.created_at,
      };
    });

    return res.status(200).json({
      client_id: clientId,
      ae_name: client.ae_name,
      generated_at: new Date().toISOString(),
      pending_count: accounts.length,
      accounts,
    });
  } catch (err) {
    console.error('Error fetching digest:', {
      client_id: clientId,
      error: err.message,
      stack: err.stack,
    });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
