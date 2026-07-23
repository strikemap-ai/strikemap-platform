import { resolveContactTarget } from './enrichmentService.js';

// Every channel service (instantlyService, connectSafelyService, hubspotService) and
// outreachExecution.js only ever reads account.primary_* to know who to actually deliver to.
// Rather than teach each of those files about contact_ref, this remaps a single view of the
// account so an additional contact's asset delivers to *their* email/name/linkedin instead of
// the account's primary contact - the channel files stay exactly as they were before Build 5.
export function resolveDeliveryContact(account, contactRef) {
  if (!contactRef || contactRef === 'primary') {
    return account;
  }

  const target = resolveContactTarget(account, contactRef);
  if (!target) {
    return account;
  }

  const contacts = Array.isArray(account.additional_contacts) ? account.additional_contacts : [];
  const entry = contacts[target.index] || {};

  return {
    ...account,
    primary_first_name: entry.first_name || null,
    primary_last_name: entry.last_name || null,
    primary_title: entry.title || null,
    primary_email: target.fields.email,
    primary_direct_dial: target.fields.phone,
    primary_linkedin: target.fields.linkedin,
  };
}
