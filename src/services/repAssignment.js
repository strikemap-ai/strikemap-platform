import { supabase } from '../db/client.js';
import { findOwnerId } from './hubspotService.js';
import { extractDomain } from '../utils/domain.js';

// Resolves which rep a newly-created account belongs to, via HubSpot's existing Deal/Contact
// Owner field - never throws. Any failure (no credentials, no match, API error) resolves to
// null (unassigned) rather than blocking account creation. Returns a reason alongside a null
// repId so the admin unassigned-accounts view can distinguish why, instead of every failure
// mode collapsing into the same unlabeled "unassigned" state.
export async function resolveRepId(client, { companyWebsite, primaryEmail }) {
  try {
    const domain = extractDomain(companyWebsite);
    const { ownerId, reason } = await findOwnerId(client, { domain, email: primaryEmail });

    if (!ownerId) {
      return { repId: null, reason };
    }

    const { data: rep } = await supabase
      .from('reps')
      .select('id')
      .eq('client_id', client.id)
      .eq('hubspot_owner_id', ownerId)
      .eq('status', 'active')
      .maybeSingle();

    if (!rep?.id) {
      return { repId: null, reason: 'owner_not_mapped_to_rep' };
    }

    return { repId: rep.id, reason: null };
  } catch (err) {
    console.warn('Rep resolution failed, leaving account unassigned:', {
      client_id: client?.id,
      error: err.message,
    });
    return { repId: null, reason: 'resolution_error' };
  }
}
