import { Router } from 'express';
import { supabase } from '../db/client.js';
import { requireAuth, getUserAccess } from '../middleware/requireAuth.js';
import { resolveDeliveryContact } from '../services/deliveryContact.js';

const router = Router();

router.use(requireAuth);

const STAGE_BY_STATUS = {
  pending_ae_review: 'Signal',
  pending_dm: 'Signal',
  approved: 'Outreach Sent',
  replied: 'Replied',
  meeting_booked: 'Discovery Booked',
};

const ACTIVITY_TIMESTAMP_FIELDS = [
  'meeting_booked_at',
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
        sequence_status,
        created_at,
        approved_at,
        rejected_at,
        replied_at,
        linkedin_connection_sent_at,
        linkedin_connection_accepted_at,
        linkedin_dm_sent_at,
        email_step_1_sent_at,
        meeting_booked_at,
        accounts!inner (
          id,
          company_name,
          trigger_type,
          trigger_date,
          primary_first_name,
          primary_last_name,
          additional_contacts,
          rep_id,
          reps ( name )
        )
      `
      )
      .eq('client_id', clientId)
      .order('created_at', { ascending: false });

    // Admin sees every rep's assigned accounts combined, but unassigned accounts stay carved
    // out - those are only visible through the dedicated /api/admin/unassigned endpoint.
    query = isAdmin
      ? query.not('accounts.rep_id', 'is', null)
      : query.eq('accounts.rep_id', access.repId);

    const { data: assets, error: assetsError } = await query;

    if (assetsError) {
      throw assetsError;
    }

    // Keyed by account+contact, not just account - an account can now have up to 3 assets
    // active at once (primary plus activated additional contacts), each a distinct pipeline card.
    const latestAssetByAccountContact = new Map();
    for (const asset of assets || []) {
      const key = `${asset.account_id}:${asset.contact_ref}`;
      if (!latestAssetByAccountContact.has(key)) {
        latestAssetByAccountContact.set(key, asset);
      }
    }

    const stages = {
      Signal: [],
      'Outreach Sent': [],
      Replied: [],
      'Discovery Booked': [],
    };

    for (const asset of latestAssetByAccountContact.values()) {
      const stage = STAGE_BY_STATUS[asset.sequence_status];
      if (!stage) {
        continue;
      }

      const account = asset.accounts || {};
      const deliveryContact = resolveDeliveryContact(account, asset.contact_ref);
      const contactName = [deliveryContact.primary_first_name, deliveryContact.primary_last_name]
        .filter(Boolean)
        .join(' ');

      stages[stage].push({
        account_id: asset.account_id,
        asset_id: asset.id,
        contact_ref: asset.contact_ref,
        company_name: account.company_name,
        contact_name: contactName,
        trigger_type: account.trigger_type,
        sequence_status: asset.sequence_status,
        meeting_booked_at: asset.meeting_booked_at,
        days_since_last_activity: daysSince(lastActivityAt(asset, account)),
        ...(isAdmin ? { assigned_rep: account.reps?.name || null } : {}),
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
