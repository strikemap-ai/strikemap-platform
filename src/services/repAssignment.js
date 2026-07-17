import { supabase } from '../db/client.js';
import { findOwnerId } from './hubspotService.js';

function extractDomain(url) {
  if (!url) {
    return null;
  }

  try {
    const parsed = new URL(url.startsWith('http') ? url : `https://${url}`);
    return parsed.hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

// Resolves which rep a newly-created account belongs to, via HubSpot's existing Deal/Contact
// Owner field - never throws. Any failure (no credentials, no match, API error) resolves to
// null (unassigned) rather than blocking account creation.
export async function resolveRepId(client, { companyWebsite, primaryEmail }) {
  try {
    const domain = extractDomain(companyWebsite);
    const ownerId = await findOwnerId(client, { domain, email: primaryEmail });

    if (!ownerId) {
      return null;
    }

    const { data: rep } = await supabase
      .from('reps')
      .select('id')
      .eq('client_id', client.id)
      .eq('hubspot_owner_id', ownerId)
      .eq('status', 'active')
      .maybeSingle();

    return rep?.id || null;
  } catch (err) {
    console.warn('Rep resolution failed, leaving account unassigned:', {
      client_id: client?.id,
      error: err.message,
    });
    return null;
  }
}
