import { Router } from 'express';
import { supabase } from '../db/client.js';
import { requireAuth, getUserAccess } from '../middleware/requireAuth.js';
import {
  ensureContactId,
  enrichFromHubSpot,
  enrichWaterfall,
} from '../services/enrichmentService.js';

const router = Router();

router.use(requireAuth);

async function loadOwnedAccount(req, res, accountId) {
  const { data: account, error } = await supabase
    .from('accounts')
    .select('*, clients ( id, hubspot_access_token, hubspot_pipeline_id )')
    .eq('id', accountId)
    .single();

  if (error || !account) {
    res.status(404).json({ error: 'Account not found' });
    return null;
  }

  const access = await getUserAccess(req.user.id, account.client_id);
  const isAdmin = access?.role === 'admin';
  const isOwnAccount = Boolean(access) && account.rep_id !== null && account.rep_id === access.repId;

  // Admin can act on any account in their client, including unassigned ones (rep_id null) -
  // same admin-override pattern as approve/reject. A regular rep is still strictly scoped to
  // their own accounts.
  if (!access || (!isAdmin && !isOwnAccount)) {
    res.status(403).json({ error: 'This account is not assigned to you' });
    return null;
  }

  return { account, access, adminOverride: isAdmin && !isOwnAccount };
}

router.post('/hubspot', async (req, res) => {
  const { account_id, contact_ref } = req.body;

  if (!account_id || !contact_ref) {
    return res.status(400).json({ error: 'account_id and contact_ref are required' });
  }

  try {
    const owned = await loadOwnedAccount(req, res, account_id);
    if (!owned) return;

    const resolved = await ensureContactId(owned.account, contact_ref);
    if (!resolved) {
      return res.status(404).json({ error: 'Contact not found on this account' });
    }

    const result = await enrichFromHubSpot(
      owned.account.clients,
      resolved.account,
      resolved.contactRef,
      req.user.id,
      owned.adminOverride
    );

    return res.status(200).json(result);
  } catch (err) {
    console.error('Error enriching from HubSpot:', {
      account_id,
      contact_ref,
      error: err.message,
      stack: err.stack,
    });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/waterfall', async (req, res) => {
  const { account_id, contact_ref } = req.body;

  if (!account_id || !contact_ref) {
    return res.status(400).json({ error: 'account_id and contact_ref are required' });
  }

  try {
    const owned = await loadOwnedAccount(req, res, account_id);
    if (!owned) return;

    const resolved = await ensureContactId(owned.account, contact_ref);
    if (!resolved) {
      return res.status(404).json({ error: 'Contact not found on this account' });
    }

    const result = await enrichWaterfall(
      owned.account.clients,
      resolved.account,
      resolved.contactRef,
      // The account's OWN rep_id, not the caller's - an admin acting on an unassigned account
      // (rep_id null) must never have this billed against their own personal rep budget.
      resolved.account.rep_id,
      req.user.id,
      owned.adminOverride
    );

    if (result.status === 'budget_exceeded') {
      return res.status(403).json({ error: 'Weekly enrichment budget reached' });
    }

    if (result.status === 'pending') {
      return res.status(202).json(result);
    }

    return res.status(200).json(result);
  } catch (err) {
    console.error('Error running enrichment waterfall:', {
      account_id,
      contact_ref,
      error: err.message,
      stack: err.stack,
    });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/status/:requestId', async (req, res) => {
  const { requestId } = req.params;

  try {
    const { data: request, error } = await supabase
      .from('enrichment_requests')
      .select('id, status, source, result, error_message, fields_requested, accounts ( client_id, rep_id )')
      .eq('id', requestId)
      .single();

    if (error || !request) {
      return res.status(404).json({ error: 'Enrichment request not found' });
    }

    const access = await getUserAccess(req.user.id, request.accounts.client_id);
    const isAdmin = access?.role === 'admin';
    const isOwnAccount =
      Boolean(access) && request.accounts.rep_id !== null && request.accounts.rep_id === access.repId;

    if (!access || (!isAdmin && !isOwnAccount)) {
      return res.status(403).json({ error: 'This account is not assigned to you' });
    }

    return res.status(200).json({
      status: request.status,
      source: request.source,
      result: request.result,
      error_message: request.error_message,
      fields_requested: request.fields_requested,
    });
  } catch (err) {
    console.error('Error fetching enrichment status:', {
      request_id: requestId,
      error: err.message,
      stack: err.stack,
    });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
