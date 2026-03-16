// netlify/functions/simplybook.js
// Proxy som vidarebefordrar JSON-RPC-anrop till SimplyBook
// och lägger till korrekt CORS-headers

const SIMPLYBOOK_ENDPOINT = 'https://user-api.simplybook.it/';

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  // Preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: cors, body: 'Method Not Allowed' };
  }

  try {
    const body = event.body;

    // Vidarebefordra headers från klienten (token etc)
    const incoming = event.headers || {};
    const headers  = { 'Content-Type': 'application/json' };
    if (incoming['x-company-login']) headers['X-Company-Login'] = incoming['x-company-login'];
    if (incoming['x-token'])         headers['X-Token']         = incoming['x-token'];

    const response = await fetch(SIMPLYBOOK_ENDPOINT, {
      method:  'POST',
      headers,
      body,
    });

    const text = await response.text();

    return {
      statusCode: response.status,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: text,
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: { message: err.message } }),
    };
  }
};
