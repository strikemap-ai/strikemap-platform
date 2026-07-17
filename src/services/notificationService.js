import { Resend } from 'resend';
import { supabase } from '../db/client.js';

const resend = new Resend(process.env.RESEND_API_KEY);

function buildDigestHtml(accounts) {
  const rows = accounts
    .map(
      (a) => `
        <tr>
          <td style="padding:8px 12px;border-bottom:1px solid #e5e5e5;">${a.company_name}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #e5e5e5;">${a.trigger_score ?? ''}</td>
        </tr>`
    )
    .join('');

  return `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
      <h2>New accounts ready for review</h2>
      <p>${accounts.length} account${accounts.length === 1 ? '' : 's'} pending review in your Strikemap digest.</p>
      <table style="border-collapse:collapse;width:100%;">
        <thead>
          <tr>
            <th style="text-align:left;padding:8px 12px;border-bottom:2px solid #333;">Company</th>
            <th style="text-align:left;padding:8px 12px;border-bottom:2px solid #333;">Trigger Score</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    </div>
  `.trim();
}

// One digest per active rep, filtered to their own assigned accounts. Unassigned accounts are
// never included here - they only surface through the admin unassigned-queue endpoint.
export async function sendDigestNotification(client) {
  const { data: reps, error: repsError } = await supabase
    .from('reps')
    .select('id, name, email')
    .eq('client_id', client.id)
    .eq('status', 'active');

  if (repsError) {
    throw repsError;
  }

  for (const rep of reps || []) {
    const { data: assets, error } = await supabase
      .from('assets')
      .select('accounts!inner(company_name, trigger_score, rep_id)')
      .eq('client_id', client.id)
      .eq('sequence_status', 'pending_ae_review')
      .eq('accounts.rep_id', rep.id);

    if (error) {
      console.error('Failed to load pending accounts for rep digest:', {
        rep_id: rep.id,
        error: error.message,
      });
      continue;
    }

    const accounts = (assets || []).map((row) => row.accounts).filter(Boolean);

    if (accounts.length === 0) {
      continue;
    }

    await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL,
      to: rep.email,
      subject: 'Strikemap Digest - new accounts ready',
      html: buildDigestHtml(accounts),
    });
  }
}
