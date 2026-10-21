// api/remove-bg.js
export default async function handler(req, res) {
  // CORS configuration
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // Key is retrieved safely from Vercel's private environment variables
  const apiKey = process.env.REMOVE_BG_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'REMOVE_BG_API_KEY is not configured in Vercel Environment Variables.'
    });
  }

  try {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (_) {}
    }

    const { image_b64, size = 'auto', type = 'person' } = body || {};
    if (!image_b64) {
      return res.status(400).json({ error: 'Missing image_b64 parameter.' });
    }

    const cleanBase64 = image_b64.replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, '');

    const response = await fetch('https://api.remove.bg/v1.0/removebg', {
      method: 'POST',
      headers: {
        'X-Api-Key': apiKey,
        'Content-Type': 'application/json',
        'Accept': 'image/png'
      },
      body: JSON.stringify({
        image_file_b64: cleanBase64,
        size: size || 'auto',
        type: type || 'person',
        format: 'png'
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(response.status).send(errText);
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    return res.status(200).send(buffer);
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Server error' });
  }
}