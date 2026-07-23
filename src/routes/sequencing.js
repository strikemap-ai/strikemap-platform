import { Router } from 'express';
import { supabase } from '../db/client.js';
import { requireAuth, getUserAccess } from '../middleware/requireAuth.js';
import { ensureContactId } from '../services/enrichmentService.js';
import {
  getActiveSeatCount,
  getEligibleWaitingContacts,
  getOpenSeatAccounts,
  MAX_ACTIVE_SEATS,
} from '../services/sequencingService.js';
import { runPromptEngine } from '../services/promptEngine.js';

const router = Router();

router.use(requireAuth);

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
    const openSeatAccounts = await getOpenSeatAccounts(clientId, isAdmin ? null : access.repId);

    return res.status(200).json({ client_id: clientId, open_seat_accounts: openSeatAccounts });
  } catch (err) {
    console.error('Error fetching open seat accounts:', {
      client_id: clientId,
      error: err.message,
      stack: err.stack,
    });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/activate', async (req, res) => {
  const { account_id, contact_ref } = req.body;

  if (!account_id || !contact_ref) {
    return res.status(400).json({ error: 'account_id and contact_ref are required' });
  }

  try {
    const { data: account, error: accountError } = await supabase
      .from('accounts')
      .select('*')
      .eq('id', account_id)
      .single();

    if (accountError || !account) {
      return res.status(404).json({ error: 'Account not found' });
    }

    const access = await getUserAccess(req.user.id, account.client_id);
    const isAdmin = access?.role === 'admin';
    const isOwnAccount = Boolean(access) && account.rep_id !== null && account.rep_id === access.repId;

    if (!access || (!isAdmin && !isOwnAccount)) {
      return res.status(403).json({ error: 'This account is not assigned to you' });
    }

    const resolved = await ensureContactId(account, contact_ref);
    if (!resolved) {
      return res.status(404).json({ error: 'Contact not found on this account' });
    }

    // Recheck seat count and eligibility live, rather than trusting whatever the rep last saw
    // on the Open Seats list - both can have changed since that page loaded.
    const seatCount = await getActiveSeatCount(account_id);
    if (seatCount >= MAX_ACTIVE_SEATS) {
      return res.status(409).json({ error: 'No open seat on this account' });
    }

    const { data: existingAssets, error: assetsError } = await supabase
      .from('assets')
      .select('contact_ref')
      .eq('account_id', account_id);

    if (assetsError) {
      throw assetsError;
    }

    const usedRefs = new Set((existingAssets || []).map((a) => a.contact_ref));

    if (usedRefs.has(resolved.contactRef)) {
      return res.status(409).json({ error: 'This contact has already been activated on this account' });
    }

    const waiting = getEligibleWaitingContacts(resolved.account, usedRefs);
    const isEligible = waiting.some((c) => c.contactRef === resolved.contactRef);

    if (!isEligible) {
      return res
        .status(400)
        .json({ error: 'This contact is not currently eligible - needs an email or LinkedIn URL on file' });
    }

    const { data: client, error: clientError } = await supabase
      .from('clients')
      .select('id, ae_name')
      .eq('id', account.client_id)
      .single();

    if (clientError || !client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    // Generation is a real Claude call with unpredictable duration - same shape of problem the
    // Clay enrichment waterfall has. Don't block the response on it: return immediately, and let
    // the frontend poll /status for the asset to land, same fix Build 1 applied there. Errors are
    // handled by promptEngine.js's own catch block (it inserts a sequence_status='error' row and
    // rethrows) - the rethrow is caught here purely to avoid an unhandled rejection crashing the
    // process; the poller surfaces the failure via that error row, not via this response.
    runPromptEngine(client, resolved.account, resolved.contactRef).catch((err) => {
      console.error('Background contact activation failed:', {
        account_id,
        contact_ref: resolved.contactRef,
        error: err.message,
      });
    });

    return res.status(202).json({ status: 'pending', account_id, contact_ref: resolved.contactRef });
  } catch (err) {
    console.error('Error activating contact:', {
      account_id,
      contact_ref,
      error: err.message,
      stack: err.stack,
    });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/status/:accountId/:contactRef', async (req, res) => {
  const { accountId, contactRef } = req.params;

  try {
    const { data: account, error: accountError } = await supabase
      .from('accounts')
      .select('id, client_id, rep_id')
      .eq('id', accountId)
      .single();

    if (accountError || !account) {
      return res.status(404).json({ error: 'Account not found' });
    }

    const access = await getUserAccess(req.user.id, account.client_id);
    const isAdmin = access?.role === 'admin';
    const isOwnAccount = Boolean(access) && account.rep_id !== null && account.rep_id === access.repId;

    if (!access || (!isAdmin && !isOwnAccount)) {
      return res.status(403).json({ error: 'This account is not assigned to you' });
    }

    const { data: asset, error: assetError } = await supabase
      .from('assets')
      .select('*')
      .eq('account_id', accountId)
      .eq('contact_ref', contactRef)
      .maybeSingle();

    if (assetError) {
      throw assetError;
    }

    if (!asset) {
      return res.status(200).json({ status: 'pending' });
    }

    if (asset.sequence_status === 'error') {
      return res.status(200).json({ status: 'failed', error_message: asset.rejection_reason });
    }

    return res.status(200).json({ status: 'success', asset });
  } catch (err) {
    console.error('Error fetching activation status:', {
      account_id: accountId,
      contact_ref: contactRef,
      error: err.message,
      stack: err.stack,
    });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
