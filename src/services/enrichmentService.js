import crypto from 'crypto';
import { supabase } from '../db/client.js';
import { findContactDetails } from './hubspotService.js';
import { extractDomain } from '../utils/domain.js';

const CONTACT_FIELDS = ['email', 'phone', 'linkedin'];

// Real per-lookup costs from Ali's Clay plan (2026-07-20). Cost is computed live from
// fields_requested rather than persisted on each row, since enrichment_requests carries no cost
// column.
export const CLAY_COST_PER_FIELD = {
  email: 0.3,
  phone: 0.3,
  linkedin: 0.46,
};

// Which fields Clay's table can actually attempt right now. Phone/LinkedIn enrichment paths are
// deferred - Clay has no provider configured for them yet, so a request that asks for them still
// gets sent (needs_phone/needs_linkedin=true), but never actually costs anything until a real
// path exists. Add a field here the same day its Clay path goes live, not before - otherwise
// rep budgets get charged for lookups Clay never actually performs.
const ACTIVE_CLAY_FIELDS = ['email'];

function isDryRun() {
  return process.env.DRY_RUN === 'true';
}

function costForFields(fields) {
  return (fields || [])
    .filter((field) => ACTIVE_CLAY_FIELDS.includes(field))
    .reduce((total, field) => total + (CLAY_COST_PER_FIELD[field] || 0), 0);
}

// Monday 00:00 UTC - Sunday 23:59:59 UTC. Chosen over a rolling 7-day window for simplicity:
// nothing in this feature shows the rep a countdown or remaining balance, so a rolling window's
// fairness advantage isn't visible to anyone - a predictable weekly reset is easier to reason
// about when reviewing spend.
export function startOfCalendarWeekUTC(date = new Date()) {
  const utcDay = date.getUTCDay();
  const daysSinceMonday = (utcDay + 6) % 7;
  const start = new Date(date);
  start.setUTCDate(date.getUTCDate() - daysSinceMonday);
  start.setUTCHours(0, 0, 0, 0);
  return start;
}

export async function getWeeklyClaySpend(repId) {
  const weekStart = startOfCalendarWeekUTC();

  // No rep_id column on enrichment_requests - spend is scoped through the account a rep is
  // actually assigned to, the same ownership boundary already enforced at request time.
  const { data, error } = await supabase
    .from('enrichment_requests')
    .select('fields_requested, accounts!inner ( rep_id )')
    .eq('source', 'clay')
    .eq('status', 'success')
    .eq('accounts.rep_id', repId)
    .gte('created_at', weekStart.toISOString());

  if (error) {
    throw error;
  }

  return (data || []).reduce((total, row) => total + costForFields(row.fields_requested), 0);
}

async function getRepBudget(repId) {
  const { data, error } = await supabase
    .from('reps')
    .select('weekly_enrichment_budget')
    .eq('id', repId)
    .single();

  if (error) {
    throw error;
  }

  return data.weekly_enrichment_budget;
}

// 'primary' addresses the account's own primary_* columns; any other contact_ref addresses an
// additional_contacts entry by its id.
export function resolveContactTarget(account, contactRef) {
  if (contactRef === 'primary') {
    return {
      type: 'primary',
      fields: {
        email: account.primary_email || null,
        phone: account.primary_direct_dial || null,
        linkedin: account.primary_linkedin || null,
      },
    };
  }

  const contacts = Array.isArray(account.additional_contacts) ? account.additional_contacts : [];
  const index = contacts.findIndex((c) => c.id === contactRef);

  if (index === -1) {
    return null;
  }

  const entry = contacts[index];
  return {
    type: 'additional',
    index,
    fields: {
      email: entry.email || null,
      phone: entry.phone || null,
      linkedin: entry.linkedin || null,
    },
  };
}

export function getMissingFields(target) {
  return CONTACT_FIELDS.filter((field) => !target.fields[field]);
}

// additional_contacts entries have no stable id until the first time someone tries to enrich
// them - the frontend addresses an id-less entry by its array index, and this assigns + persists
// a real id on first use so every later reference (enrichment_requests.contact_ref, polling,
// future Build 2 lookups) has something stable to hold onto.
export async function ensureContactId(account, contactRef) {
  if (contactRef === 'primary') {
    return { contactRef, account };
  }

  const contacts = Array.isArray(account.additional_contacts) ? [...account.additional_contacts] : [];
  let index = contacts.findIndex((c) => c.id === contactRef);

  if (index === -1) {
    const asIndex = Number(contactRef);
    if (!Number.isInteger(asIndex) || asIndex < 0 || asIndex >= contacts.length) {
      return null;
    }
    index = asIndex;
  }

  if (contacts[index].id) {
    return { contactRef: contacts[index].id, account };
  }

  const id = crypto.randomUUID();
  contacts[index] = { ...contacts[index], id };

  const { data: updated, error } = await supabase
    .from('accounts')
    .update({ additional_contacts: contacts })
    .eq('id', account.id)
    .select()
    .single();

  if (error) {
    throw error;
  }

  return { contactRef: id, account: updated };
}

// Only fills currently-null fields - never overwrites a value already on file, whether it came
// from Clay, HubSpot, or manual TAP entry.
export async function applyEnrichedFields(account, contactRef, fields) {
  if (contactRef === 'primary') {
    const updates = {};
    if (fields.email && !account.primary_email) updates.primary_email = fields.email;
    if (fields.phone && !account.primary_direct_dial) updates.primary_direct_dial = fields.phone;
    if (fields.linkedin && !account.primary_linkedin) updates.primary_linkedin = fields.linkedin;

    if (Object.keys(updates).length === 0) {
      return account;
    }

    const { data, error } = await supabase
      .from('accounts')
      .update(updates)
      .eq('id', account.id)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  const contacts = Array.isArray(account.additional_contacts) ? [...account.additional_contacts] : [];
  const index = contacts.findIndex((c) => c.id === contactRef);

  if (index === -1) {
    return account;
  }

  const entry = { ...contacts[index] };
  let changed = false;
  for (const field of CONTACT_FIELDS) {
    if (fields[field] && !entry[field]) {
      entry[field] = fields[field];
      changed = true;
    }
  }

  if (!changed) {
    return account;
  }

  contacts[index] = entry;

  const { data, error } = await supabase
    .from('accounts')
    .update({ additional_contacts: contacts })
    .eq('id', account.id)
    .select()
    .single();

  if (error) throw error;
  return data;
}

// Clay's no-code conditional branching works against flat booleans, not array membership - this
// is the shape sent over the wire to Clay; fields_requested (the array) still gets persisted on
// the enrichment_requests row itself for our own cost/budget accounting.
function fieldFlags(fields) {
  return {
    needs_email: fields.includes('email'),
    needs_phone: fields.includes('phone'),
    needs_linkedin: fields.includes('linkedin'),
  };
}

function contactSeedFields(account, target) {
  const base = {
    company_name: account.company_name,
    company_domain: extractDomain(account.company_website),
  };

  if (target.type === 'primary') {
    return {
      ...base,
      first_name: account.primary_first_name,
      last_name: account.primary_last_name,
      title: account.primary_title,
      known_email: account.primary_email,
    };
  }

  const entry = account.additional_contacts[target.index];
  return {
    ...base,
    first_name: entry.first_name,
    last_name: entry.last_name,
    title: entry.title,
    known_email: entry.email,
  };
}

async function postToClayWebhook(payload) {
  const url = process.env.CLAY_ENRICHMENT_WEBHOOK_URL;

  if (!url) {
    throw new Error('CLAY_ENRICHMENT_WEBHOOK_URL is not configured');
  }

  if (isDryRun()) {
    console.log('[DRY RUN] Would POST to Clay enrichment webhook:', payload);
    return;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    throw new Error(`Clay webhook POST failed (${res.status})`);
  }
}

async function runHubSpotStep(client, account, contactRef, target, missing, userId) {
  const details = await findContactDetails(client, {
    domain: extractDomain(account.company_website),
    email: target.fields.email,
  });

  const found = {};
  for (const field of missing) {
    if (details[field]) {
      found[field] = details[field];
    }
  }

  const status = Object.keys(found).length > 0 ? 'success' : 'no_match';

  await supabase.from('enrichment_requests').insert({
    client_id: account.client_id,
    account_id: account.id,
    requested_by_user_id: userId,
    contact_ref: contactRef,
    fields_requested: missing,
    status,
    source: 'hubspot',
    result: found,
    completed_at: new Date().toISOString(),
  });

  const updatedAccount = status === 'success' ? await applyEnrichedFields(account, contactRef, found) : account;

  return { status, found, account: updatedAccount };
}

// Free, HubSpot-only. Never touches Clay or the weekly budget.
export async function enrichFromHubSpot(client, account, contactRef, userId) {
  const target = resolveContactTarget(account, contactRef);

  if (!target) {
    throw new Error('Contact not found on this account');
  }

  const missing = getMissingFields(target);

  if (missing.length === 0) {
    return { status: 'no_match', source: null, fields_requested: [], result: null };
  }

  const { status, found } = await runHubSpotStep(client, account, contactRef, target, missing, userId);

  return { status, source: 'hubspot', fields_requested: missing, result: found };
}

// HubSpot first (free), Clay only for whatever HubSpot didn't resolve. Only the Clay portion is
// checked against / counted toward the rep's weekly budget.
export async function enrichWaterfall(client, account, contactRef, repId, userId) {
  const target = resolveContactTarget(account, contactRef);

  if (!target) {
    throw new Error('Contact not found on this account');
  }

  const missing = getMissingFields(target);

  if (missing.length === 0) {
    return { status: 'no_match', source: null, fields_requested: [], result: null };
  }

  const hubspotStep = await runHubSpotStep(client, account, contactRef, target, missing, userId);
  const stillMissing = missing.filter((field) => !hubspotStep.found[field]);

  if (stillMissing.length === 0) {
    return { status: 'success', source: 'hubspot', fields_requested: missing, result: hubspotStep.found };
  }

  const budget = await getRepBudget(repId);

  if (budget !== null) {
    const weeklySpend = await getWeeklyClaySpend(repId);
    const thisRequestCost = costForFields(stillMissing);

    if (weeklySpend + thisRequestCost > budget) {
      return { status: 'budget_exceeded' };
    }
  }

  const { data: pending, error } = await supabase
    .from('enrichment_requests')
    .insert({
      client_id: account.client_id,
      account_id: account.id,
      requested_by_user_id: userId,
      contact_ref: contactRef,
      fields_requested: stillMissing,
      status: 'pending',
      source: 'clay',
    })
    .select()
    .single();

  if (error) {
    throw error;
  }

  await postToClayWebhook({
    enrichment_request_id: pending.id,
    client_id: account.client_id,
    account_id: account.id,
    contact_ref: contactRef,
    ...fieldFlags(stillMissing),
    ...contactSeedFields(hubspotStep.account, target),
  });

  return { status: 'pending', enrichment_request_id: pending.id };
}
