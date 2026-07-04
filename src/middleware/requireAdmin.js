import { supabase } from '../db/client.js';

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
