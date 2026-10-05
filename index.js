require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");
const {
  Client, GatewayIntentBits, MessageFlags, ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder, REST, Routes, AttachmentBuilder,
  SlashCommandBuilder, PermissionFlagsBits
} = require("discord.js");
const OpenAI = require("openai");

const required = ["DISCORD_TOKEN", "CLIENT_ID", "GUILD_ID", "CHANNEL_ID", "OPENAI_API_KEY"];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`Configuração ausente: ${key}. Veja o arquivo .env.example.`);
    process.exit(1);
  }
}
const CONFIG_PATH = path.join(__dirname, "config.json");
const STATE_PATH = path.join(__dirname, "data", "state.json");
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const aiHistory = new Map();
const imageCooldown = new Map();

let checking = false;
let apiCooldownUntil = 0;
const BRASIL_TZ = "America/Sao_Paulo";
const nextStockAt = { normal: null, mirage: null };

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); }
  catch { return { roles: {}, emojis: {}, aliases: {}, titles: {}, historyLimit: 20 }; }
}
function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}
function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, "utf8")); }
  catch { return { history: [], stockSignatures: {} }; }
}
function fruitKey(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}
function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}
function normalizeStock(payload) {
  let data = payload;
  for (let i = 0; i < 3 && typeof data === "string"; i++) {
    try { data = JSON.parse(data); } catch { break; }
  }
  if (data && data.data) data = data.data;
  if (data && data.result) data = data.result;
  if (data && data.stock) data = data.stock;

  if (data && (Array.isArray(data.normal) || Array.isArray(data.mirage))) {
    const list = [];
    for (const item of data.normal || []) {
      list.push(typeof item === "string" ? { name: item, type: "Normal" } : { ...item, type: "Normal" });
    }
    for (const item of data.mirage || []) {
      list.push(typeof item === "string" ? { name: item, type: "Mirage" } : { ...item, type: "Mirage" });
    }
    return list;
  }
  if (Array.isArray(data)) return data.map(x => typeof x === "string" ? { name: x } : x);
  throw new Error("Formato da API não reconhecido. Confira a resposta do endpoint.");
}
const WIKI_STOCK_URL = process.env.WIKI_STOCK_URL || "https://blox-fruits.fandom.com/wiki/Stock";

function decodeHtmlEntities(value) {
  return String(value)
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

function htmlToStockText(html) {
  return decodeHtmlEntities(
    String(html)
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<!--([\s\S]*?)-->/g, " ")
      .replace(/<[^>]+>/g, "\n")
  ).replace(/[\t\r ]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}

function parseWikiStockSection(text, heading, nextHeading, type) {
  const start = text.toLowerCase().indexOf(heading.toLowerCase());
  if (start < 0) throw new Error("A seção '" + heading + "' não foi encontrada na página de stock.");
  const contentStart = start + heading.length;
  const end = text.toLowerCase().indexOf(nextHeading.toLowerCase(), contentStart);
  const section = text.slice(contentStart, end < 0 ? undefined : end);
  const found = [];

  for (const fruit of ALL_FRUITS) {
    const escaped = fruit.replace(/[.*+?^$()|[\]\\]/g, "\\$&");
    const match = new RegExp("(^|[^A-Za-z0-9])(" + escaped + ")(?=$|[^A-Za-z0-9])", "i").exec(section);
    if (match) found.push({ name: fruit, index: match.index + match[1].length });
  }
  found.sort((a, b) => a.index - b.index);

  return found.map((fruit, index) => {
    const nextIndex = found[index + 1]?.index ?? section.length;
    const details = section.slice(fruit.index + fruit.name.length, nextIndex);
    const numbers = [...details.matchAll(/\b\d[\d,]*(?:\.\d+)?\b/g)].map(match => Number(match[0].replace(/,/g, "")));
    return {
      name: fruit.name,
      type,
      ...(numbers.length ? { money_price: numbers[0] } : {}),
      ...(numbers.length > 1 ? { robux_price: numbers[1] } : {})
    };
  });
}

async function getStock() {
  // Consulta diretamente a página pública da Fandom, sem consumir créditos de API.
  const response = await fetch(WIKI_STOCK_URL, {
    headers: {
      "Accept": "text/html,application/xhtml+xml",
      "User-Agent": "Mozilla/5.0 (compatible; AstralStock/1.0; +https://github.com/)"
    },
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) throw new Error("Fandom respondeu HTTP " + response.status);
  const html = await response.text();
  const text = htmlToStockText(html);
  const normal = parseWikiStockSection(text, "Current Stock", "Last Stock", "Normal");
  const mirage = parseWikiStockSection(text, "Current Mirage Stock", "Last Mirage Stock", "Mirage");
  if (!normal.length || !mirage.length) {
    throw new Error("A Fandom ainda não apresentou as listas completas de stock. Nenhum dado salvo foi alterado.");
  }
  return [...normal, ...mirage];
}
function safeName(item) {
  return String(item.name || item.Name || item.fruit || item.Fruit || "Fruta desconhecida");
}
function signature(stock) {
  return JSON.stringify(stock.map(x => ({
    name: safeName(x).toLowerCase(),
    beli: beliPrice(x) ?? "",
    robux: x.robux_price || "",
    type: x.type || ""
  })).sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name)));
}
function roleMentions(stock) {
  const roles = readConfig().roles || {};
  const mentions = [];
  for (const item of stock) {
    const id = roles[fruitKey(safeName(item))];
    if (id && /^\d{17,20}$/.test(String(id))) mentions.push(`<@&${id}>`);
  }
  return [...new Set(mentions)].join(" ");
}
function fruitEmoji(item) {
  const emojis = readConfig().emojis || {};
  return emojis[fruitKey(safeName(item))] || "🍈";
}
const SAVED_BELI_PRICES = {
  Rocket: 5000, Spin: 7500, Blade: 30000, Spring: 60000, Bomb: 80000, Smoke: 100000, Spike: 180000,
  Flame: 250000, Ice: 350000, Sand: 420000, Dark: 500000, Eagle: 550000, Diamond: 600000, Light: 650000,
  Rubber: 750000, Ghost: 940000, Magma: 960000, Quake: 1000000, Buddha: 1200000, Love: 1300000,
  Creation: 1400000, Spider: 1500000, Sound: 1700000, Phoenix: 1800000, Portal: 1900000, Lightning: 2100000,
  Pain: 2300000, Blizzard: 2400000, Gravity: 2500000, Mammoth: 2700000, "T-Rex": 2700000, Dough: 2800000,
  Shadow: 2900000, Venom: 3000000, Gas: 3200000, Spirit: 3400000, Tiger: 5000000, Yeti: 5000000,
  Kitsune: 8000000, Control: 9000000, Dragon: 15000000, Magnet: 6000000
};
function savedBeliPrice(name) {
  const key = Object.keys(SAVED_BELI_PRICES).find(k => fruitKey(k) === fruitKey(name));
  return key ? SAVED_BELI_PRICES[key] : null;
}
function beliPrice(item) {
  const apiPrice = item?.money_price ?? item?.price_beli ?? item?.price;
  return apiPrice != null && apiPrice !== "" ? apiPrice : savedBeliPrice(safeName(item));
}
function stockTitle(groupKey) {
  const config = readConfig();
  const defaults = {
    normal: "🏪 Blox Fruits | Stock normal atualizado",
    mirage: "🌙 Blox Fruits | Stock da Mirage atualizado"
  };
  return config.titles?.[groupKey] || defaults[groupKey] || "🍈 Blox Fruits | Stock atualizado";
}
function nextGlobalReset(groupKey, now = new Date()) {
  const intervalHours = groupKey === "mirage" ? 2 : 4;
  const d = new Date(now.getTime());
  const hour = d.getUTCHours();
  let nextHour = hour + (intervalHours - (hour % intervalHours));
  if (nextHour === hour && (d.getUTCMinutes() || d.getUTCSeconds() || d.getUTCMilliseconds())) nextHour += intervalHours;
  if (nextHour >= 24) { d.setUTCDate(d.getUTCDate() + 1); nextHour -= 24; }
  d.setUTCHours(nextHour, 0, 0, 0);
  return d;
}
function brasilTime(timestamp) {
  return new Intl.DateTimeFormat("pt-BR", { timeZone: BRASIL_TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(timestamp));
}
function stockCountdown(groupKey) {
  const next = nextGlobalReset(groupKey);
  const label = groupKey === "mirage" ? "Stock da Mirage" : "Stock normal";
  return "<a:emoji_233:1556370328135925931> **Próximo " + label + ":** <t:" + Math.floor(next.getTime() / 1000) + ":R> • **" + brasilTime(next.getTime()) + " (Brasília)**";
}
async function resolveEmoji(input) {
  const value = String(input || "").trim();
  if (/^<a?:[A-Za-z0-9_]+:\d{17,20}>$/.test(value) || /\p{Extended_Pictographic}/u.test(value)) return value;
  const name = value.replace(/^:|:$/g, "");
  try {
    const appEmojis = await client.application.emojis.fetch();
    const found = appEmojis.find(emoji => emoji.name === name);
    if (found) return `${found.animated ? "<a" : "<"}:${found.name}:${found.id}>`;
  } catch (error) {
    console.warn("Não consegui consultar os emojis da aplicação:", error.message);
  }
  return value;
}
function stockContainer(stock, title, groupKey = null) {
  const lines = stock.map(item => {
    const price = beliPrice(item);
    return `${fruitEmoji(item)} **${safeName(item)}**${price != null ? ` | <:emoji_232:1556366446257242112> \`${Number(price).toLocaleString("en-US")}\`` : ""}${item.robux_price != null ? ` | ${item.robux_price} <:emoji_217:1550603330722467922>` : ""}`;
  });
  const mentions = roleMentions(stock);
  const body = [
    `# ${title}`,
    "",
    mentions,
    ...(lines.length ? lines : ["Nenhuma fruta encontrada."]),
    "",
    groupKey ? stockCountdown(groupKey) : "",
    "-# Dados de stock • Confira no jogo antes de negociar"
  ].filter(Boolean).join("\n");
  return new ContainerBuilder()
    .setAccentColor(0x00FFFF)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(body));
}
function panelContainer() {
  const state = readState();
  const latest = state.latestStock || {};
  const normal = Array.isArray(latest.normal) ? latest.normal : [];
  const mirage = Array.isArray(latest.mirage) ? latest.mirage : [];
  const normalNames = normal.length ? normal.map(item => `${fruitEmoji(item)} **${safeName(item)}**`).join(" • ") : "Nenhum stock normal publicado ainda.";
  const mirageNames = mirage.length ? mirage.map(item => `${fruitEmoji(item)} **${safeName(item)}**`).join(" • ") : "Nenhum stock da Mirage publicado ainda.";
  const normalBeli = normal.reduce((sum, item) => sum + (Number(beliPrice(item)) || 0), 0);
  const mirageBeli = mirage.reduce((sum, item) => sum + (Number(beliPrice(item)) || 0), 0);
  const lastNormal = state.history?.find(h => h.type === "Normal" || (h.stock || []).some(x => String(x.type || "").toLowerCase() === "normal"));
  const lastMirage = state.history?.find(h => h.type === "Mirage" || (h.stock || []).some(x => String(x.type || "").toLowerCase() === "mirage"));
  const body = [
    "# 🌌 ASTRAL STOCK",
    "",
    "## 🟢 SISTEMA ONLINE",
    "O painel está conectado e acompanhando o stock automaticamente.",
    "",
    "## 📦 STOCK NORMAL",
    `**${normal.length}** frutas encontradas`,
    normalNames,
    `💰 Valor listado: **${normalBeli.toLocaleString("pt-BR")} Beli**`,
    `<a:emoji_233:1556370328135925931> Próximo reset: <t:${Math.floor(nextGlobalReset("normal").getTime() / 1000)}:R>`,
    lastNormal ? `🕒 Última alteração: <t:${Math.floor(new Date(lastNormal.at).getTime() / 1000)}:R>` : "",
    "",
    "## 🌙 STOCK DA MIRAGE",
    `**${mirage.length}** frutas encontradas`,
    mirageNames,
    `💰 Valor listado: **${mirageBeli.toLocaleString("pt-BR")} Beli**`,
    `<a:emoji_233:1556370328135925931> Próximo reset: <t:${Math.floor(nextGlobalReset("mirage").getTime() / 1000)}:R>`,
    lastMirage ? `🕒 Última alteração: <t:${Math.floor(new Date(lastMirage.at).getTime() / 1000)}:R>` : "",
    "",
    "## 🤖 ASTRAL IA",
    "Marque o bot no chat para conversar com a IA.",
    "",
    "-# Stock automático • Emojis personalizados • Cargos por fruta • IA integrada"
  ].filter(Boolean).join("\n");
  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("astral_panel_stock").setLabel("Ver Stock").setEmoji("📦").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("astral_panel_refresh").setLabel("Atualizar Painel").setEmoji("🔄").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("astral_panel_help").setLabel("Comandos").setEmoji("❓").setStyle(ButtonStyle.Secondary)
  );
  return new ContainerBuilder()
    .setAccentColor(0x00FFFF)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(body))
    .addSeparatorComponents(new SeparatorBuilder())
    .addActionRowComponents(buttons);
}
async function postStock(stock, announce, title, groupKey = null) {
  const channel = await client.channels.fetch(process.env.CHANNEL_ID);
  if (!channel || !channel.isTextBased() || !channel.send) throw new Error("CHANNEL_ID não é um canal de texto acessível.");
  await channel.send({ components: [stockContainer(stock, title, groupKey)], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: ["roles"] } });
}
async function checkStock(force = false, onlyGroups = ["normal", "mirage"], throwOnError = false, providedStock = null) {
  if (checking) return false;
  checking = true;
  try {
    const stock = providedStock || await getStock();
    const state = readState();
    state.stockSignatures = state.stockSignatures || {};
    state.latestStock = state.latestStock || {};
    const groups = [
      { key: "normal", type: "Normal", title: stockTitle("normal") },
      { key: "mirage", type: "Mirage", title: stockTitle("mirage") }
    ].filter(group => onlyGroups.includes(group.key));

    for (const group of groups) {
      const items = stock.filter(item => String(item.type || "").toLowerCase() === group.type.toLowerCase());
      const sig = signature(items);

      if (items.length && (force || !state.stockSignatures[group.key] || sig !== state.stockSignatures[group.key])) {
        await postStock(items, true, group.title, group.key);
        state.latestStock[group.key] = items;
        state.history = Array.isArray(state.history) ? state.history : [];
        state.history.unshift({ at: new Date().toISOString(), stock: items, type: group.type });
        state.history = state.history.slice(0, Math.max(500, Number(readConfig().historyLimit || 500)));
      }
      state.stockSignatures[group.key] = sig;
    }

    saveState(state);
    console.log(`Stock consultado: ${groups.map(g => `${g.type} ${stock.filter(x => String(x.type || "").toLowerCase() === g.type.toLowerCase()).length} frutas`).join("; ")}.`);
    return true;
  } catch (error) {
    console.error("Erro ao consultar/enviar stock:", error.message);
    if (throwOnError) throw error;
    return false;
  } finally {
    checking = false;
  }
}


const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function runScheduledStockCycle(groupKeys) {
  const pending = new Set(groupKeys);
  const baseline = {};
  const initialState = readState();
  for (const key of pending) baseline[key] = initialState.stockSignatures?.[key] || null;

  // A primeira consulta acontece 1 minuto após o horário previsto do reset.
  await wait(60000);
  console.log("Iniciando captura pós-reset para: " + [...pending].join(", "));

  while (pending.size) {
    // Se uma captura demorar além do próximo reset, adiciona esse grupo ao ciclo
    // sem interromper as tentativas que já estão em andamento.
    const now = Date.now();
    for (const key of ["normal", "mirage"]) {
      if (!pending.has(key) && nextStockAt[key] && now >= nextStockAt[key] + 60000) {
        pending.add(key);
        baseline[key] = readState().stockSignatures?.[key] || null;
        console.log("Novo ciclo de captura iniciado para: " + key);
      }
    }

    try {
      const stock = await getStock();
      const normal = stock.filter(item => String(item.type || "").toLowerCase() === "normal");
      const mirage = stock.filter(item => String(item.type || "").toLowerCase() === "mirage");
      if (!normal.length || !mirage.length) throw new Error("A fonte não retornou as duas listas completas.");

      const readyGroups = [];
      for (const key of pending) {
        const items = key === "normal" ? normal : mirage;
        const currentSignature = signature(items);
        // Só considera pronto quando o conteúdo muda em relação ao estoque anterior.
        if (baseline[key] === null || currentSignature !== baseline[key]) readyGroups.push(key);
      }

      if (readyGroups.length) {
        const ok = await checkStock(false, readyGroups, false, stock);
        if (ok) {
          for (const key of readyGroups) {
            pending.delete(key);
            nextStockAt[key] = nextGlobalReset(key, new Date(Date.now())).getTime();
          }
          console.log("Captura concluída para: " + readyGroups.join(", "));
        }
      } else {
        console.log("Stock ainda não mudou na Fandom; nova tentativa em 1 minuto.");
      }
    } catch (error) {
      console.warn("Ainda não foi possível capturar o stock: " + error.message);
    }

    if (pending.size) await wait(60000);
  }
}


async function askAI(userId, question) {
  const history = aiHistory.get(userId) || [];
  const cached = readState().latestStock || {};
  const stock = [
    ...(Array.isArray(cached.normal) ? cached.normal : []),
    ...(Array.isArray(cached.mirage) ? cached.mirage : [])
  ];
  const stockText = stock.map(item => {
    const price = beliPrice(item);
    return `${safeName(item)} (${item.type || "Stock"}, ${price != null ? Number(price).toLocaleString("pt-BR") + " Beli" : "preço não informado"})`;
  }).join(", ") || "Stock indisponível no momento.";

  const input = [
    {
      role: "developer",
      content: "Você é o assistente oficial do servidor Astral Stock. Responda em português do Brasil, de forma amigável, curta e natural. Ajude com Blox Fruits, stock, frutas, preços e dúvidas gerais do servidor. Não invente informações sobre o stock. Quando perguntarem pelo stock atual, use somente os dados fornecidos abaixo. Não peça nem revele tokens, API keys ou outras credenciais. Evite assuntos impróprios para menores."
    },
    ...history.slice(-8),
    {
      role: "user",
      content: question + "\n\nStock consultado agora: " + stockText
    }
  ];

  const response = await openai.responses.create({
    model: process.env.OPENAI_MODEL || "gpt-5.4-nano",
    input
  });

  const answer = String(response.output_text || "Não consegui gerar uma resposta agora.").trim();
  const updated = [...history, { role: "user", content: question }, { role: "assistant", content: answer }].slice(-10);
  aiHistory.set(userId, updated);
  return answer;
}

const ALL_FRUITS = [
  "Rocket", "Spin", "Blade", "Spring", "Bomb", "Smoke", "Spike", "Flame", "Ice", "Sand",
  "Dark", "Eagle", "Diamond", "Light", "Rubber", "Ghost", "Magma", "Quake", "Buddha", "Love",
  "Creation", "Spider", "Sound", "Phoenix", "Portal", "Lightning", "Pain", "Blizzard", "Gravity",
  "Mammoth", "T-Rex", "Dough", "Shadow", "Venom", "Gas", "Spirit", "Tiger", "Yeti",
  "Magnet", "Kitsune", "Control", "Dragon"
];

function historySnapshots(groupKey) {
  const targetType = groupKey === "mirage" ? "mirage" : "normal";
  const history = readState().history || [];
  const snapshots = [];
  for (const entry of history) {
    const at = new Date(entry.at).getTime();
    if (!Number.isFinite(at)) continue;
    const items = Array.isArray(entry.stock) ? entry.stock : [];
    let matching = items.filter(item => String(item.type || "").toLowerCase() === targetType);
    if (entry.type && String(entry.type).toLowerCase() === (targetType === "mirage" ? "mirage" : "normal")) {
      matching = items;
    }
    if (matching.length) snapshots.push({ at, names: [...new Set(matching.map(item => fruitKey(safeName(item))))] });
  }
  return snapshots.sort((a, b) => a.at - b.at);
}
function buildFruitAnalytics(groupKey) {
  const snapshots = historySnapshots(groupKey);
  const stats = new Map();
  for (const snapshot of snapshots) {
    for (const name of snapshot.names) {
      if (!stats.has(name)) stats.set(name, []);
      const dates = stats.get(name);
      if (!dates.length || dates[dates.length - 1] !== snapshot.at) dates.push(snapshot.at);
    }
  }
  return [...stats.entries()].map(([name, dates]) => {
    const gaps = dates.slice(1).map((date, index) => date - dates[index]);
    const averageGap = gaps.length ? gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length : null;
    const displayName = ALL_FRUITS.find(fruit => fruitKey(fruit) === name) || name;
    const frequency = snapshots.length ? (dates.length / snapshots.length) * 100 : 0;
    return { name, displayName, count: dates.length, frequency, lastSeen: dates[dates.length - 1], averageGap, nextEstimate: averageGap ? dates[dates.length - 1] + averageGap : null };
  }).sort((a, b) => b.count - a.count);
}
function formatDuration(ms) {
  const hours = Math.max(0, Math.round(ms / 3600000));
  if (hours < 24) return hours + "h";
  const days = Math.floor(hours / 24);
  return days + "d " + (hours % 24) + "h";
}
function percentageBar(percent) {
  const filled = Math.max(0, Math.min(10, Math.round(percent / 10)));
  return "▰".repeat(filled) + "▱".repeat(10 - filled);
}
function analyticsMessage(groupKey, prediction = false) {
  const snapshots = historySnapshots(groupKey);
  const stats = buildFruitAnalytics(groupKey);
  const label = groupKey === "mirage" ? "Mirage" : "Normal";
  if (!snapshots.length) return "📊 Ainda não tenho histórico suficiente do Stock " + label + ". Deixe o bot registrar mais atualizações.";
  if (!prediction) {
    const top = stats.slice(0, 10).map((item, index) =>
      fruitEmoji({ name: item.displayName }) + " **" + (index + 1) + ". " + item.displayName + "**\n" +
      "`" + item.frequency.toFixed(1) + "%` " + percentageBar(item.frequency) +
      " • " + item.count + "/" + snapshots.length + " registros"
    );
    return ["# 📊 Estatísticas do Stock " + label, "", "Registros analisados: **" + snapshots.length + "**", "", ...top, "", "-# Percentual = frequência histórica nos registros do bot, não garantia de aparição futura."].join("\n");
  }
  const candidates = stats.filter(item => item.averageGap && item.count >= 2 && item.nextEstimate).sort((a, b) => a.nextEstimate - b.nextEstimate).slice(0, 8);
  if (!candidates.length) return "# 🔮 Previsão do Stock " + label + "\n\nAinda preciso registrar mais aparições repetidas para estimar intervalos. Continue deixando o bot atualizar o histórico.";
  const now = Date.now();
  const lines = candidates.map(item => {
    const remaining = item.nextEstimate - now;
    const estimate = remaining <= 0 ? "estimativa de retorno já passou" : "estimativa em " + formatDuration(remaining);
    return fruitEmoji({ name: item.displayName }) + " **" + item.displayName + "**\n" +
      "`" + item.frequency.toFixed(1) + "%` " + percentageBar(item.frequency) +
      " • frequência histórica\n↳ " + estimate + " • média: " + formatDuration(item.averageGap);
  });
  return ["# 🔮 Previsão do Stock " + label, "", ...lines, "", "-# A porcentagem mostra a frequência nos registros anteriores. O horário é uma estimativa matemática, não uma chance garantida: o stock é aleatório."].join("\n");
}
async function testStockContainers() {
  const config = readConfig();
  const emojis = config.emojis || {};
  const lines = ALL_FRUITS.map(name => {
    const emoji = emojis[fruitKey(name)] || "🍈";
    const price = savedBeliPrice(name);
    const priceText = price != null ? "<:emoji_232:1556366446257242112> `" + Number(price).toLocaleString("en-US") + "`" : "<:emoji_232:1556366446257242112> `Valor não cadastrado`";
    return emoji + " **" + name + "** | " + priceText;
  });
  const body = ["# <:emoji_001:1539652915050971226> Blox Fruits", "", ...lines].join("\n");
  return [new ContainerBuilder().setAccentColor(0x00FFFF).addTextDisplayComponents(new TextDisplayBuilder().setContent(body))];
}

const fruitOption = (option) => option.setName("fruta").setDescription("Nome da fruta exatamente como aparece no stock").setRequired(true);
const commands = [
  new SlashCommandBuilder().setName("stock").setDescription("Mostra o stock atual de Blox Fruits"),
  new SlashCommandBuilder().setName("painel").setDescription("Abre o painel completo do Astral Stock"),
  new SlashCommandBuilder().setName("ia").setDescription("Conversa com a IA do Astral Stock").addStringOption(option => option.setName("pergunta").setDescription("O que você quer perguntar").setRequired(true).setMaxLength(1000)),
  new SlashCommandBuilder().setName("imagem").setDescription("Gera uma imagem com inteligência artificial").addStringOption(option => option.setName("prompt").setDescription("Descreva a imagem que deseja criar").setRequired(true).setMaxLength(1000)),
  new SlashCommandBuilder().setName("testeestoque").setDescription("Mostra todas as frutas para testar os emojis").setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName("atualizar").setDescription("Consulta a Wiki e publica o stock atual").setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName("historico").setDescription("Mostra as últimas alterações de stock"),
  new SlashCommandBuilder().setName("previsao").setDescription("Estima possíveis retornos de frutas com base no histórico")
    .addStringOption(option => option.setName("estoque").setDescription("Qual estoque analisar").setRequired(true)
      .addChoices({ name: "Stock Normal", value: "normal" }, { name: "Stock da Mirage", value: "mirage" })),
  new SlashCommandBuilder().setName("estatisticas").setDescription("Mostra as frutas mais frequentes no histórico")
    .addStringOption(option => option.setName("estoque").setDescription("Qual estoque analisar").setRequired(true)
      .addChoices({ name: "Stock Normal", value: "normal" }, { name: "Stock da Mirage", value: "mirage" })),
  new SlashCommandBuilder().setName("configurar-fruta").setDescription("Define o cargo que será mencionado para uma fruta")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(fruitOption)
    .addRoleOption(option => option.setName("cargo").setDescription("Cargo que será mencionado").setRequired(true)),
  new SlashCommandBuilder().setName("configurar-emoji").setDescription("Define o emoji que aparece ao lado de uma fruta")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(fruitOption)
    .addStringOption(option => option.setName("emoji").setDescription("Emoji Unicode ou nome de um emoji da aplicação").setRequired(true)),
  new SlashCommandBuilder().setName("configurar-titulo").setDescription("Edita o título do estoque normal ou Mirage")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(option => option.setName("estoque").setDescription("Qual estoque deseja editar").setRequired(true)
      .addChoices({ name: "Stock Normal", value: "normal" }, { name: "Stock da Mirage", value: "mirage" }))
    .addStringOption(option => option.setName("titulo").setDescription("Novo título que aparecerá na mensagem").setRequired(true).setMaxLength(100)),
  new SlashCommandBuilder().setName("listar-emojis").setDescription("Lista os emojis configurados para as frutas")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName("remover-emoji").setDescription("Remove o emoji personalizado de uma fruta")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(fruitOption),
  new SlashCommandBuilder().setName("listar-cargos").setDescription("Lista os cargos configurados para as frutas")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName("remover-cargo").setDescription("Remove o cargo configurado para uma fruta")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(fruitOption)
];
async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body: commands.map(c => c.toJSON()) });
  console.log("Comandos de stock, IA, cargos e emojis registrados.");
}
client.once("ready", async () => {
  console.log(`Bot conectado como ${client.user.tag}`);
  try {
    await registerCommands();
  } catch (error) {
    console.error("Erro ao registrar comandos do Astral Stock:", error);
  }

  nextStockAt.normal = nextGlobalReset("normal").getTime();
  nextStockAt.mirage = nextGlobalReset("mirage").getTime();

  console.log("Agendamento automático: captura 1 minuto após cada reset e tenta novamente a cada minuto até detectar um stock novo.");

  const schedule = () => {
    const now = Date.now();
    nextStockAt.normal = nextGlobalReset("normal", new Date(now)).getTime();
    nextStockAt.mirage = nextGlobalReset("mirage", new Date(now)).getTime();
    const nextAt = Math.min(nextStockAt.normal, nextStockAt.mirage);
    const delay = Math.max(1000, nextAt - now);

    setTimeout(async () => {
      const dueGroups = [];
      const current = Date.now();
      if (nextStockAt.normal <= current + 1000) dueGroups.push("normal");
      if (nextStockAt.mirage <= current + 1000) dueGroups.push("mirage");

      if (dueGroups.length) {
        await runScheduledStockCycle(dueGroups);
      }
      schedule();
    }, delay);
  };
  schedule();
});

process.on("unhandledRejection", error => {
  console.error("Promise rejeitada sem tratamento:", error);
});

process.on("uncaughtException", error => {
  console.error("Erro não tratado:", error);
});
const aiCooldown = new Map();

async function detectStockIntent(userId, question) {
  const history = aiHistory.get(userId) || [];
  try {
    const response = await openai.responses.create({
      model: process.env.OPENAI_MODEL || "gpt-5.4-nano",
      input: [
        {
          role: "developer",
          content: [
            "Classifique a intenção da mensagem de um usuário que marcou o bot Astral Stock.",
            "Considere a mensagem atual e o histórico recente para entender o contexto.",
            "Responda com exatamente UMA destas opções: STOCK_NORMAL, STOCK_MIRAGE, STOCK_BOTH ou CHAT.",
            "Use STOCK_NORMAL quando a pessoa pedir claramente para ver/consultar o stock normal atual ou perguntar quais frutas estão disponíveis agora no stock normal.",
            "Use STOCK_MIRAGE quando pedir claramente o stock atual da Mirage.",
            "Use STOCK_BOTH quando pedir o stock atual sem especificar o tipo.",
            "Use CHAT para dúvidas, explicações, comentários, conversas ou qualquer mensagem que apenas mencione stock, frutas ou Mirage sem pedir os dados atuais.",
            "Exemplos: 'como funciona o stock?' = CHAT; 'por que o stock muda?' = CHAT; 'qual é o horário do stock?' = CHAT; 'me mostra o stock' = STOCK_BOTH; 'quais frutas estão no stock agora?' = STOCK_BOTH; 'mostra o stock normal' = STOCK_NORMAL; 'tem o que na Mirage agora?' = STOCK_MIRAGE.",
            "Na dúvida, escolha CHAT. Nunca classifique como pedido de stock só porque o usuário marcou o bot."
          ].join(" ")
        },
        ...history.slice(-6),
        { role: "user", content: question }
      ]
    });

    const intent = String(response.output_text || "").trim().toUpperCase();
    if (intent === "STOCK_NORMAL") return ["normal"];
    if (intent === "STOCK_MIRAGE") return ["mirage"];
    if (intent === "STOCK_BOTH") return ["normal", "mirage"];
    return null;
  } catch (error) {
    // Falha na classificação não pode bloquear a conversa normal com a IA.
    console.warn("Não foi possível classificar pedido de stock; seguindo para a IA:", error.message);
    return null;
  }
}

async function sendSavedStock(channel, groups) {
  const latest = readState().latestStock || {};
  const components = [];
  for (const key of groups) {
    const items = Array.isArray(latest[key]) ? latest[key] : [];
    if (items.length) components.push(stockContainer(items, stockTitle(key), key));
  }
  if (!components.length) {
    await channel.send("Ainda não tenho um estoque válido salvo da Fandom. Assim que conseguir capturar a próxima atualização, vou poder mostrar aqui.");
    return false;
  }
  await channel.send({
    components,
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: ["roles"] }
  });
  return true;
}

client.on("messageCreate", async message => {
  if (message.author.bot || !message.guild) return;
  console.log("[CHAT] Mensagem recebida em #" + (message.channel?.name || "canal") + " de " + message.author.tag);

  if (!client.user) {
    console.warn("[CHAT] client.user ainda não está disponível.");
    return;
  }
  const botMentionPattern = new RegExp("<@!?" + client.user.id + ">");
  const hasBotMention = message.mentions.users.has(client.user.id) || botMentionPattern.test(String(message.content || ""));
  if (!hasBotMention) {
    console.log("[CHAT] Mensagem ignorada: não contém menção direta ao bot.");
    return;
  }
  console.log("[CHAT] Menção detectada; iniciando processamento.");

  const now = Date.now();
  const last = aiCooldown.get(message.author.id) || 0;
  if (now - last < 5000) {
    await message.reply("⏳ Calma aí! Espere alguns segundos antes de me chamar de novo.");
    return;
  }
  aiCooldown.set(message.author.id, now);

  const question = String(message.content || "")
    .replace(new RegExp("<@!?" + client.user.id + ">", "g"), "")
    .trim();
  console.log("[CHAT] Texto após remover menção: " + (question || "(vazio)"));

  if (!question) {
    await message.reply("👋 Me marque e escreva sua pergunta. Ex.: `@Astral Stock qual é o stock atual?`");
    return;
  }

  try {
    console.log("[CHAT] Analisando intenção da mensagem.");
    const stockGroups = await detectStockIntent(message.author.id, question);
    console.log("[CHAT] Análise concluída: " + (stockGroups ? stockGroups.join(",") : "conversa normal"));
    if (stockGroups) {
      await sendSavedStock(message.channel, stockGroups);
      return;
    }

    console.log("[CHAT] Enviando pergunta para a IA.");
    await message.channel.sendTyping();
    const answer = await askAI(message.author.id, question);
    console.log("[CHAT] IA respondeu; enviando resposta ao Discord.");
    await message.reply({
      content: answer.slice(0, 2000),
      allowedMentions: { repliedUser: false }
    });
  } catch (error) {
    console.error("Erro na IA pelo chat:", error.message);
    await message.reply({
      content: "❌ Não consegui responder agora. Tente novamente em alguns segundos.",
      allowedMentions: { repliedUser: false }
    });
  }
});

client.on("interactionCreate", async interaction => {
  if (interaction.isButton()) {
    try {
      if (interaction.customId === "astral_panel_stock") {
        const state = readState();
        const latest = state.latestStock || {};
        const normal = Array.isArray(latest.normal) ? latest.normal : [];
        const mirage = Array.isArray(latest.mirage) ? latest.mirage : [];
        const components = [];
        if (normal.length) components.push(stockContainer(normal, stockTitle("normal"), "normal"));
        if (mirage.length) components.push(stockContainer(mirage, stockTitle("mirage"), "mirage"));
        if (!components.length) components.push(stockContainer([], "🍈 STOCK ATUAL", null));
        await interaction.reply({ components, flags: MessageFlags.IsComponentsV2 });
        return;
      }
      if (interaction.customId === "astral_panel_refresh") {
        await interaction.update({ components: [panelContainer()], flags: MessageFlags.IsComponentsV2 });
        return;
      }
      if (interaction.customId === "astral_panel_help") {
        await interaction.reply({ content: "📚 **Comandos principais**\n`/painel` painel completo\n`/stock` stock atual\n`/ia` conversa com a IA\n`/historico` histórico\n`/testeestoque` teste das frutas\n`/atualizar` consulta e publica agora", ephemeral: true });
        return;
      }
    } catch (error) {
      console.error("Erro no botão do painel:", error);
      if (!interaction.replied && !interaction.deferred) await interaction.reply({ content: "❌ Não consegui executar essa ação.", ephemeral: true });
    }
    return;
  }
  if (!interaction.isChatInputCommand()) return;
  try {
  if (interaction.commandName === "imagem") {
    const now = Date.now();
    const last = imageCooldown.get(interaction.user.id) || 0;
    const waitMs = 45000 - (now - last);
    if (waitMs > 0) {
      await interaction.reply({ content: "⏳ Aguarde " + Math.ceil(waitMs / 1000) + " segundos antes de gerar outra imagem.", ephemeral: true });
      return;
    }
    imageCooldown.set(interaction.user.id, now);
    await interaction.deferReply();
    try {
      const prompt = interaction.options.getString("prompt", true).trim();
      const result = await openai.images.generate({
        model: process.env.OPENAI_IMAGE_MODEL || "gpt-image-1-mini",
        prompt,
        size: "1024x1024",
        quality: "low",
        n: 1
      });
      const imageBase64 = result.data?.[0]?.b64_json;
      if (!imageBase64) throw new Error("A API não retornou a imagem.");
      const file = new AttachmentBuilder(Buffer.from(imageBase64, "base64"), { name: "astral-imagem.png" });
      await interaction.editReply({ content: "🎨 Imagem criada para " + interaction.user + "!", files: [file], allowedMentions: { users: [interaction.user.id] } });
    } catch (error) {
      console.error("Erro ao gerar imagem:", error);
      const message = /billing|quota|insufficient/i.test(error.message || "")
        ? "❌ A conta da API está sem saldo ou atingiu o limite de uso. Confira o faturamento da OpenAI."
        : "❌ Não consegui gerar essa imagem. Tente outra descrição ou verifique a chave e o acesso ao modelo.";
      await interaction.editReply({ content: message });
    }
  } else if (interaction.commandName === "ia") {
    await interaction.deferReply();
    try {
      const question = interaction.options.getString("pergunta");
      const answer = await askAI(interaction.user.id, question);
      await interaction.editReply(answer.slice(0, 2000));
    } catch (e) {
      console.error("Erro na IA:", e.message);
      await interaction.editReply("❌ Não consegui falar com a IA agora. Verifique a configuração da OpenAI.");
    }
  } else if (interaction.commandName === "testeestoque") {
    await interaction.reply({ components: await testStockContainers(), flags: MessageFlags.IsComponentsV2 });
  } else if (interaction.commandName === "painel") {
    await interaction.reply({ components: [panelContainer()], flags: MessageFlags.IsComponentsV2 });
  } else if (interaction.commandName === "stock") {
    try {
      // /stock mostra o mesmo stock que o bot publicou no canal configurado.
      // Não consulta a API novamente, evitando gastar crédito e possíveis dados antigos.
      const state = readState();
      const latest = state.latestStock || {};
      const normal = Array.isArray(latest.normal) ? latest.normal : [];
      const mirage = Array.isArray(latest.mirage) ? latest.mirage : [];
      const components = [];
      if (normal.length) components.push(stockContainer(normal, stockTitle("normal"), "normal"));
      if (mirage.length) components.push(stockContainer(mirage, stockTitle("mirage"), "mirage"));
      if (!components.length) {
        components.push(stockContainer([], "🍈 STOCK ATUAL", null));
      }
      await interaction.reply({ components, flags: MessageFlags.IsComponentsV2 });
    } catch (e) {
      console.error("Erro no /stock:", e);
      if (!interaction.replied && !interaction.deferred) await interaction.reply({ content: "❌ Não consegui mostrar o estoque agora.", ephemeral: true });
    }
  } else if (interaction.commandName === "atualizar") {
    await interaction.deferReply({ ephemeral: true });
    try {
      const completed = await checkStock(true, ["normal", "mirage"], true);
      if (!completed) {
        await interaction.editReply("⏳ Já existe uma consulta de stock em andamento. Tente novamente em alguns segundos.");
      } else {
        await interaction.editReply("✅ Consultei a Wiki, salvei o stock mais recente e publiquei as listas no canal!");
      }
    } catch (e) {
      await interaction.editReply("❌ Não consegui consultar a Wiki: " + e.message + ". O último stock salvo foi preservado.");
    }
  } else if (interaction.commandName === "configurar-titulo") {
    const groupKey = interaction.options.getString("estoque");
    const title = interaction.options.getString("titulo").trim();
    const config = readConfig();
    config.titles = config.titles || {};
    config.titles[groupKey] = title;
    saveConfig(config);
    await interaction.reply({
      content: `Título do ${groupKey === "mirage" ? "Stock da Mirage" : "Stock Normal"} alterado para **${title}**.`,
      ephemeral: true
    });
  } else if (interaction.commandName === "configurar-fruta") {
    const fruit = fruitKey(interaction.options.getString("fruta"));
    const role = interaction.options.getRole("cargo");
    const config = readConfig();
    config.roles = config.roles || {};
    config.roles[fruit] = role.id;
    saveConfig(config);
    await interaction.reply({ content: `Cargo ${role} configurado para **${fruit}**. Vou mencionar esse cargo quando a fruta aparecer no stock.`, ephemeral: true });
  } else if (interaction.commandName === "configurar-emoji") {
    const fruit = fruitKey(interaction.options.getString("fruta"));
    const emoji = await resolveEmoji(interaction.options.getString("emoji"));
    const config = readConfig();
    config.emojis = config.emojis || {};
    config.emojis[fruit] = emoji;
    saveConfig(config);
    await interaction.reply({ content: `Emoji ${emoji} configurado para **${fruit}**.`, ephemeral: true });
  } else if (interaction.commandName === "listar-emojis") {
    const emojis = readConfig().emojis || {};
    const content = Object.entries(emojis).map(([fruit, emoji]) => `• ${emoji} **${fruit}**`).join("\n");
    await interaction.reply({ content: content || "Nenhum emoji personalizado configurado ainda.", ephemeral: true });
  } else if (interaction.commandName === "remover-emoji") {
    const fruit = fruitKey(interaction.options.getString("fruta"));
    const config = readConfig();
    config.emojis = config.emojis || {};
    if (!config.emojis[fruit]) {
      await interaction.reply({ content: `Não há emoji personalizado para **${fruit}**.`, ephemeral: true });
    } else {
      delete config.emojis[fruit];
      saveConfig(config);
      await interaction.reply({ content: `Emoji personalizado removido para **${fruit}**.`, ephemeral: true });
    }
  } else if (interaction.commandName === "listar-cargos") {
    const roles = readConfig().roles || {};
    const entries = Object.entries(roles).filter(([, id]) => /^\d{17,20}$/.test(String(id)));
    const content = entries.map(([fruit, id]) => `• **${fruit}**: <@&${id}>`).join("\n");
    await interaction.reply({ content: content || "Nenhum cargo configurado ainda. Use /configurar-fruta.", ephemeral: true, allowedMentions: { parse: [] } });
  } else if (interaction.commandName === "remover-cargo") {
    const fruit = fruitKey(interaction.options.getString("fruta"));
    const config = readConfig();
    config.roles = config.roles || {};
    if (!config.roles[fruit]) {
      await interaction.reply({ content: `Não há cargo configurado para **${fruit}**.`, ephemeral: true });
    } else {
      delete config.roles[fruit];
      saveConfig(config);
      await interaction.reply({ content: `Configuração de cargo removida para **${fruit}**.`, ephemeral: true });
    }
  } else if (interaction.commandName === "previsao" || interaction.commandName === "estatisticas") {
    const groupKey = interaction.options.getString("estoque", true);
    const isPrediction = interaction.commandName === "previsao";
    await interaction.reply({ content: analyticsMessage(groupKey, isPrediction), ephemeral: true });
  } else if (interaction.commandName === "historico") {
    const history = readState().history || [];
    const content = history.slice(0, 5).map((h, i) =>
      `**${i + 1}.** <t:${Math.floor(new Date(h.at).getTime() / 1000)}:R> • ${(h.stock || []).map(safeName).join(", ") || "Sem dados"}`
    ).join("\n");
    await interaction.reply({ content: content || "Ainda não há histórico de alterações.", ephemeral: true });
  }
  } catch (error) {
    console.error(`Erro no comando /${interaction.commandName}:`, error);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: `❌ Ocorreu um erro ao executar /${interaction.commandName}. Tente novamente.` });
      } else {
        await interaction.reply({ content: "❌ Ocorreu um erro ao executar este comando.", ephemeral: true });
      }
    } catch (replyError) {
      console.error("Não foi possível responder à interação:", replyError);
    }
  }
});
client.login(process.env.DISCORD_TOKEN);
