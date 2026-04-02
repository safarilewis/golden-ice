import { randomUUID } from 'node:crypto';

export const defaultSettings = {
  venueName: 'Golden Ice',
  venueAliases: ['golden ice', 'goldenice', 'golden ice nightclub'],
  earnRate: 10,
  welcomeBonus: 100,
  receiptWindowHours: 48,
  minSpendAmount: 5,
  maxSpendAmount: 2000,
  operatingHours: {
    opensAtHour: 20,
    closesAtHour: 4,
  },
  dailyStaffPointLimit: 20000,
  dualConfirmationThreshold: 1200,
  highAmountMultiplier: 2,
  velocityWindowMinutes: 10,
  velocityThreshold: 5,
  repeatPairThreshold: 3,
  concentrationThreshold: 0.6,
};

export function isWithinHours(hour, opensAtHour, closesAtHour) {
  if (opensAtHour === closesAtHour) {
    return true;
  }

  if (opensAtHour < closesAtHour) {
    return hour >= opensAtHour && hour < closesAtHour;
  }

  return hour >= opensAtHour || hour < closesAtHour;
}

export function generateBarcode(seed) {
  const digits = String(seed || '')
    .replace(/\D/g, '')
    .slice(-8)
    .padStart(8, '0');
  return `GI-${digits}`;
}

export function buildReceiptVerification({ spendAmount, extractedDate, venueText, settings, duplicate }) {
  const now = new Date();
  const receiptDate = new Date(extractedDate);
  const hoursDiff = Math.abs(now.getTime() - receiptDate.getTime()) / (1000 * 60 * 60);
  const venueMatched = [settings.venueName, ...settings.venueAliases].some((alias) =>
    String(venueText || '')
      .toLowerCase()
      .includes(alias.toLowerCase())
  );
  const dateValid = hoursDiff <= settings.receiptWindowHours;
  const amountInRange =
    spendAmount >= settings.minSpendAmount && spendAmount <= settings.maxSpendAmount;

  let blockingReason = null;
  const warnings = [];

  if (!venueMatched) {
    blockingReason = 'Receipt venue does not match Golden Ice aliases.';
  }

  if (duplicate) {
    blockingReason = 'Duplicate receipt detected.';
  }

  if (!dateValid && !blockingReason) {
    warnings.push('Receipt date is outside the preferred validation window.');
  }

  if (!amountInRange) {
    warnings.push('Spend amount is outside the configured safe range.');
  }

  return {
    extractedAmount: spendAmount,
    extractedDate,
    venueMatched,
    dateValid,
    duplicate,
    amountInRange,
    blockingReason,
    warnings,
    venueText,
  };
}

export function normalizeSettingsPatch(patch = {}) {
  const update = {};

  if (typeof patch.venueName === 'string') update.venue_name = patch.venueName.trim();
  if (Array.isArray(patch.venueAliases)) update.venue_aliases = patch.venueAliases;
  if (typeof patch.earnRate === 'number') update.earn_rate = patch.earnRate;
  if (typeof patch.welcomeBonus === 'number') update.welcome_bonus = patch.welcomeBonus;
  if (typeof patch.receiptWindowHours === 'number') update.receipt_window_hours = patch.receiptWindowHours;
  if (typeof patch.minSpendAmount === 'number') update.min_spend_amount = patch.minSpendAmount;
  if (typeof patch.maxSpendAmount === 'number') update.max_spend_amount = patch.maxSpendAmount;
  if (typeof patch.dailyStaffPointLimit === 'number') update.daily_staff_point_limit = patch.dailyStaffPointLimit;
  if (typeof patch.dualConfirmationThreshold === 'number') update.dual_confirmation_threshold = patch.dualConfirmationThreshold;
  if (typeof patch.highAmountMultiplier === 'number') update.high_amount_multiplier = patch.highAmountMultiplier;
  if (typeof patch.velocityWindowMinutes === 'number') update.velocity_window_minutes = patch.velocityWindowMinutes;
  if (typeof patch.velocityThreshold === 'number') update.velocity_threshold = patch.velocityThreshold;
  if (typeof patch.repeatPairThreshold === 'number') update.repeat_pair_threshold = patch.repeatPairThreshold;
  if (typeof patch.concentrationThreshold === 'number') update.concentration_threshold = patch.concentrationThreshold;
  if (patch.operatingHours && typeof patch.operatingHours === 'object') {
    if (typeof patch.operatingHours.opensAtHour === 'number') update.opens_at_hour = patch.operatingHours.opensAtHour;
    if (typeof patch.operatingHours.closesAtHour === 'number') update.closes_at_hour = patch.operatingHours.closesAtHour;
  }

  update.updated_at = new Date().toISOString();
  return update;
}

export function makeInviteCode() {
  return `GI-${randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`;
}
