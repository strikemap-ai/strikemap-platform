import { supabase } from '../db/client.js';

// Unlike requireAdmin.js, this verifies the token against Supabase Auth (signature + expiry)
// instead of just base64-decoding the payload - a decoded-but-unverified `sub` can be forged by
// anyone, since nothing checks it was actually signed by Supabase.
// TODO: requireAdmin.js has this same forgeable-token gap, plus a `.single()` lookup that breaks
// for any user with roles on more than one client - fix it to match this pattern separately.
export async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const [scheme, token] = authHeader.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const { data, error } = await supabase.auth.getUser(token);

  if (error || !data?.user) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }

  req.user = { id: data.user.id, email: data.user.email };
  next();
}

export async function requireClientAccess(userId, clientId) {
  const { data } = await supabase
    .from('user_roles')
    .select('role')
    .eq('user_id', userId)
    .eq('client_id', clientId)
    .maybeSingle();

  return Boolean(data);
}
