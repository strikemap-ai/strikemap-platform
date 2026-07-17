#!/usr/bin/env node
import { supabase } from '../src/db/client.js';

const [clientId, name, email, hubspotOwnerId] = process.argv.slice(2);

if (!clientId || !name || !email) {
  console.error('Usage: node scripts/onboardRep.mjs <client_id> "<name>" <email> [hubspot_owner_id]');
  process.exit(1);
}

async function main() {
  const { data: client, error: clientError } = await supabase
    .from('clients')
    .select('id, name')
    .eq('id', clientId)
    .single();

  if (clientError || !client) {
    console.error('Client not found:', clientId);
    process.exit(1);
  }

  console.log(`Onboarding ${name} <${email}> as a rep for ${client.name}...`);

  const { data: invited, error: inviteError } = await supabase.auth.admin.inviteUserByEmail(email);

  if (inviteError) {
    console.error('Failed to send Supabase invite:', inviteError.message);
    process.exit(1);
  }

  console.log('Invite sent. user_id:', invited.user.id);

  const { data: rep, error: repError } = await supabase
    .from('reps')
    .insert({
      client_id: clientId,
      name,
      email,
      hubspot_owner_id: hubspotOwnerId || null,
      status: 'active',
    })
    .select()
    .single();

  if (repError) {
    console.error('Failed to create reps row:', repError.message);
    process.exit(1);
  }

  console.log('reps row created:', rep.id);

  const { error: roleError } = await supabase
    .from('user_roles')
    .insert({
      user_id: invited.user.id,
      client_id: clientId,
      role: 'rep',
      rep_id: rep.id,
    });

  if (roleError) {
    console.error('Failed to create user_roles row:', roleError.message);
    process.exit(1);
  }

  console.log('user_roles row created. Onboarding complete.');
  console.log({ user_id: invited.user.id, rep_id: rep.id, client_id: clientId });
}

main();
