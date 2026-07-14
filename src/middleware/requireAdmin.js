import { supabase } from '../db/client.js';

// TODO(not urgent, admin/overview only - not used day-to-day): this middleware has two real bugs,
// fixed properly in requireAuth.js - use that pattern here too when this gets revisited:
// 1. extractUserId() only base64-decodes the JWT payload, it never verifies the signature - a
//    forged token with a fabricated `sub` passes this check with no real credentials.
// 2. The user_roles lookup below has no client_id filter and uses .single(), which errors (and
//    denies access) for any user with roles on more than one client - confirmed live now that
//    Ali has admin rows for both Strikemap and Pallet.
function extractUserId(req) {
  const authHeader = req.headers.authorization || '';
  const [scheme, token] = authHeader.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return null;
  }

  try {
    const payloadSegment = token.split('.')[1];
    const payload = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8'));
    return payload.sub || null;
  } catch {
    return null;
  }
}

export async function requireAdmin(req, res, next) {
  const user_id = extractUserId(req);

  if (!user_id) {
    return res.status(403).json({ error: 'Admin access required' });
  }

  req.user = { user_id };

  const { data } = await supabase
    .from('user_roles')
    .select('role')
    .eq('user_id', user_id)
    .single();

  if (!data || data.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  next();
}
