import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildReceiptVerification,
  defaultSettings,
  generateBarcode,
  isWithinHours,
  makeInviteCode,
  normalizeSettingsPatch,
} from './domain.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.resolve(__dirname, '../.env');

if (fs.existsSync(envPath)) {
  const envFile = fs.readFileSync(envPath, 'utf8');
  for (const line of envFile.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim().replace(/^['"]|['"]$/g, '');
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);

function isConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY && SUPABASE_SERVICE_ROLE_KEY);
}

function getCorsHeaders(origin) {
  const allowAll = ALLOWED_ORIGINS.includes('*');
  const allowedOrigin = allowAll ? origin || '*' : origin && ALLOWED_ORIGINS.includes(origin) ? origin : '';

  return {
    'access-control-allow-origin': allowedOrigin || ALLOWED_ORIGINS[0] || '*',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET,POST,PATCH,OPTIONS',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
}

function sendJson(res, status, payload, origin) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    ...getCorsHeaders(origin),
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendEmpty(res, status, origin) {
  res.writeHead(status, getCorsHeaders(origin));
  res.end();
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
  }

  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw createHttpError(400, 'Request body must be valid JSON.');
  }
}

function createHttpError(status, message, details) {
  const error = new Error(message);
  error.status = status;
  error.details = details;
  return error;
}

function getAuthToken(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) {
    throw createHttpError(401, 'Missing bearer token.');
  }

  return header.slice('Bearer '.length).trim();
}

async function supabaseRequest(path, { method = 'GET', body, accessToken, useServiceRole = false } = {}) {
  if (!isConfigured()) {
    throw createHttpError(500, 'Backend is missing Supabase configuration.');
  }

  const headers = {
    apikey: useServiceRole ? SUPABASE_SERVICE_ROLE_KEY : SUPABASE_ANON_KEY,
    Authorization: `Bearer ${useServiceRole ? SUPABASE_SERVICE_ROLE_KEY : accessToken}`,
  };

  if (body !== undefined) {
    headers['content-type'] = 'application/json';
  }

  const response = await fetch(`${SUPABASE_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  const payload = text ? safeJsonParse(text) : null;

  if (!response.ok) {
    const message =
      payload?.message ||
      payload?.error_description ||
      payload?.error ||
      payload?.msg ||
      `Supabase request failed with status ${response.status}.`;
    throw createHttpError(response.status, message, payload);
  }

  return payload;
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function buildRestPath(table, options = {}) {
  const params = new URLSearchParams();
  params.set('select', options.select || '*');

  if (options.filters) {
    for (const [key, value] of Object.entries(options.filters)) {
      if (value !== undefined && value !== null && value !== '') {
        params.set(key, value);
      }
    }
  }

  if (options.order) {
    params.set('order', options.order);
  }

  if (options.limit) {
    params.set('limit', String(options.limit));
  }

  return `/rest/v1/${table}?${params.toString()}`;
}

async function selectRows(table, options = {}) {
  return supabaseRequest(buildRestPath(table, options), { useServiceRole: true });
}

async function selectSingle(table, options = {}) {
  const rows = await selectRows(table, { ...options, limit: 1 });
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

async function insertRows(table, payload, options = {}) {
  const select = options.select || '*';
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/${table}?select=${encodeURIComponent(select)}`,
    {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'content-type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify(payload),
    }
  );

  const text = await response.text();
  const data = text ? safeJsonParse(text) : null;
  if (!response.ok) {
    throw createHttpError(
      response.status,
      data?.message || data?.error_description || data?.error || 'Insert failed.',
      data
    );
  }

  if (options.single) {
    return Array.isArray(data) ? data[0] ?? null : data;
  }

  return data;
}

async function updateRows(table, filters, payload, options = {}) {
  const params = new URLSearchParams();
  params.set('select', options.select || '*');
  for (const [key, value] of Object.entries(filters)) {
    params.set(key, value);
  }

  const response = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${params.toString()}`, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'content-type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  const data = text ? safeJsonParse(text) : null;
  if (!response.ok) {
    throw createHttpError(
      response.status,
      data?.message || data?.error_description || data?.error || 'Update failed.',
      data
    );
  }

  if (options.single) {
    return Array.isArray(data) ? data[0] ?? null : data;
  }

  return data;
}

async function callRpc(name, payload) {
  return supabaseRequest(`/rest/v1/rpc/${name}`, {
    method: 'POST',
    body: payload,
    useServiceRole: true,
  });
}

async function getAuthenticatedUser(req) {
  const accessToken = getAuthToken(req);
  const user = await supabaseRequest('/auth/v1/user', {
    accessToken,
    useServiceRole: false,
  });

  return {
    accessToken,
    user,
  };
}

function mapProfile(row) {
  return {
    id: row.id,
    phone: row.phone || '',
    displayName: row.display_name || row.phone || row.id,
    role: row.role,
    barcode: row.barcode || generateBarcode(row.phone || row.id),
    pointsBalance: row.points_balance || 0,
    tier: row.tier || 'bronze',
    lifetimeSpend: row.lifetime_spend || 0,
    isActive: row.is_active ?? true,
    createdAt: row.created_at,
  };
}

function mapTransaction(row) {
  return {
    id: row.id,
    customerId: row.customer_id,
    staffId: row.staff_id,
    type: row.type,
    points: row.points,
    spendAmount: row.spend_amount,
    source: row.source || 'manual',
    receiptImageUrl: row.receipt_image_url,
    receiptVenueMatch: row.receipt_venue_match,
    receiptDateMatch: row.receipt_date_match,
    verification: row.verification,
    flag: row.flag,
    description: row.description || 'Ledger entry',
    createdAt: row.created_at,
  };
}

function mapReward(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description || '',
    pointsCost: row.points_cost,
    category: row.category || 'reward',
    tierRequired: row.tier_required,
    isActive: row.is_active,
    quantityLimit: row.quantity_limit,
    quantityUsed: row.quantity_used,
    imageUrl: row.image_url,
    createdAt: row.created_at,
  };
}

function mapRedemption(row) {
  return {
    id: row.id,
    customerId: row.customer_id,
    rewardId: row.reward_id,
    transactionId: row.transaction_id,
    redemptionCode: row.redemption_code,
    status: row.status,
    fulfilledBy: row.fulfilled_by,
    fulfilledAt: row.fulfilled_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

function mapAlert(row) {
  return {
    id: row.id,
    transactionId: row.transaction_id,
    staffId: row.staff_id,
    customerId: row.customer_id,
    alertType: row.alert_type,
    details: row.details || {},
    status: row.status,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    createdAt: row.created_at,
  };
}

function mapInvite(row) {
  return {
    id: row.id,
    code: row.code,
    createdBy: row.created_by,
    usedBy: row.used_by,
    usedAt: row.used_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

function mapSettings(row) {
  if (!row) {
    return defaultSettings;
  }

  return {
    venueName: row.venue_name,
    venueAliases: row.venue_aliases,
    earnRate: row.earn_rate,
    welcomeBonus: row.welcome_bonus,
    receiptWindowHours: row.receipt_window_hours,
    minSpendAmount: row.min_spend_amount,
    maxSpendAmount: row.max_spend_amount,
    operatingHours: {
      opensAtHour: row.opens_at_hour,
      closesAtHour: row.closes_at_hour,
    },
    dailyStaffPointLimit: row.daily_staff_point_limit,
    dualConfirmationThreshold: row.dual_confirmation_threshold,
    highAmountMultiplier: row.high_amount_multiplier,
    velocityWindowMinutes: row.velocity_window_minutes,
    velocityThreshold: row.velocity_threshold,
    repeatPairThreshold: row.repeat_pair_threshold,
    concentrationThreshold: row.concentration_threshold,
  };
}

function getAvailableRoles(profile) {
  if (!profile) {
    return [];
  }

  if (profile.role === 'owner') {
    return ['customer', 'owner'];
  }

  if (profile.role === 'staff') {
    return ['customer', 'staff'];
  }

  return ['customer'];
}

async function requireRole(req, allowedRoles) {
  const { user } = await getAuthenticatedUser(req);
  const profile = await getProfileById(user.id);

  if (!profile) {
    throw createHttpError(404, 'Profile not found.');
  }

  if (!allowedRoles.includes(profile.role)) {
    throw createHttpError(403, 'You do not have access to this action.');
  }

  return { user, profile };
}

function buildFraudAlerts({ settings, transaction, customer, staffTransactions, pairTransactions, nightlyTransactions }) {
  const alerts = [];
  const date = new Date(transaction.createdAt);
  const hour = date.getHours();
  const rollingAverage =
    nightlyTransactions.reduce((sum, item) => sum + (item.spendAmount || 0), 0) /
      Math.max(nightlyTransactions.length, 1) || 0;
  const staffIssuedPoints = nightlyTransactions
    .filter((item) => item.staffId === transaction.staffId)
    .reduce((sum, item) => sum + Math.max(item.points, 0), 0);
  const totalIssuedPoints = nightlyTransactions.reduce((sum, item) => sum + Math.max(item.points, 0), 0);

  const entries = [
    [
      rollingAverage > 0 && (transaction.spendAmount || 0) > rollingAverage * settings.highAmountMultiplier,
      'high_amount',
      { spendAmount: transaction.spendAmount || 0, rollingAverage },
    ],
    [
      pairTransactions.length >= settings.repeatPairThreshold,
      'repeat_pair',
      { pairCount: pairTransactions.length, customer: customer.displayName },
    ],
    [
      !isWithinHours(hour, settings.operatingHours.opensAtHour, settings.operatingHours.closesAtHour),
      'off_hours',
      { hour },
    ],
    [
      transaction.verification?.duplicate || false,
      'duplicate_receipt',
      { duplicate: true },
    ],
    [
      totalIssuedPoints > 0 && staffIssuedPoints / totalIssuedPoints > settings.concentrationThreshold,
      'concentration',
      { concentration: Number((staffIssuedPoints / totalIssuedPoints).toFixed(2)) },
    ],
  ];

  for (const [triggered, alertType, details] of entries) {
    if (!triggered || !alertType) {
      continue;
    }

    alerts.push({
      id: makeInviteCode(),
      transactionId: transaction.id,
      staffId: transaction.staffId,
      customerId: transaction.customerId,
      alertType,
      details,
      status: 'open',
      reviewedBy: null,
      reviewedAt: null,
      createdAt: transaction.createdAt,
    });
  }

  if (staffTransactions.length >= settings.velocityThreshold) {
    alerts.push({
      id: makeInviteCode(),
      transactionId: transaction.id,
      staffId: transaction.staffId,
      customerId: transaction.customerId,
      alertType: 'velocity',
      details: {
        velocityWindowMinutes: settings.velocityWindowMinutes,
        transactionCount: staffTransactions.length,
      },
      status: 'open',
      reviewedBy: null,
      reviewedAt: null,
      createdAt: transaction.createdAt,
    });
  }

  return alerts;
}

async function getSettings() {
  const row = await selectSingle('venue_settings');
  return mapSettings(row);
}

async function getProfileById(userId) {
  const row = await selectSingle('profiles', {
    filters: {
      id: `eq.${userId}`,
    },
  });

  return row ? mapProfile(row) : null;
}

async function fetchBootstrapData(profile, requestedScope) {
  const settings = await getSettings();
  const availableRoles = getAvailableRoles(profile);
  const scope = requestedScope && availableRoles.includes(requestedScope) ? requestedScope : availableRoles.length === 1 ? availableRoles[0] : 'chooser';

  if (scope === 'chooser') {
    return {
      currentUserId: profile.id,
      profiles: [profile],
      invites: [],
      transactions: [],
      rewards: [],
      redemptions: [],
      alerts: [],
      settings,
    };
  }

  if (scope === 'customer') {
    const [transactions, rewards, redemptions] = await Promise.all([
      selectRows('transactions', {
        filters: {
          customer_id: `eq.${profile.id}`,
        },
        order: 'created_at.desc',
        limit: 50,
      }),
      selectRows('rewards', {
        filters: {
          is_active: 'eq.true',
        },
        order: 'created_at.desc',
      }),
      selectRows('redemptions', {
        filters: {
          customer_id: `eq.${profile.id}`,
        },
        order: 'created_at.desc',
        limit: 50,
      }),
    ]);

    return {
      currentUserId: profile.id,
      profiles: [profile],
      invites: [],
      transactions: transactions.map(mapTransaction),
      rewards: rewards.map(mapReward),
      redemptions: redemptions.map(mapRedemption),
      alerts: [],
      settings,
    };
  }

  if (scope === 'staff') {
    const [profiles, transactions, rewards, redemptions] = await Promise.all([
      selectRows('profiles', {
        filters: {
          role: 'eq.customer',
        },
        order: 'created_at.desc',
        limit: 100,
      }),
      selectRows('transactions', {
        order: 'created_at.desc',
        limit: 100,
      }),
      selectRows('rewards', {
        filters: {
          is_active: 'eq.true',
        },
        order: 'created_at.desc',
      }),
      selectRows('redemptions', {
        order: 'created_at.desc',
        limit: 100,
      }),
    ]);

    return {
      currentUserId: profile.id,
      profiles: [profile, ...profiles.map(mapProfile).filter((item) => item.id !== profile.id)],
      invites: [],
      transactions: transactions.map(mapTransaction),
      rewards: rewards.map(mapReward),
      redemptions: redemptions.map(mapRedemption),
      alerts: [],
      settings,
    };
  }

  const [profiles, invites, transactions, rewards, redemptions, alerts] = await Promise.all([
    selectRows('profiles', { order: 'created_at.desc', limit: 200 }),
    selectRows('staff_invites', { order: 'created_at.desc', limit: 50 }),
    selectRows('transactions', { order: 'created_at.desc', limit: 200 }),
    selectRows('rewards', { order: 'created_at.desc', limit: 100 }),
    selectRows('redemptions', { order: 'created_at.desc', limit: 100 }),
    selectRows('fraud_alerts', { order: 'created_at.desc', limit: 100 }),
  ]);

  return {
    currentUserId: profile.id,
    profiles: profiles.map(mapProfile),
    invites: invites.map(mapInvite),
    transactions: transactions.map(mapTransaction),
    rewards: rewards.map(mapReward),
    redemptions: redemptions.map(mapRedemption),
    alerts: alerts.map(mapAlert),
    settings,
  };
}

async function handleProfile(req, res, origin) {
  const { user } = await getAuthenticatedUser(req);
  const profile = await getProfileById(user.id);
  sendJson(res, 200, { profile }, origin);
}

async function handleAccountSetup(req, res, origin) {
  const body = await readBody(req);
  const draft = body?.draft || {};
  const { user } = await getAuthenticatedUser(req);

  const existing = await getProfileById(user.id);
  if (existing) {
    sendJson(res, 200, { profile: existing }, origin);
    return;
  }

  const displayName = String(draft.displayName || '').trim();
  if (!displayName) {
    throw createHttpError(400, 'Enter your name to create an account.');
  }

  if (draft.role === 'owner') {
    throw createHttpError(400, 'Owner accounts must be pre-created in Supabase.');
  }

  const settings = await getSettings();
  const phone = user.phone || draft.phone || '';
  const pointsBalance = draft.role === 'customer' ? settings.welcomeBonus : 0;

  await insertRows(
    'profiles',
    {
      id: user.id,
      phone,
      display_name: displayName,
      role: 'customer',
      barcode: generateBarcode(phone || user.id),
      points_balance: pointsBalance,
      tier: 'bronze',
      lifetime_spend: 0,
      is_active: true,
    },
    { single: false }
  );

  if (draft.role === 'customer' && settings.welcomeBonus > 0) {
    await insertRows('transactions', {
      customer_id: user.id,
      type: 'bonus',
      points: settings.welcomeBonus,
      source: 'welcome',
      description: 'Welcome bonus issued on signup.',
    });
  }

  if (draft.role === 'staff') {
    if (!String(draft.inviteCode || '').trim()) {
      throw createHttpError(400, 'Staff invite code is required.');
    }

    await callRpc('accept_staff_invite', {
      code_input: String(draft.inviteCode).trim(),
      user_id: user.id,
    });
  }

  const profile = await getProfileById(user.id);
  if (!profile) {
    throw createHttpError(500, 'Profile was created but could not be loaded.');
  }

  sendJson(res, 200, { profile }, origin);
}

async function handleBootstrap(req, res, origin, url) {
  const { user } = await getAuthenticatedUser(req);
  const profile = await getProfileById(user.id);
  if (!profile) {
    sendJson(
      res,
      200,
      {
        currentUserId: user.id,
        profiles: [],
        invites: [],
        transactions: [],
        rewards: [],
        redemptions: [],
        alerts: [],
        settings: defaultSettings,
      },
      origin
    );
    return;
  }

  const scopeParam = url.searchParams.get('scope');
  const allowedScopes = new Set(['chooser', 'customer', 'staff', 'owner']);
  const requestedScope = allowedScopes.has(scopeParam || '') ? scopeParam : null;
  const payload = await fetchBootstrapData(profile, requestedScope);
  sendJson(res, 200, payload, origin);
}

async function handleUpdateProfile(req, res, origin) {
  const body = await readBody(req);
  const { user } = await getAuthenticatedUser(req);
  const displayName = String(body?.displayName || '').trim();

  if (!displayName) {
    throw createHttpError(400, 'Name cannot be empty.');
  }

  const updated = await updateRows(
    'profiles',
    {
      id: `eq.${user.id}`,
    },
    {
      display_name: displayName,
    },
    { single: true }
  );

  sendJson(res, 200, { profile: mapProfile(updated) }, origin);
}

async function handleReceiptVerify(req, res, origin) {
  const body = await readBody(req);
  const settings = await getSettings();
  const verification = buildReceiptVerification({
    spendAmount: Number(body?.spendAmount || 0),
    extractedDate: body?.receiptDate || new Date().toISOString(),
    venueText: String(body?.venueText || ''),
    settings,
    duplicate: Boolean(body?.duplicate),
  });

  sendJson(res, 200, { verification }, origin);
}

async function handleAwardPoints(req, res, origin) {
  const body = await readBody(req);
  const { user } = await getAuthenticatedUser(req);
  const actorProfile = await getProfileById(user.id);

  if (!actorProfile || !['staff', 'owner'].includes(actorProfile.role)) {
    throw createHttpError(403, 'Only staff or owners can award points.');
  }

  if (body.staffId && body.staffId !== actorProfile.id) {
    throw createHttpError(403, 'Staff ID does not match the authenticated account.');
  }

  const settings = await getSettings();
  const verification = buildReceiptVerification({
    spendAmount: Number(body?.spendAmount || 0),
    extractedDate: body?.receiptDate || new Date().toISOString(),
    venueText: String(body?.venueText || ''),
    settings,
    duplicate: Boolean(body?.duplicate),
  });

  if (verification.blockingReason) {
    throw createHttpError(400, verification.blockingReason, { verification });
  }

  const transactionRow = await callRpc('award_points', {
    customer_id_input: body.customerId,
    staff_id_input: actorProfile.id,
    spend_amount_input: Number(body.spendAmount),
    receipt_asset_input: body.receiptAssetUrl,
    verification_input: verification,
  });

  const transaction = mapTransaction(transactionRow);
  const customer = await getProfileById(body.customerId);

  if (customer) {
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const dayStartIso = dayStart.toISOString();

    const nightlyRows = await selectRows('transactions', {
      filters: {
        created_at: `gte.${dayStartIso}`,
      },
      order: 'created_at.asc',
      limit: 500,
    });

    const nightlyTransactions = nightlyRows.map(mapTransaction);
    const alerts = buildFraudAlerts({
      settings,
      transaction,
      customer,
      staffTransactions: nightlyTransactions.filter((item) => item.staffId === actorProfile.id),
      pairTransactions: nightlyTransactions.filter(
        (item) => item.staffId === actorProfile.id && item.customerId === customer.id
      ),
      nightlyTransactions,
    });

    if (alerts.length > 0) {
      await insertRows(
        'fraud_alerts',
        alerts.map((alert) => ({
          transaction_id: alert.transactionId,
          staff_id: alert.staffId,
          customer_id: alert.customerId,
          alert_type: alert.alertType,
          details: alert.details,
          status: alert.status,
          reviewed_by: alert.reviewedBy,
          reviewed_at: alert.reviewedAt,
          created_at: alert.createdAt,
        }))
      );
    }
  }

  sendJson(res, 200, { transaction, verification }, origin);
}

async function handleFraudEvaluate(req, res, origin) {
  const body = await readBody(req);
  const transaction = body?.transaction || {};
  const alerts = Number(transaction?.spendAmount || 0) > 800
    ? [{ alertType: 'high_amount', details: { spendAmount: Number(transaction.spendAmount || 0) } }]
    : [];
  sendJson(res, 200, { alerts }, origin);
}

async function handleDigestNightly(_req, res, origin) {
  sendJson(
    res,
    200,
    {
      message: 'Nightly digest endpoint is ready for scheduled jobs.',
    },
    origin
  );
}

async function handleRedeemReward(req, res, origin) {
  const body = await readBody(req);
  const { profile } = await requireRole(req, ['customer', 'staff', 'owner']);

  const redemptionRow = await callRpc('redeem_reward', {
    customer_id_input: profile.id,
    reward_id_input: body.rewardId,
  });

  sendJson(res, 200, { redemption: mapRedemption(redemptionRow) }, origin);
}

async function handleFulfillRedemption(req, res, origin, redemptionId) {
  const { profile } = await requireRole(req, ['staff', 'owner']);
  const updated = await updateRows(
    'redemptions',
    { id: `eq.${redemptionId}` },
    {
      status: 'fulfilled',
      fulfilled_by: profile.id,
      fulfilled_at: new Date().toISOString(),
    },
    { single: true }
  );

  sendJson(res, 200, { redemption: mapRedemption(updated) }, origin);
}

async function handleReviewAlert(req, res, origin, alertId) {
  const body = await readBody(req);
  const { profile } = await requireRole(req, ['owner']);
  const nextStatus = body.status;
  if (!['reviewed', 'dismissed', 'confirmed'].includes(nextStatus)) {
    throw createHttpError(400, 'Invalid alert status.');
  }

  const updated = await updateRows(
    'fraud_alerts',
    { id: `eq.${alertId}` },
    {
      status: nextStatus,
      reviewed_by: profile.id,
      reviewed_at: new Date().toISOString(),
    },
    { single: true }
  );

  sendJson(res, 200, { alert: mapAlert(updated) }, origin);
}

async function handleCreateInvite(req, res, origin) {
  const body = await readBody(req);
  const { profile } = await requireRole(req, ['owner']);
  const expiresAt =
    typeof body.expiresAt === 'string' && body.expiresAt
      ? body.expiresAt
      : new Date(Date.now() + 1000 * 60 * 60 * 24 * 14).toISOString();

  const invite = await insertRows(
    'staff_invites',
    {
      code: makeInviteCode(),
      created_by: profile.id,
      expires_at: expiresAt,
    },
    { single: true }
  );

  sendJson(res, 200, { invite: mapInvite(invite) }, origin);
}

async function handleUpdateStaffStatus(req, res, origin, staffId) {
  const body = await readBody(req);
  await requireRole(req, ['owner']);
  const updated = await updateRows(
    'profiles',
    { id: `eq.${staffId}` },
    { is_active: Boolean(body.isActive) },
    { single: true }
  );

  sendJson(res, 200, { profile: mapProfile(updated) }, origin);
}

async function handleToggleReward(req, res, origin, rewardId) {
  const body = await readBody(req);
  await requireRole(req, ['owner']);
  const updated = await updateRows(
    'rewards',
    { id: `eq.${rewardId}` },
    { is_active: Boolean(body.isActive) },
    { single: true }
  );

  sendJson(res, 200, { reward: mapReward(updated) }, origin);
}

async function handleUpdateSettings(req, res, origin) {
  const body = await readBody(req);
  await requireRole(req, ['owner']);
  const settingsRow = await selectSingle('venue_settings');
  const patch = normalizeSettingsPatch(body.patch || {});

  const updated = settingsRow
    ? await updateRows('venue_settings', { id: `eq.${settingsRow.id}` }, patch, { single: true })
    : await insertRows(
        'venue_settings',
        {
          venue_name: defaultSettings.venueName,
          venue_aliases: defaultSettings.venueAliases,
          earn_rate: defaultSettings.earnRate,
          welcome_bonus: defaultSettings.welcomeBonus,
          receipt_window_hours: defaultSettings.receiptWindowHours,
          min_spend_amount: defaultSettings.minSpendAmount,
          max_spend_amount: defaultSettings.maxSpendAmount,
          opens_at_hour: defaultSettings.operatingHours.opensAtHour,
          closes_at_hour: defaultSettings.operatingHours.closesAtHour,
          daily_staff_point_limit: defaultSettings.dailyStaffPointLimit,
          dual_confirmation_threshold: defaultSettings.dualConfirmationThreshold,
          high_amount_multiplier: defaultSettings.highAmountMultiplier,
          velocity_window_minutes: defaultSettings.velocityWindowMinutes,
          velocity_threshold: defaultSettings.velocityThreshold,
          repeat_pair_threshold: defaultSettings.repeatPairThreshold,
          concentration_threshold: defaultSettings.concentrationThreshold,
          ...patch,
        },
        { single: true }
      );

  sendJson(res, 200, { settings: mapSettings(updated) }, origin);
}

async function handleRevokeTransaction(req, res, origin, transactionId) {
  const body = await readBody(req);
  const { profile } = await requireRole(req, ['owner']);
  const transactionRow = await selectSingle('transactions', {
    filters: { id: `eq.${transactionId}` },
  });

  if (!transactionRow) {
    throw createHttpError(404, 'Transaction not found.');
  }

  const transaction = mapTransaction(transactionRow);
  const reversal = await insertRows(
    'transactions',
    {
      customer_id: transaction.customerId,
      staff_id: profile.id,
      type: 'adjust',
      points: -transaction.points,
      spend_amount: transaction.spendAmount,
      source: 'manual',
      receipt_image_url: transaction.receiptImageUrl,
      receipt_venue_match: transaction.receiptVenueMatch,
      receipt_date_match: transaction.receiptDateMatch,
      verification: transaction.verification,
      flag: transaction.flag,
      description: `Owner reversal: ${String(body.reason || 'Manual adjustment')}`,
    },
    { single: true }
  );

  const customer = await selectSingle('profiles', {
    filters: { id: `eq.${transaction.customerId}` },
  });

  if (customer) {
    await updateRows(
      'profiles',
      { id: `eq.${transaction.customerId}` },
      {
        points_balance: Math.max(0, Number(customer.points_balance || 0) - transaction.points),
        lifetime_spend:
          transaction.type === 'earn' && transaction.spendAmount
            ? Math.max(0, Number(customer.lifetime_spend || 0) - Number(transaction.spendAmount))
            : Number(customer.lifetime_spend || 0),
      }
    );
  }

  sendJson(res, 200, { transaction: mapTransaction(reversal) }, origin);
}

async function route(req, res) {
  const origin = req.headers.origin || '';
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'OPTIONS') {
    sendEmpty(res, 204, origin);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(
      res,
      200,
      {
        ok: true,
        service: 'goldenice-backend',
        configured: isConfigured(),
      },
      origin
    );
    return;
  }

  try {
    if (req.method === 'GET' && url.pathname === '/profile') {
      await handleProfile(req, res, origin);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/account/setup') {
      await handleAccountSetup(req, res, origin);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/app/bootstrap') {
      await handleBootstrap(req, res, origin, url);
      return;
    }

    if (req.method === 'PATCH' && url.pathname === '/profiles/me') {
      await handleUpdateProfile(req, res, origin);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/receipt/verify') {
      await handleReceiptVerify(req, res, origin);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/points/award') {
      await handleAwardPoints(req, res, origin);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/fraud/evaluate') {
      await handleFraudEvaluate(req, res, origin);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/digest/nightly') {
      await handleDigestNightly(req, res, origin);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/rewards/redeem') {
      await handleRedeemReward(req, res, origin);
      return;
    }

    const redemptionMatch =
      req.method === 'POST'
        ? url.pathname.match(/^\/redemptions\/([^/]+)\/fulfill$/)
        : null;
    if (redemptionMatch) {
      await handleFulfillRedemption(req, res, origin, redemptionMatch[1]);
      return;
    }

    const alertMatch = req.method === 'PATCH' ? url.pathname.match(/^\/alerts\/([^/]+)$/) : null;
    if (alertMatch) {
      await handleReviewAlert(req, res, origin, alertMatch[1]);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/staff/invites') {
      await handleCreateInvite(req, res, origin);
      return;
    }

    const staffMatch =
      req.method === 'PATCH' ? url.pathname.match(/^\/staff\/([^/]+)\/status$/) : null;
    if (staffMatch) {
      await handleUpdateStaffStatus(req, res, origin, staffMatch[1]);
      return;
    }

    const rewardMatch =
      req.method === 'PATCH' ? url.pathname.match(/^\/rewards\/([^/]+)$/) : null;
    if (rewardMatch) {
      await handleToggleReward(req, res, origin, rewardMatch[1]);
      return;
    }

    if (req.method === 'PATCH' && url.pathname === '/settings') {
      await handleUpdateSettings(req, res, origin);
      return;
    }

    const revokeMatch =
      req.method === 'POST'
        ? url.pathname.match(/^\/transactions\/([^/]+)\/revoke$/)
        : null;
    if (revokeMatch) {
      await handleRevokeTransaction(req, res, origin, revokeMatch[1]);
      return;
    }

    sendJson(res, 404, { error: 'Not found' }, origin);
  } catch (error) {
    const status = error?.status || 500;
    const message = error instanceof Error ? error.message : 'Unexpected backend error.';
    sendJson(
      res,
      status,
      {
        error: message,
        details: error?.details || null,
      },
      origin
    );
  }
}

const server = http.createServer((req, res) => {
  void route(req, res);
});

server.listen(PORT, HOST, () => {
  console.log(`GoldenIce backend listening on http://${HOST}:${PORT}`);
});
