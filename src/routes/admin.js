import { Router } from 'express';
import { supabase } from '../db/client.js';
import { requireAuth, getUserAccess, hasAnyAdminRole } from '../middleware/requireAuth.js';
import { logOutreachAction } from '../services/outreachLog.js';

const router = Router();

router.use(requireAuth);

router.get('/overview', async (req, res) => {
  if (!(await hasAnyAdminRole(req.user.id))) {
    return res.status(403).json({ error: 'Admin access required' });
  }

  try {
    const { data: clients, error: clientsError } = await supabase
      .from('clients')
      .select('id, name, ae_name, ae_email');

    if (clientsError) {
      throw clientsError;
    }

    const clientOverviews = await Promise.all(
      (clients || []).map(async (client) => {
        const [pending, approved, replied, lastAccount] = await Promise.all([
          supabase
            .from('assets')
            .select('id', { count: 'exact', head: true })
            .eq('client_id', client.id)
            .eq('sequence_status', 'pending_ae_review'),
          supabase
            .from('assets')
            .select('id', { count: 'exact', head: true })
            .eq('client_id', client.id)
            .eq('sequence_status', 'approved'),
          supabase
            .from('assets')
            .select('id', { count: 'exact', head: true })
            .eq('client_id', client.id)
            .eq('sequence_status', 'replied'),
          supabase
            .from('accounts')
            .select('trigger_date')
            .eq('client_id', client.id)
            .order('trigger_date', { ascending: false })
            .limit(1)
            .maybeSingle(),
        ]);

        if (pending.error) throw pending.error;
        if (approved.error) throw approved.error;
        if (replied.error) throw replied.error;
        if (lastAccount.error) throw lastAccount.error;

        return {
          id: client.id,
          name: client.name,
          ae_name: client.ae_name,
          ae_email: client.ae_email,
          pending_assets: pending.count || 0,
          approved_assets: approved.count || 0,
          replied_assets: replied.count || 0,
          last_trigger: lastAccount.data?.trigger_date || null,
        };
      })
    );

    const { data: pendingPrompts, error: promptsError } = await supabase
      .from('system_prompts')
      .select('id, version, created_at, clients(name)')
      .eq('status', 'pending');

    if (promptsError) {
      throw promptsError;
    }

    const { data: pendingCompetitors, error: competitorsError } = await supabase
      .from('competitors')
      .select('id, competitor_name, created_at, clients(name)')
      .eq('status', 'pending');

    if (competitorsError) {
      throw competitorsError;
    }

    return res.status(200).json({
      clients: clientOverviews,
      pending_approvals: {
        system_prompts: (pendingPrompts || []).map((p) => ({
          id: p.id,
          client_name: p.clients?.name,
          version: p.version,
          created_at: p.created_at,
        })),
        competitors: (pendingCompetitors || []).map((c) => ({
          id: c.id,
          client_name: c.clients?.name,
          competitor_name: c.competitor_name,
          created_at: c.created_at,
        })),
      },
    });
  } catch (err) {
    console.error('Error fetching admin overview:', {
      error: err.message,
      stack: err.stack,
    });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Deliberately kept separate from the normal pipeline/digest views - unassigned accounts never
// appear there, even for an admin. Checking this queue is meant to be a distinct action.
router.get('/unassigned/:clientId', async (req, res) => {
  const { clientId } = req.params;

  try {
    const access = await getUserAccess(req.user.id, clientId);

    if (!access || access.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required for this client' });
    }

    const { data: accounts, error } = await supabase
      .from('accounts')
      .select(
        `
        id,
        company_name,
        trigger_type,
        trigger_score,
        trigger_date,
        primary_first_name,
        primary_last_name,
        primary_title,
        assets ( id, sequence_status, created_at )
      `
      )
      .eq('client_id', clientId)
      .is('rep_id', null)
      .order('trigger_date', { ascending: false });

    if (error) {
      throw error;
    }

    return res.status(200).json({ client_id: clientId, accounts: accounts || [] });
  } catch (err) {
    console.error('Error fetching unassigned accounts:', {
      client_id: clientId,
      error: err.message,
      stack: err.stack,
    });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch('/accounts/:accountId/reassign', async (req, res) => {
  const { accountId } = req.params;
  const { rep_id } = req.body;

  try {
    const { data: account, error: fetchError } = await supabase
      .from('accounts')
      .select('id, client_id, rep_id')
      .eq('id', accountId)
      .single();

    if (fetchError || !account) {
      return res.status(404).json({ error: 'Account not found' });
    }

    const access = await getUserAccess(req.user.id, account.client_id);

    if (!access || access.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required for this client' });
    }

    if (rep_id) {
      const { data: rep, error: repError } = await supabase
        .from('reps')
        .select('id, client_id')
        .eq('id', rep_id)
        .maybeSingle();

      if (repError || !rep || rep.client_id !== account.client_id) {
        return res.status(400).json({ error: 'rep_id does not belong to this client' });
      }
    }

    const previousRepId = account.rep_id;
    const nextRepId = rep_id || null;

    const { data: updated, error: updateError } = await supabase
      .from('accounts')
      .update({ rep_id: nextRepId })
      .eq('id', accountId)
      .select()
      .single();

    if (updateError) {
      throw updateError;
    }

    await logOutreachAction({
      client_id: account.client_id,
      asset_id: null,
      account_id: account.id,
      channel: 'dashboard',
      action: 'reassign',
      outcome: 'success',
      performed_by_user_id: req.user.id,
      admin_override: true,
      target_rep_id: nextRepId,
      note: `Reassigned from ${previousRepId || 'unassigned'} to ${nextRepId || 'unassigned'}`,
    });

    return res.status(200).json({ account: updated });
  } catch (err) {
    console.error('Error reassigning account:', {
      account_id: accountId,
      error: err.message,
      stack: err.stack,
    });

    await logOutreachAction({
      account_id: accountId,
      channel: 'dashboard',
      action: 'reassign',
      outcome: 'error',
      error_message: err.message,
      performed_by_user_id: req.user.id,
      admin_override: true,
    });

    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
