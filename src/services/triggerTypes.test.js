import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TriggerTypeKey,
  classifyTriggerType,
  promptFacingTriggerType,
} from './triggerTypes.js';

// The exact, literal trigger_type strings defined in Pallet's v4 system prompt
// (system_prompts row bb91b895-dc85-47ed-8d6b-932c98285472), extracted verbatim. The Clay
// callback columns send these character-for-character, so the sanitizer must recognize the real
// label, not a paraphrase.
const LABOR_DISRUPTION = 'Labor disruption (strike, labor dispute)';
const OTHER_TRIGGER_TYPES = [
  'Acquisition/merger announced',
  'Business expansion',
  'Supply chain disruption',
  'Commercial performance shift (customer loss or growth initiative)',
  'New CIO/CTO/VP Technology hired (last 90 days)',
];

// The words that must never reach the Claude prompt input via the trigger_type channel, per v4's
// CRITICAL FRAMING RULE for labor disruption.
const FORBIDDEN_IN_PROMPT = /\b(strike|walkout|labor dispute)\b/i;

test('classifyTriggerType maps the real labor disruption label to the internal key', () => {
  assert.equal(classifyTriggerType(LABOR_DISRUPTION), TriggerTypeKey.LABOR_DISRUPTION);
});

test('classifyTriggerType does not misclassify the other trigger types as labor disruption', () => {
  for (const triggerType of OTHER_TRIGGER_TYPES) {
    assert.equal(
      classifyTriggerType(triggerType),
      TriggerTypeKey.OTHER,
      `${triggerType} should classify as OTHER`
    );
  }
  // "Supply chain disruption" also contains the word "disruption" - guard against the anchor
  // regressing into a loose substring match that would sanitize it too.
  assert.equal(classifyTriggerType('Supply chain disruption'), TriggerTypeKey.OTHER);
});

test('promptFacingTriggerType scrubs every forbidden word from the labor disruption label', () => {
  const label = promptFacingTriggerType(LABOR_DISRUPTION);
  assert.equal(label, 'Operational resilience opportunity');
  assert.doesNotMatch(label, FORBIDDEN_IN_PROMPT);
  // Belt and suspenders: the raw label itself does contain a forbidden word, so this proves the
  // test would actually catch a pass-through regression.
  assert.match(LABOR_DISRUPTION, FORBIDDEN_IN_PROMPT);
});

test('promptFacingTriggerType passes the other trigger types through verbatim', () => {
  for (const triggerType of OTHER_TRIGGER_TYPES) {
    assert.equal(
      promptFacingTriggerType(triggerType),
      triggerType,
      `${triggerType} must reach the prompt unchanged`
    );
  }
});

test('promptFacingTriggerType preserves the existing N/A fallback for a missing value', () => {
  assert.equal(promptFacingTriggerType(null), 'N/A');
  assert.equal(promptFacingTriggerType(undefined), 'N/A');
  assert.equal(promptFacingTriggerType(''), 'N/A');
});
