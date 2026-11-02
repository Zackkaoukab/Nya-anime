import { createHash } from 'node:crypto';
import manifest from './manifest.json' with { type: 'json' };
const base = 'https://nyaa.si';
const timeout = 10000;
const xmlDecode = x => String(x || '').replace(/&(?:amp|lt|gt|quot|apos|#(\d+)|#x([\da-f]+));/gi, (all,dec,hex) => dec ? String.fromCodePoint(Number(dec)) : hex ? String.fromCodePoint(parseInt(hex,16)) : ({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'"}[all] || all));
const norm = x => String(x||'').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const field = (xml, tag) => xmlDecode(xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`,'i'))?.[1]?.replace(/^<!\[CDATA\[|\]\]>$/g,'') || '');
async function get(url, binary=false) {
  const res = await fetch(url, { headers: {'User-Agent':'Mozilla/5.0 (compatible; StremioAnimeAddon/2.0)','Accept':'application/rss+xml, application/json, */*'}, signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`Upstream ${res.status}: ${new URL(url).host}`);
  return binary ? Buffer.from(await res.arrayBuffer()) : res.text();
}
function parseId(id) {
  const m = id.match(/^(tt\d+|kitsu:\d+)(?::(\d+):(\d+))?$/);
  if (!m) return null;
  return { key:m[1], season:m[2] === undefined ? null : Number(m[2]), episode:m[3] === undefined ? null : Number(m[3]) };
}
async function titlesFor(key, type) {
  if (key.startsWith('kitsu:')) {
    const a = JSON.parse(await get(`https://kitsu.io/api/edge/anime/${key.slice(6)}`)).data?.attributes || {};
    return [...new Set([a.titles?.en_jp,a.titles?.en,a.titles?.ja_jp,a.canonicalTitle].filter(Boolean))];
  }
  const id = key;
  const meta = JSON.parse(await get(`https://v3-cinemeta.strem.io/meta/${type === 'movie' ? 'movie':'series'}/${id}.json`)).meta || {};
  return [...new Set([meta.name,meta.originalName].filter(Boolean))];
}
function episodeMatches(release, season, episode) {
  if (episode == null) return true;
  const s=String(season).padStart(2,'0'), e=String(episode).padStart(2,'0');
  const patterns=[new RegExp(`\\bS${s}E${e}\\b`,'i'),new RegExp(`\\b${season}x${e}\\b`,'i'),new RegExp(`(?:^|[^0-9])0*${episode}(?:v\\d+)?(?=$|[^0-9])`,'i')];
  return patterns.some(r=>r.test(release));
}
function titleMatches(release, title) {
  const r=norm(release), words=norm(title).split(' ').filter(w=>w.length>1);
  return words.length>0 && words.every(w=>r.split(' ').includes(w));
}
function parseRss(xml) {
  return [...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)].map(m=>({
    title:field(m[1],'title'), link:field(m[1],'link'),
    seeders:Number(field(m[1],'nyaa:seeders')||0),
    magnet:field(m[1],'magnetURI'),
    enclosure:xmlDecode(m[1].match(/<enclosure[^>]*url=["']([^"']+)/i)?.[1]||'')
  }));
}
function hashFromMagnet(magnet) {
  const hash=magnet.match(/(?:\?|&)xt=urn:btih:([a-f0-9]{40})(?:&|$)/i)?.[1];
  return hash?.toLowerCase() || null;
}
function torrentInfoHash(buf) {
  let i=0, start=-1,end=-1;
  const str=()=>{let n='';while(i<buf.length && buf[i]>=48 && buf[i]<=57)n+=String.fromCharCode(buf[i++]);if(!n||buf[i++]!==58)throw Error('Bad torrent');const len=Number(n),s=i;i+=len;if(i>buf.length)throw Error('Bad length');return buf.subarray(s,i).toString('utf8')};
  const parse=()=>{const c=buf[i++];if(c===105){while(i<buf.length&&buf[i]!==101)i++;i++;}else if(c===108){while(i<buf.length&&buf[i]!==101)parse();i++;}else if(c===100){while(i<buf.length&&buf[i]!==101){const k=str(),a=i;parse();if(k==='info'){start=a;end=i}}i++;}else{i--;str();}};
  parse();if(start<0)throw Error('Missing info');return createHash('sha1').update(buf.subarray(start,end)).digest('hex');
}
async function toStream(item) {
  let hash=hashFromMagnet(item.magnet);
  if (!hash) {
    const url=item.enclosure.startsWith(base+'/download/') ? item.enclosure : item.link.replace('/view/','/download/').replace(/\/?$/,'.torrent');
    if (!url.startsWith(base+'/download/')) return null;
    const bytes=await get(url,true);
    if(bytes.length>2_000_000)return null;
    hash=torrentInfoHash(bytes);
  }
  const q=item.title.match(/2160p|1080p|720p|480p/i)?.[0] || 'Anime';
  return {name:`Nyaa ${q}`,title:`${item.title}\nSeeders: ${item.seeders}`,infoHash:hash,sources:['tracker:udp://tracker.opentrackr.org:1337/announce']};
}
async function streams(id,type) {
  const parsed=parseId(id);if(!parsed)return [];
  if(type!=='movie' && parsed.episode===null)return [];
  const titles=await titlesFor(parsed.key,type);
  if(!titles.length)return [];
  const queries=[...new Set(titles.flatMap(t=>parsed.episode===null?[t]:[`${t} ${String(parsed.episode).padStart(2,'0')}`,`${t} S${String(parsed.season).padStart(2,'0')}E${String(parsed.episode).padStart(2,'0')}`]))].slice(0,4);
  const rss=await Promise.allSettled(queries.map(q=>get(`${base}/?page=rss&c=1_0&f=0&q=${encodeURIComponent(q)}`)));
  const all=rss.filter(x=>x.status==='fulfilled').flatMap(x=>parseRss(x.value));
  const seen=new Set();
  const matches=all.filter(x=>{if(!titles.some(t=>titleMatches(x.title,t))||!episodeMatches(x.title,parsed.season,parsed.episode))return false;const k=x.link||x.title;if(seen.has(k))return false;seen.add(k);return true;}).sort((a,b)=>b.seeders-a.seeders).slice(0,15);
  const results=await Promise.allSettled(matches.map(toStream));
  return results.filter(x=>x.status==='fulfilled'&&x.value).map(x=>x.value);
}
export async function respond(path) {
  if(path==='/'||path==='/health')return {status:200,body:{ok:true,name:manifest.name,manifest:'/manifest.json'}};
  if(path==='/manifest.json')return {status:200,body:manifest};
  const m=path.match(/^\/stream\/(series|movie|anime)\/([^/]+)\.json$/);
  if(!m)return {status:404,body:{error:'Not found'}};
  try {return {status:200,body:{streams:await streams(decodeURIComponent(m[2]),m[1])}};}
  catch(e){console.error('Nyaa stream error:',e);return {status:200,body:{streams:[]}};}
}
