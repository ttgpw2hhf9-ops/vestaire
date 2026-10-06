// Vestiaire Hub — collecte des news (RSS) et des matchs (données publiques), sans IA.
// Lancé par GitHub Actions. Lit sources.json, écrit site/data.json.
import fs from "node:fs/promises";
import crypto from "node:crypto";

const cfg = JSON.parse(await fs.readFile("sources.json", "utf8"));
const OUT = process.env.OUT || "site/data.json";
const KEEP_DAYS = 14, MAX_ARTICLES = 500;
const UA = "Mozilla/5.0 (compatible; VestiaireHub/1.0; lecteur RSS personnel)";
const now = Date.now();
const DAY = 864e5;

// ---------- HTTP ----------
async function get(url, { json = false, timeout = 20000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, "Accept": json ? "application/json" : "application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.8, */*;q=0.5", "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8" }, signal: ctl.signal, redirect: "follow" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return json ? await r.json() : await r.text();
  } finally { clearTimeout(t); }
}

// ---------- RSS / Atom ----------
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…", ndash: "–", mdash: "—", eacute: "é", egrave: "è", agrave: "à", ccedil: "ç", ecirc: "ê", ocirc: "ô", icirc: "î", ucirc: "û", laquo: "«", raquo: "»" };
export function decode(s) {
  return String(s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m);
}
const stripHtml = s => decode(decode(s)).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
function tag(block, names) {
  for (const n of names) {
    const m = block.match(new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${n}>`, "i"));
    if (m && m[1].trim()) return m[1];
  }
  return "";
}
function attr(block, re) { const m = block.match(re); return m ? decode(m[1]) : ""; }
export function parseFeed(xml) {
  if (!/<(rss|feed|rdf:RDF)[\s>]/i.test(xml)) return null;
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>|<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  return blocks.map(b => {
    let link = stripHtml(tag(b, ["link"]));
    if (!/^https?:/.test(link)) link = attr(b, /<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)/i) || attr(b, /<link[^>]*href=["']([^"']+)/i) || stripHtml(tag(b, ["guid", "id"]));
    const rawDesc = tag(b, ["description", "summary", "content:encoded", "content"]);
    const img = attr(b, /<media:content[^>]*url=["']([^"']+)/i) || attr(b, /<media:thumbnail[^>]*url=["']([^"']+)/i) ||
      attr(b, /<enclosure[^>]*type=["']image[^"']*["'][^>]*url=["']([^"']+)/i) || attr(b, /<enclosure[^>]*url=["']([^"']+\.(?:jpe?g|png|webp)[^"']*)/i) ||
      attr(decode(rawDesc + tag(b, ["content:encoded"])), /<img[^>]*src=["']([^"']+)/i);
    const date = stripHtml(tag(b, ["pubDate", "published", "updated", "dc:date"]));
    return { title: stripHtml(tag(b, ["title"])), link: link.trim(), desc: stripHtml(rawDesc), date: date ? new Date(date).toISOString() : null, image: img || null };
  }).filter(i => i.title && /^https?:/.test(i.link));
}
function discoverFeed(html, base) {
  const m = html.match(/<link[^>]+type=["']application\/(?:rss|atom)\+xml["'][^>]*>/i);
  if (!m) return null;
  const h = m[0].match(/href=["']([^"']+)/i);
  return h ? new URL(decode(h[1]), base).href : null;
}

// ---------- classement ----------
const norm = s => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
function matches(team, text) {
  return (team.keywords || []).some(k => {
    if (k.length <= 3 && k === k.toUpperCase()) return new RegExp(`(^|[^A-Za-z])${k}([^A-Za-z]|$)`).test(text); // sigles (OM) : sensible à la casse
    return new RegExp(`(^|[^a-z0-9])${norm(k).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`).test(norm(text));
  });
}
export function category(title, desc) {
  const t = norm(title + " " + desc.slice(0, 200));
  if (/mercato|transfert|recrue|signe |signature|prolong|contrat|rumeur|trade|free agent|agent libre|echange|arbitrage salarial|offre/.test(t)) return "transfert";
  if (/\b\d{1,3}\s?[-–]\s?\d{1,3}\b/.test(title) || /s'impose|victoire|defaite|battu|bat |l'emporte|chute|corrige|renverse|beats|defeat|win over|loss to|recap|resume du match/.test(t)) return "resultat";
  if (/avant[- ]match|preview|programme|compo|groupe pour|face a .* ce soir|a quelle heure|ou regarder|probables/.test(t)) return "avant-match";
  return "news";
}
const sha = s => crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);
// Mots à exclure (sources.json > "exclure") : l'article est ignoré si son titre ou son résumé contient l'un d'eux
const EXCL = (cfg.exclure || []).map(w => new RegExp(`(^|[^a-z0-9])${norm(w).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`));
const excluded = text => EXCL.some(re => re.test(norm(text)));

// ---------- articles ----------
const teams = cfg.teams;
const teamByKey = Object.fromEntries(teams.map(t => [t.key, t]));
const sourceStatus = [];
const fresh = [];

for (const src of cfg.sources) {
  if (src.on === false) { sourceStatus.push({ ...pub(src), status: "pause" }); continue; }
  let items = null, used = null, fellBack = false, err = "";
  for (const [i, url] of (src.feeds || []).entries()) {
    try { const x = await get(url); items = parseFeed(x); if (items && items.length) { used = url; fellBack = i > 0; break; } items = null; err = err || "flux vide ou invalide"; }
    catch (e) { err = e.name === "AbortError" ? "délai dépassé" : e.message; }
  }
  if (!items && src.site) {
    try { const html = await get(src.site); const f = discoverFeed(html, src.site); if (f) { items = parseFeed(await get(f)); used = f; fellBack = true; } else err = err || "aucun flux trouvé"; }
    catch (e) { err = err || e.message; }
  }
  if (!items) { sourceStatus.push({ ...pub(src), status: "erreur", error: err }); continue; }
  // Flux Google Actualités (secours quand un site bloque GitHub) : titres « Titre - Site », pas de résumé utile
  if (/news\.google\./.test(used)) items = items.map(it => ({ ...it, title: it.title.replace(/\s+[-–]\s+[^-–]+$/, ""), desc: "", image: null }));
  let kept = 0;
  for (const it of items) {
    if (src.urlMatch && !/news\.google\./.test(used) && !it.link.includes(src.urlMatch)) continue;
    const text = it.title + " " + it.desc;
    if (excluded(text)) continue;
    let team = null, sport = null;
    if (src.scope.startsWith("sport:")) {
      sport = src.scope.slice(6);
      const hit = teams.find(t => t.sport === sport && matches(t, text));
      if (hit) team = hit.key; else if (src.keep !== "all") continue;
    } else {
      const t = teamByKey[src.scope]; if (!t) continue;
      if ((src.filter || (fellBack && src.filterIfFallback)) && !matches(t, text)) continue;
      team = t.key; sport = t.sport;
    }
    const date = it.date && !isNaN(Date.parse(it.date)) ? it.date : new Date().toISOString();
    if (now - Date.parse(date) > KEEP_DAYS * DAY) continue;
    fresh.push({ id: sha(it.link), team, sport, cat: category(it.title, it.desc), source: src.name, title: it.title, summary: it.desc.slice(0, 320) + (it.desc.length > 320 ? "…" : ""), url: it.link, image: it.image, publishedAt: date });
    kept++;
  }
  sourceStatus.push({ ...pub(src), status: "ok", count: kept, feed: used, via: /news\.google\./.test(used) ? "Google Actualités" : null });
}
function pub(s) { return { name: s.name, scope: s.scope, keep: s.keep || null, site: s.site, chip: !!s.chip }; }

// ---------- matchs ----------
const teamData = {};
const iso = d => new Date(d).toISOString();
async function espn(t) {
  const base = `https://site.api.espn.com/apis/site/v2/sports/${t.data.sport}/teams/${t.data.team}/schedule`;
  const evs = [];
  for (const u of [base, base + "?fixture=true", base + "?seasontype=2"]) { try { const j = await get(u, { json: true }); evs.push(...(j.events || [])); } catch {} }
  const seen = new Set(), next = [], last = [];
  for (const e of evs) {
    if (seen.has(e.id)) continue; seen.add(e.id);
    const c = e.competitions?.[0]; if (!c) continue;
    const me = c.competitors.find(x => String(x.team?.id) === String(t.data.team) || x.team?.abbreviation?.toLowerCase() === String(t.data.team).toLowerCase());
    const op = c.competitors.find(x => x !== me); if (!me || !op) continue;
    const sc = x => x.score?.displayValue ?? x.score?.value ?? x.score;
    const g = { date: iso(e.date), opp: op.team.shortDisplayName || op.team.displayName, home: me.homeAway === "home", comp: e.seasonType?.name && !/regular/i.test(e.seasonType.name) ? e.seasonType.name : (t.comp || "") };
    if (t.data.sport === "basketball/nba") {
      const homeAbbr = (me.homeAway === "home" ? me : op).team?.abbreviation;
      const pre = /pre/i.test(e.seasonType?.name || "") || e.season?.type === 1;
      g.box = pre || !BR[homeAbbr] ? { url: `https://www.espn.com/nba/boxscore/_/gameId/${e.id}`, label: "Box score (ESPN)" }
        : { url: `https://www.basketball-reference.com/boxscores/${usDate(e.date)}0${BR[homeAbbr]}.html`, label: "Box score (Basketball Reference)", check: true };
    } else if (t.data.sport.startsWith("soccer")) g.box = { url: `https://www.espn.com/soccer/match/_/gameId/${e.id}`, label: "Feuille de match (ESPN)" };
    if (c.status?.type?.completed) { const a = +sc(me), b = +sc(op); last.push({ ...g, score: `${a}-${b}`, result: a > b ? "W" : a < b ? "L" : "D" }); }
    else if (Date.parse(e.date) > now - 3 * 36e5) next.push(g);
  }
  let standings = null;
  try {
    const j = await get(`https://site.api.espn.com/apis/v2/sports/${t.data.sport}/standings`, { json: true });
    const groups = j.children?.length ? j.children : [j];
    const grp = groups.find(gq => gq.standings?.entries?.some(en => String(en.team?.id) === String(t.data.team) || en.team?.abbreviation?.toLowerCase() === String(t.data.team).toLowerCase())) || groups[0];
    const stat = (en, n) => en.stats?.find(s => s.name === n)?.value;
    const soccer = t.data.sport.startsWith("soccer");
    const rows = (grp.standings?.entries || []).map(en => ({ name: en.team.shortDisplayName || en.team.displayName, me: String(en.team.id) === String(t.data.team) || en.team.abbreviation?.toLowerCase() === String(t.data.team).toLowerCase(),
      val: soccer ? stat(en, "points") : `${stat(en, "wins") ?? 0}-${stat(en, "losses") ?? 0}`, sort: soccer ? stat(en, "points") : stat(en, "winPercent") ?? 0 }))
      .sort((a, b) => b.sort - a.sort).map((r, i) => ({ rank: i + 1, name: r.name, val: r.val, me: r.me }));
    standings = { title: grp.name || grp.abbreviation || "Classement", unit: soccer ? "pts" : "V-D", rows: trimRows(rows) };
  } catch {}
  return { next: next.sort((a, b) => Date.parse(a.date) - Date.parse(b.date)).slice(0, 5), last: last.sort((a, b) => Date.parse(b.date) - Date.parse(a.date)).slice(0, 5), standings };
}
async function mlb(t) {
  const d = x => new Date(now + x * DAY).toISOString().slice(0, 10);
  const j = await get(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&teamId=${t.data.id}&startDate=${d(-12)}&endDate=${d(14)}&hydrate=team`, { json: true });
  const next = [], last = [];
  for (const day of j.dates || []) for (const g of day.games || []) {
    const home = g.teams.home.team.id === t.data.id, me = home ? g.teams.home : g.teams.away, op = home ? g.teams.away : g.teams.home;
    const base = { date: g.gameDate, opp: op.team.teamName || op.team.name, home, comp: g.seriesDescription && g.gameType !== "R" ? g.seriesDescription : "MLB", box: { url: `https://www.mlb.com/gameday/${g.gamePk}/final/box`, label: "Box score (MLB.com)" } };
    if (g.status.abstractGameState === "Final" && me.score != null) last.push({ ...base, score: `${me.score}-${op.score}`, result: me.isWinner ? "W" : "L" });
    else if (g.status.abstractGameState !== "Final") next.push(base);
  }
  let standings = null;
  try {
    const s = await get(`https://statsapi.mlb.com/api/v1/standings?leagueId=103,104&hydrate=division,team`, { json: true });
    const rec = (s.records || []).find(r => r.teamRecords.some(x => x.team.id === t.data.id));
    if (rec) standings = { title: rec.division?.nameShort || rec.division?.name || "Division", unit: "V-D", rows: rec.teamRecords.map(x => ({ rank: +x.divisionRank, name: x.team.teamName || x.team.name, val: `${x.wins}-${x.losses}`, me: x.team.id === t.data.id })) };
  } catch {}
  return { next: next.slice(0, 5), last: last.reverse().slice(0, 5), standings };
}
async function sofascore(t) {
  const ev = async kind => (await get(`https://api.sofascore.com/api/v1/team/${t.data.id}/events/${kind}/0`, { json: true })).events || [];
  const conv = e => { const home = e.homeTeam.id === t.data.id; return { date: new Date(e.startTimestamp * 1000).toISOString(), opp: (home ? e.awayTeam : e.homeTeam).shortName || (home ? e.awayTeam : e.homeTeam).name, home, comp: e.tournament?.name || "", _e: e, _home: home }; };
  const next = (await ev("next")).map(conv).slice(0, 5).map(({ _e, _home, ...g }) => g);
  const last = (await ev("last")).map(conv).filter(g => g._e.status?.type === "finished").reverse().slice(0, 5).map(({ _e, _home, ...g }) => {
    const a = _home ? _e.homeScore.current : _e.awayScore.current, b = _home ? _e.awayScore.current : _e.homeScore.current;
    return { ...g, score: `${a}-${b}`, result: a > b ? "W" : a < b ? "L" : "D" };
  });
  return { next, last, standings: null };
}
// TheSportsDB (clé publique gratuite) : Nanterre, LOU, XV de France
const TS = "https://www.thesportsdb.com/api/v1/json/123/";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const TS_COMP = { "French LNB": "Betclic Élite", "Basketball Champions League": "BCL", "French Top 14": "Top 14", "European Rugby Champions Cup": "Champions Cup" };
async function tsGet(path) { if (!process.env.NOSLEEP) await sleep(2100); return await get(TS + path, { json: true }) || {}; } // 30 requêtes/min max
async function tsdb(t) {
  const id = String(t.data.id), evs = new Map(); let ok = 0;
  const add = a => { for (const e of a || []) if (e && (e.idHomeTeam === id || e.idAwayTeam === id)) evs.set(e.idEvent, e); };
  try { add((await tsGet(`eventslast.php?id=${id}`)).results); ok++; } catch {}
  try { add((await tsGet(`eventsnext.php?id=${id}`)).events); ok++; } catch {}
  for (const l of t.data.leagues || []) for (let i = 0; i <= 2; i++) {
    const d = new Date(now - i * DAY).toISOString().slice(0, 10);
    try { add((await tsGet(`eventsday.php?d=${d}&l=${l}`)).events); ok++; } catch {}
  }
  if (!ok) throw new Error("TheSportsDB injoignable");
  const next = [], last = [];
  for (const e of evs.values()) {
    const ts = e.strTimestamp ? e.strTimestamp + (/[zZ]|[+-]\d\d:?\d\d$/.test(e.strTimestamp) ? "" : "Z") : `${e.dateEvent}T${e.strTime || "18:00:00"}Z`;
    const home = e.idHomeTeam === id;
    const g = { id: "ts" + e.idEvent, date: iso(ts), opp: home ? e.strAwayTeam : e.strHomeTeam, home, comp: TS_COMP[e.strLeague] || e.strLeague || t.comp || "" };
    const hs = e.intHomeScore, as = e.intAwayScore;
    if (hs != null && hs !== "" && as != null && as !== "" && Date.parse(g.date) < now) {
      const a = +(home ? hs : as), b = +(home ? as : hs);
      last.push({ ...g, score: `${a}-${b}`, result: a > b ? "W" : a < b ? "L" : "D" });
    } else if (Date.parse(g.date) > now - 3 * 36e5) next.push(g);
  }
  return { next, last, standings: null };
}

// F1 : base Jolpica (ex-Ergast), gratuite
const GP = { Australian: "GP d'Australie", Chinese: "GP de Chine", Japanese: "GP du Japon", Bahrain: "GP de Bahreïn", "Saudi Arabian": "GP d'Arabie saoudite", Miami: "GP de Miami", "Emilia Romagna": "GP d'Émilie-Romagne", Monaco: "GP de Monaco", Spanish: "GP d'Espagne", "Barcelona-Catalunya": "GP de Barcelone", Canadian: "GP du Canada", Austrian: "GP d'Autriche", British: "GP de Grande-Bretagne", Belgian: "GP de Belgique", Hungarian: "GP de Hongrie", Dutch: "GP des Pays-Bas", Italian: "GP d'Italie", Madrid: "GP de Madrid", Azerbaijan: "GP d'Azerbaïdjan", Singapore: "GP de Singapour", "United States": "GP des États-Unis", "Mexico City": "GP du Mexique", "São Paulo": "GP de São Paulo", "Las Vegas": "GP de Las Vegas", Qatar: "GP du Qatar", "Abu Dhabi": "GP d'Abou Dhabi" };
const gpName = r => { const k = r.raceName.replace(/ Grand Prix$/, ""); return GP[k] || "GP " + k; };
const F1S = [["FirstPractice", "Essais libres 1"], ["SecondPractice", "Essais libres 2"], ["ThirdPractice", "Essais libres 3"], ["SprintQualifying", "Qualifs sprint"], ["Sprint", "Sprint"], ["Qualifying", "Qualifications"]];
const at = s => iso(`${s.date}T${s.time || "12:00:00Z"}`);
async function f1() {
  const J = "https://api.jolpi.ca/ergast/f1/";
  const races = (await get(J + "current.json", { json: true })).MRData.RaceTable.Races || [];
  const sess = [];
  for (const r of races) {
    const name = gpName(r);
    for (const [f, l] of F1S) if (r[f]?.date) sess.push({ id: `f1-${r.season}-${r.round}-${f}`, date: at(r[f]), label: `${name} · ${l}`, opp: name, home: true, comp: l });
    sess.push({ id: `f1-${r.season}-${r.round}-Race`, date: at(r), label: `${name} · Course`, opp: name, home: true, comp: "Course", race: true });
  }
  const next = sess.filter(s => Date.parse(s.date) > now - 2 * 36e5).sort((a, b) => Date.parse(a.date) - Date.parse(b.date)).slice(0, 6);
  let last = [];
  try {
    const lr = (await get(J + "current/last/results.json", { json: true })).MRData.RaceTable.Races[0];
    if (lr) {
      const top = (lr.Results || []).slice(0, 10).map(x => ({ pos: x.position, name: `${x.Driver.givenName[0]}. ${x.Driver.familyName}`, team: x.Constructor?.name || "", time: x.Time?.time || x.status || "", pts: x.points }));
      last = [{ id: `f1-${lr.season}-${lr.round}-Race`, date: at(lr), label: gpName(lr), opp: gpName(lr), home: true, comp: "Course", score: top.slice(0, 3).map(x => `${x.pos}. ${x.name}`).join(" · "), top, season: lr.season, round: lr.round }];
    }
  } catch {}
  let standings = null;
  try {
    const sl = (await get(J + "current/driverStandings.json", { json: true })).MRData.StandingsTable.StandingsLists[0];
    if (sl) standings = { title: "Championnat pilotes", col: "Pilote", unit: "pts", rows: sl.DriverStandings.slice(0, 10).map(x => ({ rank: +x.position, name: `${x.Driver.givenName[0]}. ${x.Driver.familyName}`, val: x.points, me: false })) };
  } catch {}
  return { next, last, standings };
}

// Codes équipes ESPN -> Basketball Reference
const BR = { ATL: "ATL", BOS: "BOS", BKN: "BRK", CHA: "CHO", CHI: "CHI", CLE: "CLE", DAL: "DAL", DEN: "DEN", DET: "DET", GS: "GSW", HOU: "HOU", IND: "IND", LAC: "LAC", LAL: "LAL", MEM: "MEM", MIA: "MIA", MIL: "MIL", MIN: "MIN", NO: "NOP", NY: "NYK", OKC: "OKC", ORL: "ORL", PHI: "PHI", PHX: "PHO", POR: "POR", SAC: "SAC", SA: "SAS", TOR: "TOR", UTAH: "UTA", WSH: "WAS" };
const usDate = d => new Date(d).toLocaleDateString("en-CA", { timeZone: "America/New_York" }).replace(/-/g, "");
async function boxAvailable(url) {
  try { const r = await fetch(url, { method: "GET", headers: { "User-Agent": UA }, redirect: "follow" }); return r.status === 404 ? false : true; }
  catch { return true; } // site injoignable : on publie quand même le lien
}
function trimRows(rows) { const top = rows.slice(0, 8); const me = rows.find(r => r.me); return me && !top.includes(me) ? [...top, me] : top; }

// Version publiée précédente (articles + historique des matchs)
let prevData = {};
{
  const repo0 = process.env.GITHUB_REPOSITORY;
  if (process.env.PREV_URL || repo0) {
    const [owner, name] = (repo0 || "/").split("/");
    const url = process.env.PREV_URL || (name.toLowerCase() === `${owner.toLowerCase()}.github.io` ? `https://${owner}.github.io/data.json` : `https://${owner}.github.io/${name}/data.json`);
    try { prevData = await get(url + "?t=" + now, { json: true }) || {}; } catch {}
  }
}
const prev = prevData.articles || [];

// Historique : TheSportsDB (gratuit) ne donne que le dernier / prochain match -> on cumule d'un passage à l'autre
function mergeHist(k, d) {
  const p = (prevData.teamData || {})[k] || {};
  const key = g => g.id || g.date;
  const lastMap = new Map();
  for (const g of [...(d.last || []), ...(p.last || [])]) if (!lastMap.has(key(g)) && now - Date.parse(g.date) < 60 * DAY) lastMap.set(key(g), g);
  const last = [...lastMap.values()].sort((a, b) => Date.parse(b.date) - Date.parse(a.date)).slice(0, 5);
  const done = new Set(last.map(key));
  const nextMap = new Map();
  for (const g of [...(d.next || []), ...(p.next || [])]) if (!nextMap.has(key(g)) && !done.has(key(g)) && Date.parse(g.date) > now - 3 * 36e5) nextMap.set(key(g), g);
  const next = [...nextMap.values()].sort((a, b) => Date.parse(a.date) - Date.parse(b.date)).slice(0, 5);
  return { ...d, last, next, standings: d.standings || p.standings || null };
}

const dataStatus = {};
for (const t of teams) {
  if (!t.data) continue;
  try { teamData[t.key] = await ({ espn, mlb, sofascore, tsdb, f1 })[t.data.type](t); if (t.data.type === "tsdb") teamData[t.key] = mergeHist(t.key, teamData[t.key]); dataStatus[t.key] = "ok"; }
  catch (e) { dataStatus[t.key] = "erreur : " + e.message; if (prevData.teamData?.[t.key]) teamData[t.key] = mergeHist(t.key, {}); }
}

const prevIds = new Set(prev.map(a => a.id));

// Articles automatiques : résultats récents et matchs à venir
const fmt = (d) => new Date(d).toLocaleString("fr-FR", { timeZone: "Europe/Paris", weekday: "long", hour: "2-digit", minute: "2-digit" });
for (const [k, d] of Object.entries(teamData)) {
  const t = teamByKey[k];
  if (t.data?.type === "f1") {
    for (const g of d.last || []) {
      if (!g.top || now - Date.parse(g.date) > 4 * DAY) continue;
      fresh.push({ id: `res-f1-${g.season}-${g.round}`, team: k, sport: t.sport, cat: "resultat", source: "Résultats", title: `${g.label} : le classement de la course`, summary: g.top.map(x => `${x.pos}. ${x.name} (${x.team})${x.time ? " — " + x.time : ""}`).join(" · "), url: "https://motorsport.nextgen-auto.com/fr/formule-1/resultats/", urlLabel: "Résultats complets (Next Gen Auto)", publishedAt: new Date(Math.min(Date.parse(g.date) + 2.5 * 36e5, now)).toISOString() });
    }
    for (const g of d.next || []) {
      const dt = Date.parse(g.date) - now;
      if (dt < 0 || dt > 36 * 36e5 || !/Qualif|Sprint|Course/.test(g.comp)) continue;
      fresh.push({ id: `pre-${g.id}`, team: k, sport: t.sport, cat: "avant-match", source: "Agenda", title: g.label, summary: `${fmt(g.date)} (heure de Paris).`, url: null, publishedAt: new Date(now).toISOString() });
    }
    continue;
  }
  for (const g of d.last || []) {
    if (now - Date.parse(g.date) > 4 * DAY) continue;
    if (g.box?.check && !prevIds.has(`res-${k}-${g.date.slice(0, 10)}`) && !(await boxAvailable(g.box.url))) { console.log(` - box score pas encore dispo : ${g.box.url}`); continue; }
    const [a, b] = g.score.split("-");
    const title = g.home ? `${t.label} ${a}-${b} ${g.opp}` : `${g.opp} ${b}-${a} ${t.label}`;
    fresh.push({ id: `res-${k}-${g.date.slice(0, 10)}`, team: k, sport: t.sport, cat: "resultat", source: "Résultats", title, summary: `${g.result === "W" ? "Victoire" : g.result === "L" ? "Défaite" : "Match nul"} ${g.home ? "à domicile" : "à l'extérieur"}${g.comp ? " · " + g.comp : ""}.`, url: g.box?.url || null, urlLabel: g.box?.label || null, publishedAt: new Date(Math.min(Date.parse(g.date) + 3 * 36e5, now)).toISOString(), fixture: { home: g.home ? k : g.opp, away: g.home ? g.opp : k, score: g.home ? `${a} – ${b}` : `${b} – ${a}`, comp: g.comp, date: g.date } });
  }
  for (const g of d.next || []) {
    const dt = Date.parse(g.date) - now;
    if (dt < 0 || dt > 36 * 36e5) continue;
    fresh.push({ id: `pre-${k}-${g.date.slice(0, 10)}`, team: k, sport: t.sport, cat: "avant-match", source: "Agenda", title: `${t.label} ${g.home ? "reçoit" : "se déplace chez"} ${g.opp}`, summary: `${fmt(g.date)} (heure de Paris)${g.comp ? " · " + g.comp : ""}.`, url: null, publishedAt: new Date(now).toISOString(), fixture: { home: g.home ? k : g.opp, away: g.home ? g.opp : k, comp: g.comp, date: g.date } });
  }
}

// ---------- fusion avec la version précédente ----------
const repo = process.env.GITHUB_REPOSITORY;
const byId = new Map();
const activeSources = new Set([...cfg.sources.filter(s => s.on !== false).map(s => s.name), "Résultats", "Agenda"]);
for (const a of prev) if (activeSources.has(a.source)) byId.set(a.id, a);
for (const a of fresh) { const old = byId.get(a.id); byId.set(a.id, old && a.cat !== "avant-match" ? { ...a, publishedAt: old.publishedAt } : a); }
const seenTitles = new Set();
const articles = [...byId.values()]
  .filter(a => teams.some(t => t.key === a.team) || (!a.team && a.sport))
  .filter(a => a.source === "Résultats" || a.source === "Agenda" || !excluded(a.title + " " + (a.summary || "")))
  .filter(a => now - Date.parse(a.publishedAt) <= KEEP_DAYS * DAY)
  .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
  .filter(a => { const k = norm(a.title).replace(/[^a-z0-9]/g, "").slice(0, 60); if (seenTitles.has(k)) return false; seenTitles.add(k); return true; })
  .slice(0, MAX_ARTICLES);

const out = {
  updatedAt: new Date().toISOString(),
  teams: teams.map(({ keywords, data, ...t }) => t),
  articles, teamData,
  sources: sourceStatus, dataStatus,
  repo: repo || null,
  journal: cfg.journal || null,
  exclure: cfg.exclure || []
};
await fs.mkdir(OUT.split("/").slice(0, -1).join("/") || ".", { recursive: true });
await fs.writeFile(OUT, JSON.stringify(out));
console.log(`OK : ${articles.length} articles (${fresh.length} récupérés ce passage)`);
for (const s of sourceStatus) console.log(` - ${s.name} [${s.scope}] : ${s.status}${s.count != null ? " (" + s.count + ")" : ""}${s.error ? " — " + s.error : ""}`);
for (const [k, v] of Object.entries(dataStatus)) console.log(` - données ${k} : ${v}`);
