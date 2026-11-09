// Outlaw Radar — live demand scanner
// GET /api/radar?q=topic&deep=1
// Pulls what real people type and post: Google, YouTube, Bing, DuckDuckGo,
// Amazon and eBay autocomplete, plus Reddit and Hacker News posts.
// No API keys, no cost. Results are cached at the edge for an hour.

const UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';
const enc = encodeURIComponent;

async function fetchText(url, timeout = 7000, headers = {}) {
  const r = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'application/json, text/javascript, */*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      ...headers,
    },
    signal: AbortSignal.timeout(timeout),
    redirect: 'follow',
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.text();
}

async function fetchJSON(url, timeout, headers) {
  const t = await fetchText(url, timeout, headers);
  try {
    return JSON.parse(t);
  } catch {
    throw new Error('blocked or not JSON');
  }
}

// Run one term-fetcher over many terms; succeed if any term works.
async function multi(terms, fn) {
  const res = await Promise.allSettled(terms.map(fn));
  const ok = res.filter((r) => r.status === 'fulfilled');
  if (!ok.length) throw new Error((res[0] && res[0].reason && res[0].reason.message) || 'no results');
  return ok.flatMap((r) => r.value);
}

async function runSource(name, kind, fn) {
  const t = Date.now();
  try {
    const items = await fn();
    return { name, kind, ok: true, items, ms: Date.now() - t };
  } catch (e) {
    return { name, kind, ok: false, items: [], error: String((e && e.message) || e).slice(0, 240), ms: Date.now() - t };
  }
}

// ---------- autocomplete sources ----------
function googlePatterns(q, deep) {
  const p = [
    q, `how ${q}`, `what ${q}`, `why ${q}`, `can ${q}`, `is ${q}`, `where ${q}`,
    `best ${q}`, `cheap ${q}`, `${q} for`, `${q} vs`, `${q} without`, `${q} near me`,
    `${q} not`, `${q} alternative`, `${q} ideas`, `${q} app`, `${q} for beginners`, `${q} help`,
  ];
  if (deep) for (const c of 'abcdefghijklmnopqrstuvwxyz') p.push(`${q} ${c}`);
  return p;
}

async function googleSuggest(term, ds) {
  const url =
    'https://suggestqueries.google.com/complete/search?client=firefox&hl=en&gl=us&ie=UTF-8&oe=UTF-8' +
    (ds ? '&ds=' + ds : '') +
    '&q=' + enc(term);
  const j = await fetchJSON(url, 6000);
  return Array.isArray(j && j[1]) ? j[1].map(String) : [];
}

async function bingSuggest(term) {
  const j = await fetchJSON(`https://api.bing.com/osjson.aspx?query=${enc(term)}&market=en-US`, 6000);
  return Array.isArray(j && j[1]) ? j[1].map(String) : [];
}

async function ddgSuggest(term) {
  const j = await fetchJSON(`https://duckduckgo.com/ac/?q=${enc(term)}&kl=us-en`, 6000);
  if (Array.isArray(j) && Array.isArray(j[1])) return j[1].map(String);
  return Array.isArray(j) ? j.map((x) => x && x.phrase).filter(Boolean) : [];
}

async function amazonSuggest(term) {
  const j = await fetchJSON(
    `https://completion.amazon.com/api/2017/suggestions?limit=11&prefix=${enc(term)}&suggestion-type=KEYWORD&page-type=Gateway&lop=en_US&site-variant=desktop&client-info=amazon-search-ui&mid=ATVPDKIKX0DER&alias=aps`,
    6000
  );
  return ((j && j.suggestions) || []).map((s) => s.value).filter(Boolean);
}

async function ebaySuggest(term) {
  // eBay sometimes wraps its JSON in a callback; pull out the object either way.
  const t = await fetchText(`https://autosug.ebay.com/autosug?kwd=${enc(term)}&sId=0&_jgr=1&_ch=0`, 6000);
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('blocked or not JSON');
  let j;
  try {
    j = JSON.parse(t.slice(a, b + 1));
  } catch {
    throw new Error('blocked or not JSON');
  }
  return (j && j.res && j.res.sug) || [];
}

// ---------- post sources ----------
function clean(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&#x2F;/g, '/')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function mapReddit(d) {
  return {
    source: 'reddit',
    title: clean(d.title),
    snippet: clean(d.selftext).slice(0, 320),
    url: 'https://www.reddit.com' + (d.permalink || ''),
    where: 'r/' + d.subreddit,
    score: d.score || 0,
    comments: d.num_comments || 0,
    date: d.created_utc ? new Date(d.created_utc * 1000).toISOString() : null,
  };
}

function isoDate(s) {
  const d = new Date(s);
  return isNaN(d) ? null : d.toISOString();
}

// Bing search results as RSS: lets us read Reddit and Quora threads
// even when those sites block server traffic.
async function bingRss(query) {
  const t = await fetchText(
    `https://www.bing.com/search?format=rss&count=30&setlang=en-US&cc=US&q=${enc(query)}`,
    7000,
    { Accept: 'application/rss+xml, application/xml, text/xml, */*' }
  );
  const items = [...t.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => {
    const get = (tag) => {
      const r = m[1].match(new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>'));
      return r ? clean(clean(r[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'))) : '';
    };
    return { title: get('title'), link: get('link'), description: get('description'), pubDate: get('pubDate') };
  });
  if (!items.length) throw new Error(/<rss/i.test(t) ? 'no results' : 'bing blocked');
  return items;
}

async function reddit(q) {
  const errs = [];
  // 1) Reddit directly
  for (const host of ['www', 'old']) {
    try {
      const j = await fetchJSON(
        `https://${host}.reddit.com/search.json?q=${enc(q)}&sort=relevance&t=year&limit=50&raw_json=1`,
        7000,
        { 'User-Agent': 'web:outlaw-radar:v1.1 (demand research)' }
      );
      const kids = (j && j.data && j.data.children) || [];
      if (kids.length) return kids.map((k) => mapReddit(k.data));
      errs.push(host + ': empty');
    } catch (e) {
      errs.push(host + ': ' + e.message);
    }
  }
  // 2) PullPush public Reddit archive
  try {
    const j = await fetchJSON(`https://api.pullpush.io/reddit/search/submission/?q=${enc(q)}&size=50`, 8000);
    const d = (j && j.data) || [];
    if (d.length) return d.map(mapReddit);
    errs.push('pullpush: empty');
  } catch (e) {
    errs.push('pullpush: ' + e.message);
  }
  // 3) Reddit threads found through Bing
  try {
    const items = (await bingRss(`site:reddit.com ${q}`)).filter((i) => /reddit\.com\/r\//.test(i.link));
    if (items.length)
      return items.map((i) => ({
        source: 'reddit',
        title: i.title.replace(/\s*[:|\-–]\s*r\/[\w-]+.*$/i, '').replace(/\s*-\s*Reddit$/i, ''),
        snippet: i.description.slice(0, 320),
        url: i.link,
        where: 'r/' + ((i.link.match(/reddit\.com\/r\/([^/]+)/) || [])[1] || 'reddit'),
        score: 0,
        comments: 0,
        date: isoDate(i.pubDate),
      }));
    errs.push('bing: empty');
  } catch (e) {
    errs.push('bing: ' + e.message);
  }
  throw new Error(errs.join(' | '));
}

async function quora(q) {
  const items = (await bingRss(`site:quora.com ${q}`)).filter((i) => /quora\.com\//.test(i.link));
  if (!items.length) throw new Error('no results');
  return items.map((i) => ({
    source: 'quora',
    title: i.title.replace(/\s*-\s*Quora$/i, ''),
    snippet: i.description.slice(0, 320),
    url: i.link,
    where: 'Quora',
    score: 0,
    comments: 0,
    date: isoDate(i.pubDate),
  }));
}

async function hackerNews(q) {
  const [s, c] = await Promise.allSettled([
    fetchJSON(`https://hn.algolia.com/api/v1/search?query=${enc(q)}&tags=story&hitsPerPage=25`, 7000),
    fetchJSON(`https://hn.algolia.com/api/v1/search?query=${enc(q)}&tags=comment&hitsPerPage=25`, 7000),
  ]);
  const out = [];
  if (s.status === 'fulfilled')
    for (const h of s.value.hits || [])
      out.push({
        source: 'hn',
        title: clean(h.title),
        snippet: clean(h.story_text).slice(0, 320),
        url: `https://news.ycombinator.com/item?id=${h.objectID}`,
        where: 'Hacker News',
        score: h.points || 0,
        comments: h.num_comments || 0,
        date: h.created_at || null,
      });
  if (c.status === 'fulfilled')
    for (const h of c.value.hits || []) {
      const txt = clean(h.comment_text);
      if (!txt) continue;
      out.push({
        source: 'hn',
        title: txt.slice(0, 140) + (txt.length > 140 ? '…' : ''),
        snippet: txt.slice(0, 320),
        url: `https://news.ycombinator.com/item?id=${h.objectID}`,
        where: 'HN comment' + (h.story_title ? ' · ' + clean(h.story_title).slice(0, 60) : ''),
        score: h.points || 0,
        comments: 0,
        date: h.created_at || null,
      });
    }
  if (!out.length && s.status === 'rejected' && c.status === 'rejected') throw s.reason;
  return out;
}

// ---------- handler ----------
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const url = new URL(req.url, 'http://x');
  const q = (url.searchParams.get('q') || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  const deep = url.searchParams.get('deep') === '1';
  if (!q) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: 'Type a topic to scan.' }));
  }

  const gTerms = googlePatterns(q, deep);
  const ytTerms = [q, `how ${q}`, `${q} for`, `best ${q}`, `${q} ideas`, `${q} tutorial`];
  const shortTerms = [q, `how ${q}`, `best ${q}`, `${q} for`];

  const results = await Promise.all([
    runSource('Google', 'suggest', () => multi(gTerms, (t) => googleSuggest(t))),
    runSource('YouTube', 'suggest', () => multi(ytTerms, (t) => googleSuggest(t, 'yt'))),
    runSource('Bing', 'suggest', () => multi(shortTerms, bingSuggest)),
    runSource('DuckDuckGo', 'suggest', () => multi(shortTerms, ddgSuggest)),
    runSource('Amazon', 'suggest', () => multi([q, `${q} for`, `best ${q}`], amazonSuggest)),
    runSource('eBay', 'suggest', () => multi([q], ebaySuggest)),
    runSource('Reddit', 'posts', () => reddit(q)),
    runSource('Quora', 'posts', () => quora(q)),
    runSource('Hacker News', 'posts', () => hackerNews(q)),
  ]);

  const sugMap = new Map();
  const posts = [];
  const seenPosts = new Set();
  for (const r of results) {
    if (r.kind === 'suggest') {
      for (const raw of r.items) {
        const t = String(raw).trim().replace(/\s+/g, ' ');
        if (!t || t.length > 140) continue;
        const k = t.toLowerCase();
        let e = sugMap.get(k);
        if (!e) sugMap.set(k, (e = { text: t, sources: [], hits: 0 }));
        e.hits++;
        if (!e.sources.includes(r.name)) e.sources.push(r.name);
      }
    } else {
      for (const p of r.items) {
        if (!p.title || seenPosts.has(p.url)) continue;
        seenPosts.add(p.url);
        posts.push(p);
      }
    }
  }

  const suggestions = [...sugMap.values()].sort(
    (a, b) => b.sources.length - a.sources.length || b.hits - a.hits || a.text.length - b.text.length
  );

  const body = {
    query: q,
    deep,
    at: new Date().toISOString(),
    sources: results.map((r) => ({ name: r.name, ok: r.ok, count: r.items.length, error: r.error || null, ms: r.ms })),
    suggestions,
    posts,
  };

  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
  res.end(JSON.stringify(body));
};
