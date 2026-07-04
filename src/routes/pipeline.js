import { Router } from 'express';
import { supabase } from '../db/client.js';

const router = Router();

const STAGE_BY_STATUS = {
  pending_ae_review: 'Signal',
  pending_dm: 'Signal',
  approved: 'Outreach Sent',
  replied: 'Replied',
};

const ACTIVITY_TIMESTAMP_FIELDS = [
  'replied_at',
  'approved_at',
  'rejected_at',
  'linkedin_connection_accepted_at',
  'linkedin_dm_sent_at',
  'linkedin_connection_sent_at',
  'email_step_1_sent_at',
  'created_at',
];

function daysSince(isoString) {
  const then = new Date(isoString).getTime();
  const diffMs = Date.now() - then;
  return Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
}

function lastActivityAt(asset, account) {
  const timestamps = ACTIVITY_TIMESTAMP_FIELDS.map((field) => asset[field]).filter(Boolean);
  if (timestamps.length > 0) {
    return timestamps.sort().at(-1);
  }
  return account?.trigger_date || asset.created_at;
}

router.get('/:clientId', async (req, res) => {
  const { clientId } = req.params;

  try {
    const { data: client, error: clientError } = await supabase
      .from('clients')
      .select('id')
      .eq('id', clientId)
      .single();

    if (clientError || !client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    const { data: assets, error: assetsError } = await supabase
      .from('assets')
      .select(
        `
        id,
        account_id,
        sequence_status,
        created_at,
        approved_at,
        rejected_at,
        replied_at,
        linkedin_connection_sent_at,
        linkedin_connection_accepted_at,
        linkedin_dm_sent_at,
        email_step_1_sent_at,
        accounts (
          id,
          company_name,
          trigger_type,
          trigger_date,
          primary_first_name,
          primary_last_name
        )
      `
      )
      .eq('client_id', clientId)
      .order('created_at', { ascending: false });

    if (assetsError) {
      throw assetsError;
    }

    const latestAssetByAccount = new Map();
    for (const asset of assets || []) {
      if (!latestAssetByAccount.has(asset.account_id)) {
        latestAssetByAccount.set(asset.account_id, asset);
      }
    }

    const stages = {
      Signal: [],
      'Outreach Sent': [],
      Replied: [],
    };

    for (const asset of latestAssetByAccount.values()) {
      const stage = STAGE_BY_STATUS[asset.sequence_status];
      if (!stage) {
        continue;
      }

      const account = asset.accounts || {};
      const contactName = [account.primary_first_name, account.primary_last_name]
        .filter(Boolean)
        .join(' ');

      stages[stage].push({
        account_id: asset.account_id,
        asset_id: asset.id,
        company_name: account.company_name,
        contact_name: contactName,
        trigger_type: account.trigger_type,
        sequence_status: asset.sequence_status,
        days_since_last_activity: daysSince(lastActivityAt(asset, account)),
      });
    }

    return res.status(200).json({
      client_id: clientId,
      generated_at: new Date().toISOString(),
      stages,
    });
  } catch (err) {
    console.error('Error fetching pipeline:', {
      client_id: clientId,
      error: err.message,
      stack: err.stack,
    });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
