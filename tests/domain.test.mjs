import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildReceiptVerification,
  defaultSettings,
  generateBarcode,
  isWithinHours,
  makeInviteCode,
  normalizeSettingsPatch,
} from '../src/domain.mjs';

test('generateBarcode returns a stable GI-prefixed code', () => {
  assert.equal(generateBarcode('+1 (555) 444-3322'), 'GI-54443322');
});

test('isWithinHours handles overnight venues', () => {
  assert.equal(isWithinHours(23, 20, 4), true);
  assert.equal(isWithinHours(2, 20, 4), true);
  assert.equal(isWithinHours(12, 20, 4), false);
});

test('buildReceiptVerification validates venue aliases and receipt windows', () => {
  const verification = buildReceiptVerification({
    spendAmount: 150,
    extractedDate: new Date().toISOString(),
    venueText: 'Golden Ice Nightclub',
    settings: defaultSettings,
    duplicate: false,
  });

  assert.equal(verification.venueMatched, true);
  assert.equal(verification.blockingReason, null);
  assert.equal(verification.amountInRange, true);
});

test('normalizeSettingsPatch maps camelCase settings to database columns', () => {
  const patch = normalizeSettingsPatch({
    earnRate: 15,
    welcomeBonus: 250,
    operatingHours: {
      opensAtHour: 18,
      closesAtHour: 3,
    },
  });

  assert.equal(patch.earn_rate, 15);
  assert.equal(patch.welcome_bonus, 250);
  assert.equal(patch.opens_at_hour, 18);
  assert.equal(patch.closes_at_hour, 3);
  assert.ok(typeof patch.updated_at === 'string');
});

test('makeInviteCode returns the expected format', () => {
  const code = makeInviteCode();
  assert.match(code, /^GI-[A-Z0-9]{6}$/);
});
