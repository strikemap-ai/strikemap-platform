import { Router } from 'express';
import crypto from 'crypto';
import { supabase } from '../../db/client.js';
import { applyEnrichedFields } from '../../services/enrichmentService.js';

const router = Router();

// Clay's outbound HTTP action lets you set a custom header - configure it there with this same
// secret. Fails closed (unlike Instantly's webhook, which has no signing option at all) since
// this endpoint writes contact data straight into accounts.
function isAuthorized(req) {
  const secret = process.env.CLAY_ENRICHMENT_WEBHOOK_SECRET;

  if (!secret) {
    return false;
  }

  const header = req.get('X-Webhook-Secret') || '';
  const a = Buffer.from(header);
  const b = Buffer.from(secret);

  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

router.post('/', async (req, res) => {
  if (!isAuthorized(req)) {
    console.warn('Rejected unauthorized Clay enrichment callback:', {
      headerNames: Object.keys(req.headers),
    });
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { enrichment_request_id, status, email, phone, linkedin, error_message } = req.body;

  if (!enrichment_request_id || !status) {
    return res.status(400).json({ error: 'enrichment_request_id and status are required' });
  }

  try {
    const { data: request, error: fetchError } = await supabase
      .from('enrichment_requests')
      .select('id, account_id, contact_ref')
      .eq('id', enrichment_request_id)
      .single();

    if (fetchError || !request) {
      return res.status(404).json({ error: 'Enrichment request not found' });
    }

    const result = { email: email || null, phone: phone || null, linkedin: linkedin || null };

    const { error: updateError } = await supabase
      .from('enrichment_requests')
      .update({
        status,
        result,
        error_message: error_message || null,
        completed_at: new Date().toISOString(),
      })
      .eq('id', request.id);

    if (updateError) {
      throw updateError;
    }

    if (status === 'success') {
      const { data: account, error: accountError } = await supabase
        .from('accounts')
        .select('*')
        .eq('id', request.account_id)
        .single();

      if (accountError) {
        throw accountError;
      }

      if (account) {
        await applyEnrichedFields(account, request.contact_ref, result);
      }
    }

    return res.status(200).json({ status: 'recorded' });
  } catch (err) {
    console.error('Error handling Clay enrichment callback:', {
      enrichment_request_id,
      error: err.message,
      stack: err.stack,
    });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
