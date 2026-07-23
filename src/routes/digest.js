import { Router } from 'express';
import { supabase } from '../db/client.js';
import { requireAuth, getUserAccess } from '../middleware/requireAuth.js';
import { resolveDeliveryContact } from '../services/deliveryContact.js';

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

    const access = await getUserAccess(req.user.id, clientId);

    if (!access) {
      return res.status(403).json({ error: 'You do not have access to this client' });
    }

    const isAdmin = access.role === 'admin';

    let query = supabase
      .from('assets')
      .select(
        `
        id,
        account_id,
        contact_ref,
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
        meeting_booked_at,
        created_at,
        accounts!inner (
          trigger_score,
          trigger_type,
          company_name,
          primary_first_name,
          primary_last_name,
          primary_title,
          primary_email,
          primary_linkedin,
          primary_direct_dial,
          additional_contacts,
          rep_id,
          reps ( name )
        )
      `
      )
      .eq('client_id', clientId)
      .eq('sequence_status', 'pending_ae_review')
      .order('trigger_score', { foreignTable: 'accounts', ascending: false });

    query = isAdmin
      ? query.not('accounts.rep_id', 'is', null)
      : query.eq('accounts.rep_id', access.repId);

    const { data: assets, error: assetsError } = await query;

    if (assetsError) {
      throw assetsError;
    }

    const accounts = (assets || []).map((asset) => {
      const account = asset.accounts || {};
      // This asset's target contact - the account's primary contact by default, or whichever
      // additional contact was activated into this seat.
      const contact = resolveDeliveryContact(account, asset.contact_ref);
      const contactName = [contact.primary_first_name, contact.primary_last_name]
        .filter(Boolean)
        .join(' ');

      return {
        asset_id: asset.id,
        account_id: asset.account_id,
        contact_ref: asset.contact_ref,
        trigger_score: account.trigger_score,
        trigger_type: account.trigger_type,
        company_name: account.company_name,
        primary_name: contactName,
        primary_title: contact.primary_title,
        primary_email: contact.primary_email,
        primary_linkedin: contact.primary_linkedin,
        primary_direct_dial: contact.primary_direct_dial,
        additional_contacts: account.additional_contacts || [],
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
        meeting_booked_at: asset.meeting_booked_at,
        created_at: asset.created_at,
        ...(isAdmin ? { assigned_rep: account.reps?.name || null } : {}),
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
