// Internal trigger-type keys for code-level logic and routing, deliberately decoupled from the
// human-readable trigger_type strings stored on accounts.trigger_type (and shown to reps in the
// admin dashboard, pipeline view, and digest). The decoupling exists so that sensitive text
// embedded in a stored label can never leak into the Claude prompt input merely because that
// label happens to be interpolated there.
//
// Today only labor disruption needs this: its stored label literally contains "(strike, labor
// dispute)", and Pallet's v4 system prompt flags any reference to the strike/labor situation in
// generated outreach as a real reputational and legal risk (its CRITICAL FRAMING RULE). Relying
// on the model to follow that instruction was the only defense on this specific channel; this
// module adds a code-level layer so the words never reach the model in the first place.
//
// Every other Pallet trigger type carries no sensitive embedded text, so all of them map to OTHER
// and pass through to the prompt verbatim - what the model sees still matches what the rep sees.

export const TriggerTypeKey = {
  LABOR_DISRUPTION: 'labor_disruption',
  OTHER: 'other',
};

// Classify a stored trigger_type string into an internal key. The match is anchored to the start
// of the trimmed, lower-cased label, so "Supply chain disruption" (which also contains the word
// "disruption") can never collide with labor disruption. This is intentionally the only special
// case: adding a new sensitive trigger type later means adding a branch here plus a prompt-facing
// label below, and nothing else in the pipeline changes.
export function classifyTriggerType(triggerType) {
  const normalized = (triggerType || '').trim().toLowerCase();
  if (normalized.startsWith('labor disruption')) {
    return TriggerTypeKey.LABOR_DISRUPTION;
  }
  return TriggerTypeKey.OTHER;
}

// The label substituted into the Claude prompt in place of the raw trigger_type. For labor
// disruption this carries only v4's general operational-resilience framing, with zero reference
// to strike, walkout, or labor dispute. Any key not listed here (i.e. OTHER) falls through to the
// raw trigger_type value, preserving the existing "N/A" fallback for a missing value.
const PROMPT_FACING_LABELS = {
  [TriggerTypeKey.LABOR_DISRUPTION]: 'Operational resilience opportunity',
};

// The single value that should be interpolated into the prompt's "Trigger Type:" line - never the
// raw account.trigger_type. Callers outside the prompt builder (DB storage, admin, pipeline,
// digest) must keep using the raw trigger_type, which is unchanged by this module.
export function promptFacingTriggerType(triggerType) {
  const key = classifyTriggerType(triggerType);
  return PROMPT_FACING_LABELS[key] ?? (triggerType || 'N/A');
}
