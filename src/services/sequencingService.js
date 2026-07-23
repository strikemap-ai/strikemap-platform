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

// Persona layer is derived from title text - the schema has no dedicated persona/layer column
// (confirmed against live accounts.additional_contacts rows: id, first_name, last_name, title,
// email, linkedin, channel, priority, source only). This mirrors the executive vs.
// champion/director persona split already defined in the client's approved system prompt.
//
// Rule set (edit the two patterns below to add or remove keywords):
//   executive - title contains: Chief, President, EVP, SVP, VP, Vice President, CEO, COO, CFO,
//               CTO, CIO, CCO
//   champion  - title contains: Director, Manager (of a specific workflow, e.g. Director of
//               Customer Service, Document Processing Manager)
//   Executive is checked before champion, so a title matching both patterns (e.g. a "VP" title
//   that also happens to contain "Director") classifies as executive, not champion.
const EXECUTIVE_TITLE_PATTERN = /\b(chief|president|evp|svp|vp|vice president|ceo|coo|cfo|cto|cio|cco)\b/i;
const CHAMPION_TITLE_PATTERN = /\b(director|manager)\b/i;

export function classifyPersonaLayer(title) {
  const normalized = (title || '').trim();
  if (!normalized) {
    return null;
  }
  if (EXECUTIVE_TITLE_PATTERN.test(normalized)) {
    return 'executive';
  }
  if (CHAMPION_TITLE_PATTERN.test(normalized)) {
    return 'champion';
  }
  return null;
}

function getContactTitle(account, contactRef) {
  if (contactRef === 'primary') {
    return account.primary_title;
  }
  const contacts = Array.isArray(account.additional_contacts) ? account.additional_contacts : [];
  const match = contacts.find((contact, index) => (contact.id ?? String(index)) === contactRef);
  return match ? match.title : null;
}

// Which persona layers currently occupy one of the account's active seats - the signal used to
// decide whether an open slot should favor a champion/director contact. Only currently active
// (unfreed) seats count; a champion whose seat was later freed (rejected, completed) no longer
// represents the champion layer, so a fresh champion is fair game again.
function getActiveLayers(account, activeContactRefs) {
  const layers = new Set();
  for (const ref of activeContactRefs || []) {
    const layer = classifyPersonaLayer(getContactTitle(account, ref));
    if (layer) {
      layers.add(layer);
    }
  }
  return layers;
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
//
// activeContactRefs (optional) is the set of contact_refs currently occupying an active seat -
// passing it enables the role-diversity preference: when the executive layer is represented on
// the account's active seats but the champion/director layer isn't, an eligible champion sorts
// ahead of tier order for the next open slot. This is a soft preference, not a gate - contacts
// that fail isDeliverable are filtered out before this boost ever runs, so if no eligible
// champion exists, sorting falls back to plain tier order automatically. Once both layers are
// represented (or activeContactRefs is omitted), sorting is pure tier order, same as before this
// preference existed.
export function getEligibleWaitingContacts(account, usedContactRefs, activeContactRefs) {
  const used = new Set(usedContactRefs || []);
  const contacts = Array.isArray(account.additional_contacts) ? account.additional_contacts : [];

  const activeLayers = getActiveLayers(account, activeContactRefs);
  const needsChampion = activeLayers.has('executive') && !activeLayers.has('champion');

  return contacts
    .map((contact, index) => ({ contact, index }))
    .filter(({ contact }) => !contact.id || !used.has(contact.id))
    .filter(({ contact }) => isDeliverable(contact))
    .sort((a, b) => {
      if (needsChampion) {
        const aIsChampion = classifyPersonaLayer(a.contact.title) === 'champion' ? 0 : 1;
        const bIsChampion = classifyPersonaLayer(b.contact.title) === 'champion' ? 0 : 1;
        if (aIsChampion !== bIsChampion) {
          return aIsChampion - bIsChampion;
        }
      }
      const rankDiff = priorityRank(a.contact.priority) - priorityRank(b.contact.priority);
      return rankDiff !== 0 ? rankDiff : a.index - b.index;
    })
    .map(({ contact, index }) => ({ ...contact, contactRef: contact.id ?? String(index) }));
}

export async function getOpenSeatAccounts(clientId, repId) {
  let accountsQuery = supabase
    .from('accounts')
    .select('id, company_name, additional_contacts, primary_title, rep_id')
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
  const activeRefsByAccount = new Map();

  for (const asset of assets || []) {
    if (!usedRefsByAccount.has(asset.account_id)) {
      usedRefsByAccount.set(asset.account_id, new Set());
    }
    usedRefsByAccount.get(asset.account_id).add(asset.contact_ref);

    if (asset.slot_freed_at === null) {
      seatsByAccount.set(asset.account_id, (seatsByAccount.get(asset.account_id) || 0) + 1);

      if (!activeRefsByAccount.has(asset.account_id)) {
        activeRefsByAccount.set(asset.account_id, new Set());
      }
      activeRefsByAccount.get(asset.account_id).add(asset.contact_ref);
    }
  }

  const openSeatAccounts = [];

  for (const account of accounts) {
    const activeSeatCount = seatsByAccount.get(account.id) || 0;
    if (activeSeatCount >= MAX_ACTIVE_SEATS) {
      continue;
    }

    const waiting = getEligibleWaitingContacts(
      account,
      usedRefsByAccount.get(account.id),
      activeRefsByAccount.get(account.id)
    );
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
