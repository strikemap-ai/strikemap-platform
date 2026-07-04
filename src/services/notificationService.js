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

export async function sendDigestNotification(client) {
  const { data: assets, error } = await supabase
    .from('assets')
    .select('accounts(company_name, trigger_score)')
    .eq('client_id', client.id)
    .eq('sequence_status', 'pending_ae_review');

  if (error) {
    throw error;
  }

  const accounts = (assets || []).map((row) => row.accounts).filter(Boolean);

  if (accounts.length === 0) {
    return;
  }

  await resend.emails.send({
    from: process.env.RESEND_FROM_EMAIL,
    to: client.ae_email,
    subject: 'Strikemap Digest - new accounts ready',
    html: buildDigestHtml(accounts),
  });
}
