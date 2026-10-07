require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");
const {
  Client, GatewayIntentBits, MessageFlags, ContainerBuilder, TextDisplayBuilder, MediaGalleryBuilder, MediaGalleryItemBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, RoleSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, REST, Routes,
  SlashCommandBuilder, PermissionFlagsBits
} = require("discord.js");

const required = ["DISCORD_TOKEN", "CLIENT_ID"];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`Configuração ausente: ${key}. Veja o arquivo .env.example.`);
    process.exit(1);
  }
}
const CONFIG_PATH = path.join(__dirname, "config.json");
const STATE_PATH = path.join(__dirname, "data", "state.json");
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

let checking = false;
let apiCooldownUntil = 0;
const BRASIL_TZ = "America/Sao_Paulo";
const nextStockAt = { normal: null, mirage: null };

const fruitRoleBusyUsers = new Set();
const aiCooldowns = new Map();
const aiActiveChats = new Map();
const AI_CHAT_TIMEOUT_MS = 30 * 60 * 1000;

async function askGroqAI(prompt, userId) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error("A IA ainda não foi configurada. Adicione GROQ_API_KEY nas variáveis de ambiente.");
  }

  const now = Date.now();
  const lastUse = aiCooldowns.get(String(userId)) || 0;
  const remaining = 5000 - (now - lastUse);
  if (remaining > 0) {
    throw new Error("Aguarde " + Math.ceil(remaining / 1000) + "s antes de usar a IA novamente.");
  }
  aiCooldowns.set(String(userId), now);

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + apiKey,
      "Content-Type": "application/json",
      "Accept": "application/json"
    },
    body: JSON.stringify({
      model: process.env.GROQ_MODEL || "openai/gpt-oss-120b",
      messages: [
        {
          role: "system",
          content: "Você é a IA do Astral Stock, um bot de Discord focado em Blox Fruits. Responda em português do Brasil, de forma útil, clara e curta. Não invente informações sobre o stock atual. Quando não souber algo, diga que não sabe."
        },
        { role: "user", content: String(prompt).trim() }
      ],
      max_completion_tokens: 700,
      temperature: 0.7
    }),
    signal: AbortSignal.timeout(30000)
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data?.error?.message || "A API da IA recusou a solicitação.";
    throw new Error(detail);
  }

  const text = data?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("A IA não retornou uma resposta.");
  return text;
}

function splitDiscordText(text, maxLength = 1900) {
  const chunks = [];
  let remaining = String(text || "");
  while (remaining.length > maxLength) {
    let cut = remaining.lastIndexOf("\n", maxLength);
    if (cut < 500) cut = remaining.lastIndexOf(" ", maxLength);
    if (cut < 1) cut = maxLength;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks.length ? chunks : ["Não recebi uma resposta da IA."];
}


function defaultGuildConfig() {
  return { channelId: null, roles: {}, emojis: {}, aliases: {}, titles: {}, stockAlertChannelId: null, stockAlerts: {} };
}
function readConfig() {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    config.guilds = config.guilds || {};
    return config;
  } catch {
    return { guilds: {}, historyLimit: 20 };
  }
}
function saveConfig(config) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

const PROTECTED_GUILD_ID = "1528047581845000353";

function getAllowedGuildIds() {
  const config = readConfig();
  return Array.isArray(config.allowedGuildIds) ? config.allowedGuildIds : [];
}

const BOT_OWNER_IDS = new Set([
  "904829627799834684"
]);

async function isBotOwner(userId) {
  // Donos definidos diretamente pelo projeto, além do dono oficial da aplicação.
  if (BOT_OWNER_IDS.has(String(userId))) return true;

  try {
    const application = await client.application.fetch();
    const owner = application.owner;

    // Aplicação pessoal: owner.id é o ID do usuário.
    if (owner?.id && userId === owner.id) return true;

    // Aplicação pertencente a uma Team: ownerId é o ID do dono da Team.
    if (owner?.ownerId && userId === owner.ownerId) return true;

    // Permite definir explicitamente o dono no .env, sem depender do cache do Discord.
    if (process.env.OWNER_ID && userId === process.env.OWNER_ID) return true;

    return false;
  } catch (error) {
    console.warn("[SECURITY] Não foi possível verificar o dono da aplicação:", error.message);
    return false;
  }
}

function initializeGuildWhitelist() {
  const config = readConfig();
  let changed = false;

  // Segurança: nunca autoriza automaticamente todos os servidores onde o bot
  // já estiver. Um servidor só pode ser autorizado se o ID estiver no painel
  // (/manage-servers) ou se for o servidor protegido.
  if (!Array.isArray(config.allowedGuildIds)) {
    config.allowedGuildIds = [];
    changed = true;
  }

  if (!config.allowedGuildIds.includes(PROTECTED_GUILD_ID)) {
    config.allowedGuildIds.push(PROTECTED_GUILD_ID);
    changed = true;
  }

  if (changed) {
    saveConfig(config);
    console.log("[SECURITY] Lista de servidores permitidos inicializada com segurança.");
  }
}

async function enforceGuildWhitelist() {
  const allowed = new Set(getAllowedGuildIds());
  for (const guild of client.guilds.cache.values()) {
    if (!allowed.has(guild.id) && guild.id !== PROTECTED_GUILD_ID) {
      console.log("[SECURITY] Servidor não autorizado detectado: " + guild.name + " (" + guild.id + "). Saindo.");
      try { await guild.leave(); } catch (error) {
        console.warn("[SECURITY] Não foi possível sair de " + guild.name + ": " + error.message);
      }
    }
  }
}
function getGuildConfig(guildId) {
  const config = readConfig();
  if (!guildId) return defaultGuildConfig();

  config.guilds = config.guilds || {};
  const current = config.guilds[guildId] || defaultGuildConfig();

  // Compatibilidade com configurações antigas que ficaram no nível raiz.
  // Se os cargos já existirem no formato antigo, eles também ficam disponíveis
  // para o painel novo, sem apagar a configuração atual do servidor.
  const legacyRoles = config.roles || {};
  const legacyAlerts = config.stockAlerts || {};

  const merged = {
    ...defaultGuildConfig(),
    ...current,
    roles: {
      ...legacyRoles,
      ...(current.roles || {})
    },
    titles: {
      ...(config.titles || {}),
      ...(current.titles || {})
    },
    stockAlerts: {
      ...legacyAlerts,
      ...(current.stockAlerts || {})
    }
  };

  if (!config.guilds[guildId]) {
    config.guilds[guildId] = merged;
    saveConfig(config);
  }

  return merged;
}
function updateGuildConfig(guildId, updater) {
  if (!guildId) throw new Error("Este comando só pode ser usado dentro de um servidor.");
  const config = readConfig();
  config.guilds = config.guilds || {};
  config.guilds[guildId] = { ...defaultGuildConfig(), ...(config.guilds[guildId] || {}) };
  updater(config.guilds[guildId]);
  saveConfig(config);
  return config.guilds[guildId];
}
function migrateLegacyConfig() {
  const config = readConfig();
  const legacyGuild = process.env.GUILD_ID;
  const legacyChannel = process.env.CHANNEL_ID;
  const hasLegacy = legacyChannel || ["roles","emojis","aliases","titles","stockAlertChannelId","stockAlerts"].some(k => config[k] !== undefined);
  if (legacyGuild && hasLegacy && !config.guilds[legacyGuild]) {
    config.guilds[legacyGuild] = { ...defaultGuildConfig(), channelId: legacyChannel || null, roles: config.roles || {}, emojis: config.emojis || {}, aliases: config.aliases || {}, titles: config.titles || {}, stockAlertChannelId: config.stockAlertChannelId || null, stockAlerts: config.stockAlerts || {} };
    for (const key of ["roles","emojis","aliases","titles","stockAlertChannelId","stockAlerts"]) delete config[key];
    saveConfig(config);
    console.log("[CONFIG] Configuração antiga migrada para o servidor " + legacyGuild + ".");
  }
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

  const normalizeItem = (item, type) => {
    const value = typeof item === "string" ? { name: item } : { ...(item || {}) };
    const robux = value.robux_price ?? value.robuxPrice ?? value.robux ?? value.permanent_price ?? value.permanentPrice ?? value.permanent_robux;
    const beli = value.money_price ?? value.price_beli ?? value.beli_price ?? value.beliPrice ?? value.price;
    return {
      ...value,
      type,
      ...(beli != null && beli !== "" ? { money_price: beli } : {}),
      ...(robux != null && robux !== "" ? { robux_price: robux } : {})
    };
  };

  if (data && (Array.isArray(data.normal) || Array.isArray(data.mirage))) {
    const list = [];
    for (const item of data.normal || []) list.push(normalizeItem(item, "Normal"));
    for (const item of data.mirage || []) list.push(normalizeItem(item, "Mirage"));
    return list;
  }
  if (Array.isArray(data)) return data.map(x => normalizeItem(x, x?.type || "Normal"));
  throw new Error("Formato da API não reconhecido. Confira a resposta do endpoint.");
}
const STOCK_SOURCES = [...new Set([
  process.env.WIKI_STOCK_URL,
  "https://blox-fruits-wiki.com/wiki/stock/",
  "https://blox-fruits.fandom.com/wiki/Blox_Fruits_%22Stock%22"
].filter(Boolean))];

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
  const apiKeys = [
    process.env.STOCK_API_KEY_1,
    process.env.STOCK_API_KEY_2,
    process.env.STOCK_API_KEY_3
  ].filter(Boolean);

  const stockApiUrl = process.env.STOCK_API_URL;

  if (stockApiUrl && apiKeys.length) {
    const failures = [];

    for (let i = 0; i < apiKeys.length; i++) {
      const apiKey = apiKeys[i];
      try {
        console.log("[STOCK API] Consultando API com key " + (i + 1) + ".");
        const response = await fetch(stockApiUrl, {
          headers: {
            "Accept": "application/json",
            "X-API-Key": apiKey,
            "User-Agent": "AstralStockDiscordBot/1.0"
          },
          signal: AbortSignal.timeout(20000)
        });

        const responseText = await response.text();

        if (!response.ok) {
          let detail = responseText.slice(0, 250);
          try {
            const parsed = JSON.parse(responseText);
            detail = parsed.message || parsed.error || detail;
          } catch {}
          throw new Error("HTTP " + response.status + (detail ? ": " + detail : ""));
        }

        let payload;
        try {
          payload = JSON.parse(responseText);
        } catch {
          throw new Error("A API retornou uma resposta que não é JSON válido.");
        }

        const stock = applySavedFruitPrices(normalizeStock(payload));
        const normal = stock.filter(item => String(item.type || "").toLowerCase() === "normal");
        const mirage = stock.filter(item => String(item.type || "").toLowerCase() === "mirage");

        if (!normal.length || !mirage.length) {
          throw new Error("A API não retornou as listas Normal e Mirage.");
        }

        console.log("[STOCK API] Captura válida com key " + (i + 1) +
          " (Normal: " + normal.length + ", Mirage: " + mirage.length + ").");
        return stock;
      } catch (error) {
        failures.push("key " + (i + 1) + ": " + error.message);
        console.warn("[STOCK API] Falha com key " + (i + 1) + "; tentando a próxima:", error.message);
      }
    }

    throw new Error("Todas as STOCK_API_KEY falharam. " + failures.join(" | "));
  }

  // Compatibilidade: se nenhuma API estiver configurada, tenta as fontes públicas.
  const failures = [];
  for (const sourceUrl of STOCK_SOURCES) {
    try {
      console.log("[STOCK] Consultando fonte pública:", sourceUrl);
      const response = await fetch(sourceUrl, {
        headers: {
          "Accept": "text/html,application/xhtml+xml",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36"
        },
        signal: AbortSignal.timeout(15000)
      });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const html = await response.text();
      const text = htmlToStockText(html);
      const normal = parseWikiStockSection(text, "Current Stock", "Last Stock", "Normal");
      const mirage = parseWikiStockSection(text, "Current Mirage Stock", "Last Mirage Stock", "Mirage");
      if (!normal.length || !mirage.length) throw new Error("A página não retornou as duas listas de stock.");
      return applySavedFruitPrices([...normal, ...mirage]);
    } catch (error) {
      failures.push(sourceUrl + ": " + error.message);
    }
  }

  throw new Error("Nenhuma fonte de stock respondeu corretamente. " + failures.join(" | "));
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
function roleMentions(stock, guildConfig = defaultGuildConfig()) {
  const roles = guildConfig.roles || {};
  const mentions = [];
  for (const item of stock) {
    const id = roles[fruitKey(safeName(item))];
    if (id && /^\d{17,20}$/.test(String(id))) mentions.push(`<@&${id}>`);
  }
  return [...new Set(mentions)].join(" ");
}
function stockAlertMentions(stock, guildConfig = defaultGuildConfig()) {
  const alerts = guildConfig.stockAlerts || {};
  const mentions = [];
  for (const item of stock) {
    const id = alerts[fruitKey(safeName(item))];
    if (id && /^\d{17,20}$/.test(String(id))) mentions.push(id);
  }
  return [...new Set(mentions)];
}

async function sendStockAlerts(stock, groupKey, guildConfig) {
  const channelId = guildConfig?.stockAlertChannelId;
  if (!channelId) return;
  const roleIds = stockAlertMentions(stock, guildConfig);
  if (!roleIds.length) return;
  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.isTextBased() || !channel.send) throw new Error("Canal de alertas indisponível.");
  const label = groupKey === "mirage" ? "Stock da Mirage" : "Stock Normal";
  const names = stock.map(item => `${fruitEmoji(item)} **${safeName(item)}**`).join(", ");
  await channel.send({
    content: `🔔 **Alerta de ${label}!**\\n${names}\\n\\n${roleIds.map(id => `<@&${id}>`).join(" ")}`,
    allowedMentions: { roles: roleIds }
  });
}

const APPLICATION_UI_EMOJIS = {
  beli: "<:beli:1556626992588267630>",
  clock: "<a:stock_clock:1556626990893629470>",
  stockTitle: "<:stock_title:1556626988587639892>",
  mirageTitle: "<:mirage_title:1556626985487306752>",
  rocket: "<:rocket:1556626983147012116>",
  spin: "<:spin:1556626981012111360>",
  blade: "<:blade:1556626979149713538>",
  spring: "<:spring:1556626976813613086>",
  bomb: "<:bomb:1556626975236558918>",
  smoke: "<:smoke:1556626973558710342>",
  spike: "<:spike:1556626971843362877>",
  robux: "<:robux:1556626988578639892>",
};

const PERMANENT_ROBUX_PRICES = {
  rocket: 50, spin: 75, blade: 100, spring: 180, bomb: 220, smoke: 250, spike: 380,
  flame: 550, ice: 750, sand: 850, dark: 950, eagle: 975, diamond: 1000,
  light: 1100, rubber: 1200, ghost: 1275, magma: 1300,
  quake: 1500, buddha: 1650, love: 1700, creation: 1750, spider: 1800, sound: 1900,
  phoenix: 2000, portal: 2000, lightning: 2100, pain: 2200, blizzard: 2250,
  gravity: 2300, mammoth: 2350, "t-rex": 2350, dough: 2400, shadow: 2425,
  venom: 2450, gas: 2500, spirit: 2550, tiger: 3000, yeti: 3000,
  magnet: 3500, kitsune: 4000, control: 4000, dragon: 5000
};

const APPLICATION_FRUIT_EMOJIS = {
  rocket: APPLICATION_UI_EMOJIS.rocket,
  spin: APPLICATION_UI_EMOJIS.spin,
  blade: APPLICATION_UI_EMOJIS.blade,
  spring: APPLICATION_UI_EMOJIS.spring,
  bomb: APPLICATION_UI_EMOJIS.bomb,
  smoke: APPLICATION_UI_EMOJIS.smoke,
  spike: APPLICATION_UI_EMOJIS.spike,
  flame: "<:flame:1556625833408598026>",
  ice: "<:ice:1556625830720049252>",
  sand: "<:sand:1556625828429963336>",
  dark: "<:dark:1556625826252984340>",
  eagle: "<:eagle:1556625823908495391>",
  diamond: "<:diamond:1556625822175993966>",
  light: "<:light:1556625820561444884>",
  rubber: "<:rubber:1556625818770341968>",
  ghost: "<:ghost:1556625817214124122>",
  magma: "<:magma:1556625815389601792>",
  quake: "<:quake:155662458504855050>",
  buddha: "<:buddha:1556624582385991761>",
  love: "<:love:1556624580649689119>",
  creation: "<:creation:1556624578275442748>",
  spider: "<:spider:15566245756300187698>",
  sound: "<:sound:1556624573678620733>",
  phoenix: "<:phoenix:1556624570579161108>",
  portal: "<:portal:1556624565239808020>",
  lightning: "<:lightning:1556624562515777838>",
  pain: "<:pain:1556624560353321131>",
  blizzard: "<:blizzard:1556624558134534225>",
  gravity: "<:gravity:1556621287521263677>",
  mammoth: "<:mammoth:1556621285268914227>",
  "t-rex": "<:trex:1556621283591192597>",
  dough: "<:dough:1556621282198429696>",
  shadow: "<:shadow:1556621279304351834>",
  venom: "<:venom:1556621276922253372>",
  gas: "<:gas:1556621274891948062>",
  spirit: "<:spirit:1556621272606183526>",
  tiger: "<:tiger:1556621270643245127>",
  yeti: "<:yeti:1556621268575330315>",
  magnet: "<:magnet:1556621263013941258>",
  kitsune: "<:kitsune:1556621259939258500>",
  control: "<:control:1556621258182103090>",
  dragon: "<:dragon:1556621255984029706>"
};


const APPLICATION_SEMANTIC_EMOJIS = {
  error: "❌",
  success: "✅",
  warning: "⚠️",
  alert: "🔔",
  package: "📦",
  image: "🎨",
  user: "👤",
  settings: "⚙️",
  trash: "🗑️",
  mute: "🔕",
  statistics: "📊",
  id: "🆔",
  calendar: "📅",
  users: "👥",
  followers: "👣",
  arrow: "➡️",
  lock: "🔒",
  key: "🔑",
  bot: "🤖",
  gem: "💎",
  money: "💰",
  list: "📋",
  search: "🔍",
  tools: "🛠️",
  star: "⭐",
  fire: "🔥",
  sparkle: "✨"
};

const APPLICATION_SEMANTIC_ALIASES = {
  error: ["error","erro","err","fail","failed","failure","wrong","cross","xmark","denied","no"],
  success: ["success","sucesso","ok","check","done","complete","completed","yes"],
  warning: ["warning","warn","aviso","attention","caution"],
  alert: ["alert","alerta","bell","notification","notify","notificacao"],
  package: ["package","zip","file","arquivo","download","box"],
  image: ["image","imagem","photo","foto","picture","banner","art"],
  user: ["user","usuario","profile","perfil","person","member"],
  settings: ["settings","config","configuracao","gear","setup","admin"],
  trash: ["trash","delete","deleted","remove","lixeira"],
  mute: ["mute","silent","unmute","bell_off"],
  statistics: ["stats","statistics","stat","grafico","chart","analytics"],
  id: ["id","identifier","identificador"],
  calendar: ["calendar","date","data"],
  users: ["users","members","grupo","group","friends","amigos"],
  followers: ["followers","follow","seguidores","following","seguindo"],
  arrow: ["arrow","next","right","seta"],
  lock: ["lock","locked","private","privado"],
  key: ["key","token","security","seguranca"],
  bot: ["bot","robot","automation","automacao"],
  gem: ["gem","diamond","crystal","premium"],
  money: ["money","cash","beli","coin","coins","dinheiro"],
  list: ["list","menu","lista"],
  search: ["search","find","lupa"],
  tools: ["tools","tool","hammer","wrench","ferramenta"],
  star: ["star","favorite","fav","estrela"],
  fire: ["fire","flame","fogo"],
  sparkle: ["sparkle","sparkles","shine","brilho"]
};

function normalizeApplicationEmojiName(name) {
  return String(name || "").toLowerCase().normalize("NFD").replace(/[\\u0300-\\u036f]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function findSemanticApplicationEmoji(emojiMap, aliases) {
  for (const alias of aliases) {
    const exact = emojiMap.get(normalizeApplicationEmojiName(alias));
    if (exact) return exact;
  }
  for (const [name, emoji] of emojiMap.entries()) {
    const normalized = normalizeApplicationEmojiName(name);
    if (aliases.some(alias => normalized.includes(normalizeApplicationEmojiName(alias)))) return emoji;
  }
  return null;
}

function uiEmoji(key, fallback) {
  return APPLICATION_SEMANTIC_EMOJIS[key] || fallback || "";
}

function applicationEmojiObject(name, fallback) {
  const wanted = normalizeApplicationEmojiName(name);
  const emoji = client.application?.emojis?.cache?.find(
    item => normalizeApplicationEmojiName(item.name) === wanted
  );
  if (emoji) {
    return { name: emoji.name, id: emoji.id, animated: Boolean(emoji.animated) };
  }
  return { name: fallback || "•" };
}

function applicationEmojiTag(name, fallback = "") {
  const wanted = normalizeApplicationEmojiName(name);
  const emoji = client.application?.emojis?.cache?.find(
    item => normalizeApplicationEmojiName(item.name) === wanted
  );
  return emoji ? applicationEmojiMarkup(emoji) : fallback;
}

const APPLICATION_EMOJI_RENAMES = {
  "1556626992588267630": "beli",
  "1556626990893629470": "stock_clock",
  "1556626988587639892": "stock_title",
  "1556626985487306752": "mirage_title",
  "1556626983147012116": "rocket",
  "1556626981012111360": "spin",
  "1556626979149713538": "blade",
  "1556626976813613086": "spring",
  "1556626975236558918": "bomb",
  "1556626973558710342": "smoke",
  "1556626971843362877": "spike",
  "1556625833408598026": "flame",
  "1556625830720049252": "ice",
  "1556625828429963336": "sand",
  "1556625826252984340": "dark",
  "1556625823908495391": "eagle",
  "1556625822175993966": "diamond",
  "1556625820561444884": "light",
  "1556625818770341968": "rubber",
  "1556625817214124122": "ghost",
  "1556625815389601792": "magma",
  "155662458504855050": "quake",
  "1556624582385991761": "buddha",
  "1556624580649689119": "love",
  "1556624578275442748": "creation",
  "15566245756300187698": "spider",
  "1556624573678620733": "sound",
  "1556624570579161108": "phoenix",
  "1556624565239808020": "portal",
  "1556624562515777838": "lightning",
  "1556624560353321131": "pain",
  "1556624558134534225": "blizzard",
  "1556621287521263677": "gravity",
  "1556621285268914227": "mammoth",
  "1556621283591192597": "trex",
  "1556621282198429696": "dough",
  "1556621279304351834": "shadow",
  "1556621276922253372": "venom",
  "1556621274891948062": "gas",
  "1556621272606183526": "spirit",
  "1556621270643245127": "tiger",
  "1556621268575330315": "yeti",
  "1556621263013941258": "magnet",
  "1556621259939258500": "kitsune",
  "1556621258182103090": "control",
  "1556621255984029706": "dragon"
};

const APPLICATION_NUMERIC_EMOJI_RENAMES = {
  "60779": "rocket_ui",
  "60777": "ethereum",
  "60775": "ghost_ui",
  "60773": "globe",
  "60770": "fire",
  "60768": "calendar_ui",
  "60767": "money_bag",
  "60766": "dislike",
  "60765": "check",
  "60764": "config_title",
  "60763": "money",
  "60762": "medical",
  "60761": "bug",
  "60760": "key",
  "60759": "celebrate",
  "60758": "settings",
  "60756": "shop",
  "60755": "cactus",
  "60754": "cube",
  "60753": "robot",
  "60752": "candy",
  "60751": "announcement",
  "60750": "add",
  "60749": "euro",
  "60748": "mail",
  "60747": "unlock",
  "60746": "image_upload",
  "60745": "lock",
  "60744": "folder_open",
  "60743": "image_download",
  "60742": "image",
  "60741": "folder_link",
  "60740": "files",
  "60739": "folder",
  "60738": "file",
  "60737": "file_settings",
  "60736": "eye",
  "60735": "file_music",
  "60734": "database",
  "60733": "wrench",
  "60732": "card",
  "60731": "database_alt",
  "60730": "text",
  "60729": "bot_settings",
  "60728": "bug_alt",
  "60727": "upload",
  "60726": "download",
  "60725": "server",
  "60724": "cloud_settings",
  "60723": "alarm",
  "60722": "cloud",
  "60721": "clipboard_add",
  "60720": "clipboard_check",
  "60719": "clipboard",
  "60718": "calendar",
  "60717": "calendar_check",
  "60716": "calendar_remove",
  "60715": "calendar_add",
  "60714": "minus",
  "60713": "bell_alert",
  "60712": "mobile",
  "60711": "checkbox",
  "60710": "arrow_up",
  "60709": "bell",
  "60708": "arrow_right",
  "60707": "arrow_down",
  "60706": "refresh",
  "60705": "youtube",
  "60704": "arrow_left",
  "60703": "whatsapp",
  "60702": "roblox",
  "60701": "discord",
  "60700": "chrome",
  "60699": "prohibited",
  "60698": "offline",
  "60697": "warning",
  "60696": "online",
  "60695": "help",
  "60694": "info",
  "60649": "refresh_alt",
  "60648": "user_add",
  "60647": "users",
  "60646": "user_settings",
  "60645": "user_check",
  "60644": "user_remove",
  "60643": "user",
  "60642": "wallet",
  "60641": "ticket_check",
  "60640": "ticket_plus",
  "60639": "ticket",
  "60638": "shield",
  "60637": "shield_plus",
  "60636": "tags",
  "60635": "tag",
  "60634": "shield_alt",
  "60633": "shield_check",
  "60632": "shield_off",
  "60631": "orbit",
  "60630": "gem",
  "60629": "coin",
  "60627": "money_note",
  "60625": "bitcoin",
  "60624": "efi",
  "60621": "bitcoin_white",
  "60619": "lightning",
  "60617": "users_alt",
  "60616": "bank",
  "60615": "wallet_alt",
  "60614": "truck",
  "60613": "trophy",
  "60612": "briefcase",
  "60611": "trash",
  "60610": "text_alt",
  "60609": "steam",
  "60608": "lightbulb",
  "60607": "search",
  "60606": "sparkles",
  "60605": "image_off",
  "60604": "save",
  "60603": "inbox",
  "60602": "handshake",
  "60601": "bolt",
  "60600": "star",
  "60599": "planet",
  "60598": "compass",
  "60597": "palette",
  "60596": "paintbrush",
  "60595": "sprout",
  "60594": "age_18",
  "60593": "link",
  "60592": "like",
  "60591": "minus_circle",
  "60590": "key_alt",
  "60589": "leaf",
  "60588": "id_card",
  "60587": "chart",
  "60586": "smile",
  "60585": "home",
  "60584": "heart",
  "60583": "headphones",
  "60582": "seat",
  "60581": "control_center",
  "60580": "gift",
  "60579": "ghost_alt",
  "60578": "settings_button"
};

function applicationEmojiMarkup(emoji) {
  if (!emoji?.id || !emoji?.name) return null;
  return `<${emoji.animated ? "a" : ""}:${emoji.name}:${emoji.id}>`;
}

async function syncApplicationEmojis() {
  try {
    const emojis = await client.application.emojis.fetch();
    const byName = new Map();

    for (const emoji of emojis.values()) {
      const wantedName = APPLICATION_EMOJI_RENAMES[emoji.id] || APPLICATION_NUMERIC_EMOJI_RENAMES[emoji.name];
      if (!wantedName || emoji.name === wantedName) continue;

      let renamed = false;
      for (let attempt = 1; attempt <= 3 && !renamed; attempt++) {
        try {
          await emoji.setName(wantedName);
          renamed = true;
          console.log(`[EMOJIS] Renomeado ${emoji.id}: ${wantedName}`);
        } catch (error) {
          console.warn(`[EMOJIS] Falha ao renomear ${emoji.id} para ${wantedName} (tentativa ${attempt}/3): ${error.message}`);
          if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 1200));
        }
      }
    }

    const refreshed = await client.application.emojis.fetch();
    for (const emoji of refreshed.values()) {
      byName.set(normalizeApplicationEmojiName(emoji.name), applicationEmojiMarkup(emoji));
    }

    // Analisa automaticamente todos os emojis da aplicação pelo nome.
    // Assim, emojis novos também podem ser usados nas funções sem precisar
    // cadastrar cada ID manualmente no código.
    for (const [key, aliases] of Object.entries(APPLICATION_SEMANTIC_ALIASES)) {
      const found = findSemanticApplicationEmoji(
        new Map([...byName.entries()].map(([name, markup]) => [name, markup])),
        aliases
      );
      if (found) APPLICATION_SEMANTIC_EMOJIS[key] = found;
    }

    console.log("[EMOJIS] Categorias detectadas: " + Object.entries(APPLICATION_SEMANTIC_EMOJIS)
      .filter(([, value]) => value && value !== "❌" && value !== "✅" && value !== "⚠️" && value !== "🔔" && value !== "📦" && value !== "🎨" && value !== "👤" && value !== "⚙️")
      .map(([key, value]) => key + "=" + value)
      .join(", "));

    // Preserva exatamente o emoji definido pelo ID. Não usamos o nome para
    // hidratar os emojis, porque nomes podem ser alterados/duplicados e isso
    // pode trocar uma fruta por outro emoji sem querer.
    const byId = new Map([...refreshed.values()].map(emoji => [String(emoji.id), emoji]));

    for (const [key, value] of Object.entries(APPLICATION_UI_EMOJIS)) {
      const match = String(value).match(/<a?:([^:>]+):(\d+)>/);
      const id = match?.[2];
      const currentName = match?.[1];
      const emoji = (id && byId.get(id))
        || refreshed.find(e => normalizeApplicationEmojiName(e.name) === normalizeApplicationEmojiName(currentName || key));
      if (emoji) APPLICATION_UI_EMOJIS[key] = applicationEmojiMarkup(emoji);
    }

    for (const [key, value] of Object.entries(APPLICATION_FRUIT_EMOJIS)) {
      const match = String(value).match(/<a?:([^:>]+):(\d+)>/);
      const id = match?.[2];
      const currentName = match?.[1];
      const emoji = (id && byId.get(id))
        || refreshed.find(e => normalizeApplicationEmojiName(e.name) === normalizeApplicationEmojiName(currentName || key));
      if (emoji) {
        APPLICATION_FRUIT_EMOJIS[key] = applicationEmojiMarkup(emoji);
      } else {
        console.warn("[EMOJIS] Fruta sem emoji encontrado: " + key + " (ID " + (id || "sem ID") + ")");
      }
    }

    console.log(`[EMOJIS] Application Emojis carregados: ${refreshed.size}`);
    console.log(`[EMOJIS] Exemplo Rocket: ${APPLICATION_UI_EMOJIS.rocket}`);
  } catch (error) {
    console.warn("[EMOJIS] Falha ao sincronizar emojis da aplicação:", error.message);
  }
}

function fruitEmoji(item) {
  const name = typeof item === "string" ? item : safeName(item);
  const key = fruitKey(name);
  return APPLICATION_FRUIT_EMOJIS[key] || "🍈";
}

function fruitEmojiObject(item) {
  const markup = fruitEmoji(item);
  const match = String(markup).match(/^<a?:([^:>]+):(\d+)>$/);
  if (!match) return { name: "🍈" };
  return { name: match[1], id: match[2] };
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

// Os preços oficiais da loja são fixos. A API não sobrescreve esses valores.
function beliPrice(item) {
  return savedBeliPrice(safeName(item));
}

function robuxPrice(item) {
  return PERMANENT_ROBUX_PRICES[fruitKey(safeName(item))] ?? null;
}

function applySavedFruitPrices(stock) {
  return (Array.isArray(stock) ? stock : []).map(item => ({
    ...item,
    money_price: beliPrice(item),
    robux_price: robuxPrice(item)
  }));
}

function stockTitle(groupKey, guildConfig = defaultGuildConfig()) {
  const defaults = {
    normal: "<:60119:1556621255984029706> Blox Fruits | Stock normal atualizado",
    mirage: APPLICATION_UI_EMOJIS.mirageTitle + " Blox Fruits | Stock da Mirage atualizado"
  };
  return guildConfig.titles?.[groupKey] || defaults[groupKey] || APPLICATION_UI_EMOJIS.stockTitle + " Blox Fruits | Stock atualizado";
}
function nextGlobalReset(groupKey, now = new Date()) {
  // Horários globais em UTC: Normal a cada 4 horas;
  // Mirage a cada 2 horas.
  // O cálculo é feito diretamente pelo relógio UTC, evitando diferenças
  // causadas por arredondamentos de minutos/segundos.
  const intervalMs = (groupKey === "mirage" ? 2 : 4) * 60 * 60 * 1000;
  const nowMs = now.getTime();
  const nextMs = Math.floor(nowMs / intervalMs + 1) * intervalMs;
  return new Date(nextMs);
}
function brasilTime(timestamp) {
  return new Intl.DateTimeFormat("pt-BR", { timeZone: BRASIL_TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(timestamp));
}
function stockCountdown(groupKey) {
  // Usa o mesmo timestamp que o agendador já calculou para o próximo reset.
  let timestamp = nextStockAt[groupKey];
  const now = Date.now();

  if (!Number.isFinite(timestamp) || timestamp <= now) {
    timestamp = nextGlobalReset(groupKey).getTime();
  }

  const label = groupKey === "mirage" ? "Stock da Mirage" : "Stock normal";
  return `${APPLICATION_UI_EMOJIS.clock} **Próximo ${label}:** <t:${Math.floor(timestamp / 1000)}:R> • **${brasilTime(timestamp)} (Brasília)**`;
}
async function resolveEmoji(input) {
  const value = String(input || "").trim();
  if (/^<a?:[A-Za-z0-9_]+:\d{17,20}>$/.test(value) || /\p{Extended_Pictographic}/u.test(value)) return value;
  const name = value.replace(/^:|:$/g, "");
  try {
    const appEmojis = await client.application.emojis.fetch();
    const found = appEmojis.find(emoji => emoji.name === name);
    if (found) return found.toString();
  } catch (error) {
    console.warn("Não consegui consultar os emojis da aplicação:", error.message);
  }
  return value;
}
function stockContainer(stock, title, groupKey = null, guildConfig = defaultGuildConfig()) {
  const lines = stock.map(item => {
    const name = safeName(item);
    const price = beliPrice(item);
    const robuxPriceValue = robuxPrice(item);
    return `${fruitEmoji(item)} **${name}**${price != null ? ` | ${APPLICATION_UI_EMOJIS.beli} \`${Number(price).toLocaleString("en-US")}\`` : ""}${robuxPriceValue != null ? ` | ${Number(robuxPriceValue).toLocaleString("en-US")} ${APPLICATION_UI_EMOJIS.robux}` : ""}`;
  });
  const mentions = roleMentions(stock, guildConfig);
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
async function postStock(stock, announce, title, groupKey = null) {
  const config = readConfig();
  const entries = Object.entries(config.guilds || {}).filter(([, guildConfig]) => guildConfig?.channelId);
  if (!entries.length) {
    console.warn("[STOCK] Nenhum servidor configurou um canal de stock. Use /set-stock-channel.");
    return false;
  }
  let sent = 0;
  for (const [guildId, rawGuildConfig] of entries) {
    const guildConfig = { ...defaultGuildConfig(), ...rawGuildConfig };
    try {
      const channel = await client.channels.fetch(guildConfig.channelId);
      if (!channel || !channel.isTextBased() || !channel.send) {
        console.warn("[STOCK] Canal do servidor " + guildId + " não está acessível.");
        continue;
      }
      await channel.send({
        components: [stockContainer(stock, stockTitle(groupKey, guildConfig), groupKey, guildConfig)],
        flags: MessageFlags.IsComponentsV2,
        allowedMentions: { parse: ["roles"] }
      });
      sent++;
      if (groupKey) {
        try { await sendStockAlerts(stock, groupKey, guildConfig); }
        catch (error) { console.error("[ALERTAS] Falha no servidor " + guildId + ":", error.message); }
      }
    } catch (error) {
      console.error("[STOCK] Falha ao publicar no servidor " + guildId + ":", error.message);
    }
  }
  console.log("[STOCK] Publicação concluída: " + sent + "/" + entries.length + " servidores. Uma única consulta foi usada para todos.");
  return sent > 0;
}
async function checkStock(force = false, onlyGroups = ["normal", "mirage"], throwOnError = false, providedStock = null) {
  if (checking) return false;
  checking = true;
  try {
    const stock = providedStock || await getStock();
    const state = readState();
    state.stockSignatures = state.stockSignatures || {};
    state.latestStock = state.latestStock || {};

    // Corrige preços antigos que já estavam salvos no state.json.
    for (const key of ["normal", "mirage"]) {
      if (Array.isArray(state.latestStock[key])) {
        state.latestStock[key] = applySavedFruitPrices(state.latestStock[key]);
      }
    }
    const groups = [
      { key: "normal", type: "Normal" },
      { key: "mirage", type: "Mirage" }
    ].filter(group => onlyGroups.includes(group.key));

    for (const group of groups) {
      const items = applySavedFruitPrices(stock.filter(item => String(item.type || "").toLowerCase() === group.type.toLowerCase()));
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

async function runScheduledStockCycle(groupKey, resetAt) {
  const initialState = readState();
  const baseline = initialState.stockSignatures?.[groupKey] || null;
  const resetLabel = new Date(resetAt).toISOString();

  console.log(`[SCHEDULER] ${groupKey} entrou em monitoramento. Reset previsto: ${resetLabel}.`);

  // A rotação real pode atrasar alguns segundos/minutos em relação ao horário previsto.
  // Por isso, nunca publicamos apenas porque o relógio virou: primeiro confirmamos
  // que a assinatura do stock realmente mudou.
  const firstCheckDelay = Math.min(
    Math.max(resetAt + 30000 - Date.now(), 5000),
    60000
  );
  await wait(firstCheckDelay);

  let attempts = 0;
  let consecutiveErrors = 0;

  while (true) {
    attempts++;

    try {
      const stock = await getStock();
      const normal = stock.filter(item => String(item.type || "").toLowerCase() === "normal");
      const mirage = stock.filter(item => String(item.type || "").toLowerCase() === "mirage");

      // Nunca considera uma resposta parcial como uma rotação válida.
      if (!normal.length || !mirage.length) {
        throw new Error("A fonte retornou stock incompleto; aguardando a próxima consulta.");
      }

      const items = groupKey === "normal" ? normal : mirage;
      const currentSignature = signature(items);
      const savedSignature = readState().stockSignatures?.[groupKey] || baseline;

      if (savedSignature && currentSignature === savedSignature) {
        consecutiveErrors = 0;
        console.log(`[SCHEDULER] ${groupKey}: a fonte ainda mostra o stock anterior. Tentativa ${attempts}; nova consulta em 60s.`);
      } else {
        // A assinatura mudou. checkStock grava/publica somente depois de confirmar
        // novamente que o resultado recebido é válido.
        console.log(`[SCHEDULER] ${groupKey}: nova rotação detectada; validando publicação.`);
        const published = await checkStock(false, [groupKey], false, stock);
        const after = readState().stockSignatures?.[groupKey];

        if (published && after === currentSignature) {
          console.log(`[SCHEDULER] ${groupKey}: nova rotação publicada e salva com sucesso.`);
          return;
        }

        console.warn(`[SCHEDULER] ${groupKey}: a rotação foi detectada, mas não foi confirmada no estado. Nova tentativa em 30s.`);
      }
    } catch (error) {
      consecutiveErrors++;
      const retrySeconds = Math.min(60, 15 + consecutiveErrors * 10);
      console.warn(`[SCHEDULER] ${groupKey}: consulta ${attempts} falhou: ${error.message}. Nova tentativa em ${retrySeconds}s.`);
      await wait(retrySeconds * 1000);
      continue;
    }

    await wait(60000);
  }
}

const activeStockCycles = new Set();
let schedulerTimer = null;

function startStockScheduler() {
  const tick = () => {
    const now = Date.now();

    for (const key of ["normal", "mirage"]) {
      if (!nextStockAt[key] || now < nextStockAt[key]) continue;

      const dueAt = nextStockAt[key];

      // Agenda o próximo ciclo antes de iniciar o monitoramento atual.
      // Assim, um atraso da API nunca trava o outro relógio.
      nextStockAt[key] = nextGlobalReset(key, new Date(now)).getTime();

      if (activeStockCycles.has(key)) {
        console.log(`[SCHEDULER] ${key} já está em monitoramento; mantendo o ciclo atual.`);
        continue;
      }

      activeStockCycles.add(key);
      runScheduledStockCycle(key, dueAt)
        .catch(error => console.error(`[SCHEDULER] Erro inesperado em ${key}:`, error))
        .finally(() => activeStockCycles.delete(key));
    }

    schedulerTimer = setTimeout(tick, 5000);
  };

  if (schedulerTimer) clearTimeout(schedulerTimer);

  // O contador das mensagens e o scheduler usam exatamente estes timestamps.
  nextStockAt.normal = nextGlobalReset("normal").getTime();
  nextStockAt.mirage = nextGlobalReset("mirage").getTime();

  console.log("[SCHEDULER] Agendador ativo. Normal: 4h; Mirage: 2h; publicação somente após detectar mudança real no stock.");
  tick();
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
  const lines = ALL_FRUITS.map(name => {
    const emoji = fruitEmoji({ name });
    const price = savedBeliPrice(name);
    const priceText = price != null ? APPLICATION_UI_EMOJIS.beli + " `" + Number(price).toLocaleString("en-US") + "`" : APPLICATION_UI_EMOJIS.beli + " `Valor não cadastrado`";
    return emoji + " **" + name + "** | " + priceText;
  });
  const body = ["# <:60119:1556621255984029706> Blox Fruits", "", ...lines].join("\n");
  return [new ContainerBuilder().setAccentColor(0x00FFFF).addTextDisplayComponents(new TextDisplayBuilder().setContent(body))];
}

const fruitOption = (option) => option.setName("fruit").setDescription("Nome da fruta").setRequired(true);

function resolveFruitName(input) {
  const normalized = fruitKey(input);
  const fruit = ALL_FRUITS.find(name => fruitKey(name) === normalized);
  return fruit || null;
}

function invalidFruitMessage(input) {
  const value = String(input || "").trim();
  return "❌ **" + (value || "Fruta") + "** não é uma fruta válida do Blox Fruits.\n\nFrutas disponíveis: " + ALL_FRUITS.join(", ") + ".";
}

function configuredFruitRoleId(guildConfig, fruit) {
  const key = fruitKey(fruit);
  const roles = guildConfig?.roles || {};
  const stockAlerts = guildConfig?.stockAlerts || {};

  // O painel aceita o cargo configurado no stock normal ou no sistema de alertas.
  // Prioriza o cargo de alerta quando ele existe, pois é o cargo que o usuário
  // configurou para ser notificado quando a fruta aparecer.
  return stockAlerts[key] || roles[key] || null;
}

function fruitButtonTextWidth(value) {
  // Largura aproximada da fonte dos botões do Discord.
  // Isso é bem mais preciso que contar apenas caracteres, porque
  // "i/l" ocupam menos espaço que "M/W", por exemplo.
  const widths = {
    A: 1.12, B: 1.22, C: 1.18, D: 1.33, E: 1.02, F: 0.96, G: 1.31,
    H: 1.24, I: 0.55, J: 0.55, K: 1.24, L: 1.02, M: 1.59, N: 1.24,
    O: 1.27, P: 1.17, Q: 1.36, R: 1.23, S: 1.15, T: 1.09, U: 1.25,
    V: 1.24, W: 1.48, X: 1.03, Y: 1.16, Z: 1.05,
    a: 1.08, b: 1.15, c: 0.89, d: 1.15, e: 1.09, f: 0.68, g: 1.15,
    h: 1.14, i: 0.55, j: 0.55, k: 1.06, l: 0.55, m: 1.67, n: 1.14,
    o: 1.10, p: 1.15, q: 1.15, r: 0.79, s: 0.95, t: 0.77, u: 1.14,
    v: 1.04, w: 1.48, x: 1.03, y: 1.04, z: 0.93,
    "-": 0.66, " ": 0.50
  };
  return [...String(value)].reduce((sum, char) => sum + (widths[char] || 1), 0);
}

function fruitButtonLabel(fruit, targetWidth) {
  // O Discord não permite definir a largura diretamente.
  // Preenchemos somente o espaço que falta usando thin spaces,
  // mantendo os dois lados equilibrados para o texto continuar centralizado.
  const text = String(fruit);
  const current = fruitButtonTextWidth(text);
  const missing = Math.max(0, targetWidth - current);
  const thinSpaceWidth = 0.30;
  const totalSpaces = Math.max(0, Math.ceil(missing / thinSpaceWidth));
  const leftSpaces = Math.floor(totalSpaces / 2);
  const rightSpaces = totalSpaces - leftSpaces;
  const left = "\u2009".repeat(leftSpaces);
  const right = "\u2009".repeat(rightSpaces);
  return "\u200b" + left + text + right + "\u200b";
}

function fruitRoleButton(fruit, roleId, targetWidth, hasRole = false) {
  const emojiMarkup = fruitEmoji({ name: fruit });
  const emojiMatch = String(emojiMarkup).match(/^<(a?):([^:>]+):(\d{17,20})>$/);

  const button = new ButtonBuilder()
    .setCustomId("fruit_role:" + fruitKey(fruit) + ":" + String(roleId))
    .setLabel(fruitButtonLabel(fruit, targetWidth))
    .setStyle(hasRole ? ButtonStyle.Success : ButtonStyle.Danger);

  if (emojiMatch) {
    button.setEmoji({
      animated: emojiMatch[1] === "a",
      name: emojiMatch[2],
      id: emojiMatch[3]
    });
  }

  return button;
}

function removeAllFruitRolesButton(isPublic = false) {
  return new ButtonBuilder()
    .setCustomId(isPublic ? "fruit_roles:remove_all:public" : "fruit_roles:remove_all")
    .setLabel("REMOVER TODOS OS CARGOS")
    .setEmoji({ name: "XXX", id: "1557086367844933702" })
    .setStyle(ButtonStyle.Secondary);
}

function buildFruitRolePanelForMember(guildId, member, statusText = null) {
  const guildConfig = getGuildConfig(guildId);
  const configured = [...ALL_FRUITS].reverse()
    .map(fruit => ({ fruit, roleId: configuredFruitRoleId(guildConfig, fruit) }))
    .filter(item => /^\d{17,20}$/.test(String(item.roleId || "")));

  if (!configured.length) return null;

  const rows = [];
  for (let i = 0; i < configured.length; i += 25) {
    const chunk = configured.slice(i, i + 25);
    const menu = new StringSelectMenuBuilder()
      .setCustomId("fruit_select:" + Math.floor(i / 25))
      .setPlaceholder("🍎 Escolha uma fruta")
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(chunk.map(item => ({
        label: item.fruit,
        value: fruitKey(item.fruit),
        emoji: fruitEmojiObject(item.fruit),
        description: member.roles.cache.has(item.roleId)
          ? "🟢 Você possui este cargo"
          : "🔴 Você não possui este cargo"
      })));
    rows.push(new ActionRowBuilder().addComponents(menu));
  }

  rows.push(new ActionRowBuilder().addComponents(removeAllFruitRolesButton(false)));

  // Painel individual compacto: somente a mensagem de status (quando houver),
  // os seletores e o botão de remover todos os cargos.
  const container = new ContainerBuilder()
    .setAccentColor(0x00FFFF);

  if (statusText) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(statusText)
    );
  }

  container.addActionRowComponents(...rows);

  return {
    components: [container]
  };
}

function buildFruitRolePanel(guildId) {
  const guildConfig = getGuildConfig(guildId);
  const configured = [...ALL_FRUITS].reverse()
    .map(fruit => ({ fruit, roleId: configuredFruitRoleId(guildConfig, fruit) }))
    .filter(item => /^\d{17,20}$/.test(String(item.roleId || "")));

  if (!configured.length) return { configured: [], messages: [] };

  const rows = [];
  for (let i = 0; i < configured.length; i += 25) {
    const chunk = configured.slice(i, i + 25);
    const menu = new StringSelectMenuBuilder()
      .setCustomId("fruit_select_public:" + Math.floor(i / 25))
      .setPlaceholder("🍎 Escolha uma fruta")
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(chunk.map(item => ({
        label: item.fruit,
        value: fruitKey(item.fruit),
        emoji: fruitEmojiObject(item.fruit),
        description: "Clique para receber/remover"
      })));
    rows.push(new ActionRowBuilder().addComponents(menu));
  }

  rows.push(new ActionRowBuilder().addComponents(removeAllFruitRolesButton(true)));

  const title =
    "@everyone\n# " + APPLICATION_FRUIT_EMOJIS.dragon + "  CARGOS DE FRUTAS";
  const description =
    "### Escolha uma fruta abaixo para receber ou remover o cargo.\n\n" +
    uiEmoji("alert", "🔔") + " **Selecione os cargos das frutas que você deseja receber para receber as notificações de stock.**\n" +
    "📢 As notificações serão enviadas no canal <#1555984553016033380>.";

  const container = new ContainerBuilder()
    .setAccentColor(0x00FFFF)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(title),
      new TextDisplayBuilder().setContent(description)
    );

  container.addActionRowComponents(...rows);

  return {
    configured,
    components: [container],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: ["everyone"] }
  };
}


function buildMainPanel(guildId, userId) {
  const home = applicationEmojiTag("home", "🏠");
  const overview = applicationEmojiTag("sparkles", "✨");
  const bell = applicationEmojiTag("bell_alert", "🔔");
  const updated = applicationEmojiTag("alarm", "⏰");
  const manage = applicationEmojiTag("settings_button", "⚙️");

  const container = new ContainerBuilder()
    .setAccentColor(0x00FFFF)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "## " + home + " ASTRAL STORE\n" +
        "> Olá, " + (userId ? "<@" + userId + ">" : "@USUARIO") + "! Aqui está o resumo da sua loja.\n" +
        "### " + overview + " Visão Geral\n" +
        ">>> " + bell + " Notificações não lidas: **0**\n" +
        updated + " Configurações atualizadas <t:" + Math.floor(Date.now() / 1000) + ":R>\n\n" +
        "### " + manage + " O que deseja gerenciar?\n" +
        "> Selecione uma área no menu abaixo para começar\n\n" +
        "-# Todas as ações são aplicadas em tempo real"
      )
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("panel:manage")
          .setPlaceholder("🏠 Selecione uma área para gerenciar")
          .addOptions(
            {
              label: "Estoque",
              description: "Gerencie as configurações do estoque",
              value: "stock",
              emoji: applicationEmojiObject("clipboard", "📋")
            },
            {
              label: "Configurações",
              description: "Configure as preferências do Astral Stock",
              value: "settings",
              emoji: applicationEmojiObject("settings_button", "⚙️")
            },
            {
              label: "Cargos das Frutas",
              description: "Configure os cargos de cada fruta",
              value: "fruit_roles",
              emoji: fruitEmojiObject("Dragon")
            },
            {
              label: "Servidores Autorizados",
              description: "Gerencie os servidores autorizados",
              value: "servers",
              emoji: applicationEmojiObject("users_alt", "👥")
            },
            {
              label: "Preços",
              description: "Gerencie os preços salvos das frutas",
              value: "prices",
              emoji: { name: "beli", id: "1556626992588267630" }
            }
          )
      )
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("panel:restart")
          .setLabel("REINICIAR BOT")
          .setEmoji({ name: "refresh", id: "1557204768093372466" })
          .setStyle(ButtonStyle.Success)
      )
    );

  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}
function buildConfigPanel(guildId) {
  const config = getGuildConfig(guildId);
  const stockChannel = config.channelId ? "<#" + config.channelId + ">" : "Não configurado";
  const alertChannel = config.stockAlertChannelId ? "<#" + config.stockAlertChannelId + ">" : "Não configurado";
  const container = new ContainerBuilder()
    .setAccentColor(0x00FFFF)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "# <:60764:1557204540460240926> CONFIGURAÇÕES\n\n"+
        uiEmoji("package", "📦") + " **Canal do Stock:** " + stockChannel + "\n" +
        uiEmoji("alert", "🔔") + " **Canal de Alertas:** " + alertChannel + "\n" +
        "🤖 **Status:** " + (client.ws.status === 0 ? "<:60696:1557204563675848814> Online" : "<:60698:1557204568432185454> Offline") + "\n\n" +
        "-# Para configurações detalhadas, use os comandos correspondentes."
      )
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("panel:servers").setLabel("SERVIDORES AUTORIZADOS").setEmoji({ name: "60581", id: "1557204878001176586" }).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("panel:fruit_roles").setLabel("CARGOS DAS FRUTAS").setEmoji(fruitEmojiObject("Dragon")).setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("panel:main").setLabel("VOLTAR").setEmoji({ name: "60578", id: "1557204872648982579" }).setStyle(ButtonStyle.Secondary)
      )
    );
  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

function buildFruitAdminPanel(guildId, selectedFruit = null) {
  const config = getGuildConfig(guildId);
  const current = selectedFruit ? configuredFruitRoleId(config, selectedFruit) : null;
  const currentRole = current ? "<@&" + current + ">" : "Nenhum cargo configurado";
  const fruits = ALL_FRUITS.map(fruit => ({
    label: fruit,
    value: fruitKey(fruit),
    emoji: fruitEmojiObject(fruit),
    description: configuredFruitRoleId(config, fruit) ? "Cargo configurado" : "Sem cargo"
  }));
  const menu = new StringSelectMenuBuilder()
    .setCustomId("admin_fruit_select")
    .setPlaceholder("🍈 Selecione uma fruta para configurar")
    .setMinValues(1).setMaxValues(1)
    .addOptions(fruits.slice(0, 25));
  const rows = [new ActionRowBuilder().addComponents(menu)];
  if (fruits.length > 25) {
    const menu2 = new StringSelectMenuBuilder()
      .setCustomId("admin_fruit_select_2")
      .setPlaceholder("🍓 Mais frutas")
      .setMinValues(1).setMaxValues(1)
      .addOptions(fruits.slice(25));
    rows.push(new ActionRowBuilder().addComponents(menu2));
  }
  if (selectedFruit) {
    const roleMenu = new RoleSelectMenuBuilder()
      .setCustomId("admin_role_select:" + fruitKey(selectedFruit))
      .setPlaceholder("Escolha o cargo para " + selectedFruit)
      .setMinValues(1).setMaxValues(1);
    rows.push(new ActionRowBuilder().addComponents(roleMenu));
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("admin_fruit_remove:" + fruitKey(selectedFruit)).setLabel("REMOVER CARGO").setEmoji(uiEmoji("trash", "🗑️")).setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("panel:main").setLabel("VOLTAR AO PAINEL").setEmoji(uiEmoji("arrow", "➡️")).setStyle(ButtonStyle.Secondary)
    ));
  } else {
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("panel:main").setLabel("VOLTAR AO PAINEL").setEmoji(uiEmoji("arrow", "➡️")).setStyle(ButtonStyle.Secondary)
    ));
  }
  const container = new ContainerBuilder()
    .setAccentColor(0x00FFFF)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "# <:60581:1557204878001176586> CARGOS DAS FRUTAS\n\n" +
        "Selecione uma fruta para **adicionar, trocar ou remover** o cargo.\n\n" +
        (selectedFruit ? fruitEmoji({name:selectedFruit}) + " **" + selectedFruit + "**\n" + uiEmoji("users","👥") + " Cargo atual: " + currentRole : uiEmoji("list","📋") + " Escolha uma fruta abaixo.")
      )
    )
    .addActionRowComponents(...rows);
  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

function buildServerAdminPanel() {
  const ids = getAllowedGuildIds();
  const lines = ids.map(id => {
    const guild = client.guilds.cache.get(id);
    return "• " + uiEmoji("server", "🏠") + " " + (guild ? "**" + guild.name + "**" : "Servidor não encontrado") + " • `" + id + "`";
  });
  const container = new ContainerBuilder()
    .setAccentColor(0x00FFFF)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "# <:60581:1557204878001176586> SERVIDORES AUTORIZADOS\n\n" +
        (lines.join("\n") || "Nenhum servidor autorizado.") + "\n\n" +
        "-# Somente o dono da aplicação pode alterar esta lista."
      )
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("server:add").setLabel("ADICIONAR").setEmoji(uiEmoji("success", "✅")).setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("server:remove").setLabel("REMOVER").setEmoji(uiEmoji("trash", "🗑️")).setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId("panel:main").setLabel("VOLTAR").setEmoji(uiEmoji("arrow", "➡️")).setStyle(ButtonStyle.Secondary)
      )
    );
  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

const stockTypeOption = (option) => option.setName("stock_type").setDescription("Choose which stock to analyze").setRequired(true)
  .addChoices({ name: "Normal Stock", value: "normal" }, { name: "Mirage Stock", value: "mirage" });

async function getRobloxAvatar(username) {
  const cleanUsername = String(username || "").trim();
  if (!cleanUsername) throw new Error("Informe um nome de usuário do Roblox.");

  const userResponse = await fetch("https://users.roblox.com/v1/usernames/users", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({
      usernames: [cleanUsername],
      excludeBannedUsers: false
    }),
    signal: AbortSignal.timeout(10000)
  });

  if (!userResponse.ok) throw new Error("Não consegui consultar o usuário do Roblox.");
  const userData = await userResponse.json();
  const user = userData.data?.[0];
  if (!user?.id) throw new Error("Usuário do Roblox não encontrado.");

  const jsonFetch = async (url, fallback) => {
    try {
      const response = await fetch(url, {
        headers: { "Accept": "application/json" },
        signal: AbortSignal.timeout(10000)
      });
      if (!response.ok) return fallback;
      return await response.json();
    } catch {
      return fallback;
    }
  };

  const avatarUrl =
    "https://thumbnails.roblox.com/v1/users/avatar" +
    "?userIds=" + encodeURIComponent(user.id) +
    "&size=720x720&format=Png&isCircular=false";

  const [avatarData, details, friends, followers, following] = await Promise.all([
    jsonFetch(avatarUrl, { data: [] }),
    jsonFetch("https://users.roblox.com/v1/users/" + user.id, {}),
    jsonFetch("https://friends.roblox.com/v1/users/" + user.id + "/friends/count", {}),
    jsonFetch("https://friends.roblox.com/v1/users/" + user.id + "/followers/count", {}),
    jsonFetch("https://friends.roblox.com/v1/users/" + user.id + "/followings/count", {})
  ]);

  const imageUrl = avatarData.data?.[0]?.imageUrl;
  if (!imageUrl) throw new Error("O Roblox não retornou a imagem desse avatar.");

  // Roblox não fornece um total direto de jogos favoritos. Contamos as páginas,
  // com um limite de segurança para evitar consultas excessivas.
  let favoriteGames = 0;
  let cursor = null;
  let favoritesComplete = true;
  for (let page = 0; page < 40; page++) {
    const params = new URLSearchParams({ sortOrder: "Desc", limit: "50" });
    if (cursor) params.set("cursor", cursor);
    const pageData = await jsonFetch(
      "https://games.roblox.com/v2/users/" + user.id + "/favorite/games?" + params.toString(),
      null
    );
    if (!pageData) {
      favoritesComplete = false;
      break;
    }
    favoriteGames += Array.isArray(pageData.data) ? pageData.data.length : 0;
    cursor = pageData.nextPageCursor || null;
    if (!cursor) break;
    if (page === 39) favoritesComplete = false;
  }

  return {
    id: user.id,
    username: user.name,
    displayName: user.displayName || user.name,
    imageUrl,
    created: details.created || null,
    friends: Number(friends.count ?? 0),
    followers: Number(followers.count ?? 0),
    following: Number(following.count ?? 0),
    favoriteGames,
    favoritesComplete
  };
}

const commands = [
  // General
  new SlashCommandBuilder().setName("stock").setDescription("Show the current Blox Fruits stock")
    .setIntegrationTypes([0, 1]).setContexts([0]),
  new SlashCommandBuilder().setName("send-stock").setDescription("Send the saved Blox Fruits stock in this channel")
    .setIntegrationTypes([0, 1]).setContexts([0]),
  new SlashCommandBuilder().setName("avatar").setDescription("Show a Roblox avatar").addStringOption(option => option.setName("username").setDescription("Roblox username").setRequired(true).setMaxLength(20)),
  new SlashCommandBuilder().setName("ia").setDescription("Converse com a IA do Astral Stock")
    .setIntegrationTypes([0, 1]).setContexts([0])
    .addStringOption(option => option.setName("pergunta").setDescription("O que você quer perguntar para a IA?").setRequired(true).setMaxLength(2000)),
  new SlashCommandBuilder().setName("server-panel").setDescription("Configure os servidores autorizados a usar o bot")
    .addStringOption(option => option.setName("action").setDescription("Ação do painel").setRequired(true).addChoices(
      { name: "Adicionar servidor", value: "add" },
      { name: "Remover servidor", value: "remove" },
      { name: "Listar servidores", value: "list" }
    ))
    .addStringOption(option => option.setName("server_id").setDescription("ID do servidor Discord").setRequired(false).setMinLength(17).setMaxLength(20)),

  new SlashCommandBuilder().setName("painel").setDescription("Abrir o painel central do Astral Stock"),

  // Stock tools
  new SlashCommandBuilder().setName("test-stock").setDescription("Preview all fruits and configured emojis")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName("refresh-stock").setDescription("Fetch and publish the current stock")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName("stock-history").setDescription("Show recent stock changes")
    .setIntegrationTypes([0, 1]).setContexts([0]),
  new SlashCommandBuilder().setName("stock-prediction").setDescription("Estimate possible fruit returns from history")
    .setIntegrationTypes([0, 1]).setContexts([0])
    .addStringOption(stockTypeOption),
  new SlashCommandBuilder().setName("stock-statistics").setDescription("Show the most frequent fruits in history")
    .setIntegrationTypes([0, 1]).setContexts([0])
    .addStringOption(stockTypeOption),

  // Server configuration
  new SlashCommandBuilder().setName("set-stock-channel").setDescription("Choose where automatic stock messages will be posted")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption(option => option.setName("channel").setDescription("Text channel for automatic stock").setRequired(true)),
  new SlashCommandBuilder().setName("set-fruit-role").setDescription("Set the role to mention when a fruit appears")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(fruitOption)
    .addRoleOption(option => option.setName("role").setDescription("Role to mention").setRequired(true)),
  new SlashCommandBuilder().setName("set-stock-title").setDescription("Edit the Normal or Mirage stock message title")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(stockTypeOption)
    .addStringOption(option => option.setName("title").setDescription("New message title").setRequired(true).setMaxLength(100)),
  new SlashCommandBuilder().setName("list-roles").setDescription("List configured fruit roles")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName("remove-role").setDescription("Remove a configured fruit role")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(fruitOption),
  new SlashCommandBuilder().setName("fruit-role-panel").setDescription("Send a panel with buttons to receive configured fruit roles")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  // Stock alerts: one command handles channel and fruit alert setup/removal
  new SlashCommandBuilder().setName("stock-alert").setDescription("Manage alert channel and fruit alerts in one command")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(option => option.setName("action").setDescription("Choose an action: add or remove")
      .setRequired(true).addChoices(
        { name: "Add / change alert channel", value: "set_channel" },
        { name: "Remove alert channel", value: "remove_channel" },
        { name: "Add fruit alert", value: "add_fruit" },
        { name: "Remove fruit alert", value: "remove_fruit" }
      ))
    .addChannelOption(option => option.setName("channel").setDescription("Text channel for stock alerts").setRequired(false))
    .addStringOption(option => option.setName("fruit").setDescription("Fruit to add or remove").setRequired(false))
    .addRoleOption(option => option.setName("role").setDescription("Role to mention for this fruit").setRequired(false))
];
async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  const registeredCommands = commands.map(c => c.toJSON());
  const applicationId = client.user.id;

  console.log("[COMMANDS] Aplicação detectada pelo token:", applicationId);
  console.log("[COMMANDS] Registrando " + registeredCommands.length + " comandos globalmente...");

  // Comandos principais ficam globais. /ia continua separado para manter
  // o comportamento atual de registro por servidor.
  const globalCommands = registeredCommands.filter(command => command?.name !== "ia");
  const aiCommands = registeredCommands.filter(command => command?.name === "ia");

  try {
    await rest.put(Routes.applicationCommands(applicationId), { body: globalCommands });
    console.log("[COMMANDS] Comandos globais publicados: " + globalCommands.length + ".");
  } catch (error) {
    console.error("[COMMANDS] ERRO ao publicar comandos globais:", error);
  }

  const guildIds = [...new Set([
    ...client.guilds.cache.keys(),
    PROTECTED_GUILD_ID,
    process.env.GUILD_ID
  ].filter(Boolean))];

  for (const guildId of guildIds) {
    try {
      // Limpa qualquer registro antigo de guild para que os comandos
      // globais não apareçam duplicados no servidor.
      await rest.put(Routes.applicationGuildCommands(applicationId, guildId), { body: aiCommands });
      console.log("[COMMANDS] /ia publicado no servidor " + guildId + ".");
    } catch (error) {
      console.error("[COMMANDS] ERRO ao publicar /ia no servidor " + guildId + ":", error);
    }
  }
}

client.once("ready", async () => {
  migrateLegacyConfig();
  initializeGuildWhitelist();
  void syncApplicationEmojis().catch(error => console.warn("[EMOJIS] Sincronização em segundo plano falhou:", error.message));
  console.log(`Bot conectado como ${client.user.tag}`);
  try {
    await registerCommands();
  } catch (error) {
    console.error("Erro ao registrar comandos do Astral Stock:", error);
  }

  // Captura inicial: se o estado estiver vazio, publica o stock válido atual.
  // Se a fonte estiver indisponível, checkStock registra o erro e o agendador segue ativo.
  await checkStock(false, ["normal", "mirage"], false);
  startStockScheduler();
  await enforceGuildWhitelist();
});

client.on("guildCreate", async guild => {
  const allowed = new Set(getAllowedGuildIds());
  if (allowed.has(guild.id) || guild.id === PROTECTED_GUILD_ID) {
    console.log("[SECURITY] Entrei no servidor autorizado: " + guild.name + ".");
    return;
  }

  console.log("[SECURITY] Entrei em servidor não autorizado: " + guild.name + " (" + guild.id + "). Saindo automaticamente.");
  try {
    await guild.leave();
  } catch (error) {
    console.warn("[SECURITY] Falha ao sair do servidor não autorizado: " + error.message);
  }
});

process.on("unhandledRejection", error => {
  console.error("Promise rejeitada sem tratamento:", error);
});

process.on("uncaughtException", error => {
  console.error("Erro não tratado:", error);
});
client.on("messageCreate", async message => {
  if (message.author.bot || !message.guild) return;
  if (!client.user) return;

  const chatKey = message.guild.id + ":" + message.channel.id + ":" + message.author.id;
  const mentioned = message.mentions.users.has(client.user.id);
  const activeUntil = aiActiveChats.get(chatKey) || 0;
  const active = activeUntil > Date.now();

  if (!mentioned && !active) return;

  const prompt = message.content
    .replace(new RegExp("<@!?" + client.user.id + ">", "g"), "")
    .trim();

  if (mentioned) {
    aiActiveChats.set(chatKey, Date.now() + AI_CHAT_TIMEOUT_MS);
  }

  if (!prompt) {
    await message.reply({
      content: "🤖 Pode mandar sua pergunta agora. Enquanto a conversa estiver ativa, você não precisa me marcar novamente.",
      allowedMentions: { repliedUser: false }
    });
    return;
  }

  try {
    const stockRequest = /\b(stock|estoque)\b/i.test(prompt);

    if (stockRequest) {
      const state = readState();
      const latest = state.latestStock || {};
      const normal = Array.isArray(latest.normal) ? latest.normal : [];
      const mirage = Array.isArray(latest.mirage) ? latest.mirage : [];

      if (!normal.length && !mirage.length) {
        await message.reply({
          content: uiEmoji("error", "❌") + " Ainda não tenho um stock salvo para mostrar.",
          allowedMentions: { repliedUser: false }
        });
        return;
      }

      const guildConfig = getGuildConfig(message.guild.id);
      const components = [];

      if (normal.length) {
        components.push(stockContainer(normal, stockTitle("normal", guildConfig), "normal", guildConfig));
      }

      if (mirage.length) {
        components.push(stockContainer(mirage, stockTitle("mirage", guildConfig), "mirage", guildConfig));
      }

      await message.reply({
        components,
        flags: MessageFlags.IsComponentsV2,
        allowedMentions: { parse: [] }
      });
      return;
    }

    await message.channel.sendTyping();
    const answer = await askGroqAI(prompt, message.author.id);
    const chunks = splitDiscordText(answer);

    aiActiveChats.set(chatKey, Date.now() + AI_CHAT_TIMEOUT_MS);

    await message.reply({
      content: chunks[0],
      allowedMentions: { repliedUser: false }
    });

    for (const chunk of chunks.slice(1)) {
      await message.channel.send(chunk);
    }
  } catch (error) {
    console.error("Erro na IA por mensagem:", error);
    await message.reply({
      content: uiEmoji("error", "❌") + (error.message || "Não consegui falar com a IA agora."),
      allowedMentions: { repliedUser: false }
    });
  }
});

client.on("interactionCreate", async interaction => {
  if (interaction.isButton() && interaction.customId.startsWith("fruit_roles:")) {
    try {
      // O painel público nunca deve ser alterado com o estado de outro usuário.
      // Ao clicar nele, abrimos uma cópia privada somente para quem clicou.
      const isPublicPanel = interaction.customId === "fruit_roles:remove_all:public";
      const isPrivate = !isPublicPanel;

      if (isPublicPanel) {
        const member = await interaction.guild.members.fetch({
          user: interaction.user.id,
          force: true
        }).catch(() => interaction.member);
        const panel = buildFruitRolePanelForMember(interaction.guildId, member);
        if (!panel) {
          await interaction.reply({ content: uiEmoji("error", "❌") + " Não há cargos de frutas configurados.", ephemeral: true });
          return;
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2 });
        await interaction.editReply(panel);
        return;
      }

      if (isPrivate) await interaction.deferUpdate();
      else await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral });

      const guildConfig = getGuildConfig(interaction.guildId);
      let member = await interaction.guild.members.fetch({
        user: interaction.user.id,
        force: true
      }).catch(() => interaction.member);

      if (interaction.customId === "fruit_roles:remove_all") {
        const configured = ALL_FRUITS
          .map(fruit => ({ fruit, roleId: configuredFruitRoleId(guildConfig, fruit) }))
          .filter(item => /^\d{17,20}$/.test(String(item.roleId || "")));

        const botMember = interaction.guild.members.me || await interaction.guild.members.fetchMe();
        if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
          const msg={content:uiEmoji("error", "❌") + " Eu preciso da permissão **Gerenciar Cargos**."};
          if(isPrivate) await interaction.followUp({...msg,ephemeral:true}); else await interaction.editReply(msg);
          return;
        }

        const removable=[];
        for(const item of configured){
          if(!member.roles.cache.has(item.roleId)) continue;
          const role=interaction.guild.roles.cache.get(item.roleId) || await interaction.guild.roles.fetch(item.roleId).catch(()=>null);
          if(role?.editable) removable.push(role);
        }

        if(removable.length){
          let lastError=null;
          for(let attempt=1;attempt<=5;attempt++){
            try{
              await member.roles.remove(removable,"Todos os cargos de frutas removidos pelo painel");
              lastError=null;
              break;
            }catch(error){
              lastError=error;
              console.error("[FRUIT ROLE] Remover todos tentativa "+attempt+"/5:",error?.message||error);
              if(attempt<5) await new Promise(resolve=>setTimeout(resolve,500*attempt));
            }
          }
          if(lastError) throw lastError;
        }

        member=await interaction.guild.members.fetch({user:interaction.user.id,force:true}).catch(()=>member);
        const panel=buildFruitRolePanelForMember(
          interaction.guildId,
          member,
          removable.length ? "🔴 **Todos os cargos de frutas foram removidos.**" : "ℹ️ **Você não possuía cargos de frutas.**"
        );

        // A interação já foi reconhecida com deferReply/deferUpdate.
        // Sempre finalizamos a interação, inclusive quando o painel não puder ser reconstruído.
        if(!panel){
          await interaction.editReply({ content:uiEmoji("error", "❌") + " Não consegui reconstruir o painel de cargos." }).catch(error => {
            console.error("[FRUIT ROLE] Falha ao finalizar remoção sem painel:", error?.message || error);
          });
          return;
        }

        await interaction.editReply(panel);
        return;
      }
    }catch(error){
      console.error("Erro no botão de remoção de cargos:",error);

      // Se a interação já foi deferida, reply() não a finaliza e o Discord
      // fica mostrando o carregamento. Nesse caso usamos editReply().
      if(interaction.deferred || interaction.replied){
        await interaction.editReply({
          content:"❌ Os cargos podem ter sido removidos, mas não consegui atualizar o painel. Tente clicar novamente."
        }).catch(editError => {
          console.error("[FRUIT ROLE] Falha ao finalizar interação após erro:", editError?.message || editError);
        });
      }else{
        await interaction.reply({
          content:uiEmoji("error", "❌") + " Não consegui processar o painel.",
          ephemeral:true
        }).catch(()=>{});
      }
    }
    return;
  }

  if (interaction.isStringSelectMenu() && interaction.customId.startsWith("fruit_select")) {
    const isPrivatePanel = interaction.customId.startsWith("fruit_select:");
    const userKey = interaction.guildId + ":" + interaction.user.id;

    try {
      // Acknowledge imediatamente. Depois disso podemos esperar a API do Discord
      // sem deixar a interação expirar.
      if (isPrivatePanel) {
        await interaction.deferUpdate();
      } else {
        // Primeiro reconhecemos a interação. Depois restauramos o painel
        // público e abrimos um painel individual efêmero para quem clicou.
        // Usar deferUpdate + editReply evita que o update consuma a interação
        // antes do followUp privado ser criado.
        await interaction.deferUpdate();

        const publicPanel = buildFruitRolePanel(interaction.guildId);
        const member = await interaction.guild.members.fetch({
          user: interaction.user.id,
          force: true
        }).catch(() => interaction.member);
        const privatePanel = buildFruitRolePanelForMember(interaction.guildId, member);

        if (!publicPanel || !privatePanel) {
          await interaction.followUp({
            content: uiEmoji("error", "❌") + " Não há cargos de frutas configurados.",
            ephemeral: true
          });
          return;
        }

        // O painel geral continua exatamente com título, texto, seletores
        // e botão. Ele nunca recebe o estado individual do usuário.
        await interaction.editReply({
          ...publicPanel,
          flags: MessageFlags.IsComponentsV2
        });

        // Painel individual: somente o usuário que clicou consegue vê-lo.
        await interaction.followUp({
          ...privatePanel,
          flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral
        });

        return;
      }

      // Impede dois cliques simultâneos de inverterem o cargo de volta.
      if (fruitRoleBusyUsers.has(userKey)) {
        if (isPrivatePanel) {
          const currentMember = await interaction.guild.members.fetch({
            user: interaction.user.id,
            force: true
          }).catch(() => interaction.member);
          const currentPanel = buildFruitRolePanelForMember(interaction.guildId, currentMember);
          if (currentPanel) await interaction.editReply(currentPanel).catch(() => {});
        }
        return;
      }

      fruitRoleBusyUsers.add(userKey);

      try {
        const fruit = ALL_FRUITS.find(name => fruitKey(name) === interaction.values?.[0]);
        if (!fruit) return;

        const guildConfig = getGuildConfig(interaction.guildId);
        const roleId = configuredFruitRoleId(guildConfig, fruit);
        if (!roleId || !/^\d{17,20}$/.test(String(roleId))) return;

        let role = interaction.guild.roles.cache.get(roleId);
        if (!role) role = await interaction.guild.roles.fetch(roleId).catch(() => null);
        if (!role) return;

        const botMember = interaction.guild.members.me ||
          await interaction.guild.members.fetchMe().catch(() => null);

        if (!botMember?.permissions.has(PermissionFlagsBits.ManageRoles) || !role.editable) {
          console.error("[FRUIT ROLE] Sem permissão/hierarquia para " + fruit + " (" + roleId + ")");
          return;
        }

        let freshMember = await interaction.guild.members.fetch({
          user: interaction.user.id,
          force: true
        }).catch(() => interaction.member);

        const hadRoleBefore = freshMember.roles.cache.has(role.id);
        let changed = false;

        for (let attempt = 1; attempt <= 5; attempt++) {
          try {
            if (hadRoleBefore) {
              await freshMember.roles.remove(role, "Cargo de fruta removido pelo painel");
            } else {
              await freshMember.roles.add(role, "Cargo de fruta recebido pelo painel");
            }
            changed = true;
            break;
          } catch (error) {
            console.error("[FRUIT ROLE] Tentativa " + attempt + "/5 para " + fruit + ":", error?.message || error);
            if (attempt < 5) await new Promise(resolve => setTimeout(resolve, 600 * attempt));
            freshMember = await interaction.guild.members.fetch({
              user: interaction.user.id,
              force: true
            }).catch(() => freshMember);
          }
        }

        if (!changed) return;

        // Confirma várias vezes o estado real antes de atualizar o painel.
        let verifiedMember = freshMember;
        let verified = false;
        for (let attempt = 1; attempt <= 3; attempt++) {
          verifiedMember = await interaction.guild.members.fetch({
            user: interaction.user.id,
            force: true
          }).catch(() => verifiedMember);

          const hasRoleNow = verifiedMember.roles.cache.has(role.id);
          if (hasRoleNow !== hadRoleBefore) {
            verified = true;
            break;
          }
          if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 500));
        }

        if (!verified) {
          console.error("[FRUIT ROLE] Discord não confirmou a alteração de " + fruit);
          return;
        }

        const status = hadRoleBefore
          ? "🔴 **<@&" + role.id + "> removido.**"
          : "🟢 **<@&" + role.id + "> recebido.**";

        const updatedPanel = buildFruitRolePanelForMember(
          interaction.guildId,
          verifiedMember,
          status
        );

        if (updatedPanel) {
          await interaction.editReply(updatedPanel).catch(error => {
            console.error("[FRUIT ROLE] Falha ao atualizar painel privado:", error?.message || error);
          });
        }
      } finally {
        fruitRoleBusyUsers.delete(userKey);
      }
    } catch (error) {
      console.error("Erro no menu de cargos de frutas:", error);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: uiEmoji("error", "❌") + " Não consegui abrir o painel privado.",
          ephemeral: true
        }).catch(() => {});
      }
    }
    return;
  }

  if (interaction.isStringSelectMenu() && interaction.customId === "panel:manage") {
    try {
      const action = interaction.values?.[0];
      if (!interaction.guildId) {
        await interaction.reply({ content: "❌ Este painel só pode ser usado dentro de um servidor.", ephemeral: true });
        return;
      }

      if (action === "servers" && !(await isBotOwner(interaction.user.id))) {
        await interaction.reply({ content: uiEmoji("error", "❌") + " Apenas o dono da aplicação pode acessar os servidores autorizados.", ephemeral: true });
        return;
      }

      if (action !== "servers") {
        const canManage = await isBotOwner(interaction.user.id) ||
          Boolean(interaction.member?.permissions?.has?.(PermissionFlagsBits.ManageGuild));
        if (!canManage) {
          await interaction.reply({ content: uiEmoji("error", "❌") + " Você precisa da permissão **Gerenciar Servidor** para usar este painel.", ephemeral: true });
          return;
        }
      }

      let panel;
      if (action === "config" || action === "stock" || action === "settings" || action === "prices") panel = buildConfigPanel(interaction.guildId);
      else if (action === "fruit_roles") panel = buildFruitAdminPanel(interaction.guildId);
      else if (action === "servers") panel = buildServerAdminPanel();
      else panel = buildMainPanel(interaction.guildId, interaction.user.id);

      await interaction.update(panel);
    } catch (error) {
      console.error("[PANEL] Erro no menu principal:", error);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: uiEmoji("error", "❌") + " Não consegui abrir essa área.", ephemeral: true }).catch(() => {});
      }
    }
    return;
  }

  if (interaction.isButton() && interaction.customId === "panel:restart") {
    try {
      if (!(await isBotOwner(interaction.user.id))) {
        await interaction.reply({
          content: uiEmoji("error", "❌") + " Apenas o dono da aplicação pode reiniciar o bot.",
          ephemeral: true
        });
        return;
      }

      await interaction.reply({
        content: "<:refresh:1557204768093372466> **Reiniciando o Astral Stock...**",
        ephemeral: true
      });

      setTimeout(() => process.exit(0), 800);
    } catch (error) {
      console.error("[PANEL] Erro ao reiniciar:", error);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: "❌ Não consegui reiniciar o bot.", ephemeral: true }).catch(() => {});
      }
    }
    return;
  }

  if (interaction.isButton() && interaction.customId.startsWith("panel:")) {
    try {
      const action = interaction.customId.slice("panel:".length);
      if (!interaction.guildId) {
        await interaction.reply({ content: "❌ Este painel só pode ser usado dentro de um servidor.", ephemeral: true });
        return;
      }

      if (action === "servers" && !(await isBotOwner(interaction.user.id))) {
        await interaction.reply({ content: uiEmoji("error", "❌") + " Apenas o dono da aplicação pode acessar os servidores autorizados.", ephemeral: true });
        return;
      }

      if (action !== "servers") {
        const member = interaction.member;
        const canManage = await isBotOwner(interaction.user.id) ||
          Boolean(member?.permissions?.has?.(PermissionFlagsBits.ManageGuild));
        if (!canManage) {
          await interaction.reply({ content: uiEmoji("error", "❌") + " Você precisa da permissão **Gerenciar Servidor** para usar este painel.", ephemeral: true });
          return;
        }
      }

      let panel;
      if (action === "main") panel = buildMainPanel(interaction.guildId, interaction.user.id);
      else if (action === "config") panel = buildConfigPanel(interaction.guildId);
      else if (action === "fruit_roles") panel = buildFruitAdminPanel(interaction.guildId);
      else if (action === "servers") panel = buildServerAdminPanel();
      else return;

      await interaction.update(panel);
    } catch (error) {
      console.error("[PANEL] Erro ao atualizar painel:", error);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: uiEmoji("error", "❌") + " Não consegui atualizar o painel.", ephemeral: true }).catch(() => {});
      }
    }
    return;
  }

  if (interaction.isStringSelectMenu() &&
      (interaction.customId === "admin_fruit_select" || interaction.customId === "admin_fruit_select_2")) {
    try {
      const canManage = await isBotOwner(interaction.user.id) ||
        Boolean(interaction.member?.permissions?.has?.(PermissionFlagsBits.ManageGuild));
      if (!canManage) {
        await interaction.reply({ content: uiEmoji("error", "❌") + " Você precisa da permissão **Gerenciar Servidor**.", ephemeral: true });
        return;
      }

      const fruit = ALL_FRUITS.find(name => fruitKey(name) === interaction.values?.[0]);
      if (!fruit) {
        await interaction.reply({ content: uiEmoji("error", "❌") + " Fruta inválida.", ephemeral: true });
        return;
      }

      await interaction.update(buildFruitAdminPanel(interaction.guildId, fruit));
    } catch (error) {
      console.error("[PANEL] Erro ao selecionar fruta:", error);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: uiEmoji("error", "❌") + " Não consegui abrir a configuração dessa fruta.", ephemeral: true }).catch(() => {});
      }
    }
    return;
  }

  if (interaction.isRoleSelectMenu() && interaction.customId.startsWith("admin_role_select:")) {
    try {
      const canManage = await isBotOwner(interaction.user.id) ||
        Boolean(interaction.member?.permissions?.has?.(PermissionFlagsBits.ManageGuild));
      if (!canManage) {
        await interaction.reply({ content: uiEmoji("error", "❌") + " Você precisa da permissão **Gerenciar Servidor**.", ephemeral: true });
        return;
      }

      const fruitKeyName = interaction.customId.slice("admin_role_select:".length);
      const fruit = ALL_FRUITS.find(name => fruitKey(name) === fruitKeyName);
      const role = interaction.roles?.first?.();
      if (!fruit || !role) {
        await interaction.reply({ content: uiEmoji("error", "❌") + " Fruta ou cargo inválido.", ephemeral: true });
        return;
      }

      const botMember = interaction.guild.members.me || await interaction.guild.members.fetchMe();
      if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
        await interaction.reply({ content: uiEmoji("error", "❌") + " Eu preciso da permissão **Gerenciar Cargos**.", ephemeral: true });
        return;
      }
      if (!role.editable) {
        await interaction.reply({ content: uiEmoji("error", "❌") + " Não consigo gerenciar esse cargo. Ele precisa estar abaixo do meu cargo mais alto.", ephemeral: true });
        return;
      }

      updateGuildConfig(interaction.guildId, config => {
        config.roles = config.roles || {};
        config.roles[fruitKey(fruit)] = role.id;
      });

      await interaction.update(buildFruitAdminPanel(interaction.guildId, fruit));
    } catch (error) {
      console.error("[PANEL] Erro ao configurar cargo:", error);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: uiEmoji("error", "❌") + " Não consegui configurar esse cargo.", ephemeral: true }).catch(() => {});
      }
    }
    return;
  }

  if (interaction.isButton() && interaction.customId.startsWith("admin_fruit_remove:")) {
    try {
      const canManage = await isBotOwner(interaction.user.id) ||
        Boolean(interaction.member?.permissions?.has?.(PermissionFlagsBits.ManageGuild));
      if (!canManage) {
        await interaction.reply({ content: uiEmoji("error", "❌") + " Você precisa da permissão **Gerenciar Servidor**.", ephemeral: true });
        return;
      }

      const fruitKeyName = interaction.customId.slice("admin_fruit_remove:".length);
      const fruit = ALL_FRUITS.find(name => fruitKey(name) === fruitKeyName);
      if (!fruit) {
        await interaction.reply({ content: uiEmoji("error", "❌") + " Fruta inválida.", ephemeral: true });
        return;
      }

      updateGuildConfig(interaction.guildId, config => {
        config.roles = config.roles || {};
        delete config.roles[fruitKey(fruit)];
      });

      await interaction.update(buildFruitAdminPanel(interaction.guildId));
    } catch (error) {
      console.error("[PANEL] Erro ao remover cargo:", error);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: uiEmoji("error", "❌") + " Não consegui remover o cargo configurado.", ephemeral: true }).catch(() => {});
      }
    }
    return;
  }

  if (interaction.isButton() && (interaction.customId === "server:add" || interaction.customId === "server:remove")) {
    if (!(await isBotOwner(interaction.user.id))) {
      await interaction.reply({ content: uiEmoji("error", "❌") + " Apenas o dono da aplicação pode alterar servidores autorizados.", ephemeral: true });
      return;
    }

    const action = interaction.customId.endsWith(":add") ? "add" : "remove";
    const modal = new ModalBuilder()
      .setCustomId("server_modal:" + action)
      .setTitle(action === "add" ? "Adicionar servidor" : "Remover servidor")
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId("server_id")
            .setLabel("ID do servidor Discord")
            .setPlaceholder("Ex.: 123456789012345678")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMinLength(17)
            .setMaxLength(20)
        )
      );

    await interaction.showModal(modal);
    return;
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith("server_modal:")) {
    try {
      if (!(await isBotOwner(interaction.user.id))) {
        await interaction.reply({ content: uiEmoji("error", "❌") + " Apenas o dono da aplicação pode alterar servidores autorizados.", ephemeral: true });
        return;
      }

      const action = interaction.customId.endsWith(":add") ? "add" : "remove";
      const serverId = interaction.fields.getTextInputValue("server_id").trim();
      if (!/^\\d{17,20}$/.test(serverId)) {
        await interaction.reply({ content: uiEmoji("error", "❌") + " ID de servidor inválido.", ephemeral: true });
        return;
      }

      const config = readConfig();
      config.allowedGuildIds = Array.isArray(config.allowedGuildIds) ? config.allowedGuildIds : [];
      if (!config.allowedGuildIds.includes(PROTECTED_GUILD_ID)) config.allowedGuildIds.push(PROTECTED_GUILD_ID);

      if (action === "add") {
        if (!config.allowedGuildIds.includes(serverId)) config.allowedGuildIds.push(serverId);
        saveConfig(config);
        await interaction.reply({ content: uiEmoji("success", "✅") + " Servidor **" + serverId + "** autorizado.", ephemeral: true });
      } else {
        if (serverId === PROTECTED_GUILD_ID) {
          await interaction.reply({ content: uiEmoji("lock", "🔒") + " Esse servidor é protegido e não pode ser removido.", ephemeral: true });
          return;
        }
        config.allowedGuildIds = config.allowedGuildIds.filter(id => id !== serverId);
        saveConfig(config);
        const guild = client.guilds.cache.get(serverId);
        if (guild) await guild.leave().catch(() => {});
        await interaction.reply({ content: uiEmoji("trash", "🗑️") + " Servidor **" + serverId + "** removido da lista.", ephemeral: true });
      }
    } catch (error) {
      console.error("[PANEL] Erro no modal de servidores:", error);
      if (!interaction.replied) await interaction.reply({ content: uiEmoji("error", "❌") + " Não consegui atualizar os servidores autorizados.", ephemeral: true }).catch(() => {});
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;
  try {
  if (interaction.commandName === "painel") {
    if (!interaction.guildId) {
      await interaction.reply({ content: uiEmoji("error", "❌") + " O painel só pode ser usado dentro de um servidor.", ephemeral: true });
      return;
    }

    const canManage = await isBotOwner(interaction.user.id) ||
      Boolean(interaction.member?.permissions?.has?.(PermissionFlagsBits.ManageGuild));

    if (!canManage) {
      await interaction.reply({
        content: uiEmoji("error", "❌") + " Você precisa da permissão **Gerenciar Servidor** para abrir o painel.",
        ephemeral: true
      });
      return;
    }

    try {
      await interaction.reply(buildMainPanel(interaction.guildId, interaction.user.id));
    } catch (error) {
      console.error("[PANEL] Erro ao abrir /painel:", error);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: "<:offline:1557204568432185454> Não consegui abrir o painel." + (error?.message ? "\n-# Erro: " + String(error.message).slice(0, 180) : ""),
          ephemeral: true
        }).catch(() => {});
      }
    }
    return;
  } else if (interaction.commandName === "server-panel") {
    if (!(await isBotOwner(interaction.user.id))) {
      await interaction.reply({ content: uiEmoji("error", "❌") + " Apenas o dono da aplicação pode usar o painel de servidores.", ephemeral: true });
      return;
    }

    const action = interaction.options.getString("action", true);
    const serverId = interaction.options.getString("server_id");
    const config = readConfig();
    config.allowedGuildIds = Array.isArray(config.allowedGuildIds) ? config.allowedGuildIds : [];
    if (!config.allowedGuildIds.includes(PROTECTED_GUILD_ID)) {
      config.allowedGuildIds.push(PROTECTED_GUILD_ID);
      saveConfig(config);
    }

    if (action === "remove" && serverId === PROTECTED_GUILD_ID) {
      await interaction.reply({ content: "🔒 Esse servidor é protegido e não pode ser removido do painel.", ephemeral: true });
      return;
    }

    if (action === "list") {
      const entries = config.allowedGuildIds.map(id => {
        const guild = client.guilds.cache.get(id);
        return guild ? "• **" + guild.name + "** — \`" + id + "\`" : "• \`" + id + "\` — servidor não encontrado";
      });
      await interaction.reply({
        content: "🛡️ **Servidores autorizados**\\n\\n" + (entries.join("\\n") || "Nenhum servidor autorizado."),
        ephemeral: true
      });
      return;
    }

    if (!/^\d{17,20}$/.test(String(serverId || ""))) {
      await interaction.reply({ content: uiEmoji("error", "❌") + " Informe um ID de servidor Discord válido em **server_id**.", ephemeral: true });
      return;
    }

    if (action === "add") {
      if (!config.allowedGuildIds.includes(serverId)) config.allowedGuildIds.push(serverId);
      saveConfig(config);

      const guild = client.guilds.cache.get(serverId);
      await interaction.reply({
        content: uiEmoji("success", "✅") + " Servidor \`" + serverId + "\` adicionado à lista de permitidos." + (guild ? " O bot já está nesse servidor." : " Quando o bot entrar nesse servidor, ele permanecerá nele."),
        ephemeral: true
      });
      return;
    }

    if (action === "remove") {
      config.allowedGuildIds = config.allowedGuildIds.filter(id => id !== serverId);
      saveConfig(config);

      const guild = client.guilds.cache.get(serverId);
      if (guild) {
        try { await guild.leave(); } catch {}
      }

      await interaction.reply({
        content: uiEmoji("trash", "🗑️") + " Servidor \`" + serverId + "\` removido da lista." + (guild ? " O bot saiu dele automaticamente." : ""),
        ephemeral: true
      });
      return;
    }
  } else if (interaction.commandName === "avatar") {
    await interaction.deferReply();
    try {
      const username = interaction.options.getString("username", true);
      const avatar = await getRobloxAvatar(username);

      const createdText = avatar.created
        ? new Intl.DateTimeFormat("pt-BR", { dateStyle: "long", timeZone: BRASIL_TZ }).format(new Date(avatar.created))
        : "Não informado";
      const favoriteText = avatar.favoritesComplete
        ? String(avatar.favoriteGames)
        : String(avatar.favoriteGames) + "+";

      const info = [
        "🆔 **ID:** " + avatar.id,
        "📅 **Conta criada:** " + createdText,
        "👥 **Amigos:** " + avatar.friends.toLocaleString("pt-BR"),
        "👣 **Seguidores:** " + avatar.followers.toLocaleString("pt-BR"),
        "➡️ **Seguindo:** " + avatar.following.toLocaleString("pt-BR"),
        "⭐ **Jogos favoritos:** " + favoriteText
      ].join("\n");

      // Container V2 com cabeçalho mais completo, mantendo a imagem do avatar.
      const avatarHeader = [
        "## 👤 PERFIL DO ROBLOX",
        "### " + avatar.displayName,
        "-# @" + avatar.username + "  •  Roblox Player"
      ].join("\n");

      const container = new ContainerBuilder()
        .setAccentColor(0x00FFFF)
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(avatarHeader)
        )
        .addMediaGalleryComponents(
          new MediaGalleryBuilder().addItems(
            new MediaGalleryItemBuilder().setURL(avatar.imageUrl)
          )
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(info)
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent("-# Roblox • Perfil público")
        );

      await interaction.editReply({
        components: [container],
        flags: MessageFlags.IsComponentsV2
      });
    } catch (error) {
      console.error("Erro no /avatar:", error);
      await interaction.editReply(uiEmoji("error", "❌") + (error.message || "Não consegui carregar esse avatar do Roblox."));
    }
  } else if (interaction.commandName === "ia") {
    await interaction.deferReply();
    try {
      const prompt = interaction.options.getString("pergunta", true);
      const answer = await askGroqAI(prompt, interaction.user.id);
      const chunks = splitDiscordText(answer);

      await interaction.editReply(chunks[0]);
      for (const chunk of chunks.slice(1)) {
        await interaction.followUp(chunk);
      }
    } catch (error) {
      console.error("Erro no /ia:", error);
      await interaction.editReply(uiEmoji("error", "❌") + (error.message || "Não consegui falar com a IA agora."));
    }
 } else if (interaction.commandName === "test-stock") {
    const lines = ALL_FRUITS.map(name => {
      const emoji = fruitEmoji({ name });
      const price = savedBeliPrice(name);
      const priceText = price != null
        ? APPLICATION_UI_EMOJIS.beli + " \`" + Number(price).toLocaleString("en-US") + "\`"
        : APPLICATION_UI_EMOJIS.beli + " \`Valor não cadastrado\`";
      const robuxPrice = PERMANENT_ROBUX_PRICES[fruitKey(name)];
      const robuxText = robuxPrice != null ? " | " + Number(robuxPrice).toLocaleString("en-US") + " " + APPLICATION_UI_EMOJIS.robux : "";
      return emoji + " **" + name + "** | " + priceText + robuxText;
    });
    const testText = [
      "# " + APPLICATION_FRUIT_EMOJIS.dragon + " Blox Fruits",
      "",
      ...lines,
      "",
      APPLICATION_UI_EMOJIS.clock + " **Clock test**",
      APPLICATION_UI_EMOJIS.robux + " **Robux** 2,400"
    ].join("\n");

    // Divide o teste em páginas para nunca ultrapassar os limites de componentes/mensagem do Discord.
    const maxChars = 3500;
    const pages = [];
    let current = "";

    for (const line of testText.split("\n")) {
      const candidate = current ? current + "\n" + line : line;
      if (candidate.length > maxChars && current) {
        pages.push(current);
        current = line;
      } else {
        current = candidate;
      }
    }
    if (current) pages.push(current);

    const makeTestContainer = content => new ContainerBuilder()
      .setAccentColor(0x00FFFF)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(content)
      );

    await interaction.reply({
      components: [makeTestContainer(pages[0])],
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { parse: [] }
    });

    for (const page of pages.slice(1)) {
      await interaction.followUp({
        components: [makeTestContainer(page)],
        flags: MessageFlags.IsComponentsV2,
        allowedMentions: { parse: [] }
      });
    }
  } else if (interaction.commandName === "send-stock") {
    if (!(await isBotOwner(interaction.user.id))) {
      await interaction.reply({ content: uiEmoji("error", "❌") + " Apenas o dono da aplicação pode usar /send-stock.", ephemeral: true });
      return;
    }

    try {
      // Apps instalados na conta não são membros do servidor e não podem
      // enviar mensagens por conta própria para canais arbitrários. A resposta
      // da interação, porém, é enviada diretamente no canal onde o comando foi usado.
      const state = readState();
      const latest = state.latestStock || {};
      const normal = Array.isArray(latest.normal) ? latest.normal : [];
      const mirage = Array.isArray(latest.mirage) ? latest.mirage : [];
      const components = [];
      if (normal.length) components.push(stockContainer(normal, stockTitle("normal"), "normal", defaultGuildConfig()));
      if (mirage.length) components.push(stockContainer(mirage, stockTitle("mirage"), "mirage", defaultGuildConfig()));
      if (!components.length) {
        await interaction.reply({ content: uiEmoji("error", "❌") + " Ainda não existe stock salvo para enviar.", ephemeral: true });
        return;
      }
      await interaction.reply({ components, flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } });
    } catch (error) {
      console.error("Erro no /send-stock:", error);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: uiEmoji("error", "❌") + " Não consegui enviar o stock salvo.", ephemeral: true });
      }
    }
  } else if (interaction.commandName === "stock") {
    try {
      // /stock mostra o mesmo stock que o bot publicou no canal configurado.
      // Não consulta a API novamente, evitando gastar crédito e possíveis dados antigos.
      const state = readState();
      const latest = state.latestStock || {};
      const normal = Array.isArray(latest.normal) ? latest.normal : [];
      const mirage = Array.isArray(latest.mirage) ? latest.mirage : [];
      const components = [];
      if (normal.length) components.push(stockContainer(normal, stockTitle("normal", getGuildConfig(interaction.guildId)), "normal", getGuildConfig(interaction.guildId)));
      if (mirage.length) components.push(stockContainer(mirage, stockTitle("mirage", getGuildConfig(interaction.guildId)), "mirage", getGuildConfig(interaction.guildId)));
      if (!components.length) {
        components.push(stockContainer([], "🍈 STOCK ATUAL", null, getGuildConfig(interaction.guildId)));
      }
      await interaction.reply({ components, flags: MessageFlags.IsComponentsV2 });
    } catch (e) {
      console.error("Erro no /stock:", e);
      if (!interaction.replied && !interaction.deferred) await interaction.reply({ content: uiEmoji("error", "❌") + " Não consegui mostrar o estoque agora.", ephemeral: true });
    }
  } else if (interaction.commandName === "refresh-stock") {
    await interaction.deferReply({ ephemeral: true });
    try {
      const state = readState();
      const latest = state.latestStock || {};
      const normal = Array.isArray(latest.normal) ? latest.normal : [];
      const mirage = Array.isArray(latest.mirage) ? latest.mirage : [];
      if (!normal.length && !mirage.length) {
        throw new Error("Ainda não existe stock salvo para reenviar.");
      }

      const guildConfig = getGuildConfig(interaction.guildId);
      let sent = false;

      if (normal.length) {
        const normalSent = await postStock(normal, false, null, "normal");
        sent = sent || normalSent;
      }
      if (mirage.length) {
        const mirageSent = await postStock(mirage, false, null, "mirage");
        sent = sent || mirageSent;
      }

      if (!sent) {
        throw new Error("Nenhum canal de stock configurado ou acessível neste servidor.");
      }

      await interaction.editReply(uiEmoji("success", "✅") + " Reenviei o último stock salvo no canal configurado. Nenhuma consulta à API/Wiki foi feita.");
    } catch (e) {
      await interaction.editReply(uiEmoji("error", "❌") + " Não consegui reenviar o stock salvo: " + e.message + ".");
    }
  } else if (interaction.commandName === "set-stock-channel") {
    const channel = interaction.options.getChannel("channel", true);
    if (!channel.isTextBased() || !channel.send) {
      await interaction.reply({ content: uiEmoji("error", "❌") + " Escolha um canal de texto.", ephemeral: true });
      return;
    }
    updateGuildConfig(interaction.guildId, config => { config.channelId = channel.id; });
    await interaction.reply({ content: uiEmoji("success", "✅") + " Canal de stock configurado para " + channel + ".", ephemeral: true });
  } else if (interaction.commandName === "set-stock-title") {
    const groupKey = interaction.options.getString("stock_type");
    const title = interaction.options.getString("title").trim();
    updateGuildConfig(interaction.guildId, config => {
      config.titles = config.titles || {};
      config.titles[groupKey] = title;
    });
    await interaction.reply({
      content: `Título do ${groupKey === "mirage" ? "Stock da Mirage" : "Stock Normal"} alterado para **${title}**.`,
      ephemeral: true
    });
  } else if (interaction.commandName === "set-fruit-role") {
    const inputFruit = interaction.options.getString("fruit", true);
    const fruit = resolveFruitName(inputFruit);
    const role = interaction.options.getRole("role", true);

    if (!fruit) {
      await interaction.reply({ content: invalidFruitMessage(inputFruit), ephemeral: true });
      return;
    }

    updateGuildConfig(interaction.guildId, config => {
      config.roles = config.roles || {};
      config.roles[fruitKey(fruit)] = role.id;
    });
    await interaction.reply({ content: `Cargo ${role} configurado para **${fruit}**. Vou mencionar esse cargo quando a fruta aparecer no stock.`, ephemeral: true });
  } else if (interaction.commandName === "list-roles") {
    const roles = getGuildConfig(interaction.guildId).roles || {};
    const entries = Object.entries(roles).filter(([, id]) => /^\d{17,20}$/.test(String(id)));
    const content = entries.map(([fruit, id]) => `• ${fruitEmoji(fruit)} **${fruit}**: <@&${id}>`).join("\n");
    await interaction.reply({ content: content || "Nenhum cargo configurado ainda. Use /configurar-fruta.", ephemeral: true, allowedMentions: { parse: [] } });
  } else if (interaction.commandName === "fruit-role-panel") {
    const panel = buildFruitRolePanel(interaction.guildId);

    if (!panel.configured?.length) {
      await interaction.reply({
        content: uiEmoji("error", "❌") + " Nenhuma fruta possui cargo configurado. Use primeiro **/set-fruit-role**.",
        ephemeral: true
      });
      return;
    }

    await interaction.reply({
      ...panel,
      flags: MessageFlags.IsComponentsV2
    });
  } else if (interaction.commandName === "remove-role") {
    const inputFruit = interaction.options.getString("fruit", true);
    const fruit = resolveFruitName(inputFruit);

    if (!fruit) {
      await interaction.reply({ content: invalidFruitMessage(inputFruit), ephemeral: true });
      return;
    }

    const fruitKeyName = fruitKey(fruit);
    const config = getGuildConfig(interaction.guildId);
    if (!config.roles[fruitKeyName]) {
      await interaction.reply({ content: `Não há cargo configurado para **${fruit}**.`, ephemeral: true });
    } else {
      updateGuildConfig(interaction.guildId, config => { delete config.roles[fruitKeyName]; });
      await interaction.reply({ content: `Configuração de cargo removida para **${fruit}**.`, ephemeral: true });
    }
  } else if (interaction.commandName === "stock-alert") {
    const action = interaction.options.getString("action", true);
    const guildConfig = getGuildConfig(interaction.guildId);
    if (action === "set_channel") {
      const channel = interaction.options.getChannel("channel", true);
      if (!channel.isTextBased() || !channel.send) {
        await interaction.reply({ content: uiEmoji("error", "❌") + " Escolha um canal de texto.", ephemeral: true });
        return;
      }
      updateGuildConfig(interaction.guildId, config => { config.stockAlertChannelId = channel.id; });
      await interaction.reply({ content: uiEmoji("success", "✅") + " Canal de alertas definido como " + channel + ".", ephemeral: true });
    } else if (action === "remove_channel") {
      if (!guildConfig.stockAlertChannelId) {
        await interaction.reply({ content: "Não há canal de alertas configurado.", ephemeral: true });
      } else {
        updateGuildConfig(interaction.guildId, config => { config.stockAlertChannelId = null; });
        await interaction.reply({ content: uiEmoji("mute", "🔕") + " Canal de alertas removido.", ephemeral: true });
      }
    } else if (action === "add_fruit") {
      const inputFruit = interaction.options.getString("fruit", true);
      const fruit = resolveFruitName(inputFruit);
      const role = interaction.options.getRole("role", true);

      if (!fruit) {
        await interaction.reply({ content: invalidFruitMessage(inputFruit), ephemeral: true });
        return;
      }

      const fruitKeyName = fruitKey(fruit);
      updateGuildConfig(interaction.guildId, config => {
        config.stockAlerts = config.stockAlerts || {};
        config.stockAlerts[fruitKeyName] = role.id;
      });
      await interaction.reply({ content: uiEmoji("alert", "🔔") + " Alerta ativado para **" + fruit + "**. Vou mencionar " + role + " no canal de alertas quando aparecer.", ephemeral: true });
    } else if (action === "remove_fruit") {
      const inputFruit = interaction.options.getString("fruit", true);
      const fruit = resolveFruitName(inputFruit);

      if (!fruit) {
        await interaction.reply({ content: invalidFruitMessage(inputFruit), ephemeral: true });
        return;
      }

      const fruitKeyName = fruitKey(fruit);
      if (!guildConfig.stockAlerts?.[fruitKeyName]) {
        await interaction.reply({ content: "Não há alerta configurado para **" + fruit + "**.", ephemeral: true });
      } else {
        updateGuildConfig(interaction.guildId, config => { delete config.stockAlerts[fruitKeyName]; });
        await interaction.reply({ content: uiEmoji("mute", "🔕") + " Alerta removido para **" + fruit + "**.", ephemeral: true });
      }
    }  } else if (interaction.commandName === "stock-prediction" || interaction.commandName === "stock-statistics") {
    const groupKey = interaction.options.getString("stock_type", true);
    const isPrediction = interaction.commandName === "stock-prediction";
    await interaction.reply({ content: analyticsMessage(groupKey, isPrediction), ephemeral: true });
  } else if (interaction.commandName === "stock-history") {
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
        await interaction.editReply({ content: `${uiEmoji("error", "❌")} Ocorreu um erro ao executar /${interaction.commandName}. Tente novamente.` });
      } else {
        await interaction.reply({ content: uiEmoji("error", "❌") + " Ocorreu um erro ao executar este comando.", ephemeral: true });
      }
    } catch (replyError) {
      console.error("Não foi possível responder à interação:", replyError);
    }
  }
});
client.login(process.env.DISCORD_TOKEN);