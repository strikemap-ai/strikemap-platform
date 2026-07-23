import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getEligibleWaitingContacts, classifyPersonaLayer } from './sequencingService.js';

// Real Echo Global Logistics account shape (client_id a0c67977-2817-4308-ac76-deed4e6c0911,
// account_id fb84ae45-1e95-4cae-9ddc-49611c2ed06f), trimmed to the fields these tests need.
// Zach Jecklin (CIO) is the primary/executive contact. Dave Menzel and Trisha Leckow are P1 but
// executive-tier (President/COO, SVP), not champions - the real champion/director-tier contacts
// are Randy Valentino, Dennis Christensen, Lauren Marciano, and Stacey Lewis. In live data those
// four currently have no email or LinkedIn on file, so a LinkedIn URL is added in the tests that
// need an eligible champion in the waiting pool - everything else about the fixture is real.
function buildEchoAccount(overrides = {}) {
  return {
    primary_title: 'Chief Information Officer',
    additional_contacts: [
      { id: 'menzel', first_name: 'Dave', last_name: 'Menzel', title: 'President and COO', priority: 'P1', email: 'dave@echo.com', linkedin: null },
      { id: 'leckow', first_name: 'Trisha', last_name: 'Leckow', title: 'SVP Product Technology', priority: 'P1', email: 'trisha.leckow@echo.com', linkedin: null },
      { id: 'valentino', first_name: 'Randy', last_name: 'Valentino', title: 'Director of Tech Operations', priority: 'P1', email: null, linkedin: overrides.valentinoLinkedin ?? null },
      { id: 'christensen', first_name: 'Dennis', last_name: 'Christensen', title: 'Director Business Development', priority: 'P1', email: null, linkedin: null },
      { id: 'waggoner', first_name: 'Doug', last_name: 'Waggoner', title: 'CEO', priority: 'P2', email: null, linkedin: overrides.waggonerLinkedin ?? null },
      { id: 'lewis', first_name: 'Stacey', last_name: 'Lewis', title: 'Director Premier Client Management', priority: 'P2', email: null, linkedin: overrides.lewisLinkedin ?? null },
    ],
  };
}

test('classifyPersonaLayer maps real Echo titles to the expected layer', () => {
  assert.equal(classifyPersonaLayer('Chief Information Officer'), 'executive');
  assert.equal(classifyPersonaLayer('President and COO'), 'executive');
  assert.equal(classifyPersonaLayer('SVP Product Technology'), 'executive');
  assert.equal(classifyPersonaLayer('CEO'), 'executive');
  assert.equal(classifyPersonaLayer('Director of Tech Operations'), 'champion');
  assert.equal(classifyPersonaLayer('Director Premier Client Management'), 'champion');
  assert.equal(classifyPersonaLayer('Some Unrelated Title'), null);
});

test('prioritizes an eligible champion ahead of tier order once the executive layer is active alone', () => {
  const account = buildEchoAccount({ lewisLinkedin: 'https://linkedin.com/in/stacey-lewis' });
  const activeRefs = new Set(['primary']); // Zach Jecklin (CIO) already active, no champion yet

  const waiting = getEligibleWaitingContacts(account, new Set(), activeRefs);

  // Lewis is P2 (champion/director) and Menzel/Leckow are P1 (executive) - under plain tier sort
  // Menzel would come first. The role-diversity preference should put Lewis first instead, since
  // the executive layer is represented and the champion layer is not, even though her tier is
  // lower than the two executives she's beating out.
  assert.equal(waiting[0].contactRef, 'lewis');
  assert.deepEqual(
    waiting.map((c) => c.contactRef),
    ['lewis', 'menzel', 'leckow']
  );
});

test('falls back to plain tier order when no eligible champion exists (soft preference, not a gate)', () => {
  const account = buildEchoAccount(); // real live data: all Director-tier contacts lack email/LinkedIn
  const activeRefs = new Set(['primary']);

  const waiting = getEligibleWaitingContacts(account, new Set(), activeRefs);

  // No champion is deliverable, so the preference has nothing to promote - plain P1-before-P2
  // tier order applies, same as before this feature existed.
  assert.deepEqual(
    waiting.map((c) => c.contactRef),
    ['menzel', 'leckow']
  );
});

test('reverts to pure tier sort once both layers are already represented on active seats', () => {
  const account = buildEchoAccount({
    valentinoLinkedin: 'https://linkedin.com/in/randy-valentino',
    waggonerLinkedin: 'https://linkedin.com/in/doug-waggoner',
  });
  // Primary (Jecklin, executive) and Valentino (champion) are both already active.
  const activeRefs = new Set(['primary', 'valentino']);

  const waiting = getEligibleWaitingContacts(account, new Set(['valentino']), activeRefs);

  // Both layers are already represented, so the champion boost no longer applies - Menzel and
  // Leckow (P1) sort ahead of Waggoner (P2) purely on tier, confirming the preference doesn't
  // linger once it has been satisfied.
  assert.deepEqual(
    waiting.map((c) => c.contactRef),
    ['menzel', 'leckow', 'waggoner']
  );
});

test('preserves the Build 5 eligibility rule and permanent-exclusion behavior', () => {
  const account = buildEchoAccount();
  const usedRefs = new Set(['menzel']); // already activated - permanently excluded even if freed later
  const activeRefs = new Set(['primary', 'menzel']);

  const waiting = getEligibleWaitingContacts(account, usedRefs, activeRefs);

  assert.ok(!waiting.some((c) => c.contactRef === 'menzel'), 'used contact must not reappear');
  assert.ok(
    !waiting.some((c) => c.contactRef === 'christensen'),
    'non-deliverable contact (no email or LinkedIn) must stay ineligible'
  );
  assert.deepEqual(
    waiting.map((c) => c.contactRef),
    ['leckow']
  );
});
