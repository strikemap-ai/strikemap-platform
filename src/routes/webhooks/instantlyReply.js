import { Router } from 'express';
import { supabase } from '../../db/client.js';
import { markAssetReplied } from '../../services/replyHandling.js';

const router = Router();

// Instantly has no webhook signing mechanism - the only auth option their dashboard offers
// is a custom HTTP header you attach yourself. INSTANTLY_WEBHOOK_SECRET (if set) is checked
// against the X-Webhook-Secret header configured on Instantly's side. If unset, the check is
// skipped - set it before pointing a real webhook here.
function isAuthorized(req) {
  const configured = process.env.INSTANTLY_WEBHOOK_SECRET;

  if (!configured) {
    return true;
  }

  return req.get('X-Webhook-Secret') === configured;
}

router.post('/', async (req, res) => {
  if (!isAuthorized(req)) {
    return res.status(401).json({ error: 'Invalid webhook secret' });
  }

  const { event_type, lead_email } = req.body || {};

  try {
    if (event_type && event_type !== 'reply_received') {
      return res.status(200).json({ status: 'ignored' });
    }

    if (!lead_email) {
      return res.status(400).json({ error: 'Missing lead_email in payload' });
    }

    const { data: primaryMatch, error: primaryError } = await supabase
      .from('accounts')
      .select('id')
      .eq('primary_email', lead_email)
      .maybeSingle();

    if (primaryError) {
      throw primaryError;
    }

    let accountId = primaryMatch?.id ?? null;
    let contactRef = primaryMatch ? 'primary' : null;

    // A reply can come from any activated additional contact's own email, not just the primary
    // contact - additional_contacts @> match finds the account whose array contains an entry
    // with this exact email.
    if (!accountId) {
      const { data: additionalMatch, error: additionalError } = await supabase
        .from('accounts')
        .select('id, additional_contacts')
        .contains('additional_contacts', [{ email: lead_email }])
        .maybeSingle();

      if (additionalError) {
        throw additionalError;
      }

      if (additionalMatch) {
        const entry = (additionalMatch.additional_contacts || []).find((c) => c.email === lead_email);
        if (entry?.id) {
          accountId = additionalMatch.id;
          contactRef = entry.id;
        }
      }
    }

    if (!accountId || !contactRef) {
      console.warn('No matching account/contact for Instantly reply:', { lead_email });
      return res.status(200).json({ status: 'no_matching_asset' });
    }

    const { data: asset, error: assetError } = await supabase
      .from('assets')
      .select('id, client_id, account_id, contact_ref, hubspot_deal_id, clients (*)')
      .eq('account_id', accountId)
      .eq('contact_ref', contactRef)
      .eq('sequence_status', 'approved')
      .is('replied_at', null)
      .maybeSingle();

    if (assetError) {
      throw assetError;
    }

    if (!asset) {
      console.warn('No pending approved asset for Instantly reply:', { lead_email });
      return res.status(200).json({ status: 'no_matching_asset' });
    }

    await markAssetReplied(asset, 'email', asset.clients);

    return res.status(200).json({ status: 'recorded', asset_id: asset.id });
  } catch (err) {
    console.error('Error handling Instantly reply webhook:', {
      lead_email,
      error: err.message,
      stack: err.stack,
    });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
