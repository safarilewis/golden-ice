const port = process.env.PORT || 8787;

function json(response, status = 200) {
  return new Response(JSON.stringify(response, null, 2), {
    status,
    headers: {
      'content-type': 'application/json',
    },
  });
}

function parseReceipt(body) {
  const amount = Number(body?.spendAmount ?? 0);
  const venueText = String(body?.venueText ?? '');
  const receiptDate = body?.receiptDate ?? new Date().toISOString();
  const duplicate = Boolean(body?.duplicate);

  return {
    extractedAmount: amount,
    extractedDate: receiptDate,
    venueMatched: venueText.toLowerCase().includes('golden ice'),
    dateValid: true,
    duplicate,
    amountInRange: amount >= 5 && amount <= 2000,
    blockingReason: duplicate ? 'Duplicate receipt detected by backend hash check.' : null,
    warnings: [],
    venueText,
  };
}

if (typeof Bun !== 'undefined') {
  Bun.serve({
    port,
    fetch: async (request) => {
      const url = new URL(request.url);

      if (request.method === 'GET' && url.pathname === '/health') {
        return json({ ok: true, service: 'goldenice-backend' });
      }

      if (request.method === 'POST' && url.pathname === '/receipt/verify') {
        const body = await request.json();
        return json({ verification: parseReceipt(body) });
      }

      if (request.method === 'POST' && url.pathname === '/fraud/evaluate') {
        const body = await request.json();
        const spendAmount = Number(body?.transaction?.spendAmount ?? 0);
        return json({
          alerts: spendAmount > 800 ? [{ alertType: 'high_amount', details: { spendAmount } }] : [],
        });
      }

      if (request.method === 'POST' && url.pathname === '/digest/nightly') {
        return json({
          message: 'Nightly digest scaffold ready for owner push notifications.',
        });
      }

      return json({ error: 'Not found' }, 404);
    },
  });
} else {
  console.log(
    JSON.stringify(
      {
        info: 'This file is a runtime scaffold. Run it with Bun or replace with Express/Fastify before production use.',
        suggestedEndpoints: ['/health', '/receipt/verify', '/fraud/evaluate', '/digest/nightly'],
      },
      null,
      2
    )
  );
}
