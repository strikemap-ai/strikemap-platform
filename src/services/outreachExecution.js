import { runHubSpotChannel } from './hubspotService.js';
import { runInstantlyChannel } from './instantlyService.js';
import { runConnectSafelyChannel } from './connectSafelyService.js';

export async function executeOutreachChannels(asset, account, client) {
  await Promise.allSettled([
    runHubSpotChannel(asset, account, client),
    runInstantlyChannel(asset, account, client),
    runConnectSafelyChannel(asset, account, client),
  ]);
}
