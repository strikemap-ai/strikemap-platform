import { Router } from 'express';
import { supabase } from '../db/client.js';
import { requireAdmin } from '../middleware/requireAdmin.js';

const router = Router();

router.get('/overview', requireAdmin, async (req, res) => {
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

export default router;
