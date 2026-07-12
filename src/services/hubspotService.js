import { supabase } from '../db/client.js';
import { logOutreachAction } from './outreachLog.js';

const { HUBSPOT_ACCESS_TOKEN, HUBSPOT_PIPELINE_ID } = process.env;

if (!HUBSPOT_ACCESS_TOKEN || !HUBSPOT_PIPELINE_ID) {
  throw new Error('HUBSPOT_ACCESS_TOKEN and HUBSPOT_PIPELINE_ID must be set in .env');
}

const HUBSPOT_API_BASE = 'https://api.hubapi.com';

function isDryRun() {
  return process.env.DRY_RUN === 'true';
}

// Confirmed against the live account via GET /crm/v4/associations/{from}/{to}/labels
const ASSOCIATION_TYPE_ID = {
  DEAL_TO_CONTACT: 3,
  NOTE_TO_CONTACT: 202,
  NOTE_TO_DEAL: 214,
};

async function hubspotRequest(method, path, body) {
  const res = await fetch(`${HUBSPOT_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${HUBSPOT_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const responseBody = await res.json().catch(() => null);

  if (!res.ok) {
    const message = responseBody?.message || res.statusText;
    const error = new Error(`HubSpot API error (${res.status}): ${message}`);
    error.status = res.status;
    error.category = responseBody?.category;
    error.correlationId = responseBody?.correlationId;
    throw error;
  }

  return responseBody;
}

async function getStageId(stageLabel) {
  const pipeline = await hubspotRequest('GET', `/crm/v3/pipelines/deals/${HUBSPOT_PIPELINE_ID}`);
  const stage = pipeline.stages?.find(
    (s) => s.label.toLowerCase() === stageLabel.toLowerCase()
  );

  if (!stage) {
    throw new Error(
      `No deal stage labeled "${stageLabel}" in HubSpot pipeline ${HUBSPOT_PIPELINE_ID}`
    );
  }

  return stage.id;
}

async function upsertContact({ email, firstName, lastName, jobTitle }) {
  if (!email) {
    throw new Error('Cannot create HubSpot contact without an email address');
  }

  const result = await hubspotRequest('POST', '/crm/v3/objects/contacts/batch/upsert', {
    inputs: [
      {
        idProperty: 'email',
        id: email,
        properties: {
          email,
          firstname: firstName || undefined,
          lastname: lastName || undefined,
          jobtitle: jobTitle || undefined,
        },
      },
    ],
  });

  return result.results[0].id;
}

async function createDeal({ contactId, dealName }) {
  const stageId = await getStageId('Outreach Sent');

  const result = await hubspotRequest('POST', '/crm/v3/objects/deals', {
    properties: {
      dealname: dealName,
      pipeline: HUBSPOT_PIPELINE_ID,
      dealstage: stageId,
    },
    associations: [
      {
        to: { id: contactId },
        types: [
          { associationCategory: 'HUBSPOT_DEFINED', associationTypeId: ASSOCIATION_TYPE_ID.DEAL_TO_CONTACT },
        ],
      },
    ],
  });

  return result.id;
}

async function logNoteActivity({ contactId, dealId, body }) {
  await hubspotRequest('POST', '/crm/v3/objects/notes', {
    properties: {
      hs_note_body: body,
      hs_timestamp: Date.now(),
    },
    associations: [
      {
        to: { id: contactId },
        types: [
          { associationCategory: 'HUBSPOT_DEFINED', associationTypeId: ASSOCIATION_TYPE_ID.NOTE_TO_CONTACT },
        ],
      },
      {
        to: { id: dealId },
        types: [
          { associationCategory: 'HUBSPOT_DEFINED', associationTypeId: ASSOCIATION_TYPE_ID.NOTE_TO_DEAL },
        ],
      },
    ],
  });
}

export async function runHubSpotChannel(asset, account) {
  const primaryName = [account.primary_first_name, account.primary_last_name]
    .filter(Boolean)
    .join(' ');

  try {
    if (isDryRun()) {
      console.log('[DRY RUN] Would sync HubSpot contact + deal + note:', {
        asset_id: asset.id,
        endpoint:
          'POST /crm/v3/objects/contacts/batch/upsert, POST /crm/v3/objects/deals, POST /crm/v3/objects/notes',
        contact: {
          email: account.primary_email,
          firstName: account.primary_first_name,
          lastName: account.primary_last_name,
          jobTitle: account.primary_title,
        },
        deal: { dealName: [account.company_name, primaryName].filter(Boolean).join(' - ') },
      });

      await logOutreachAction({
        client_id: asset.client_id,
        asset_id: asset.id,
        account_id: asset.account_id,
        channel: 'hubspot',
        action: 'sync',
        outcome: 'dry_run',
      });

      return;
    }

    const contactId = await upsertContact({
      email: account.primary_email,
      firstName: account.primary_first_name,
      lastName: account.primary_last_name,
      jobTitle: account.primary_title,
    });

    await supabase.from('assets').update({ hubspot_contact_id: contactId }).eq('id', asset.id);

    const dealId = await createDeal({
      contactId,
      dealName: [account.company_name, primaryName].filter(Boolean).join(' - '),
    });

    await supabase.from('assets').update({ hubspot_deal_id: dealId }).eq('id', asset.id);

    await logNoteActivity({
      contactId,
      dealId,
      body: `Outreach approved for ${account.company_name} via Strikemap dashboard.`,
    });

    await logOutreachAction({
      client_id: asset.client_id,
      asset_id: asset.id,
      account_id: asset.account_id,
      channel: 'hubspot',
      action: 'sync',
      outcome: 'success',
    });
  } catch (err) {
    console.error('HubSpot sync failed:', {
      asset_id: asset.id,
      error: err.message,
    });

    await logOutreachAction({
      client_id: asset.client_id,
      asset_id: asset.id,
      account_id: asset.account_id,
      channel: 'hubspot',
      action: 'sync',
      outcome: 'error',
      error_message: err.message,
    });
  }
}
