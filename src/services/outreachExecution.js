import { runHubSpotChannel } from './hubspotService.js';
import { runInstantlyChannel } from './instantlyService.js';
import { runConnectSafelyChannel } from './connectSafelyService.js';

export async function executeOutreachChannels(asset, account) {
  await Promise.allSettled([
    runHubSpotChannel(asset, account),
    runInstantlyChannel(asset, account),
    runConnectSafelyChannel(asset, account),
  ]);
}
