import { createServer } from 'node:http';
import { respond } from './addon.js';
createServer(async (req, res) => {
  const {status, body} = await respond(new URL(req.url, 'http://localhost').pathname);
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Access-Control-Allow-Origin':'*'});
  res.end(JSON.stringify(body));
}).listen(Number(process.env.PORT || 3000));
