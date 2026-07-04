import { supabase } from '../db/client.js';

export async function logOutreachAction(entry) {
  const { error } = await supabase.from('outreach_log').insert({
    executed_at: new Date().toISOString(),
    ...entry,
  });

  if (error) {
    console.error('Failed to write outreach_log entry:', {
      error: error.message,
      entry,
    });
  }
}
