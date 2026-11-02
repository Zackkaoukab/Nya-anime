import { respond } from '../addon.js';
export default async function handler(req, res) {
  const { status, body } = await respond(new URL(req.url, 'https://example.org').pathname);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=180');
  return res.status(status).json(body);
}
