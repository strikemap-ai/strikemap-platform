import { supabase } from '../db/client.js';

// Unlike the old requireAdmin.js (removed), this verifies the token against Supabase Auth
// (signature + expiry) instead of just base64-decoding the payload - a decoded-but-unverified
// `sub` can be forged by anyone, since nothing checks it was actually signed by Supabase.
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

// Client-scoped: does this user have a role for this specific client, and if so, which rep are
// they (if any)? Used by every route except /api/admin/overview, which is platform-wide.
export async function getUserAccess(userId, clientId) {
  const { data } = await supabase
    .from('user_roles')
    .select('role, rep_id')
    .eq('user_id', userId)
    .eq('client_id', clientId)
    .maybeSingle();

  if (!data) {
    return null;
  }

  return { role: data.role, repId: data.rep_id };
}

// Platform-wide: does this user have an admin role on ANY client? No .single() - a user with
// admin rows on multiple clients (e.g. Ali on both Strikemap and Pallet) must not break this.
export async function hasAnyAdminRole(userId) {
  const { data } = await supabase
    .from('user_roles')
    .select('id')
    .eq('user_id', userId)
    .eq('role', 'admin')
    .limit(1);

  return Boolean(data && data.length > 0);
}

// Every client this user has a role on, with their rep identity for each - lets the frontend
// resolve which client(s) to show instead of a hardcoded build-time client_id.
export async function listUserAccess(userId) {
  const { data, error } = await supabase
    .from('user_roles')
    .select('client_id, role, rep_id, clients (name), reps (name)')
    .eq('user_id', userId);

  if (error) {
    throw error;
  }

  return (data || []).map((row) => ({
    client_id: row.client_id,
    name: row.clients?.name || null,
    role: row.role,
    rep_id: row.rep_id,
    rep_name: row.reps?.name || null,
  }));
}
