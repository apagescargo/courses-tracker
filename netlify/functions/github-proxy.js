const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = process.env.GITHUB_OWNER;
const GITHUB_REPO  = process.env.GITHUB_REPO;
const FILE_PATH    = 'data/prices.json';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
  'Content-Type': 'application/json'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({
        error: 'Variables d\'environnement manquantes : GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO'
      })
    };
  }

  const apiUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${FILE_PATH}`;
  const ghHeaders = {
    'Authorization': `token ${GITHUB_TOKEN}`,
    'Accept':        'application/vnd.github.v3+json',
    'User-Agent':    'courses-tracker'
  };

  // ── GET : lire prices.json ──────────────────────────────────
  if (event.httpMethod === 'GET') {
    const res = await fetch(apiUrl, { headers: ghHeaders });

    if (res.status === 404) {
      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({
          data: { products: [], price_records: [], purchase_history: [] },
          sha: null
        })
      };
    }

    if (!res.ok) {
      return {
        statusCode: res.status,
        headers: CORS,
        body: JSON.stringify({ error: `GitHub API error ${res.status}` })
      };
    }

    const json    = await res.json();
    const decoded = Buffer.from(json.content, 'base64').toString('utf8');
    let data;
    try { data = JSON.parse(decoded); }
    catch { data = { products: [], price_records: [], purchase_history: [] }; }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ data, sha: json.sha })
    };
  }

  // ── PUT : écrire prices.json ────────────────────────────────
  if (event.httpMethod === 'PUT') {
    let payload;
    try { payload = JSON.parse(event.body); }
    catch {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'JSON invalide' }) };
    }

    const { data: newData, sha } = payload;
    const content = Buffer.from(JSON.stringify(newData, null, 2)).toString('base64');

    const body = {
      message: `chore: update prices.json ${new Date().toISOString()}`,
      content
    };
    if (sha) body.sha = sha;

    const res = await fetch(apiUrl, {
      method:  'PUT',
      headers: { ...ghHeaders, 'Content-Type': 'application/json' },
      body:    JSON.stringify(body)
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return {
        statusCode: res.status,
        headers: CORS,
        body: JSON.stringify({ error: err.message || `GitHub API error ${res.status}` })
      };
    }

    const result = await res.json();
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ sha: result.content.sha })
    };
  }

  return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
};
