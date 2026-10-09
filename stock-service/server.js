const http = require("node:http");

const PORT = Number(process.env.PORT || 10000);
const API_KEY = process.env.STOCK_SERVICE_KEY || "";
const CACHE_MS = 60 * 1000;
const SOURCES = [
  "https://fruityblox.com/stock",
  "https://blox-fruits-wiki.com/wiki/stock/",
  "https://blox-fruits.fandom.com/wiki/Blox_Fruits_%22Stock%22"
];

let cache = null;
let cacheAt = 0;
let inFlight = null;

function cleanHtml(value) {
  return String(value || "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/[\t\r\n ]+/g, " ")
    .trim();
}

function parseFruityBlox(html) {
  const normal = [];
  const mirage = [];
  const sections = String(html).match(/<section\b[^>]*>[\s\S]*?<\/section>/gi) || [];
  for (const section of sections) {
    const heading = section.match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/i);
    if (!heading) continue;
    const title = cleanHtml(heading[1]).toLowerCase();
    if (title !== "normal" && title !== "mirage") continue;
    const names = [...section.matchAll(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi)]
      .map(m => cleanHtml(m[1])).filter(Boolean);
    const target = title === "normal" ? normal : mirage;
    for (const name of names) {
      if (!target.some(x => x.name.toLowerCase() === name.toLowerCase())) {
        target.push({ name, type: title === "normal" ? "Normal" : "Mirage" });
      }
    }
  }
  if (!normal.length || !mirage.length) throw new Error("Não encontrei as seções Normal e Mirage no HTML do FruityBlox.");
  return [...normal, ...mirage];
}

function parseWiki(html, source) {
  const text = cleanHtml(String(html).replace(/<\/(h[1-6]|p|li|tr|section|div)>/gi, "\n"));
  const allFruitNames = [
    "Rocket","Spin","Blade","Spring","Bomb","Smoke","Spike","Flame","Falcon","Ice","Sand","Dark","Diamond","Light","Rubber","Barrier","Ghost","Magma","Quake","Buddha","Love","Spider","Sound","Phoenix","Portal","Rumble","Pain","Blizzard","Gravity","Mammoth","T-Rex","Dough","Shadow","Venom","Control","Gas","Spirit","Leopard","Yeti","Kitsune","Dragon","East Dragon","West Dragon","Lightning"
  ];
  function section(startMarker, endMarker, type) {
    const start = text.toLowerCase().indexOf(startMarker.toLowerCase());
    if (start < 0) return [];
    const from = start + startMarker.length;
    const end = text.toLowerCase().indexOf(endMarker.toLowerCase(), from);
    const part = text.slice(from, end < 0 ? undefined : end);
    return allFruitNames.filter(name => new RegExp("(^|[^A-Za-z0-9])" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?=$|[^A-Za-z0-9])", "i").test(part))
      .map(name => ({ name, type }));
  }
  const normal = section("Current Stock", "Last Stock", "Normal");
  const mirage = section("Current Mirage Stock", "Last Mirage Stock", "Mirage");
  if (!normal.length || !mirage.length) throw new Error("A página wiki não trouxe as duas listas de stock.");
  return [...normal, ...mirage];
}

async function fetchStock() {
  const failures = [];
  for (const url of SOURCES) {
    try {
      const response = await fetch(url, {
        headers: {
          "Accept": "text/html,application/xhtml+xml",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          "Accept-Language": "en-US,en;q=0.9"
        },
        signal: AbortSignal.timeout(18000)
      });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const html = await response.text();
      const stock = url.includes("fruityblox.com/stock") ? parseFruityBlox(html) : parseWiki(html, url);
      const normal = stock.filter(x => x.type === "Normal");
      const mirage = stock.filter(x => x.type === "Mirage");
      if (!normal.length || !mirage.length) throw new Error("Stock incompleto");
      return { ok: true, source: url, fetchedAt: new Date().toISOString(), counts: { normal: normal.length, mirage: mirage.length }, stock };
    } catch (error) {
      failures.push({ source: url, error: error.message || String(error) });
    }
  }
  const err = new Error("Todas as fontes públicas falharam.");
  err.failures = failures;
  throw err;
}

async function getStock() {
  if (cache && Date.now() - cacheAt < CACHE_MS) return { ...cache, cached: true };
  if (!inFlight) {
    inFlight = fetchStock().then(data => {
      cache = data;
      cacheAt = Date.now();
      return data;
    }).finally(() => { inFlight = null; });
  }
  return inFlight;
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "GET" && url.pathname === "/health") {
    return send(res, 200, { ok: true, service: "astral-stock-service", time: new Date().toISOString() });
  }
  if (req.method !== "GET" || !["/stock", "/"].includes(url.pathname)) {
    return send(res, 404, { ok: false, error: "Rota não encontrada. Use /health ou /stock." });
  }
  if (API_KEY && req.headers["x-api-key"] !== API_KEY) {
    return send(res, 401, { ok: false, error: "Chave de acesso inválida." });
  }
  try {
    const data = await getStock();
    return send(res, 200, data);
  } catch (error) {
    return send(res, 502, { ok: false, error: error.message, failures: error.failures || [] });
  }
});

server.listen(PORT, "0.0.0.0", () => console.log("Astral Stock Service ativo na porta " + PORT));
