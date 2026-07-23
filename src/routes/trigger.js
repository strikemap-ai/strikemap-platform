import { Router } from 'express';
import { supabase } from '../db/client.js';
import { validateWebhook } from '../middleware/validateWebhook.js';
import { runPromptEngine, NoApprovedPromptError } from '../services/promptEngine.js';
import { sendDigestNotification } from '../services/notificationService.js';
import { resolveRepId } from '../services/repAssignment.js';

const router = Router();

router.post('/', validateWebhook, async (req, res) => {
  const {
    client_id,
    company_name,
    company_linkedin,
    company_website,
    company_headcount,
    funding_stage,
    total_funding,
    trigger_type,
    trigger_score,
    primary_first_name,
    primary_last_name,
    primary_email,
    primary_linkedin,
    primary_direct_dial,
    primary_title,
    additional_contacts,
    context,
  } = req.body;

  try {
    const { data: client, error: clientError } = await supabase
      .from('clients')
      .select('id, ae_email, ae_name, hubspot_access_token, hubspot_pipeline_id')
      .eq('id', client_id)
      .single();

    if (clientError || !client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    if (additional_contacts !== undefined && !Array.isArray(additional_contacts)) {
      return res.status(400).json({ error: 'additional_contacts must be a valid JSON array' });
    }

    const { repId: rep_id, reason: unassigned_reason } = await resolveRepId(client, {
      companyWebsite: company_website,
      primaryEmail: primary_email,
    });

    const { data: account, error: accountError } = await supabase
      .from('accounts')
      .insert({
        client_id,
        company_name,
        company_linkedin,
        company_website,
        company_headcount,
        funding_stage,
        total_funding,
        trigger_type,
        trigger_score,
        context,
        primary_first_name,
        primary_last_name,
        primary_email,
        primary_linkedin,
        primary_direct_dial,
        primary_title,
        additional_contacts: additional_contacts || [],
        raw_payload: req.body,
        rep_id,
        unassigned_reason,
      })
      .select()
      .single();

    if (accountError) {
      throw accountError;
    }

    await runPromptEngine(client, account);

    try {
      await sendDigestNotification(client);
    } catch (notifyErr) {
      console.error('Failed to send digest notification:', {
        client_id: client.id,
        error: notifyErr.message,
      });
    }

    return res.status(200).json({ status: 'success' });
  } catch (err) {
    console.error('Error processing trigger webhook:', {
      client_id,
      company_name,
      error: err.message,
      stack: err.stack,
    });

    if (err instanceof NoApprovedPromptError) {
      return res.status(400).json({ error: err.message });
    }

    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
