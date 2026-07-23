import { supabase } from '../db/client.js';

export const MAX_ACTIVE_SEATS = 3;

function priorityRank(priority) {
  const match = /^P(\d+)$/i.exec((priority || '').trim());
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
}

// A contact is eligible to fill a freed seat once it has at least one deliverable channel
// (email or linkedin) - occupying one of only 3 seats with nothing to actually send to is worse
// than leaving the seat open for someone reachable. Enrichment timing is otherwise decoupled
// from slot timing - a rep can enrich any contact at any time, independent of seat availability.
function isDeliverable(contact) {
  return Boolean(contact.email || contact.linkedin);
}

export async function getActiveSeatCount(accountId) {
  const { count, error } = await supabase
    .from('assets')
    .select('id', { count: 'exact', head: true })
    .eq('account_id', accountId)
    .is('slot_freed_at', null);

  if (error) {
    throw error;
  }

  return count || 0;
}

// Contacts already activated (any contact_ref that already has an asset row, regardless of that
// asset's current status) are excluded permanently - a rejected or completed contact doesn't
// re-enter the waiting pool, matching the one-asset-per-contact-ever model in the migration.
export function getEligibleWaitingContacts(account, usedContactRefs) {
  const used = new Set(usedContactRefs || []);
  const contacts = Array.isArray(account.additional_contacts) ? account.additional_contacts : [];

  return contacts
    .map((contact, index) => ({ contact, index }))
    .filter(({ contact }) => !contact.id || !used.has(contact.id))
    .filter(({ contact }) => isDeliverable(contact))
    .sort((a, b) => {
      const rankDiff = priorityRank(a.contact.priority) - priorityRank(b.contact.priority);
      return rankDiff !== 0 ? rankDiff : a.index - b.index;
    })
    .map(({ contact, index }) => ({ ...contact, contactRef: contact.id ?? String(index) }));
}

export async function getOpenSeatAccounts(clientId, repId) {
  let accountsQuery = supabase
    .from('accounts')
    .select('id, company_name, additional_contacts, rep_id')
    .eq('client_id', clientId);

  accountsQuery = repId ? accountsQuery.eq('rep_id', repId) : accountsQuery.not('rep_id', 'is', null);

  const { data: accounts, error: accountsError } = await accountsQuery;

  if (accountsError) {
    throw accountsError;
  }

  if (!accounts || accounts.length === 0) {
    return [];
  }

  const accountIds = accounts.map((a) => a.id);

  const { data: assets, error: assetsError } = await supabase
    .from('assets')
    .select('account_id, contact_ref, slot_freed_at')
    .in('account_id', accountIds);

  if (assetsError) {
    throw assetsError;
  }

  const seatsByAccount = new Map();
  const usedRefsByAccount = new Map();

  for (const asset of assets || []) {
    if (!usedRefsByAccount.has(asset.account_id)) {
      usedRefsByAccount.set(asset.account_id, new Set());
    }
    usedRefsByAccount.get(asset.account_id).add(asset.contact_ref);

    if (asset.slot_freed_at === null) {
      seatsByAccount.set(asset.account_id, (seatsByAccount.get(asset.account_id) || 0) + 1);
    }
  }

  const openSeatAccounts = [];

  for (const account of accounts) {
    const activeSeatCount = seatsByAccount.get(account.id) || 0;
    if (activeSeatCount >= MAX_ACTIVE_SEATS) {
      continue;
    }

    const waiting = getEligibleWaitingContacts(account, usedRefsByAccount.get(account.id));
    if (waiting.length === 0) {
      continue;
    }

    openSeatAccounts.push({
      account_id: account.id,
      company_name: account.company_name,
      active_seat_count: activeSeatCount,
      open_seats: MAX_ACTIVE_SEATS - activeSeatCount,
      recommended_contact: waiting[0],
      other_eligible_contacts: waiting.slice(1),
    });
  }

  return openSeatAccounts;
}
