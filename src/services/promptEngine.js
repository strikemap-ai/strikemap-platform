import Anthropic, {
  APIConnectionError,
  APIConnectionTimeoutError,
  InternalServerError,
  RateLimitError,
} from '@anthropic-ai/sdk';
import { supabase } from '../db/client.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const CLAUDE_MODEL = 'claude-sonnet-4-6';

const MAX_CLAUDE_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 500;

export class NoApprovedPromptError extends Error {}

function isRetryableClaudeError(err) {
  return (
    err instanceof APIConnectionError ||
    err instanceof APIConnectionTimeoutError ||
    err instanceof InternalServerError ||
    err instanceof RateLimitError ||
    (typeof err?.status === 'number' && (err.status === 429 || err.status >= 500))
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callClaudeWithRetry(params, context) {
  let attempt = 0;

  while (true) {
    try {
      return await anthropic.messages.create(params);
    } catch (err) {
      if (!isRetryableClaudeError(err) || attempt >= MAX_CLAUDE_RETRIES) {
        throw err;
      }

      const delay = RETRY_BASE_DELAY_MS * 2 ** attempt;
      console.error('Claude API call failed, retrying', {
        ...context,
        attempt: attempt + 1,
        max_attempts: MAX_CLAUDE_RETRIES + 1,
        delay_ms: delay,
        error: err.message,
      });

      await sleep(delay);
      attempt += 1;
    }
  }
}

const OUTPUT_INSTRUCTIONS = `
You must respond with a single JSON object only - no markdown, no commentary, no code fences - containing exactly these fields:

{
  "account_brief": "...",
  "cold_call_script": "...",
  "linkedin_request": "...",
  "linkedin_dm": "...",
  "email_subject_1": "...",
  "email_step_1": "...",
  "email_subject_2": "...",
  "email_step_2": "...",
  "email_subject_3": "...",
  "email_step_3": "..."
}

Email steps must be written as a sequence. Step 1 is the first cold outreach. Step 2 is a follow-up assuming no reply to Step 1 - softer and shorter. Step 3 is a final gentle close assuming no reply to Steps 1 or 2 - one sentence. Write all three steps together with this context in mind.
`.trim();

function buildUserMessage(account) {
  return `
Generate a full outreach package for the following target account.

Company: ${account.company_name}
Company LinkedIn: ${account.company_linkedin || 'N/A'}
Company Website: ${account.company_website || 'N/A'}
Headcount: ${account.company_headcount || 'N/A'}
Funding Stage: ${account.funding_stage || 'N/A'}
Total Funding: ${account.total_funding || 'N/A'}
Trigger Type: ${account.trigger_type || 'N/A'}
Trigger Score: ${account.trigger_score ?? 'N/A'}
Trigger Context: ${account.context || 'N/A'}

Primary Contact:
Name: ${account.primary_first_name || ''} ${account.primary_last_name || ''}
Title: ${account.primary_title || 'N/A'}
Email: ${account.primary_email || 'N/A'}
LinkedIn: ${account.primary_linkedin || 'N/A'}
Direct Dial: ${account.primary_direct_dial || 'N/A'}

${OUTPUT_INSTRUCTIONS}
`.trim();
}

function extractJson(rawText) {
  let text = rawText.trim();
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
  }
  return JSON.parse(text);
}

export async function runPromptEngine(client, account) {
  console.log('Loading system prompt', { client_id: client.id });

  const { data: promptRow, error: promptError } = await supabase
    .from('system_prompts')
    .select('prompt_text, version')
    .eq('client_id', client.id)
    .eq('status', 'approved')
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (promptError) {
    throw promptError;
  }

  if (!promptRow) {
    throw new NoApprovedPromptError(
      'No approved system prompt for this client - approve system prompt in admin dashboard before processing triggers'
    );
  }

  const userMessage = buildUserMessage(account);

  try {
    console.log('Calling Claude API', { client_id: client.id, account_id: account.id });

    const response = await callClaudeWithRetry(
      {
        model: CLAUDE_MODEL,
        max_tokens: 4096,
        system: promptRow.prompt_text,
        messages: [{ role: 'user', content: userMessage }],
      },
      { client_id: client.id, account_id: account.id }
    );

    const rawText = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');

    const parsed = extractJson(rawText);

    const { error: insertError } = await supabase.from('assets').insert({
      client_id: client.id,
      account_id: account.id,
      touch_number: 1,
      account_brief: parsed.account_brief,
      cold_call_script: parsed.cold_call_script,
      linkedin_request: parsed.linkedin_request,
      linkedin_dm: parsed.linkedin_dm,
      email_subject_1: parsed.email_subject_1,
      email_step_1: parsed.email_step_1,
      email_subject_2: parsed.email_subject_2,
      email_step_2: parsed.email_step_2,
      email_subject_3: parsed.email_subject_3,
      email_step_3: parsed.email_step_3,
      sequence_status: 'pending_ae_review',
      claude_model: CLAUDE_MODEL,
      claude_input_tokens: response.usage?.input_tokens ?? null,
      claude_output_tokens: response.usage?.output_tokens ?? null,
    });

    if (insertError) {
      throw insertError;
    }

    console.log('Assets saved', { client_id: client.id, account_id: account.id });
  } catch (err) {
    console.error('Prompt engine failed', {
      client_id: client.id,
      account_id: account.id,
      error: err.message,
    });

    await supabase.from('assets').insert({
      client_id: client.id,
      account_id: account.id,
      touch_number: 1,
      sequence_status: 'error',
      rejection_reason: err.message,
      claude_model: CLAUDE_MODEL,
    });

    throw err;
  }
}
