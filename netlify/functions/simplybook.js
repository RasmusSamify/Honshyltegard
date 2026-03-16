// netlify/functions/simplybook.js
// Proxy som vidarebefordrar JSON-RPC-anrop till SimplyBook
// och lägger till korrekt CORS-headers

const SIMPLYBOOK_LOGIN   = 'https://user-api.simplybook.me/login/';
const SIMPLYBOOK_MAIN    = 'https://user-api.simplybook.me/';

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Company-Login, X-Token, X-Path',
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
    const body     = event.body;
    const incoming = event.headers || {};

    // Klient skickar X-Path: 'login' för getToken, annars används huvud-URL
    const path     = (incoming['x-path'] || '').toLowerCase();
    const endpoint = path === 'login' ? SIMPLYBOOK_LOGIN : SIMPLYBOOK_MAIN;

    const headers  = { 'Content-Type': 'application/json' };
    if (incoming['x-company-login']) headers['X-Company-Login'] = incoming['x-company-login'];
    if (incoming['x-token'])         headers['X-Token']         = incoming['x-token'];

    const response = await fetch(endpoint, {
      method: 'POST',
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
