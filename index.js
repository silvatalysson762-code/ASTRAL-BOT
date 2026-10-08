require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");
const {
  Client, GatewayIntentBits, MessageFlags, ContainerBuilder, TextDisplayBuilder, SectionBuilder, ThumbnailBuilder, MediaGalleryBuilder, MediaGalleryItemBuilder, EmbedBuilder,
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
const apiKeyCooldownUntil = new Map();
const BRASIL_TZ = "America/Sao_Paulo";
const nextStockAt = { normal: null, mirage: null };
const pendingBotCustomizations = new Map();

const fruitRoleBusyUsers = new Set();
const aiCooldowns = new Map();
const aiActiveChats = new Map();
const AI_CHAT_TIMEOUT_MS = 5 * 1000;

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

async function getDiscloudAppId(token) {
  let appId = String(process.env.DISCLOUD_APP_ID || "").trim();
  if (appId) return appId;

  const userResponse = await fetch("https://api.discloud.app/v2/user", {
    headers: { "api-token": token, Accept: "*/*" },
    signal: AbortSignal.timeout(15000)
  });
  const userData = await userResponse.json().catch(() => ({}));
  if (!userResponse.ok) {
    throw new Error("Não consegui validar a API da Discloud.");
  }

  const apps = Array.isArray(userData?.user?.apps) ? userData.user.apps : [];
  if (apps.length !== 1) {
    throw new Error("Configure DISCLOUD_APP_ID com o ID da aplicação na Discloud.");
  }
  return String(apps[0]);
}

async function restartOnDiscloud() {
  const token = String(process.env.DISCLOUD_TOKEN || "").trim();
  if (!token) return false;

  const appId = await getDiscloudAppId(token);
  const response = await fetch("https://api.discloud.app/v2/app/" + encodeURIComponent(appId) + "/restart", {
    method: "PUT",
    headers: { "api-token": token, Accept: "*/*" },
    signal: AbortSignal.timeout(20000)
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok || data?.status === "error") {
    throw new Error(data?.message || "A Discloud não conseguiu reiniciar a aplicação.");
  }

  return true;
}

function crc32(buffer) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buffer.length; i++) {
    crc ^= buffer[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function createStoredZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data);
    const crc = crc32(data);

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);

    localParts.push(local, data);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centralParts.push(central);

    offset += local.length + data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const localData = Buffer.concat(localParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localData.length, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([localData, centralDirectory, end]);
}

async function buildGitHubSourceZip() {
  const repo = "silvatalysson762-code/blox-fruits-stock-bot";
  const response = await fetch(
    "https://codeload.github.com/" + repo + "/zip/refs/heads/main",
    {
      headers: { "User-Agent": "Astral-Stock-Bot/1.0" },
      signal: AbortSignal.timeout(120000)
    }
  );

  if (!response.ok) {
    throw new Error("Não consegui baixar o código atual do GitHub (HTTP " + response.status + ").");
  }

  return Buffer.from(await response.arrayBuffer());
}
async function commitOnDiscloud() {
  const token = String(process.env.DISCLOUD_TOKEN || "").trim();
  if (!token) return false;

  const appId = await getDiscloudAppId(token);
  const zip = await buildGitHubSourceZip();

  const form = new FormData();
  form.append("file", new Blob([zip], { type: "application/zip" }), "astral-stock.zip");

  const response = await fetch(
    "https://api.discloud.app/v2/app/" + encodeURIComponent(appId) + "/commit",
    {
      method: "PUT",
      headers: { "api-token": token, Accept: "*/*" },
      body: form,
      signal: AbortSignal.timeout(120000)
    }
  );
  const data = await response.json().catch(() => ({}));

  if (!response.ok || data?.status === "error") {
    throw new Error(data?.message || "A Discloud não conseguiu atualizar o código.");
  }

  return true;
}

async function downloadOriginalImage(url) {
  const response = await fetch(String(url), {
    headers: { "User-Agent": "Astral-Stock-Bot/1.0" },
    signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) throw new Error("Não consegui baixar o banner original (HTTP " + response.status + ").");
  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  if (!contentType.startsWith("image/")) throw new Error("A URL do banner precisa apontar diretamente para uma imagem.");
  return Buffer.from(await response.arrayBuffer());
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
  return { channelId: null, roles: {}, emojis: {}, aliases: {}, titles: {}, stockAlertChannelId: null, stockAlerts: {}, supportMessageChannelId: null, supportMessageId: null, ticketAppearance: { title: "ASTRAL SUPORTE", description: "Precisa de ajuda? Abra um ticket e nossa equipe entrará em contato.", thumbnail: null, banner: null, color: "00FFFF" }, ticketOpeningMode: "channel", ticketInterfaceMode: "v2", ticketFunctions: [], ticketSchedule: { enabled: false, allowOutsideHours: false, days: { sunday: { active: false, start: "09:00", end: "18:00" }, monday: { active: false, start: "09:00", end: "18:00" }, tuesday: { active: false, start: "09:00", end: "18:00" }, wednesday: { active: false, start: "09:00", end: "18:00" }, thursday: { active: false, start: "09:00", end: "18:00" }, friday: { active: false, start: "09:00", end: "18:00" }, saturday: { active: false, start: "09:00", end: "18:00" } } } };
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


const DEFAULT_TICKET_FUNCTIONS = [
  {
    id: "ticket_default_suporte_geral",
    name: "Suporte Geral",
    preDescription: "Dúvidas, informações ou ajuda.",
    description: null,
    banner: null,
    emojiName: "headphones"
  },
  {
    id: "ticket_default_denuncias",
    name: "Denúncias",
    preDescription: "Denuncie Alguém Por Comportamento Inadequado",
    description: null,
    banner: null,
    emojiName: "warning"
  },
  {
    id: "ticket_default_parcerias",
    name: "Parcerias",
    preDescription: "Propostas de parceria com a Astral Store.",
    description: null,
    banner: null,
    emojiName: "briefcase"
  },
  {
    id: "ticket_default_resgatar_produto",
    name: "Resgatar produto",
    preDescription: "Resgate aqui seu produto",
    description: null,
    banner: null,
    emojiName: "wallet"
  },
  {
    id: "ticket_default_resgatar_premio",
    name: "Resgatar prêmio",
    preDescription: "Resgate aqui seu prêmio",
    description: null,
    banner: null,
    emojiName: "gift"
  },
  {
    id: "ticket_default_outro_assunto",
    name: "Outro Assunto",
    preDescription: "Para assuntos que não se encaixam nas opções acima.",
    description: null,
    banner: null,
    emojiName: "refresh"
  }
];

function findApplicationEmojiByName(name) {
  const wanted = normalizeApplicationEmojiName(name);
  return client.application?.emojis?.cache?.find(
    emoji => normalizeApplicationEmojiName(emoji.name) === wanted
  ) || null;
}

async function seedDefaultTicketFunctions() {
  if (!client.application?.emojis) return;

  const config = readConfig();
  const allowed = new Set(Array.isArray(config.allowedGuildIds) ? config.allowedGuildIds : []);
  let changed = false;

  for (const guild of client.guilds.cache.values()) {
    if (!allowed.has(guild.id) && guild.id !== PROTECTED_GUILD_ID) continue;

    const guildConfig = getGuildConfig(guild.id);
    if (Number(guildConfig.ticketFunctionsDefaultsVersion || 0) >= 1) continue;

    const functions = Array.isArray(guildConfig.ticketFunctions) ? [...guildConfig.ticketFunctions] : [];
    const existingNames = new Set(functions.map(fn => fruitKey(fn.name)));

    for (const template of DEFAULT_TICKET_FUNCTIONS) {
      if (existingNames.has(fruitKey(template.name))) continue;

      const emoji = findApplicationEmojiByName(template.emojiName);
      functions.push({
        id: template.id,
        name: template.name,
        preDescription: template.preDescription,
        description: template.description,
        banner: template.banner,
        emoji: emoji
          ? { id: emoji.id, name: emoji.name || template.emojiName, animated: Boolean(emoji.animated) }
          : null
      });
    }

    updateGuildConfig(guild.id, cfg => {
      cfg.ticketFunctions = functions.slice(0, 25);
      cfg.ticketFunctionsDefaultsVersion = 1;
    });
    changed = true;
    console.log("[TICKET] Funções padrão adicionadas ao servidor " + guild.name + ".");
  }

  return changed;
}

function getBotSettings() {
  const config = readConfig();
  if (!config.botSettings || typeof config.botSettings !== "object") {
    config.botSettings = {
      status1: "",
      status2: "",
      avatar: "",
      banner: "",
      description: "",
      accentColor: "00FFFF"
    };
    saveConfig(config);
  } else {
    config.botSettings.status1 = String(config.botSettings.status1 || "");
    config.botSettings.status2 = String(config.botSettings.status2 || "");
    config.botSettings.avatar = String(config.botSettings.avatar || "");
    config.botSettings.banner = String(config.botSettings.banner || "");
    config.botSettings.description = String(config.botSettings.description || "").slice(0, 190);
    config.botSettings.accentColor = String(config.botSettings.accentColor || "00FFFF").replace(/^#/, "").toUpperCase();
    if (!/^[0-9A-F]{6}$/.test(config.botSettings.accentColor)) config.botSettings.accentColor = "00FFFF";
  }
  return config.botSettings;
}

function getBotPanelAccentColor() {
  const settings = getBotSettings();
  return parseInt(String(settings.accentColor || "00FFFF").replace(/^#/, ""), 16) || 0x00FFFF;
}

let rotatingStatusIndex = 0;
let rotatingStatusTimer = null;

function applyRotatingBotStatus() {
  if (!client.user) return;
  const settings = getBotSettings();
  const statuses = [settings.status1, settings.status2].filter(Boolean);
  if (!statuses.length) {
    client.user.setPresence({ status: "online", activities: [] });
    return;
  }

  if (rotatingStatusIndex >= statuses.length) rotatingStatusIndex = 0;
  const status = statuses[rotatingStatusIndex];
  rotatingStatusIndex = (rotatingStatusIndex + 1) % statuses.length;

  client.user.setPresence({
    status: "online",
    activities: [{ name: status, type: 0 }]
  });
}

function startBotStatusRotation() {
  if (rotatingStatusTimer) clearInterval(rotatingStatusTimer);
  applyRotatingBotStatus();
  rotatingStatusTimer = setInterval(applyRotatingBotStatus, 15000);
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

function setPendingRestartConfirmation(type, interactionToken) {
  const state = readState();
  state.pendingRestartConfirmation = {
    type: type === "rebuild" ? "rebuild" : "restart",
    token: String(interactionToken || ""),
    createdAt: Date.now()
  };
  saveState(state);
}

async function completePendingRestartConfirmation() {
  const state = readState();
  const pending = state.pendingRestartConfirmation;
  if (!pending?.token) return;

  // Interaction tokens expiram após 15 minutos. Se já passou disso,
  // simplesmente limpamos a confirmação pendente.
  if (Date.now() - Number(pending.createdAt || 0) > 14 * 60 * 1000) {
    delete state.pendingRestartConfirmation;
    saveState(state);
    return;
  }

  const isRebuild = pending.type === "rebuild";
  const content = isRebuild
    ? "<:online:1557204563675848814> **Rebuild concluído com sucesso!**\nCódigo atualizado, comandos e emojis sincronizados e o Astral Stock está online novamente."
    : "<:online:1557204563675848814> **Astral Stock reiniciado com sucesso!**\nO bot voltou online normalmente.";

  try {
    const route = Routes.webhookMessage(client.user.id, String(pending.token), "@original");
    await client.rest.patch(route, {
      body: { content }
    });
    console.log("[PANEL] Confirmação de " + (isRebuild ? "rebuild" : "reinício") + " enviada após o bot voltar online.");
  } catch (error) {
    console.warn("[PANEL] Não consegui atualizar a confirmação após reiniciar:", error?.message || error);
  }

  delete state.pendingRestartConfirmation;
  saveState(state);
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
      const cooldownUntil = apiKeyCooldownUntil.get(i) || 0;
      if (cooldownUntil > Date.now()) {
        const remaining = Math.ceil((cooldownUntil - Date.now()) / 1000);
        console.log("[STOCK API] Key " + (i + 1) + " está em cooldown por " + remaining + "s; pulando para a próxima.");
        continue;
      }
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
          if (response.status === 429) {
            const retryAfterRaw = response.headers.get("retry-after");
            const retryAfterSeconds = Number(retryAfterRaw);
            const cooldownMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
              ? retryAfterSeconds * 1000
              : 60000;
            apiKeyCooldownUntil.set(i, Date.now() + cooldownMs);
            console.warn("[STOCK API] Key " + (i + 1) + " recebeu 429; cooldown de " + Math.ceil(cooldownMs / 1000) + "s.");
          }
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
  error: "<:offline:1557204568432185454>",
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

    // Evita tentar renomear um emoji para um nome que já pertence a outro
    // emoji da aplicação. O Discord não permite nomes duplicados.
    const namesInUse = new Set(
      [...emojis.values()]
        .map(emoji => normalizeApplicationEmojiName(emoji.name))
        .filter(Boolean)
    );

    for (const emoji of emojis.values()) {
      const wantedName = APPLICATION_EMOJI_RENAMES[emoji.id] || APPLICATION_NUMERIC_EMOJI_RENAMES[emoji.name];
      if (!wantedName || emoji.name === wantedName) continue;

      const normalizedWantedName = normalizeApplicationEmojiName(wantedName);
      if (namesInUse.has(normalizedWantedName)) {
        console.log("[EMOJIS] Nome " + wantedName + " já está em uso; mantendo " + emoji.name + " no emoji " + emoji.id + ".");
        continue;
      }

      let renamed = false;
      for (let attempt = 1; attempt <= 3 && !renamed; attempt++) {
        try {
          await emoji.setName(wantedName);
          renamed = true;
          namesInUse.delete(normalizeApplicationEmojiName(emoji.name));
          namesInUse.add(normalizedWantedName);
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
      .filter(([, value]) => value && value !== "<:offline:1557204568432185454>" && value !== "✅" && value !== "⚠️" && value !== "🔔" && value !== "📦" && value !== "🎨" && value !== "👤" && value !== "⚙️")
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
    .setAccentColor(getBotPanelAccentColor())
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

    // O agendador só precisa acordar perto do próximo reset, não a cada 5 segundos.
    // Isso reduz despertares desnecessários sem alterar os horários de stock.
    const upcoming = Object.values(nextStockAt).filter(value => Number.isFinite(value) && value > now);
    const nextDueAt = upcoming.length ? Math.min(...upcoming) : now + 60000;
    schedulerTimer = setTimeout(tick, Math.max(1000, nextDueAt - now));
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
  return [new ContainerBuilder().setAccentColor(getBotPanelAccentColor()).addTextDisplayComponents(new TextDisplayBuilder().setContent(body))];
}

const fruitOption = (option) => option.setName("fruit").setDescription("Nome da fruta").setRequired(true);

function resolveFruitName(input) {
  const normalized = fruitKey(input);
  const fruit = ALL_FRUITS.find(name => fruitKey(name) === normalized);
  return fruit || null;
}

function invalidFruitMessage(input) {
  const value = String(input || "").trim();
  return "<:offline:1557204568432185454> **" + (value || "Fruta") + "** não é uma fruta válida do Blox Fruits.\n\nFrutas disponíveis: " + ALL_FRUITS.join(", ") + ".";
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
    .setLabel("Remover todos os cargos")
    .setEmoji({ name: "XXX", id: "1557086367844933702" })
    .setStyle(ButtonStyle.Secondary);
}

function buildFruitRolePanelForMember(guildId, member, statusText = null, page = 0) {
  const guildConfig = getGuildConfig(guildId);
  const configured = [...ALL_FRUITS].reverse()
    .map(fruit => ({ fruit, roleId: configuredFruitRoleId(guildConfig, fruit) }))
    .filter(item => /^\d{17,20}$/.test(String(item.roleId || "")));

  if (!configured.length) return null;

  const pageSize = 25;
  const pageCount = Math.max(1, Math.ceil(configured.length / pageSize));
  const currentPage = Math.min(Math.max(0, Number(page) || 0), pageCount - 1);
  const chunk = configured.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const menu = new StringSelectMenuBuilder()
    .setCustomId("fruit_select:" + currentPage)
    .setPlaceholder("🍎 Escolha uma fruta (" + (currentPage + 1) + "/" + pageCount + ")")
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

  const rows = [new ActionRowBuilder().addComponents(menu)];
  if (pageCount > 1) {
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("fruit_page:private:" + (currentPage - 1))
        .setLabel("Anterior")
        .setEmoji({ name: "arrow_up", id: "1557204775383212042" })
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(currentPage === 0),
      new ButtonBuilder()
        .setCustomId("fruit_page:private:" + (currentPage + 1))
        .setLabel("Próxima")
        .setEmoji({ name: "arrow_down", id: "1557204770178211870" })
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(currentPage >= pageCount - 1)
    ));
  }
  rows.push(new ActionRowBuilder().addComponents(removeAllFruitRolesButton(false)));

  // Painel individual compacto: somente a mensagem de status (quando houver),
  // os seletores e o botão de remover todos os cargos.
  const container = new ContainerBuilder()
    .setAccentColor(getBotPanelAccentColor());

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

function buildFruitRolePanel(guildId, page = 0) {
  const guildConfig = getGuildConfig(guildId);
  const configured = [...ALL_FRUITS].reverse()
    .map(fruit => ({ fruit, roleId: configuredFruitRoleId(guildConfig, fruit) }))
    .filter(item => /^\d{17,20}$/.test(String(item.roleId || "")));

  if (!configured.length) return { configured: [], messages: [] };

  const pageSize = 25;
  const pageCount = Math.max(1, Math.ceil(configured.length / pageSize));
  const currentPage = Math.min(Math.max(0, Number(page) || 0), pageCount - 1);
  const chunk = configured.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const menu = new StringSelectMenuBuilder()
    .setCustomId("fruit_select_public:" + currentPage)
    .setPlaceholder("🍎 Escolha uma fruta (" + (currentPage + 1) + "/" + pageCount + ")")
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(chunk.map(item => ({
      label: item.fruit,
      value: fruitKey(item.fruit),
      emoji: fruitEmojiObject(item.fruit),
      description: "Clique para receber/remover"
    })));

  const rows = [new ActionRowBuilder().addComponents(menu)];
  if (pageCount > 1) {
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("fruit_page:public:" + (currentPage - 1))
        .setLabel("Anterior")
        .setEmoji({ name: "arrow_up", id: "1557204775383212042" })
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(currentPage === 0),
      new ButtonBuilder()
        .setCustomId("fruit_page:public:" + (currentPage + 1))
        .setLabel("Próxima")
        .setEmoji({ name: "arrow_down", id: "1557204770178211870" })
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(currentPage >= pageCount - 1)
    ));
  }
  rows.push(new ActionRowBuilder().addComponents(removeAllFruitRolesButton(true)));

  const title =
    "@everyone\n# " + APPLICATION_FRUIT_EMOJIS.dragon + "  CARGOS DE FRUTAS";
  const description =
    "### Escolha uma fruta abaixo para receber ou remover o cargo.\n\n" +
    uiEmoji("alert", "🔔") + " **Selecione os cargos das frutas que você deseja receber para receber as notificações de stock.**\n" +
    "📢 As notificações serão enviadas no canal <#1555984553016033380>.";

  const container = new ContainerBuilder()
    .setAccentColor(getBotPanelAccentColor())
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


const pendingAdminRoles = new Map();

function buildAdministrativeRolesPanel(guildId) {
  const config = getGuildConfig(guildId);
  const saved = config.adminRoles || {};
  const draft = pendingAdminRoles.get(String(guildId)) || saved;

  const roleName = key => {
    const roleId = draft[key];
    if (!roleId) return "Não configurado";
    const role = client.guilds.cache.get(guildId)?.roles.cache.get(roleId);
    return role ? "<@&" + roleId + ">" : "Não configurado";
  };

  const container = new ContainerBuilder()
    .setAccentColor(getBotPanelAccentColor())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "## <:config_title_alt:1557204540460240926> CARGOS ADMINISTRATIVOS\n" +
        "> Configure os cargos utilizados pela ASTRAL STORE.\n" +
        "> Selecione abaixo qual cargo deseja configurar.\n" +
        "### <:config_title_alt:1557204540460240926> Administrador: " + roleName("administrator") + "\n" +
        "### <:shield_alt:1557205099665956875> Moderador: " + roleName("moderator") + "\n" +
        "### <:control_center:1557204878001176586> Staff: " + roleName("staff") + "\n" +
        "### <:money_symbol_alt:1557204522009370634> Cliente: " + roleName("client") + "\n" +
        "### <:user:1557205116849758238> Membro: " + roleName("member")
      )
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("panel:admin_role_type")
          .setPlaceholder("Selecione um cargo para configurar")
          .addOptions(
            { label: "Administrador", description: "Defina o cargo de administrador", value: "administrator", emoji: { name: "config_title_alt", id: "1557204540460240926" } },
            { label: "Moderador", description: "Defina o cargo de moderador", value: "moderator", emoji: { name: "shield_alt", id: "1557205099665956875" } },
            { label: "Staff", description: "Defina o cargo da equipe Staff", value: "staff", emoji: { name: "control_center", id: "1557204878001176586" } },
            { label: "Cliente", description: "Defina o cargo de cliente", value: "client", emoji: { name: "money_symbol_alt", id: "1557204522009370634" } },
            { label: "Membro", description: "Defina o cargo padrão de membro", value: "member", emoji: { name: "user", id: "1557205116849758238" } }
          )
      )
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("panel:roles").setLabel("Voltar").setEmoji({ name: "arrow_left", id: "1557204764834537534" }).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("panel:admin_roles_save").setLabel("Salvar").setEmoji({ name: "save", id: "1557205052974960780" }).setStyle(ButtonStyle.Success)
      )
    );

  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

function buildRolesPanel(guildId) {
  const container = new ContainerBuilder()
    .setAccentColor(getBotPanelAccentColor())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "## <:user:1557205116849758238> CARGOS\n" +
        "> Central de configuração de cargos da ASTRAL STORE.\n" +
        "> Organize os cargos do servidor de forma rápida e simples.\n" +
        "### <:clipboard:1557204790843412542> Categorias\n" +
        "> Selecione abaixo o tipo de cargo que deseja configurar."
      )
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("panel:roles_category")
          .setPlaceholder("Selecione uma categoria de cargos")
          .setMinValues(1)
          .setMaxValues(1)
          .addOptions(
            {
              label: "Administrativo",
              description: "Configure os cargos administrativos",
              value: "administrative",
              emoji: { name: "config_title_alt", id: "1557204540460240926" }
            },
            {
              label: "Stock Blox Fruits",
              description: "Configure os cargos das notificações de stock",
              value: "stock_blox_fruits",
              emoji: fruitEmojiObject("Dragon")
            }
          )
      )
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("panel:main")
          .setLabel("Voltar")
          .setEmoji({ name: "arrow_left", id: "1557204764834537534" })
          .setStyle(ButtonStyle.Secondary)
      )
    );

  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

function buildBotControlPanel() {
  const botUser = client.user;
  const botSettings = getBotSettings();
  const container = new ContainerBuilder()
    .setAccentColor(getBotPanelAccentColor())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "## <:discord:1557204573817405440> CONTROLE DO BOT\n" +
        "> Gerencie o Astral Stock e personalize a identidade do bot.\n" +
        "### <:online:1557204563675848814> Status\n" +
        "> **Bot:** " + (botUser ? botUser.tag : "Astral BOT") + "\n" +
        "> **ID:** `" + (botUser?.id || "N/A") + "`\n" +
        "### <:settings_button:1557204872648982579> Gerenciamento\n" +
        "> Reinicie, reconstrua os comandos ou personalize o bot."
      )
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("panel:bot_customize_select")
          .setPlaceholder("🖌️ Personalizar")
          .addOptions(
            {
              label: "Alterar Nome",
              description: "Mude o nome do bot",
              value: "nickname",
              emoji: { name: "text_alt", id: "1557205064391589979" }
            },
            {
              label: "Alterar Avatar",
              description: "Mude a foto de perfil do bot",
              value: "avatar",
              emoji: { name: "image_upload", id: "1557204842366115991" }
            },
            {
              label: "Alterar Banner",
              description: "Mude o banner do perfil do bot",
              value: "banner",
              emoji: { name: "image_upload", id: "1557204842366115991" }
            },
            {
              label: "Cor da barra lateral",
              description: "Escolha a cor da barra lateral do painel",
              value: "accentColor",
              emoji: { name: "palette", id: "1557204908250370078" }
            },
            {
              label: "Alterar Status 1",
              description: "Configure o primeiro status rotativo",
              value: "status1",
              emoji: { name: "key_alt", id: "1557204516275879987" }
            },
            {
              label: "Alterar Status 2",
              description: "Configure o segundo status rotativo",
              value: "status2",
              emoji: { name: "key_alt", id: "1557204516275879987" }
            }
          )
      )
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("panel:bot_restart")
          .setLabel("Reiniciar")
          .setEmoji({ name: "refresh_alt", id: "1557205141051019274", animated: true })
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId("panel:bot_rebuild")
          .setLabel("Rebuild")
          .setEmoji({ name: "database", id: "1557204816625934336" })
          .setStyle(ButtonStyle.Primary)
      )
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("panel:main")
          .setLabel("Voltar")
          .setEmoji({ name: "arrow_left", id: "1557204764834537534" })
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId("panel:bot_save")
          .setLabel("Salvar")
          .setEmoji({ name: "save", id: "1557205052974960780" })
          .setStyle(ButtonStyle.Success)
      )
    );

  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

function buildBotCustomizeModal(type, userId) {
  const settings = getBotSettings();
  const pending = pendingBotCustomizations.get(String(userId)) || {};
  const map = {
    nickname: {
      id: "nickname",
      title: "Alterar Nome",
      label: "Nome do bot",
      value: client.user?.username || "",
      placeholder: "Astral Stock",
      max: 32
    },
    avatar: {
      id: "avatar",
      title: "Alterar Avatar",
      label: "URL do avatar",
      value: settings.avatar,
      placeholder: "https://...",
      max: 500
    },
    banner: {
      id: "banner",
      title: "Alterar Banner",
      label: "URL do banner",
      value: settings.banner,
      placeholder: "https://...",
      max: 500
    },
    accentColor: {
      id: "accentColor",
      title: "Cor da barra lateral",
      label: "Cor HEX",
      value: settings.accentColor,
      placeholder: "00FFFF",
      max: 7
    },
    status1: {
      id: "status1",
      title: "Alterar Status 1",
      label: "Primeiro status",
      value: settings.status1,
      placeholder: "Astral Store • Online",
      max: 128
    },
    status2: {
      id: "status2",
      title: "Alterar Status 2",
      label: "Segundo status",
      value: settings.status2,
      placeholder: "Blox Fruits Stock",
      max: 128
    }
  };
  const item = map[type];
  if (!item) return null;

  return new ModalBuilder()
    .setCustomId("panel:bot_customize_modal:" + item.id)
    .setTitle(item.title)
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("value")
          .setLabel(item.label)
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(item.max)
          .setValue((Object.prototype.hasOwnProperty.call(pending, item.id) ? pending[item.id] : item.value).slice(0, item.max))
          .setPlaceholder(item.placeholder)
      )
    );
}

function buildMainPanel(guildId, userId) {
  const home = applicationEmojiTag("home", "🏠");
  const overview = applicationEmojiTag("sparkles", "✨");
  const bell = applicationEmojiTag("bell_alert", "🔔");
  const updated = applicationEmojiTag("alarm", "⏰");
  const manage = applicationEmojiTag("settings_button", "⚙️");

  const container = new ContainerBuilder()
    .setAccentColor(getBotPanelAccentColor())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "## " + home + " ASTRAL STORE\n" +
        "> Olá, " + (userId ? "<@" + userId + ">" : "@USUARIO") + "! Aqui está o resumo da sua loja.\n" +
        "### " + overview + " Visão Geral\n" +
        "> " + bell + " Notificações não lidas: **0**\n" +
        "> " + updated + " Configurações atualizadas <t:" + Math.floor(Date.now() / 1000) + ":R>\n" +
        "### " + manage + " O que deseja gerenciar?\n" +
        "> Selecione uma área no menu abaixo para começar\n" +
        "-# Todas as ações são aplicadas em tempo real"
      )
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("panel:manage")
          .setPlaceholder("🎫 Selecione uma área para gerenciar")
          .addOptions(
            {
              label: "Ticket",
              description: "Edite, personalize e configure seus tickets",
              value: "ticket",
              emoji: { name: "ticket_plus", id: "1557205110847701052" }
            },
            {
              label: "Bot",
              description: "Reinicie, faça rebuild e personalize o bot",
              value: "bot",
              emoji: { name: "discord", id: "1557204573817405440" }
            },
            {
              label: "Cargos",
              description: "Gerencie os cargos do servidor",
              value: "roles",
              emoji: { name: "user", id: "1557205116849758238" }
            }
          )
      )
    )
;

  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

const ticketAppearanceDrafts = new Map();

function normalizeTicketColor(value) {
  const raw = String(value || "").trim().replace(/^#/, "");
  if (!raw) return "00FFFF";
  if (!/^[0-9A-Fa-f]{6}$/.test(raw)) throw new Error("A cor precisa estar no formato HEX, por exemplo **00FFFF**.");
  return raw.toUpperCase();
}

function buildTicketAppearancePanel(guildId, userId) {
  const config = getGuildConfig(guildId);
  const saved = config.ticketAppearance || {};
  const key = String(guildId) + ":" + String(userId);
  const draft = ticketAppearanceDrafts.get(key) || saved;
  const title = draft.title || "ASTRAL SUPORTE";
  const description = draft.description || "Precisa de ajuda? Abra um ticket e nossa equipe entrará em contato.";
  const thumbnail = draft.thumbnail || "Automática (ícone do servidor)";
  const banner = draft.banner || "Automático (banner do servidor)";
  const color = draft.color || "00FFFF";

  const container = new ContainerBuilder()
    .setAccentColor(getBotPanelAccentColor())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "## <:config_title_alt:1557204540460240926> CONFIGURAR APARÊNCIA\n" +
        "> Personalize a mensagem principal do sistema de tickets.\n" +
        "### <:ticket_plus:1557205110847701052> Aparência atual\n" +
        "> **Título:** " + title + "\n" +
        "> **Descrição:** " + description + "\n" +
        "> **Thumbnail:** " + thumbnail + "\n" +
        "> **Banner:** " + banner + "\n" +
        "> **Cor:** #" + color
      )
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("ticket:appearance_edit")
          .setLabel("Editar campos")
          .setEmoji({ name: "compass", id: "1557204910578335844" })
          .setStyle(ButtonStyle.Primary)
      )
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("ticket:appearance_back")
          .setLabel("Voltar")
          .setEmoji({ name: "arrow_left", id: "1557204764834537534" })
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId("ticket:appearance_save")
          .setLabel("Salvar")
          .setEmoji({ name: "settings_button", id: "1557204872648982579" })
          .setStyle(ButtonStyle.Success)
      )
    );

  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

function buildTicketAppearanceModal(guildId, userId) {
  const config = getGuildConfig(guildId);
  const saved = config.ticketAppearance || {};
  const key = String(guildId) + ":" + String(userId);
  const rawDraft = ticketAppearanceDrafts.get(key) || saved;
  const draft = {
    ...rawDraft,
    thumbnail: /^https?:\/\//i.test(String(rawDraft.thumbnail || "")) ? String(rawDraft.thumbnail) : "",
    banner: /^https?:\/\//i.test(String(rawDraft.banner || "")) ? String(rawDraft.banner) : "",
    color: normalizeTicketColor(String(rawDraft.color || "00FFFF"))
  };

  return new ModalBuilder()
    .setCustomId("ticket:appearance_modal")
    .setTitle("Configurar Aparência")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("ticket_appearance_title")
          .setLabel("Título")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(100)
          .setValue(String(draft.title || "ASTRAL SUPORTE"))
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("ticket_appearance_description")
          .setLabel("Descrição")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(1000)
          .setValue(String(draft.description || "Precisa de ajuda? Abra um ticket e nossa equipe entrará em contato."))
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("ticket_appearance_thumbnail")
          .setLabel("Thumbnail (opcional)")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(500)
          .setPlaceholder("https://... (vazio = ícone do servidor)")
          .setValue(String(draft.thumbnail || ""))
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("ticket_appearance_banner")
          .setLabel("Banner (opcional)")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(500)
          .setPlaceholder("https://... (vazio = banner do servidor)")
          .setValue(String(draft.banner || ""))
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("ticket_appearance_color")
          .setLabel("Cor (opcional)")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(7)
          .setPlaceholder("00FFFF ou #00FFFF")
          .setValue(String(draft.color || "00FFFF"))
      )
    );
}

function normalizeTicketFunctionEmoji(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;

  // Aceita tanto o ID puro quanto o formato copiado do Discord:
  // <:nome:123456789012345678> ou <a:nome:123456789012345678>
  const discordMatch = raw.match(/^<(a?):([A-Za-z0-9_]+):(\d{17,20})>$/);
  if (discordMatch) {
    return {
      id: discordMatch[3],
      name: discordMatch[2],
      animated: discordMatch[1] === "a"
    };
  }

  const idMatch = raw.match(/^(\d{17,20})$/);
  if (idMatch) {
    return { id: idMatch[1], name: "ticket_emoji", animated: false };
  }

  throw new Error("Use o ID do emoji ou cole o emoji no formato <:nome:ID>.");
}

async function resolveTicketFunctionEmoji(guild, emojiId) {
  const id = String(emojiId || "").trim();
  if (!/^\d{17,20}$/.test(id)) return null;
  const guildEmoji = guild?.emojis?.cache?.get(id);
  if (guildEmoji) return { id: guildEmoji.id, name: guildEmoji.name || "ticket_emoji", animated: Boolean(guildEmoji.animated) };
  try {
    const application = await client.application.fetch();
    const appEmoji = await application.emojis.fetch(id);
    if (appEmoji) return { id: appEmoji.id, name: appEmoji.name || "ticket_emoji", animated: Boolean(appEmoji.animated) };
  } catch {}
  return null;
}

function buildTicketFunctionModal(existingFunction = null) {
  const editing = Boolean(existingFunction?.id);
  const modal = new ModalBuilder()
    .setCustomId(editing ? "ticket:edit_function_modal:" + existingFunction.id : "ticket:add_function_modal")
    .setTitle(editing ? "Editar Função" : "Adicionar Função");

  const name = new TextInputBuilder().setCustomId("ticket_function_name").setLabel("NOME DA FUNÇÃO").setPlaceholder("Insira aqui um nome, como: Suporte").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(80);
  const preDescription = new TextInputBuilder().setCustomId("ticket_function_pre_description").setLabel("PRÉ DESCRIÇÃO").setPlaceholder('Insira aqui uma pré descrição, ex: "Preciso de ajuda..."').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(200);
  const description = new TextInputBuilder().setCustomId("ticket_function_description").setLabel("DESCRIÇÃO (OPCIONAL)").setPlaceholder("Insira aqui a descrição da função. Aparece dentro do ticket após aberto.").setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1000);
  const banner = new TextInputBuilder().setCustomId("ticket_function_banner").setLabel("BANNER (OPCIONAL)").setPlaceholder("Insira aqui uma URL de uma imagem ou GIF").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(500);
  const emoji = new TextInputBuilder().setCustomId("ticket_function_emoji").setLabel("EMOJI DA FUNÇÃO").setPlaceholder("Insira um ID de um emoji do servidor ou da aplicação").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(20);

  if (editing) {
    name.setValue(String(existingFunction.name || ""));
    preDescription.setValue(String(existingFunction.preDescription || ""));
    if (existingFunction.description) description.setValue(String(existingFunction.description));
    if (existingFunction.banner) banner.setValue(String(existingFunction.banner));
    if (existingFunction.emoji?.id) emoji.setValue(String(existingFunction.emoji.id));
  }

  return modal.addComponents(
    new ActionRowBuilder().addComponents(name),
    new ActionRowBuilder().addComponents(preDescription),
    new ActionRowBuilder().addComponents(description),
    new ActionRowBuilder().addComponents(banner),
    new ActionRowBuilder().addComponents(emoji)
  );
}

function buildTicketManageFunctionsPanel(guildId) {
  const config = getGuildConfig(guildId);
  const functions = Array.isArray(config.ticketFunctions) ? config.ticketFunctions : [];
  const container = new ContainerBuilder()
    .setAccentColor(getBotPanelAccentColor())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "## <:config_title_alt:1557204540460240926> GERENCIAR FUNÇÕES\n" +
        "> Selecione uma função abaixo para gerenciar as funções criadas.\n" +
        "### <:clipboard:1557204790843412542> Funções de atendimento\n" +
        (functions.length ? "> Escolha uma função no seletor abaixo." : "> Nenhuma função criada ainda. Volte e use **Adicionar Função** para criar uma.")
      )
    );
  if (functions.length) {
    container.addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("ticket:manage_function_select")
          .setPlaceholder("🎫 Selecione uma função")
          .addOptions(functions.slice(0, 25).map(fn => ({
            label: String(fn.name || "Atendimento").slice(0, 100),
            description: String(fn.preDescription || "Função de atendimento").slice(0, 100),
            value: String(fn.id),
            ...(fn.emoji?.id ? { emoji: { id: String(fn.emoji.id), name: String(fn.emoji.name || "ticket_emoji"), animated: Boolean(fn.emoji.animated) } } : {})
          })))
      )
    );
  }
  container.addActionRowComponents(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("ticket:manage_functions_back").setLabel("Voltar").setEmoji({ name: "arrow_left", id: "1557204764834537534" }).setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("ticket:reorder_functions").setLabel("Reordenar").setEmoji({ name: "settings_button", id: "1557204872648982579" }).setStyle(ButtonStyle.Primary)
    )
  );
  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

const ticketReorderSelections = new Map();

function buildTicketFunctionReorderPanel(guildId, userId) {
  const config = getGuildConfig(guildId);
  const functions = Array.isArray(config.ticketFunctions) ? config.ticketFunctions : [];
  const selectedId = ticketReorderSelections.get(String(guildId) + ":" + String(userId)) || null;
  const selectedIndex = functions.findIndex(fn => fn.id === selectedId);
  const container = new ContainerBuilder()
    .setAccentColor(getBotPanelAccentColor())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "## <:config_title_alt:1557204540460240926> REORDENAR FUNÇÕES\n" +
        "> Selecione uma função e use os botões para mudar a ordem no painel de tickets.\n\n" +
        (functions.length ? functions.map((fn, i) => "**" + (i + 1) + ".** " + String(fn.name || "Atendimento") + (i === selectedIndex ? " ← **selecionada**" : "")).join("\n") : "> Nenhuma função criada ainda.")
      )
    );
  if (functions.length) {
    container.addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("ticket:reorder_select")
          .setPlaceholder("🎫 Selecione uma função")
          .addOptions(functions.slice(0, 25).map(fn => ({
            label: String(fn.name || "Atendimento").slice(0, 100),
            description: String(fn.preDescription || "Função de atendimento").slice(0, 100),
            value: String(fn.id),
            ...(fn.emoji?.id ? { emoji: { id: String(fn.emoji.id), name: String(fn.emoji.name || "ticket_emoji"), animated: Boolean(fn.emoji.animated) } } : {})
          })))
      )
    );
    container.addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("ticket:reorder_up").setLabel("Subir").setEmoji({ name: "arrow_up", id: "1557204775383212042" }).setStyle(ButtonStyle.Primary).setDisabled(selectedIndex <= 0),
        new ButtonBuilder().setCustomId("ticket:reorder_down").setLabel("Descer").setEmoji({ name: "arrow_down", id: "1557204770178211870" }).setStyle(ButtonStyle.Primary).setDisabled(selectedIndex < 0 || selectedIndex >= functions.length - 1)
      )
    );
  }
  container.addActionRowComponents(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("ticket:reorder_back").setLabel("Voltar").setEmoji({ name: "arrow_left", id: "1557204764834537534" }).setStyle(ButtonStyle.Secondary)
    )
  );
  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

const ticketInterfaceModeDrafts = new Map();

function buildTicketInterfaceModePanel(guildId, userId) {
  const config = getGuildConfig(guildId);
  const mode = ticketInterfaceModeDrafts.get(String(guildId) + ":" + String(userId || "")) || config.ticketInterfaceMode || "v2";
  const isEmbed = mode === "embed";

  const container = new ContainerBuilder()
    .setAccentColor(getBotPanelAccentColor())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "## <:config_title_alt:1557204540460240926> MODO DE INTERFACE\n" +
        "> Alternar entre Embed clássico e Container V2 quando abrir um ticket.\n\n" +
        "### <:clipboard:1557204790843412542> Modo atual: " + (isEmbed ? "Embed Clássico" : "Container V2") + "\n" +
        "> Clique no botão abaixo para alternar para o outro modo."
      )
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("ticket:interface_mode_toggle")
          .setLabel(isEmbed ? "Mudar para Container V2" : "Mudar para Embed Clássico")
          .setEmoji({ name: "clipboard", id: "1557204790843412542" })
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId("ticket:interface_mode_back")
          .setLabel("Voltar")
          .setEmoji({ name: "arrow_left", id: "1557204764834537534" })
          .setStyle(ButtonStyle.Secondary)
      )
    );

  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}
const ticketOpeningModeDrafts = new Map();

function buildTicketOpeningModePanel(guildId, userId) {
  const config = getGuildConfig(guildId);
  const draftKey = String(guildId) + ":" + String(userId || "");
  const mode = ticketOpeningModeDrafts.get(draftKey) || config.ticketOpeningMode || "channel";
  const channelSelected = mode === "channel";
  const threadSelected = mode === "thread";

  const container = new ContainerBuilder()
    .setAccentColor(getBotPanelAccentColor())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "## <:config_title_alt:1557204540460240926> MODO DE ABERTURA\n" +
        "> Escolha como os atendimentos serão criados quando alguém abrir um ticket.\n" +
        "<:ticket_plus:1557205110847701052> **Modo atual**\n" +
        "> " + (channelSelected ? "Canal Privado" : "Thread Privada") + "\n" +
        "-# Clique em SALVAR para aplicar a alteração."
      )
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("ticket:opening_mode")
          .setPlaceholder("Selecione o modo de abertura")
          .addOptions(
            {
              label: "Canal Privado",
              description: channelSelected ? "Modo atual • cria um canal privado" : "Criar cada atendimento em um canal privado",
              value: "channel",
              emoji: { name: "folder", id: "1557204828168397010" }
            },
            {
              label: "Thread Privada",
              description: threadSelected ? "Modo atual • cria uma thread privada" : "Criar cada atendimento em uma thread privada",
              value: "thread",
              emoji: { name: "folder_open", id: "1557204838931107951" }
            }
          )
      )
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("ticket:opening_mode_back")
          .setLabel("Voltar")
          .setEmoji({ name: "arrow_left", id: "1557204764834537534" })
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId("ticket:opening_mode_save")
          .setLabel("Salvar")
          .setEmoji({ name: "settings_button", id: "1557204872648982579" })
          .setStyle(ButtonStyle.Success)
      )
    );

  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}


const TICKET_SCHEDULE_DAYS = [
  { key: "sunday", label: "Domingo" },
  { key: "monday", label: "Segunda-feira" },
  { key: "tuesday", label: "Terça-feira" },
  { key: "wednesday", label: "Quarta-feira" },
  { key: "thursday", label: "Quinta-feira" },
  { key: "friday", label: "Sexta-feira" },
  { key: "saturday", label: "Sábado" }
];

function normalizeTicketSchedule(config) {
  const base = defaultGuildConfig().ticketSchedule;
  const current = config.ticketSchedule || {};
  const days = {};
  for (const day of TICKET_SCHEDULE_DAYS) {
    const saved = current.days?.[day.key] || {};
    days[day.key] = {
      active: Boolean(saved.active),
      start: /^([01]\\d|2[0-3]):[0-5]\\d$/.test(String(saved.start || "")) ? String(saved.start) : base.days[day.key].start,
      end: /^([01]\\d|2[0-3]):[0-5]\\d$/.test(String(saved.end || "")) ? String(saved.end) : base.days[day.key].end
    };
  }
  return { enabled: Boolean(current.enabled), allowOutsideHours: Boolean(current.allowOutsideHours), days };
}

function ticketScheduleSummary(config) {
  const schedule = normalizeTicketSchedule(config);
  const activeCount = TICKET_SCHEDULE_DAYS.filter(day => schedule.days[day.key].active).length;
  return { schedule, activeCount };
}

function buildTicketSchedulePanel(guildId) {
  const config = getGuildConfig(guildId);
  const result = ticketScheduleSummary(config);
  const schedule = result.schedule;
  const activeCount = result.activeCount;
  const statusEmoji = schedule.enabled ? "<:online:1557204563675848814>" : "<:offline:1557204568432185454>";
  const statusText = schedule.enabled ? "Ativado" : "Desativado";
  const outsideEmoji = schedule.allowOutsideHours ? "<:unlock:1557204844245295194>" : "<:lock:1557204840818409482>";
  const outsideText = schedule.allowOutsideHours ? "Permitido" : "Bloqueado";
  const outsideSub = schedule.allowOutsideHours ? "Tickets podem ser abertos a qualquer momento" : "Apenas no horário configurado";
  const dayLines = TICKET_SCHEDULE_DAYS.map(day => {
    const value = schedule.days[day.key];
    if (!value.active) return "<:offline:1557204568432185454> **" + day.label + ":** `" + "Inativo" + "`";
    return "<:online:1557204563675848814> **" + day.label + ":** `" + value.start + " - " + value.end + "`";
  });
  const container = new ContainerBuilder()
    .setAccentColor(getBotPanelAccentColor())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "## <:calendar:1557204788880613437> CONFIGURAR HORÁRIOS DE ATENDIMENTO\n" +
        "> Configure os horários em que sua equipe estará disponível para atendimento via tickets.\n" +
        "### Status do Sistema\n" +
        statusEmoji + " `" + statusText + "`\n" +
        "> " + (schedule.enabled ? "Atendimento segue os horários configurados" : "Atendimento disponível 24 horas") + "\n" +
        "### <:calendar:1557204788880613437> Horários Ativos\n" +
        "> `" + activeCount + "/7 dias`\n" +
        "### <:briefcase:1557205067910742057> Abertura Fora do Horário\n" +
        outsideEmoji + " `" + outsideText + "`\n" +
        "> " + outsideSub + "\n" +
        "### <:calendar:1557204788880613437> Horários Configurados\n" +
        dayLines.join("\n") +
        (schedule.enabled && activeCount === 0 ? "\n\n> Configure pelo menos um dia para ativar o sistema!" : "")      )
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("ticket:schedule_day")
          .setPlaceholder("Selecione um dia da semana para configurar")
          .addOptions(TICKET_SCHEDULE_DAYS.map(day => {
            const value = schedule.days[day.key];
            return { label: day.label, description: value.active ? value.start + " - " + value.end : "Inativo • clique para configurar", value: day.key, emoji: { name: "calendar", id: "1557204788880613437" } };
          }))
      )
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("ticket:schedule_toggle")
          .setLabel(schedule.enabled ? "Desativar Sistema (Ativar 24h)" : "Ativar Sistema de Horários")
          .setEmoji({ name: schedule.enabled ? "offline" : "online", id: schedule.enabled ? "1557204568432185454" : "1557204563675848814" })
          .setStyle(schedule.enabled ? ButtonStyle.Danger : ButtonStyle.Success)
      )
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("ticket:schedule_outside").setLabel(schedule.allowOutsideHours ? "Bloquear Fora do Horário" : "Permitir Fora do Horário").setEmoji(schedule.allowOutsideHours ? { name: "lock", id: "1557204840818409482" } : { name: "unlock", id: "1557204844245295194" }).setStyle(schedule.allowOutsideHours ? ButtonStyle.Danger : ButtonStyle.Success),
        new ButtonBuilder().setCustomId("ticket:schedule_all_on").setLabel("Ativar todos os dias").setEmoji({ name: "check_alt", id: "1557204542960181299" }).setStyle(ButtonStyle.Success)
      )
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("ticket:schedule_all_off").setLabel("Desativar todos os dias").setEmoji({ name: "offline", id: "1557204568432185454" }).setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId("ticket:schedule_back").setLabel("Voltar").setEmoji({ name: "arrow_left", id: "1557204764834537534" }).setStyle(ButtonStyle.Secondary)
      )
    );
  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

function buildTicketScheduleDayModal(guildId, dayKey) {
  const config = getGuildConfig(guildId);
  const schedule = normalizeTicketSchedule(config);
  const day = TICKET_SCHEDULE_DAYS.find(item => item.key === dayKey);
  const current = schedule.days[dayKey] || { active: false, start: "09:00", end: "18:00" };
  if (!day) throw new Error("Dia da semana inválido.");
  const modal = new ModalBuilder().setCustomId("ticket:schedule_day_modal:" + dayKey).setTitle("Configurar " + day.label);
  const status = new TextInputBuilder().setCustomId("schedule_status").setLabel("Status (ativo/inativo)").setStyle(TextInputStyle.Short).setRequired(true).setValue(current.active ? "ativo" : "inativo").setMaxLength(8);
  const start = new TextInputBuilder().setCustomId("schedule_start").setLabel("Horário de início (HH:MM)").setStyle(TextInputStyle.Short).setRequired(true).setValue(current.start).setMaxLength(5);
  const end = new TextInputBuilder().setCustomId("schedule_end").setLabel("Horário de fim (HH:MM)").setStyle(TextInputStyle.Short).setRequired(true).setValue(current.end).setMaxLength(5);
  modal.addComponents(new ActionRowBuilder().addComponents(status), new ActionRowBuilder().addComponents(start), new ActionRowBuilder().addComponents(end));
  return modal;
}

function isTicketScheduleCurrentlyOpen(config) {
  const result = ticketScheduleSummary(config);
  const schedule = result.schedule;
  const activeCount = result.activeCount;
  if (!schedule.enabled || schedule.allowOutsideHours) return { allowed: true };
  if (activeCount === 0) return { allowed: false, reason: "O sistema de horários está ativado, mas nenhum dia foi configurado." };
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: BRASIL_TZ, weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date());
  const weekdayMap = { Sun: "sunday", Mon: "monday", Tue: "tuesday", Wed: "wednesday", Thu: "thursday", Fri: "friday", Sat: "saturday" };
  const weekday = weekdayMap[parts.find(p => p.type === "weekday")?.value];
  const hour = Number(parts.find(p => p.type === "hour")?.value);
  const minute = Number(parts.find(p => p.type === "minute")?.value);
  const day = schedule.days[weekday];
  if (!day?.active) return { allowed: false, reason: "O atendimento está fechado hoje. Tente novamente dentro do horário configurado." };
  const start = day.start.split(":").map(Number);
  const end = day.end.split(":").map(Number);
  const startMinutes = start[0] * 60 + start[1];
  const endMinutes = end[0] * 60 + end[1];
  if (endMinutes <= startMinutes) return { allowed: false, reason: "O horário configurado para hoje é inválido. O fim deve ser depois do início." };
  const currentMinutes = hour * 60 + minute;
  if (currentMinutes < startMinutes || currentMinutes >= endMinutes) return { allowed: false, reason: "O atendimento está fechado neste momento. Tente novamente dentro do horário configurado." };
  return { allowed: true };
}
async function sendTicketOpeningMessage(target, config, selectedFunction, ticketText) {
  const title = String(selectedFunction?.name || "Atendimento");
  const description = String(ticketText || "").replace(/\\n/g, "\n");
  const appearance = config.ticketAppearance || {};
  const rawColor = String(appearance.color || "00FFFF").replace(/^#/, "");
  const color = /^[0-9A-Fa-f]{6}$/.test(rawColor) ? parseInt(rawColor, 16) : 0x00FFFF;

  if ((config.ticketInterfaceMode || "v2") === "embed") {
    const embed = new EmbedBuilder()
      .setColor(color)
      .setTitle(title)
      .setDescription(description);
    if (appearance.thumbnail) embed.setThumbnail(String(appearance.thumbnail));
    await target.send({ embeds: [embed] });
    return;
  }

  const container = new ContainerBuilder()
    .setAccentColor(color)
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent("## " + title + "\n> " + description.replace(/\n/g, "\n> "))
    );

  if (appearance.thumbnail) {
    container.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent("> Atendimento iniciado. Nossa equipe responderá em breve.")
        )
        .setThumbnailAccessory(
          new ThumbnailBuilder().setURL(String(appearance.thumbnail))
        )
    );
  }

  await target.send({
    components: [container],
    flags: MessageFlags.IsComponentsV2
  });
}

async function createAstralTicket(interaction, selectedFunction = null) {
  const guild = interaction.guild;
  if (!guild) throw new Error("Esse atendimento só pode ser aberto dentro de um servidor.");

  const config = getGuildConfig(guild.id);
  const scheduleCheck = isTicketScheduleCurrentlyOpen(config);
  if (!scheduleCheck.allowed) throw new Error(scheduleCheck.reason);
  const mode = config.ticketOpeningMode === "thread" ? "thread" : "channel";
  const username = interaction.user.username.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9-]/g, "").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 20) || "usuario";
  const functionTitle = String(selectedFunction?.name || "Atendimento");
  const functionSlug = functionTitle.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "atendimento";
  const ticketName = functionSlug + "-" + username;

  if (mode === "thread") {
    const parent = interaction.channel;
    if (!parent || !parent.isTextBased() || !parent.threads?.create) {
      throw new Error("O modo Thread Privada precisa ser usado em um canal de texto compatível com threads.");
    }

    const existing = parent.threads.cache.find(thread => thread.name === ticketName && !thread.archived && !thread.locked);
    if (existing) return { mode, target: existing, alreadyOpen: true };

    const thread = await parent.threads.create({
      name: ticketName,
      type: 12,
      invitable: false,
      autoArchiveDuration: 1440,
      reason: "Astral Support Ticket"
    });

    await thread.members.add(interaction.user.id);

    const ticketText = selectedFunction?.description
      ? selectedFunction.description
      : "Olá, <@" + interaction.user.id + ">! Seu atendimento foi aberto.\\n\\nExplique sua dúvida e aguarde nossa equipe.\\n\\n-# Um membro da equipe responderá o mais rápido possível.";

    await sendTicketOpeningMessage(thread, config, selectedFunction, ticketText);

    if (selectedFunction?.banner) await thread.send({ content: selectedFunction.banner });

    return { mode, target: thread, alreadyOpen: false };
  }

  const existing = guild.channels.cache.find(ch => ch.type === 0 && ch.topic === "astral-ticket:" + interaction.user.id);
  if (existing) return { mode, target: existing, alreadyOpen: true };

  const channel = await guild.channels.create({
    name: ticketName,
    type: 0,
    topic: "astral-ticket:" + interaction.user.id,
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: ["ViewChannel"] },
      { id: interaction.user.id, allow: ["ViewChannel", "SendMessages", "ReadMessageHistory"] },
      { id: client.user.id, allow: ["ViewChannel", "SendMessages", "ReadMessageHistory", "ManageChannels"] }
    ]
  });

  const ticketText = selectedFunction?.description
    ? selectedFunction.description
    : "Olá, <@" + interaction.user.id + ">! Seu atendimento foi aberto.\\n\\nExplique sua dúvida e aguarde nossa equipe.\\n\\n-# Um membro da equipe responderá o mais rápido possível.";

  await sendTicketOpeningMessage(channel, config, selectedFunction, ticketText);

  if (selectedFunction?.banner) await channel.send({ content: selectedFunction.banner });

  return { mode, target: channel, alreadyOpen: false };
}

function buildTicketConfigPanel(guildId) {
  const ticketEmoji = { name: "ticket_plus", id: "1557205110847701052" };

  const container = new ContainerBuilder()
    .setAccentColor(getBotPanelAccentColor())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "## <:config_title_alt:1557204540460240926> CONFIGURAÇÕES DO TICKET\n" +
        "> Aqui você poderá personalizar o sistema de tickets da sua loja.\n" +
        "### <:settings_button:1557204872648982579> O que deseja configurar?\n" +
        "> Selecione uma função no menu abaixo para começar.\n" +
        "-# As alterações serão aplicadas ao sistema de tickets."
      )
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("ticket:config")
          .setPlaceholder("🎫 Selecione uma função")
          .addOptions(
            {
              label: "Configurar Aparência",
              description: "Título, descrição, cor e banner da mensagem",
              value: "appearance",
              emoji: { name: "palette", id: "1557204908250370078" }
            },
            {
              label: "Adicionar Função",
              description: "Criar uma nova função de atendimento",
              value: "add_function",
              emoji: { name: "clipboard_add", id: "1557204794152591370" }
            },
            {
              label: "Gerenciar Funções",
              description: "Editar ou remover funções existentes (" + ((getGuildConfig(guildId).ticketFunctions || []).length) + "x)",
              value: "manage_functions",
              emoji: { name: "clipboard", id: "1557204790843412542" }
            },
            {
              label: "Modo de Abertura",
              description: "Atual: " + ((getGuildConfig(guildId).ticketOpeningMode || "channel") === "thread" ? "Thread Privada" : "Canal Privado"),
              value: "opening_mode",
              emoji: { name: "mobile", id: "1557204779174989955" }
            },
            {
              label: "Configurar Horários",
              description: "Horários de atendimento (0/7 dias)",
              value: "schedule",
              emoji: { name: "alarm", id: "1557204797537521694" }
            },
            {
              label: "Estatísticas",
              description: "Estatísticas de tickets, staffs e desempenho",
              value: "statistics",
              emoji: { name: "sparkles", id: "1557205056665944104" }
            },
            {
              label: "Blacklist",
              description: "Impedir usuários de abrir tickets (temporário ou permanente)",
              value: "blacklist",
              emoji: { name: "prohibited", id: "1557204569975562370" }
            },
            {
              label: "Modo de Interface",
              description: "Modo atual: " + (((getGuildConfig(guildId).ticketInterfaceMode || "v2") === "embed") ? "Embed" : "Container V2"),
              value: "interface_mode",
              emoji: { name: "briefcase", id: "1557205067910742057" }
            },
            {
              label: "Feedback",
              description: "Avaliação de atendimento ao fechar o ticket (Ativado)",
              value: "feedback",
              emoji: { name: "like", id: "1557204899064848524" }
            }
          )
      )
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("ticket:sync_message")
          .setLabel("Sincronizar")
          .setEmoji({ name: "settings_alt", id: "1557204510651322388" })
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId("ticket:post_message")
          .setLabel("Postar")
          .setEmoji({ name: "check_alt", id: "1557204542960181299" })
          .setStyle(ButtonStyle.Success)
      )
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("panel:main")
          .setLabel("Voltar")
          .setEmoji({ name: "arrow_left", id: "1557204764834537534" })
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId("ticket:preview")
          .setLabel("Prévia")
          .setEmoji({ name: "eye", id: "1557204822569259091" })
          .setStyle(ButtonStyle.Secondary)
      )
    );

  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

function buildSupportPreviewPanel(guild) {
  const supportPanel = buildSupportPanel(guild);
  const container = supportPanel.components[0];

  container.addActionRowComponents(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("ticket:preview_back")
        .setLabel("Voltar")
        .setEmoji({ name: "arrow_left", id: "1557204764834537534" })
        .setStyle(ButtonStyle.Secondary)
    )
  );

  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

function buildSupportPanel(guild) {
  const guildConfig = getGuildConfig(guild?.id);
  const appearance = guildConfig.ticketAppearance || {};
  const bannerUrl = appearance.banner || guild?.bannerURL({ extension: "png", size: 1024 }) || null;
  const thumbnailUrl = appearance.thumbnail || guild?.iconURL({ extension: "png", size: 256 }) || client.user?.displayAvatarURL({ extension: "png", size: 256 });

  const container = new ContainerBuilder()
    .setAccentColor(getBotPanelAccentColor())
    .addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            "## <:config_title_alt:1557204540460240926> " + (appearance.title || "ASTRAL SUPORTE") + "\n" +
            "> " + (appearance.description || "Precisa de ajuda? Abra um ticket e nossa equipe entrará em contato.")
          )
        )
        .setThumbnailAccessory(
          new ThumbnailBuilder().setURL(thumbnailUrl)
        )
    )
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "<:arrow_down:1557204770178211870> **Escolha o atendimento abaixo**"
      ),
      new TextDisplayBuilder().setContent(
        "> Clique no seletor abaixo para escolher o atendimento\n" +
        "-# Responderemos o mais rápido possível"
      )
    );

  if (bannerUrl) {
    container.addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(
        new MediaGalleryItemBuilder().setURL(bannerUrl)
      )
    );
  }

  container.addActionRowComponents(
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("ticket:select")
        .setPlaceholder("🎫 Selecione uma opção de atendimento")
        .addOptions(
          ...(Array.isArray(guildConfig.ticketFunctions) && guildConfig.ticketFunctions.length
            ? guildConfig.ticketFunctions.slice(0, 25).map(fn => ({
                label: String(fn.name || "Atendimento").slice(0, 100),
                description: String(fn.preDescription || "Abra um ticket com a equipe").slice(0, 100),
                value: String(fn.id || "open").slice(0, 100),
                ...(fn.emoji?.id ? { emoji: { id: String(fn.emoji.id), name: String(fn.emoji.name || "ticket_emoji"), animated: Boolean(fn.emoji.animated) } } : {})
              }))
            : [{
                label: "Abrir atendimento",
                description: "Abra um ticket com a equipe",
                value: "open",
                emoji: "🎫"
              }])
        )
    )
  );

  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

function buildConfigPanel(guildId) {
  const config = getGuildConfig(guildId);
  const stockChannel = config.channelId ? "<#" + config.channelId + ">" : "Não configurado";
  const alertChannel = config.stockAlertChannelId ? "<#" + config.stockAlertChannelId + ">" : "Não configurado";
  const container = new ContainerBuilder()
    .setAccentColor(getBotPanelAccentColor())
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
        new ButtonBuilder().setCustomId("panel:servers").setLabel("Servidores autorizados").setEmoji({ name: "60581", id: "1557204878001176586" }).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("panel:fruit_roles").setLabel("Cargos das frutas").setEmoji(fruitEmojiObject("Dragon")).setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("panel:main").setLabel("Voltar").setEmoji({ name: "60578", id: "1557204872648982579" }).setStyle(ButtonStyle.Secondary)
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
      new ButtonBuilder().setCustomId("admin_fruit_remove:" + fruitKey(selectedFruit)).setLabel("Remover cargo").setEmoji(uiEmoji("trash", "🗑️")).setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("panel:main").setLabel("Voltar ao painel").setEmoji(uiEmoji("arrow", "➡️")).setStyle(ButtonStyle.Secondary)
    ));
  } else {
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("panel:main").setLabel("Voltar ao painel").setEmoji(uiEmoji("arrow", "➡️")).setStyle(ButtonStyle.Secondary)
    ));
  }
  const container = new ContainerBuilder()
    .setAccentColor(getBotPanelAccentColor())
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
    .setAccentColor(getBotPanelAccentColor())
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(
        "# <:60581:1557204878001176586> SERVIDORES AUTORIZADOS\n\n" +
        (lines.join("\n") || "Nenhum servidor autorizado.") + "\n\n" +
        "-# Somente o dono da aplicação pode alterar esta lista."
      )
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("server:add").setLabel("Adicionar").setEmoji(uiEmoji("success", "✅")).setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("server:remove").setLabel("Remover").setEmoji(uiEmoji("trash", "🗑️")).setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId("panel:main").setLabel("Voltar").setEmoji(uiEmoji("arrow", "➡️")).setStyle(ButtonStyle.Secondary)
      )
    );
  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

const stockTypeOption = (option) => option.setName("stock_type").setDescription("Choose which stock to analyze").setRequired(true)
  .addChoices({ name: "Normal Stock", value: "normal" }, { name: "Mirage Stock", value: "mirage" });

const robloxAvatarCache = new Map();
const ROBLOX_AVATAR_CACHE_MS = 2 * 60 * 1000;

async function getRobloxAvatar(username) {
  const cleanUsername = String(username || "").trim();
  if (!cleanUsername) throw new Error("Informe um nome de usuário do Roblox.");

  const cacheKey = cleanUsername.toLowerCase();
  const cached = robloxAvatarCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  const userResponse = await fetch("https://users.roblox.com/v1/usernames/users", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({
      usernames: [cleanUsername],
      excludeBannedUsers: false
    }),
    signal: AbortSignal.timeout(5000)
  });

  if (!userResponse.ok) throw new Error("Não consegui consultar o usuário do Roblox.");
  const userData = await userResponse.json();
  const user = userData.data?.[0];
  if (!user?.id) throw new Error("Usuário do Roblox não encontrado.");

  const jsonFetch = async (url, fallback) => {
    try {
      const response = await fetch(url, {
        headers: { "Accept": "application/json" },
        signal: AbortSignal.timeout(5000)
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
    "&size=420x420&format=Png&isCircular=false";

  const [avatarData, details, friends, followers, following] = await Promise.all([
    jsonFetch(avatarUrl, { data: [] }),
    jsonFetch("https://users.roblox.com/v1/users/" + user.id, {}),
    jsonFetch("https://friends.roblox.com/v1/users/" + user.id + "/friends/count", {}),
    jsonFetch("https://friends.roblox.com/v1/users/" + user.id + "/followers/count", {}),
    jsonFetch("https://friends.roblox.com/v1/users/" + user.id + "/followings/count", {})
  ]);

  const imageUrl = avatarData.data?.[0]?.imageUrl;
  if (!imageUrl) throw new Error("O Roblox não retornou a imagem desse avatar.");

  // Roblox não fornece um total direto de jogos favoritos.
  // Limitamos a busca para evitar várias consultas sequenciais.
  let favoriteGames = 0;
  let cursor = null;
  let favoritesComplete = true;

  for (let page = 0; page < 4; page++) {
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
    if (page === 3) favoritesComplete = false;
  }

  const result = {
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

  robloxAvatarCache.set(cacheKey, {
    data: result,
    expiresAt: Date.now() + ROBLOX_AVATAR_CACHE_MS
  });

  return result;
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
  new SlashCommandBuilder().setName("suporte").setDescription("Abrir o painel de suporte e tickets")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

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
  // Se a instância anterior estava reiniciando/rebuildando, confirma agora
  // que a nova instância realmente voltou online.
  await completePendingRestartConfirmation();
  initializeGuildWhitelist();
  try {
    await syncApplicationEmojis();
  } catch (error) {
    console.warn("[EMOJIS] Sincronização das emojis falhou:", error.message);
  }
  await seedDefaultTicketFunctions();
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
  startBotStatusRotation();
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
          content: uiEmoji("error", "<:offline:1557204568432185454>") + " Ainda não tenho um stock salvo para mostrar.",
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
      content: uiEmoji("error", "<:offline:1557204568432185454>") + (error.message || "Não consegui falar com a IA agora."),
      allowedMentions: { repliedUser: false }
    });
  }
});

client.on("interactionCreate", async interaction => {
  if (interaction.isStringSelectMenu() && interaction.customId === "ticket:select") {
    await interaction.reply({ content: "<a:refresh_alt:1557205141051019274> Carregando", ephemeral: true });
    try {
      const guild = interaction.guild;
      if (!guild) throw new Error("Esse atendimento só pode ser aberto dentro de um servidor.");

      const selectedValue = interaction.values[0];
      const ticketFunctions = getGuildConfig(guild.id).ticketFunctions || [];
      const selectedFunction = ticketFunctions.find(fn => fn.id === selectedValue);
      if (selectedValue !== "open" && !selectedFunction) {
        throw new Error("Essa função de atendimento não está mais disponível. Atualize o painel de tickets.");
      }
      const result = await createAstralTicket(interaction, selectedFunction);
      const target = result.target;

      // Rebuild the original support panel so the selector returns to its placeholder.
      // This also keeps the same panel message instead of sending a second panel.
      try {
        if (interaction.message?.editable) {
          await interaction.message.edit(buildSupportPanel(guild));
        }
      } catch (panelError) {
        console.warn("[TICKET] Não consegui resetar o seletor do painel:", panelError?.message || panelError);
      }

      await interaction.editReply({
        content: result.alreadyOpen
          ? "<:online:1557204563675848814> | Você já tem um atendimento aberto: <#" + target.id + ">"
          : "<:online:1557204563675848814> | Ticket criado com sucesso! <#" + target.id + ">"
      });
    } catch (error) {
      console.error("[TICKET] Erro ao abrir atendimento:", error);
      await interaction.editReply({ content: "<:offline:1557204568432185454> Não consegui abrir o atendimento. Verifique se o bot tem **Gerenciar Canais**." }).catch(() => {});
    }
    return;
  }

  if (interaction.isStringSelectMenu() && interaction.customId === "panel:manage" && interaction.values[0] === "ticket") {
    try {
      const guild = interaction.guild;
      if (!guild) {
        await interaction.reply({ content: "<:offline:1557204568432185454> Esse painel só pode ser usado dentro de um servidor.", ephemeral: true });
        return;
      }
      await interaction.update(buildTicketConfigPanel(guild.id));
    } catch (error) {
      console.error("[PANEL] Erro ao abrir configurações do ticket:", error);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: "<:offline:1557204568432185454> Não consegui abrir as configurações do ticket.", ephemeral: true }).catch(() => {});
      }
    }
    return;
  }

  if (interaction.isStringSelectMenu() && interaction.customId === "panel:manage" && interaction.values[0] === "bot") {
    if (!(await isBotOwner(interaction.user.id))) {
      await interaction.reply({ content: "<:offline:1557204568432185454> Apenas o dono da aplicação pode acessar o controle do bot.", ephemeral: true });
      return;
    }
    await interaction.update(buildBotControlPanel());
    return;
  }

  if (interaction.isStringSelectMenu() && interaction.customId === "panel:manage" && interaction.values[0] === "roles") {
    await interaction.update(buildRolesPanel(interaction.guildId));
    return;
  }

  if (interaction.isStringSelectMenu() && interaction.customId === "panel:roles_category") {
    const selected = interaction.values[0];

    if (selected === "stock_blox_fruits") {
      await interaction.update(buildFruitAdminPanel(interaction.guildId));
      return;
    }

    if (selected === "administrative") {
      await interaction.update(buildAdministrativeRolesPanel(interaction.guildId));
      return;
    }
  }

  if (interaction.isStringSelectMenu() && interaction.customId === "panel:admin_role_type") {
    const selected = interaction.values[0];
    const labels = {
      administrator: "Administrador",
      moderator: "Moderador",
      staff: "Staff",
      client: "Cliente",
      member: "Membro"
    };

    await interaction.deferUpdate();
    await interaction.editReply({
      components: [
        new ContainerBuilder()
          .setAccentColor(getBotPanelAccentColor())
          .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              "## " + ({
                administrator: "<:config_title_alt:1557204540460240926>",
                moderator: "<:shield_alt:1557205099665956875>",
                staff: "<:control_center:1557204878001176586>",
                client: "<:money_symbol_alt:1557204522009370634>",
                member: "<:user:1557205116849758238>"
              })[selected] + " CONFIGURAR " + labels[selected].toUpperCase() + "\n" +
              "> Selecione o cargo do servidor que será usado como **" + labels[selected] + "**."
            )
          )
          .addActionRowComponents(
            new ActionRowBuilder().addComponents(
              new RoleSelectMenuBuilder()
                .setCustomId("panel:admin_role:" + selected)
                .setPlaceholder("Selecione o cargo " + labels[selected].toLowerCase())
                .setMinValues(1)
                .setMaxValues(1)
            )
          )
          .addActionRowComponents(
            new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId("panel:admin_roles_back").setLabel("Voltar").setEmoji({ name: "arrow_left", id: "1557204764834537534" }).setStyle(ButtonStyle.Secondary)
            )
          )
      ],
      flags: MessageFlags.IsComponentsV2
    });
    return;
  }

  if (interaction.isRoleSelectMenu() && interaction.customId.startsWith("panel:admin_role:")) {
    const roleType = interaction.customId.split(":")[2];
    const roleId = interaction.values[0];
    const key = String(interaction.guildId);
    const current = { ...(pendingAdminRoles.get(key) || getGuildConfig(interaction.guildId).adminRoles || {}) };
    current[roleType] = roleId;
    pendingAdminRoles.set(key, current);

    await interaction.deferUpdate();
    await interaction.editReply(buildAdministrativeRolesPanel(interaction.guildId));
    return;
  }

  if (interaction.isButton() && interaction.customId === "panel:admin_roles_save") {
    await interaction.deferUpdate();

    const key = String(interaction.guildId);
    const draft = pendingAdminRoles.get(key);

    if (!draft || !Object.keys(draft).length) {
      await interaction.followUp({
        content: "<:offline:1557204568432185454> Selecione pelo menos um cargo antes de salvar.",
        ephemeral: true
      }).catch(() => {});
      await interaction.editReply(buildAdministrativeRolesPanel(interaction.guildId));
      return;
    }

    updateGuildConfig(interaction.guildId, config => {
      config.adminRoles = { ...(config.adminRoles || {}), ...draft };
    });
    pendingAdminRoles.delete(key);

    await interaction.editReply(buildAdministrativeRolesPanel(interaction.guildId));
    await interaction.followUp({
      content: "<:online:1557204563675848814> Cargos administrativos salvos com sucesso.",
      ephemeral: true
    }).catch(() => {});
    return;
  }

  if (interaction.isButton() && interaction.customId === "panel:roles") {
    await interaction.deferUpdate();
    await interaction.editReply(buildRolesPanel(interaction.guildId));
    return;
  }

  if (interaction.isButton() && interaction.customId === "panel:admin_roles_back") {
    await interaction.deferUpdate();
    await interaction.editReply(buildAdministrativeRolesPanel(interaction.guildId));
    return;
  }

  if (interaction.isButton() && interaction.customId === "panel:main_roles") {
    await interaction.deferUpdate();
    await interaction.editReply(buildRolesPanel(interaction.guildId));
    return;
  }

  if (interaction.isStringSelectMenu() && interaction.customId === "ticket:config") {
    const selected = interaction.values[0];
    if (selected === "appearance") {
      await interaction.update(buildTicketAppearancePanel(interaction.guildId, interaction.user.id));
      return;
    }

    if (selected === "add_function") {
      try {
        await interaction.showModal(buildTicketFunctionModal());
      } catch (error) {
        console.error("[TICKET] Erro ao abrir adicionar função:", error);
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: "<:offline:1557204568432185454> Não consegui abrir o formulário de adicionar função.", ephemeral: true }).catch(() => {});
        }
      }
      return;
    }

    if (selected === "manage_functions") {
      await interaction.update(buildTicketManageFunctionsPanel(interaction.guildId));
      return;
    }

    if (selected === "opening_mode") {
      await interaction.update(buildTicketOpeningModePanel(interaction.guildId, interaction.user.id));
      return;
    }

    if (selected === "schedule") {
      await interaction.update(buildTicketSchedulePanel(interaction.guildId));
      return;
    }

    if (selected === "interface_mode") {
      const currentMode = getGuildConfig(interaction.guildId).ticketInterfaceMode || "v2";
      const nextMode = currentMode === "embed" ? "v2" : "embed";
      updateGuildConfig(interaction.guildId, config => {
        config.ticketInterfaceMode = nextMode;
      });

      await interaction.update(buildTicketConfigPanel(interaction.guildId));

      const modeName = nextMode === "embed" ? "Embed Clássico" : "Container V2";
      await interaction.followUp({
        content: "<:online:1557204563675848814> Modo de interface alterado para **" + modeName + "**.",
        ephemeral: true
      }).catch(() => {});
      return;
    }

    const configLabels = {
      schedule: "Configurar Horários",
      statistics: "Estatísticas",
      blacklist: "Blacklist",
      interface_mode: "Modo de Interface",
      feedback: "Feedback"
    };
    await interaction.reply({
      content: "<:ticket_plus:1557205110847701052> **" + (configLabels[selected] || "Configuração") + "** selecionada. Esta área ficará responsável por essa configuração do sistema de tickets.",
      ephemeral: true
    });
    return;
  }

  if (interaction.isStringSelectMenu() && interaction.customId === "ticket:interface_mode") {
    const mode = interaction.values[0];
    if (!["v2", "embed"].includes(mode)) {
      await interaction.reply({ content: "<:offline:1557204568432185454> Modo de interface inválido.", ephemeral: true });
      return;
    }
    ticketInterfaceModeDrafts.set(String(interaction.guildId) + ":" + String(interaction.user.id), mode);
    await interaction.update(buildTicketInterfaceModePanel(interaction.guildId, interaction.user.id));
    return;
  }

  if (interaction.isButton() && interaction.customId === "ticket:interface_mode_toggle") {
    const key = String(interaction.guildId) + ":" + String(interaction.user.id);
    const current = ticketInterfaceModeDrafts.get(key) || getGuildConfig(interaction.guildId).ticketInterfaceMode || "v2";
    const nextMode = current === "embed" ? "v2" : "embed";
    updateGuildConfig(interaction.guildId, config => {
      config.ticketInterfaceMode = nextMode;
    });
    ticketInterfaceModeDrafts.delete(key);
    await interaction.update(buildTicketInterfaceModePanel(interaction.guildId, interaction.user.id));
    return;
  }

  if (interaction.isButton() && interaction.customId === "ticket:interface_mode_back") {
    ticketInterfaceModeDrafts.delete(String(interaction.guildId) + ":" + String(interaction.user.id));
    await interaction.update(buildTicketConfigPanel(interaction.guildId));
    return;
  }

  if (interaction.isStringSelectMenu() && interaction.customId === "ticket:schedule_day") {
    try {
      const dayKey = interaction.values[0];
      if (!TICKET_SCHEDULE_DAYS.some(day => day.key === dayKey)) throw new Error("Dia da semana inválido.");
      await interaction.showModal(buildTicketScheduleDayModal(interaction.guildId, dayKey));
    } catch (error) {
      console.error("[TICKET SCHEDULE] Erro ao abrir configuração do dia:", error);
      if (!interaction.replied && !interaction.deferred) await interaction.reply({ content: "<:offline:1557204568432185454> Não consegui abrir a configuração deste dia.", ephemeral: true }).catch(() => {});
    }
    return;
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith("ticket:schedule_day_modal:")) {
    try {
      const dayKey = interaction.customId.split(":").pop();
      const day = TICKET_SCHEDULE_DAYS.find(item => item.key === dayKey);
      if (!day) throw new Error("Dia da semana inválido.");
      const status = interaction.fields.getTextInputValue("schedule_status").trim().toLowerCase();
      const start = interaction.fields.getTextInputValue("schedule_start").trim();
      const end = interaction.fields.getTextInputValue("schedule_end").trim();
      if (!["ativo", "inativo"].includes(status)) throw new Error("O status precisa ser **ativo** ou **inativo**.");
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(end)) throw new Error("Os horários precisam estar no formato **HH:MM**, por exemplo **09:00**.");
      const startParts = start.split(":").map(Number);
      const endParts = end.split(":").map(Number);
      if ((endParts[0] * 60 + endParts[1]) <= (startParts[0] * 60 + startParts[1])) throw new Error("O horário de fim precisa ser depois do horário de início.");
      updateGuildConfig(interaction.guildId, config => {
        config.ticketSchedule = normalizeTicketSchedule(config);
        config.ticketSchedule.days[dayKey] = { active: status === "ativo", start, end };
      });
      await interaction.reply({ content: "<:online:1557204563675848814> **Salvo**", ephemeral: true });
    } catch (error) {
      console.error("[TICKET SCHEDULE] Erro ao salvar dia:", error);
      await interaction.reply({ content: "<:offline:1557204568432185454> " + (error.message || "Não consegui salvar este horário."), ephemeral: true }).catch(() => {});
    }
    return;
  }

  if (interaction.isButton() && interaction.customId === "ticket:schedule_toggle") {
    try {
      updateGuildConfig(interaction.guildId, config => {
        config.ticketSchedule = normalizeTicketSchedule(config);
        config.ticketSchedule.enabled = !config.ticketSchedule.enabled;
      });
      await interaction.update(buildTicketSchedulePanel(interaction.guildId));
    } catch (error) {
      console.error("[TICKET SCHEDULE] Erro ao alternar sistema:", error);
      await interaction.reply({ content: "<:offline:1557204568432185454> Não consegui alterar o status do sistema.", ephemeral: true }).catch(() => {});
    }
    return;
  }

  if (interaction.isButton() && interaction.customId === "ticket:schedule_outside") {
    try {
      updateGuildConfig(interaction.guildId, config => {
        config.ticketSchedule = normalizeTicketSchedule(config);
        config.ticketSchedule.allowOutsideHours = !config.ticketSchedule.allowOutsideHours;
      });
      await interaction.update(buildTicketSchedulePanel(interaction.guildId));
    } catch (error) {
      console.error("[TICKET SCHEDULE] Erro ao alternar abertura fora do horário:", error);
      await interaction.reply({ content: "<:offline:1557204568432185454> Não consegui alterar essa opção.", ephemeral: true }).catch(() => {});
    }
    return;
  }

  if (interaction.isButton() && interaction.customId === "ticket:schedule_all_on") {
    try {
      updateGuildConfig(interaction.guildId, config => {
        config.ticketSchedule = normalizeTicketSchedule(config);
        for (const day of TICKET_SCHEDULE_DAYS) config.ticketSchedule.days[day.key].active = true;
      });
      await interaction.update(buildTicketSchedulePanel(interaction.guildId));
    } catch (error) {
      console.error("[TICKET SCHEDULE] Erro ao ativar todos os dias:", error);
      await interaction.reply({ content: "<:offline:1557204568432185454> Não consegui ativar todos os dias.", ephemeral: true }).catch(() => {});
    }
    return;
  }

  if (interaction.isButton() && interaction.customId === "ticket:schedule_all_off") {
    try {
      updateGuildConfig(interaction.guildId, config => {
        config.ticketSchedule = normalizeTicketSchedule(config);
        for (const day of TICKET_SCHEDULE_DAYS) config.ticketSchedule.days[day.key].active = false;
      });
      await interaction.update(buildTicketSchedulePanel(interaction.guildId));
    } catch (error) {
      console.error("[TICKET SCHEDULE] Erro ao desativar todos os dias:", error);
      await interaction.reply({ content: "<:offline:1557204568432185454> Não consegui desativar todos os dias.", ephemeral: true }).catch(() => {});
    }
    return;
  }

  if (interaction.isButton() && interaction.customId === "ticket:schedule_back") {
    await interaction.update(buildTicketConfigPanel(interaction.guildId));
    return;
  }

  if (interaction.isButton() && interaction.customId === "ticket:opening_mode_back") {
    ticketOpeningModeDrafts.delete(String(interaction.guildId) + ":" + String(interaction.user.id));
    await interaction.update(buildTicketConfigPanel(interaction.guildId));
    return;
  }

  if (interaction.isStringSelectMenu() && interaction.customId === "ticket:opening_mode") {
    try {
      const mode = interaction.values[0] === "thread" ? "thread" : "channel";
      ticketOpeningModeDrafts.set(String(interaction.guildId) + ":" + String(interaction.user.id), mode);
      await interaction.update(buildTicketOpeningModePanel(interaction.guildId, interaction.user.id));
    } catch (error) {
      console.error("[TICKET] Erro ao alterar modo de abertura:", error);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: "<:60698:1557204568432185454> Não consegui atualizar o modo de abertura.", ephemeral: true }).catch(() => {});
      }
    }
    return;
  }

  if (interaction.isButton() && interaction.customId === "ticket:opening_mode_save") {
    try {
      const key = String(interaction.guildId) + ":" + String(interaction.user.id);
      const current = getGuildConfig(interaction.guildId).ticketOpeningMode || "channel";
      const mode = ticketOpeningModeDrafts.get(key) || current;
      updateGuildConfig(interaction.guildId, config => {
        config.ticketOpeningMode = mode;
      });
      ticketOpeningModeDrafts.delete(key);
      await interaction.reply({
        content: "<:online:1557204563675848814> **Salvo**",
        ephemeral: true
      });
    } catch (error) {
      console.error("[TICKET] Erro ao salvar modo de abertura:", error);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: "<:60698:1557204568432185454> Não consegui salvar o modo de abertura.", ephemeral: true }).catch(() => {});
      }
    }
    return;
  }

  if (interaction.isModalSubmit() && interaction.customId === "ticket:add_function_modal") {
    try {
      const guild = interaction.guild;
      if (!guild) {
        await interaction.reply({ content: "<:offline:1557204568432185454> Essa configuração só pode ser usada dentro de um servidor.", ephemeral: true });
        return;
      }

      const name = interaction.fields.getTextInputValue("ticket_function_name").trim();
      const preDescription = interaction.fields.getTextInputValue("ticket_function_pre_description").trim();
      const description = interaction.fields.getTextInputValue("ticket_function_description").trim();
      const banner = interaction.fields.getTextInputValue("ticket_function_banner").trim();
      const emojiInput = interaction.fields.getTextInputValue("ticket_function_emoji").trim();

      if (!name || !preDescription) {
        await interaction.reply({ content: "<:offline:1557204568432185454> Nome da função e pré descrição são obrigatórios.", ephemeral: true });
        return;
      }
      if (banner && !/^https?:\/\//i.test(banner)) {
        await interaction.reply({ content: "<:offline:1557204568432185454> O banner precisa ser uma URL começando com http:// ou https://.", ephemeral: true });
        return;
      }

      let emoji = null;
      if (emojiInput) {
        const parsed = normalizeTicketFunctionEmoji(emojiInput);
        emoji = await resolveTicketFunctionEmoji(guild, parsed.id);
        if (!emoji) {
          await interaction.reply({ content: "<:offline:1557204568432185454> Não encontrei esse emoji no servidor nem nos emojis da aplicação.", ephemeral: true });
          return;
        }
      }

      updateGuildConfig(guild.id, config => {
        config.ticketFunctions = Array.isArray(config.ticketFunctions) ? config.ticketFunctions : [];
        if (config.ticketFunctions.length >= 25) throw new Error("Você já atingiu o limite de 25 funções de atendimento.");
        config.ticketFunctions.push({
          id: "ticket_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8),
          name,
          preDescription,
          description: description || null,
          banner: banner || null,
          emoji
        });
      });

      await interaction.reply({
        ...buildTicketConfigPanel(guild.id),
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral
      });
    } catch (error) {
      console.error("[TICKET] Erro ao salvar função:", error);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: "<:offline:1557204568432185454> " + (error.message || "Não consegui salvar a função."), ephemeral: true }).catch(() => {});
      }
    }
    return;
  }

  if (interaction.isButton() && ["ticket:sync_message", "ticket:post_message", "ticket:preview", "ticket:preview_back"].includes(interaction.customId)) {
    try {
      const guild = interaction.guild;
      if (!guild) {
        await interaction.reply({ content: "<:offline:1557204568432185454> Essa configuração só pode ser usada dentro de um servidor.", ephemeral: true });
        return;
      }

      if (interaction.customId === "ticket:preview") {
        await interaction.reply({
          ...buildSupportPreviewPanel(guild),
          flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral
        });
        return;
      }

      if (interaction.customId === "ticket:preview_back") {
        await interaction.update(buildTicketConfigPanel(guild.id));
        return;
      }

      if (interaction.customId === "ticket:post_message") {
        if (!interaction.channel || !interaction.channel.isTextBased()) {
          await interaction.reply({ content: "<:offline:1557204568432185454> Este canal não pode receber a mensagem de suporte.", ephemeral: true });
          return;
        }

        const sent = await interaction.channel.send(buildSupportPanel(guild));
        updateGuildConfig(guild.id, config => {
          config.supportMessageChannelId = interaction.channel.id;
          config.supportMessageId = sent.id;
        });

        await interaction.reply({
          content: "<:online:1557204563675848814> **Mensagem postada**",
          ephemeral: true
        });
        return;
      }

      if (interaction.customId === "ticket:sync_message") {
        const config = getGuildConfig(guild.id);
        if (!config.supportMessageChannelId || !config.supportMessageId) {
          await interaction.reply({
            content: "<:online:1557204563675848814> **Nenhuma mensagem registrada**. Use **POSTAR** primeiro.",
            ephemeral: true
          });
          return;
        }

        const channel = await guild.channels.fetch(config.supportMessageChannelId).catch(() => null);
        if (!channel || !channel.isTextBased()) {
          await interaction.reply({
            content: "<:offline:1557204568432185454> Não encontrei o canal onde a mensagem de suporte foi publicada.",
            ephemeral: true
          });
          return;
        }

        const message = await channel.messages.fetch(config.supportMessageId).catch(() => null);
        if (!message) {
          await interaction.reply({
            content: "<:offline:1557204568432185454> Não encontrei a mensagem de suporte registrada. Publique uma nova mensagem.",
            ephemeral: true
          });
          return;
        }

        await message.edit(buildSupportPanel(guild));
        await interaction.reply({
          content: "<:online:1557204563675848814> **Mensagem sincronizada**",
          ephemeral: true
        });
        return;
      }
    } catch (error) {
      console.error("[TICKET] Erro nas ações da mensagem de suporte:", error);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: "<:offline:1557204568432185454> Não foi possível concluir essa ação.", ephemeral: true }).catch(() => {});
      }
      return;
    }
  }

  if (interaction.isButton() && interaction.customId === "ticket:open") {
    try {
      const guild = interaction.guild;
      if (!guild) {
        await interaction.reply({ content: "<:offline:1557204568432185454> Esse atendimento só pode ser aberto dentro de um servidor.", ephemeral: true });
        return;
      }
      const result = await createAstralTicket(interaction);
      const target = result.target;
      await interaction.reply({
        content: result.alreadyOpen
          ? "<:online:1557204563675848814> | Você já tem um atendimento aberto: <#" + target.id + ">"
          : "<:online:1557204563675848814> | Ticket criado com sucesso! <#" + target.id + ">",
        ephemeral: true
      });
    } catch (error) {
      console.error("[TICKET] Erro ao abrir atendimento:", error);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: "<:offline:1557204568432185454> Não consegui abrir o atendimento. Verifique se o bot tem **Gerenciar Canais**.", ephemeral: true }).catch(() => {});
      }
    }
    return;
  }


  if (interaction.isButton() && interaction.customId.startsWith("fruit_page:")) {
    try {
      const [, panelType, pageRaw] = interaction.customId.split(":");
      const page = Math.max(0, Number(pageRaw) || 0);
      await interaction.deferUpdate();

      if (panelType === "public") {
        await interaction.editReply(buildFruitRolePanel(interaction.guildId, page));
      } else {
        const member = await interaction.guild.members.fetch({
          user: interaction.user.id,
          force: true
        }).catch(() => interaction.member);
        const panel = buildFruitRolePanelForMember(interaction.guildId, member, null, page);
        if (panel) await interaction.editReply(panel);
      }
    } catch (error) {
      console.error("[FRUIT ROLE] Falha ao trocar página:", error?.message || error);
    }
    return;
  }

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
          await interaction.reply({ content: uiEmoji("error", "<:offline:1557204568432185454>") + " Não há cargos de frutas configurados.", ephemeral: true });
          return;
        }
        await interaction.reply({ content: "<a:refresh_alt:1557205141051019274> Carregando", ephemeral: true });
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
          const msg={content:uiEmoji("error", "<:offline:1557204568432185454>") + " Eu preciso da permissão **Gerenciar Cargos**."};
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
          await interaction.editReply({ content:uiEmoji("error", "<:offline:1557204568432185454>") + " Não consegui reconstruir o painel de cargos." }).catch(error => {
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
          content:"<:offline:1557204568432185454> Os cargos podem ter sido removidos, mas não consegui atualizar o painel. Tente clicar novamente."
        }).catch(editError => {
          console.error("[FRUIT ROLE] Falha ao finalizar interação após erro:", editError?.message || editError);
        });
      }else{
        await interaction.reply({
          content:uiEmoji("error", "<:offline:1557204568432185454>") + " Não consegui processar o painel.",
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

        const selectedPage = Math.max(0, Number(interaction.customId.split(":").pop()) || 0);
        const publicPanel = buildFruitRolePanel(interaction.guildId, selectedPage);
        const member = await interaction.guild.members.fetch({
          user: interaction.user.id,
          force: true
        }).catch(() => interaction.member);
        const privatePanel = buildFruitRolePanelForMember(interaction.guildId, member, null, selectedPage);

        if (!publicPanel || !privatePanel) {
          await interaction.followUp({
            content: uiEmoji("error", "<:offline:1557204568432185454>") + " Não há cargos de frutas configurados.",
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
          const currentPage = Math.max(0, Number(interaction.customId.split(":").pop()) || 0);
          const currentPanel = buildFruitRolePanelForMember(interaction.guildId, currentMember, null, currentPage);
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

        const currentPage = Math.max(0, Number(interaction.customId.split(":").pop()) || 0);
        const updatedPanel = buildFruitRolePanelForMember(
          interaction.guildId,
          verifiedMember,
          status,
          currentPage
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
          content: uiEmoji("error", "<:offline:1557204568432185454>") + " Não consegui abrir o painel privado.",
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
        await interaction.reply({ content: "<:offline:1557204568432185454> Este painel só pode ser usado dentro de um servidor.", ephemeral: true });
        return;
      }

      if (action === "servers" && !(await isBotOwner(interaction.user.id))) {
        await interaction.reply({ content: uiEmoji("error", "<:offline:1557204568432185454>") + " Apenas o dono da aplicação pode acessar os servidores autorizados.", ephemeral: true });
        return;
      }

      if (action !== "servers") {
        const canManage = await isBotOwner(interaction.user.id) ||
          Boolean(interaction.member?.permissions?.has?.(PermissionFlagsBits.ManageGuild));
        if (!canManage) {
          await interaction.reply({ content: uiEmoji("error", "<:offline:1557204568432185454>") + " Você precisa da permissão **Gerenciar Servidor** para usar este painel.", ephemeral: true });
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
        await interaction.reply({ content: uiEmoji("error", "<:offline:1557204568432185454>") + " Não consegui abrir essa área.", ephemeral: true }).catch(() => {});
      }
    }
    return;
  }

  if (interaction.isButton() && interaction.customId === "panel:bot_restart") {
    if (!(await isBotOwner(interaction.user.id))) {
      await interaction.reply({ content: "<:offline:1557204568432185454> Apenas o dono da aplicação pode reiniciar o bot.", ephemeral: true });
      return;
    }

    await interaction.deferReply({ ephemeral: true }).catch(() => {});

    try {
      const usedDiscloudApi = Boolean(String(process.env.DISCLOUD_TOKEN || "").trim());
      await interaction.editReply({
        content: "<a:refresh_alt:1557205141051019274> **O Astral Stock está sendo reiniciado...**\nAguarde alguns segundos."
      });

      // Salva o token para a nova instância editar esta mesma resposta
      // quando o bot realmente voltar online.
      setPendingRestartConfirmation("restart", interaction.token);

      if (usedDiscloudApi) {
        void restartOnDiscloud()
          .then(() => console.log("[PANEL] Reinício enviado para a Discloud."))
          .catch(async error => {
            console.error("[PANEL] Erro ao reiniciar pela Discloud:", error);
            try {
              const state = readState();
              delete state.pendingRestartConfirmation;
              saveState(state);
              await interaction.editReply({
                content: "<:offline:1557204568432185454> **Não consegui reiniciar o bot.**\n" +
                  String(error?.message || "A Discloud recusou o reinício.").slice(0, 500)
              });
            } catch {}
          });
      } else {
        setTimeout(() => process.exit(0), 800);
      }
    } catch (error) {
      console.error("[PANEL] Erro ao responder ao reinício:", error);
      await interaction.editReply({
        content: "<:offline:1557204568432185454> " + String(error?.message || "Não consegui iniciar o reinício.").slice(0, 500)
      }).catch(() => {});
    }
    return;
  }

  if (interaction.isButton() && interaction.customId === "panel:bot_save") {
    await interaction.deferReply({ ephemeral: true }).catch(() => {});

    try {
      if (!(await isBotOwner(interaction.user.id))) {
        await interaction.editReply({ content: "<:offline:1557204568432185454> Apenas o dono da aplicação pode salvar as configurações." });
        return;
      }

      const userKey = String(interaction.user.id);
      const pending = pendingBotCustomizations.get(userKey);
      if (!pending || Object.keys(pending).length === 0) {
        await interaction.editReply({ content: "<:warning:1557204565877592085> Não há alterações pendentes para salvar. Faça uma alteração primeiro." });
        return;
      }

      const config = readConfig();
      config.botSettings = config.botSettings || { status1: "", status2: "", avatar: "", banner: "", description: "", accentColor: "00FFFF" };

      if (Object.prototype.hasOwnProperty.call(pending, "nickname")) {
        if (!pending.nickname) throw new Error("Informe um nome para o bot.");
        await client.user.setUsername(pending.nickname);
      }
      if (Object.prototype.hasOwnProperty.call(pending, "avatar")) {
        config.botSettings.avatar = pending.avatar;
        if (pending.avatar) await client.user.setAvatar(pending.avatar);
      }
      if (Object.prototype.hasOwnProperty.call(pending, "banner")) {
        config.botSettings.banner = pending.banner;
        if (pending.banner) await client.user.setBanner(await downloadOriginalImage(pending.banner));
      }
      if (Object.prototype.hasOwnProperty.call(pending, "accentColor")) {
        config.botSettings.accentColor = String(pending.accentColor || "00FFFF").replace(/^#/, "").toUpperCase();
      }
      if (Object.prototype.hasOwnProperty.call(pending, "status1")) {
        config.botSettings.status1 = pending.status1;
      }
      if (Object.prototype.hasOwnProperty.call(pending, "status2")) {
        config.botSettings.status2 = pending.status2;
      }

      saveConfig(config);
      pendingBotCustomizations.delete(userKey);
      rotatingStatusIndex = 0;
      applyRotatingBotStatus();

      await interaction.editReply({ content: "<:online:1557204563675848814> **Alterações salvas com sucesso!**" });
    } catch (error) {
      console.error("[PANEL] Erro ao salvar personalização:", error);
      const errorMessage = String(error?.message || "Não consegui salvar as alterações.");
      const simpleMessage = errorMessage.includes("BANNER_RATE_LIMIT")
        ? "O banner foi alterado recentemente. Aguarde um pouco e tente novamente."
        : errorMessage;
      await interaction.editReply({ content: "<:offline:1557204568432185454> " + simpleMessage.slice(0, 500) }).catch(() => {});
    }
    return;
  }

  if (interaction.isButton() && interaction.customId === "panel:bot_rebuild") {
    if (!(await isBotOwner(interaction.user.id))) {
      await interaction.reply({ content: "<:offline:1557204568432185454> Apenas o dono da aplicação pode fazer o rebuild.", ephemeral: true });
      return;
    }
    try {
      await interaction.deferReply({ ephemeral: true });

      if (!String(process.env.DISCLOUD_TOKEN || "").trim()) {
        throw new Error("DISCLOUD_TOKEN não está configurado.");
      }

      await interaction.editReply({ content: "<a:refresh_alt:1557205141051019274> **Rebuild em andamento...**\nPreparando o código do GitHub." });
      await commitOnDiscloud();

      await interaction.editReply({ content: "<a:refresh_alt:1557205141051019274> **Rebuild em andamento...**\nSincronizando comandos e emojis." });
      await registerCommands();
      await syncApplicationEmojis();

      await interaction.editReply({ content: "<a:refresh_alt:1557205141051019274> **Rebuild em andamento...**\nReiniciando a aplicação." });

      // A nova instância fará a confirmação final depois de realmente voltar online.
      setPendingRestartConfirmation("rebuild", interaction.token);
      await restartOnDiscloud();
    } catch (error) {
      console.error("[PANEL] Erro no rebuild:", error);
      await interaction.editReply({
        content: "<:offline:1557204568432185454> **Falha no rebuild**\n" + String(error?.message || "Não foi possível concluir o rebuild.").slice(0, 500)
      }).catch(() => {});
    }
    return;
  }

  if (interaction.isStringSelectMenu() && interaction.customId === "panel:bot_customize_select") {
    if (!(await isBotOwner(interaction.user.id))) {
      await interaction.reply({ content: "<:offline:1557204568432185454> Apenas o dono da aplicação pode personalizar o bot.", ephemeral: true });
      return;
    }
    const type = interaction.values[0];
    const modal = buildBotCustomizeModal(type, interaction.user.id);
    if (!modal) {
      await interaction.reply({ content: "<:offline:1557204568432185454> Opção de personalização inválida.", ephemeral: true });
      return;
    }
    await interaction.showModal(modal);
    return;
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith("panel:bot_customize_modal:")) {
    if (!(await isBotOwner(interaction.user.id))) {
      await interaction.reply({ content: "<:offline:1557204568432185454> Apenas o dono da aplicação pode personalizar o bot.", ephemeral: true });
      return;
    }

    const type = interaction.customId.split(":").pop();
    let value = interaction.fields.getTextInputValue("value").trim();

    try {
      if (type === "nickname" || type === "description" || type === "status1" || type === "status2") {
        value = value.replace(/\s+/g, " ").trim();
      }

      if (type === "nickname") {
        if (!value) throw new Error("Informe um nome para o bot.");
      } else if (type === "accentColor") {
        value = value.replace(/^#/, "").trim().toUpperCase();
        if (!/^[0-9A-F]{6}$/.test(value)) throw new Error("A cor precisa estar no formato HEX, por exemplo **00FFFF**.");
      } else if (type === "avatar" || type === "banner") {
        value = value.replace(/\s+/g, "");
        if (value && !/^https?:\/\//i.test(value)) throw new Error("A URL precisa começar com http:// ou https://.");
      } else if (type !== "status1" && type !== "status2") {
        throw new Error("Opção de personalização inválida.");
      }

      const userKey = String(interaction.user.id);
      const pending = pendingBotCustomizations.get(userKey) || {};
      pending[type] = value;
      pendingBotCustomizations.set(userKey, pending);

      await interaction.reply({ content: "<:online:1557204563675848814> **Alteração preparada.** Clique em **Salvar** para aplicar.", ephemeral: true });
    } catch (error) {
      console.error("[PANEL] Erro na personalização do bot:", error);
      await interaction.reply({ content: "<:offline:1557204568432185454> " + String(error?.message || "Não consegui alterar o bot.").slice(0, 500), ephemeral: true }).catch(() => {});
    }
    return;
  }

  if (interaction.isButton() && interaction.customId === "panel:restart") {
    try {
      if (!(await isBotOwner(interaction.user.id))) {
        await interaction.reply({
          content: uiEmoji("error", "<:offline:1557204568432185454>") + " Apenas o dono da aplicação pode reiniciar o bot.",
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
        await interaction.reply({ content: "<:offline:1557204568432185454> Não consegui reiniciar o bot.", ephemeral: true }).catch(() => {});
      }
    }
    return;
  }

  if (interaction.isButton() && interaction.customId.startsWith("panel:")) {
    try {
      const action = interaction.customId.slice("panel:".length);
      if (!interaction.guildId) {
        await interaction.reply({ content: "<:offline:1557204568432185454> Este painel só pode ser usado dentro de um servidor.", ephemeral: true });
        return;
      }

      if (action === "servers" && !(await isBotOwner(interaction.user.id))) {
        await interaction.reply({ content: uiEmoji("error", "<:offline:1557204568432185454>") + " Apenas o dono da aplicação pode acessar os servidores autorizados.", ephemeral: true });
        return;
      }

      if (action !== "servers") {
        const member = interaction.member;
        const canManage = await isBotOwner(interaction.user.id) ||
          Boolean(member?.permissions?.has?.(PermissionFlagsBits.ManageGuild));
        if (!canManage) {
          await interaction.reply({ content: uiEmoji("error", "<:offline:1557204568432185454>") + " Você precisa da permissão **Gerenciar Servidor** para usar este painel.", ephemeral: true });
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
        await interaction.reply({ content: uiEmoji("error", "<:offline:1557204568432185454>") + " Não consegui atualizar o painel.", ephemeral: true }).catch(() => {});
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
        await interaction.reply({ content: uiEmoji("error", "<:offline:1557204568432185454>") + " Você precisa da permissão **Gerenciar Servidor**.", ephemeral: true });
        return;
      }

      const fruit = ALL_FRUITS.find(name => fruitKey(name) === interaction.values?.[0]);
      if (!fruit) {
        await interaction.reply({ content: uiEmoji("error", "<:offline:1557204568432185454>") + " Fruta inválida.", ephemeral: true });
        return;
      }

      await interaction.update(buildFruitAdminPanel(interaction.guildId, fruit));
    } catch (error) {
      console.error("[PANEL] Erro ao selecionar fruta:", error);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: uiEmoji("error", "<:offline:1557204568432185454>") + " Não consegui abrir a configuração dessa fruta.", ephemeral: true }).catch(() => {});
      }
    }
    return;
  }

  if (interaction.isRoleSelectMenu() && interaction.customId.startsWith("admin_role_select:")) {
    try {
      const canManage = await isBotOwner(interaction.user.id) ||
        Boolean(interaction.member?.permissions?.has?.(PermissionFlagsBits.ManageGuild));
      if (!canManage) {
        await interaction.reply({ content: uiEmoji("error", "<:offline:1557204568432185454>") + " Você precisa da permissão **Gerenciar Servidor**.", ephemeral: true });
        return;
      }

      const fruitKeyName = interaction.customId.slice("admin_role_select:".length);
      const fruit = ALL_FRUITS.find(name => fruitKey(name) === fruitKeyName);
      const role = interaction.roles?.first?.();
      if (!fruit || !role) {
        await interaction.reply({ content: uiEmoji("error", "<:offline:1557204568432185454>") + " Fruta ou cargo inválido.", ephemeral: true });
        return;
      }

      const botMember = interaction.guild.members.me || await interaction.guild.members.fetchMe();
      if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
        await interaction.reply({ content: uiEmoji("error", "<:offline:1557204568432185454>") + " Eu preciso da permissão **Gerenciar Cargos**.", ephemeral: true });
        return;
      }
      if (!role.editable) {
        await interaction.reply({ content: uiEmoji("error", "<:offline:1557204568432185454>") + " Não consigo gerenciar esse cargo. Ele precisa estar abaixo do meu cargo mais alto.", ephemeral: true });
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
        await interaction.reply({ content: uiEmoji("error", "<:offline:1557204568432185454>") + " Não consegui configurar esse cargo.", ephemeral: true }).catch(() => {});
      }
    }
    return;
  }

  if (interaction.isButton() && interaction.customId.startsWith("admin_fruit_remove:")) {
    try {
      const canManage = await isBotOwner(interaction.user.id) ||
        Boolean(interaction.member?.permissions?.has?.(PermissionFlagsBits.ManageGuild));
      if (!canManage) {
        await interaction.reply({ content: uiEmoji("error", "<:offline:1557204568432185454>") + " Você precisa da permissão **Gerenciar Servidor**.", ephemeral: true });
        return;
      }

      const fruitKeyName = interaction.customId.slice("admin_fruit_remove:".length);
      const fruit = ALL_FRUITS.find(name => fruitKey(name) === fruitKeyName);
      if (!fruit) {
        await interaction.reply({ content: uiEmoji("error", "<:offline:1557204568432185454>") + " Fruta inválida.", ephemeral: true });
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
        await interaction.reply({ content: uiEmoji("error", "<:offline:1557204568432185454>") + " Não consegui remover o cargo configurado.", ephemeral: true }).catch(() => {});
      }
    }
    return;
  }

  if (interaction.isButton() && (interaction.customId === "server:add" || interaction.customId === "server:remove")) {
    if (!(await isBotOwner(interaction.user.id))) {
      await interaction.reply({ content: uiEmoji("error", "<:offline:1557204568432185454>") + " Apenas o dono da aplicação pode alterar servidores autorizados.", ephemeral: true });
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
        await interaction.reply({ content: uiEmoji("error", "<:offline:1557204568432185454>") + " Apenas o dono da aplicação pode alterar servidores autorizados.", ephemeral: true });
        return;
      }

      const action = interaction.customId.endsWith(":add") ? "add" : "remove";
      const serverId = interaction.fields.getTextInputValue("server_id").trim();
      if (!/^\\d{17,20}$/.test(serverId)) {
        await interaction.reply({ content: uiEmoji("error", "<:offline:1557204568432185454>") + " ID de servidor inválido.", ephemeral: true });
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
      if (!interaction.replied) await interaction.reply({ content: uiEmoji("error", "<:offline:1557204568432185454>") + " Não consegui atualizar os servidores autorizados.", ephemeral: true }).catch(() => {});
    }
    return;
  }

  if (interaction.isButton() && interaction.customId === "ticket:manage_functions_back") {
    await interaction.update(buildTicketConfigPanel(interaction.guildId));
    return;
  }

  if (interaction.isStringSelectMenu() && interaction.customId === "ticket:manage_function_select") {
    const id = interaction.values[0];
    const config = getGuildConfig(interaction.guildId);
    const fn = (config.ticketFunctions || []).find(item => item.id === id);
    if (!fn) {
      await interaction.reply({ content: "<:offline:1557204568432185454> Essa função não existe mais. Atualize a tela.", ephemeral: true });
      return;
    }
    const container = new ContainerBuilder()
      .setAccentColor(getBotPanelAccentColor())
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(
        "## <:config_title_alt:1557204540460240926> GERENCIAR FUNÇÃO\n" +
        "### <:ticket_plus:1557205110847701052> " + String(fn.name || "Atendimento") + "\n" +
        "> **Pré descrição:** " + String(fn.preDescription || "Não configurada") + "\n" +
        "> **Descrição:** " + String(fn.description || "Não configurada") + "\n" +
        "> **Banner:** " + String(fn.banner || "Não configurado") + "\n" +
        "> **Emoji:** " + (fn.emoji?.id ? "<:" + String(fn.emoji.name || "ticket_emoji") + ":" + String(fn.emoji.id) + ">" : "Não configurado")
      ))
      .addActionRowComponents(new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("ticket:function_edit:" + fn.id)
          .setLabel("Editar")
          .setEmoji({ name: "compass", id: "1557204910578335844" })
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId("ticket:function_delete:" + fn.id)
          .setLabel("Excluir")
          .setEmoji(applicationEmojiObject("trash", "🗑️"))
          .setStyle(ButtonStyle.Danger)
      ))
      .addActionRowComponents(new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("ticket:manage_function_select_back")
          .setLabel("Voltar")
          .setEmoji({ name: "arrow_left", id: "1557204764834537534" })
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId("ticket:function_save:" + fn.id)
          .setLabel("Salvar")
          .setEmoji(applicationEmojiObject("save", "💾"))
          .setStyle(ButtonStyle.Success)
      ));
    await interaction.update({ components: [container], flags: MessageFlags.IsComponentsV2 });
    return;
  }

  if (interaction.isButton() && interaction.customId.startsWith("ticket:function_delete:")) {
    try {
      const functionId = interaction.customId.slice("ticket:function_delete:".length);
      const config = getGuildConfig(interaction.guildId);
      const fn = (config.ticketFunctions || []).find(item => item.id === functionId);
      if (!fn) {
        await interaction.reply({ content: "<:offline:1557204568432185454> Essa função não existe mais.", ephemeral: true });
        return;
      }

      updateGuildConfig(interaction.guildId, cfg => {
        cfg.ticketFunctions = (Array.isArray(cfg.ticketFunctions) ? cfg.ticketFunctions : [])
          .filter(item => item.id !== functionId);
      });

      await interaction.update(buildTicketManageFunctionsPanel(interaction.guildId));
    } catch (error) {
      console.error("[TICKET] Erro ao excluir função:", error);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: "<:offline:1557204568432185454> Não consegui excluir a função.", ephemeral: true }).catch(() => {});
      }
    }
    return;
  }

  if (interaction.isButton() && interaction.customId.startsWith("ticket:function_save:")) {
    try {
      const functionId = interaction.customId.slice("ticket:function_save:".length);
      const config = getGuildConfig(interaction.guildId);
      const fn = (config.ticketFunctions || []).find(item => item.id === functionId);
      if (!fn) {
        await interaction.reply({ content: "<:offline:1557204568432185454> Essa função não existe mais.", ephemeral: true });
        return;
      }

      // As alterações do formulário já são persistidas ao enviar o modal.
      // Este botão garante uma gravação explícita e atualiza o painel.
      updateGuildConfig(interaction.guildId, cfg => {
        cfg.ticketFunctions = Array.isArray(cfg.ticketFunctions) ? cfg.ticketFunctions : [];
        const target = cfg.ticketFunctions.find(item => item.id === functionId);
        if (target) Object.assign(target, fn);
      });

      const updatedConfig = getGuildConfig(interaction.guildId);
      const savedFn = (updatedConfig.ticketFunctions || []).find(item => item.id === functionId) || fn;
      const container = new ContainerBuilder()
        .setAccentColor(getBotPanelAccentColor())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
          "## <:config_title_alt:1557204540460240926> GERENCIAR FUNÇÃO\n" +
          "### <:ticket_plus:1557205110847701052> " + String(savedFn.name || "Atendimento") + "\n" +
          "> **Pré descrição:** " + String(savedFn.preDescription || "Não configurada") + "\n" +
          "> **Descrição:** " + String(savedFn.description || "Não configurada") + "\n" +
          "> **Banner:** " + String(savedFn.banner || "Não configurado") + "\n" +
          "> **Emoji:** " + (savedFn.emoji?.id ? "<:" + String(savedFn.emoji.name || "ticket_emoji") + ":" + String(savedFn.emoji.id) + ">" : "Não configurado") + "\n\n" +
          "### <:save:1557205052974960780> Função salva com sucesso."
        ))
        .addActionRowComponents(new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("ticket:function_edit:" + savedFn.id).setLabel("Editar").setEmoji({ name: "compass", id: "1557204910578335844" }).setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId("ticket:function_delete:" + savedFn.id).setLabel("Excluir").setEmoji(applicationEmojiObject("trash", "🗑️")).setStyle(ButtonStyle.Danger)
        ))
        .addActionRowComponents(new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("ticket:manage_function_select_back").setLabel("Voltar").setEmoji({ name: "arrow_left", id: "1557204764834537534" }).setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId("ticket:function_save:" + savedFn.id).setLabel("Salvar").setEmoji(applicationEmojiObject("save", "💾")).setStyle(ButtonStyle.Success)
        ));

      await interaction.update({ components: [container], flags: MessageFlags.IsComponentsV2 });
    } catch (error) {
      console.error("[TICKET] Erro ao salvar função:", error);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: "<:offline:1557204568432185454> Não consegui salvar a função.", ephemeral: true }).catch(() => {});
      }
    }
    return;
  }

  if (interaction.isButton() && interaction.customId.startsWith("ticket:function_edit:")) {
    const functionId = interaction.customId.slice("ticket:function_edit:".length);
    const fn = (getGuildConfig(interaction.guildId).ticketFunctions || []).find(item => item.id === functionId);
    if (!fn) { await interaction.reply({ content: "<:offline:1557204568432185454> Essa função não existe mais.", ephemeral: true }); return; }
    try { await interaction.showModal(buildTicketFunctionModal(fn)); }
    catch (error) { console.error("[TICKET] Erro ao abrir edição:", error); if (!interaction.replied && !interaction.deferred) await interaction.reply({ content: "<:offline:1557204568432185454> Não consegui abrir a edição da função.", ephemeral: true }).catch(() => {}); }
    return;
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith("ticket:edit_function_modal:")) {
    try {
      const guild = interaction.guild;
      if (!guild) throw new Error("Essa configuração só pode ser usada dentro de um servidor.");
      const functionId = interaction.customId.slice("ticket:edit_function_modal:".length);
      const name = interaction.fields.getTextInputValue("ticket_function_name").trim();
      const preDescription = interaction.fields.getTextInputValue("ticket_function_pre_description").trim();
      const description = interaction.fields.getTextInputValue("ticket_function_description").trim();
      const banner = interaction.fields.getTextInputValue("ticket_function_banner").trim();
      const emojiInput = interaction.fields.getTextInputValue("ticket_function_emoji").trim();
      if (!name || !preDescription) throw new Error("Nome da função e pré descrição são obrigatórios.");
      if (banner && !/^https?:\/\//i.test(banner)) throw new Error("O banner precisa ser uma URL começando com http:// ou https://.");
      let emoji = null;
      if (emojiInput) {
        const parsed = normalizeTicketFunctionEmoji(emojiInput);
        emoji = await resolveTicketFunctionEmoji(guild, parsed.id);
        if (!emoji) throw new Error("Não encontrei esse emoji no servidor nem nos emojis da aplicação.");
      }
      updateGuildConfig(guild.id, cfg => {
        const target = (cfg.ticketFunctions || []).find(item => item.id === functionId);
        if (!target) throw new Error("Essa função não existe mais.");
        target.name = name;
        target.preDescription = preDescription;
        target.description = description || null;
        target.banner = banner || null;
        target.emoji = emoji;
      });
      const panel = buildTicketManageFunctionsPanel(guild.id);
      if (interaction.message) await interaction.update(panel);
      else await interaction.reply({ ...panel, flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral });
    } catch (error) {
      console.error("[TICKET] Erro ao editar função:", error);
      if (!interaction.replied && !interaction.deferred) await interaction.reply({ content: "<:offline:1557204568432185454> " + (error.message || "Não consegui editar a função."), ephemeral: true }).catch(() => {});
    }
    return;
  }

  if (interaction.isButton() && interaction.customId === "ticket:manage_function_select_back") {
    await interaction.update(buildTicketManageFunctionsPanel(interaction.guildId));
    return;
  }

  if (interaction.isButton() && interaction.customId === "ticket:reorder_functions") {
    await interaction.update(buildTicketFunctionReorderPanel(interaction.guildId, interaction.user.id));
    return;
  }

  if (interaction.isButton() && interaction.customId === "ticket:reorder_back") {
    ticketReorderSelections.delete(String(interaction.guildId) + ":" + String(interaction.user.id));
    await interaction.update(buildTicketManageFunctionsPanel(interaction.guildId));
    return;
  }

  if (interaction.isStringSelectMenu() && interaction.customId === "ticket:reorder_select") {
    ticketReorderSelections.set(String(interaction.guildId) + ":" + String(interaction.user.id), interaction.values[0]);
    await interaction.update(buildTicketFunctionReorderPanel(interaction.guildId, interaction.user.id));
    return;
  }

  if (interaction.isButton() && (interaction.customId === "ticket:reorder_up" || interaction.customId === "ticket:reorder_down")) {
    const key = String(interaction.guildId) + ":" + String(interaction.user.id);
    const selectedId = ticketReorderSelections.get(key);
    if (!selectedId) {
      await interaction.reply({ content: "<:offline:1557204568432185454> Selecione uma função primeiro.", ephemeral: true });
      return;
    }
    const config = getGuildConfig(interaction.guildId);
    const functions = Array.isArray(config.ticketFunctions) ? [...config.ticketFunctions] : [];
    const index = functions.findIndex(fn => fn.id === selectedId);
    if (index < 0) {
      await interaction.reply({ content: "<:offline:1557204568432185454> Essa função não existe mais.", ephemeral: true });
      return;
    }
    const direction = interaction.customId === "ticket:reorder_up" ? -1 : 1;
    const target = index + direction;
    if (target < 0 || target >= functions.length) {
      await interaction.update(buildTicketFunctionReorderPanel(interaction.guildId, interaction.user.id));
      return;
    }
    [functions[index], functions[target]] = [functions[target], functions[index]];
    updateGuildConfig(interaction.guildId, cfg => { cfg.ticketFunctions = functions; });
    await interaction.update(buildTicketFunctionReorderPanel(interaction.guildId, interaction.user.id));
    return;
  }

  if (interaction.isButton() && interaction.customId === "ticket:appearance_back") {
    await interaction.update(buildTicketConfigPanel(interaction.guildId));
    return;
  }

  if (interaction.isButton() && interaction.customId === "ticket:appearance_edit") {
    try {
      await interaction.showModal(buildTicketAppearanceModal(interaction.guildId, interaction.user.id));
    } catch (error) {
      console.error("[TICKET] Erro ao abrir aparência:", error);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: "<:offline:1557204568432185454> Não consegui abrir a configuração de aparência.", ephemeral: true }).catch(() => {});
      }
    }
    return;
  }

  if (interaction.isModalSubmit() && interaction.customId === "ticket:appearance_modal") {
    try {
      const guild = interaction.guild;
      if (!guild) {
        await interaction.reply({ content: "<:offline:1557204568432185454> Essa configuração só pode ser usada dentro de um servidor.", ephemeral: true });
        return;
      }

      const title = interaction.fields.getTextInputValue("ticket_appearance_title").trim();
      const description = interaction.fields.getTextInputValue("ticket_appearance_description").trim();
      const thumbnail = interaction.fields.getTextInputValue("ticket_appearance_thumbnail").trim();
      const banner = interaction.fields.getTextInputValue("ticket_appearance_banner").trim();
      const color = normalizeTicketColor(interaction.fields.getTextInputValue("ticket_appearance_color").trim());

      if (!title || !description) {
        await interaction.reply({ content: "<:offline:1557204568432185454> Título e descrição são obrigatórios.", ephemeral: true });
        return;
      }

      if (thumbnail && !/^https?:\/\//i.test(thumbnail)) {
        await interaction.reply({ content: "<:offline:1557204568432185454> A thumbnail precisa ser uma URL começando com http:// ou https://.", ephemeral: true });
        return;
      }

      if (banner && !/^https?:\/\//i.test(banner)) {
        await interaction.reply({ content: "<:offline:1557204568432185454> O banner precisa ser uma URL começando com http:// ou https://.", ephemeral: true });
        return;
      }

      ticketAppearanceDrafts.set(String(guild.id) + ":" + String(interaction.user.id), {
        title,
        description,
        thumbnail: thumbnail || null,
        banner: banner || null,
        color
      });

      await interaction.reply({
        ...buildTicketAppearancePanel(guild.id, interaction.user.id),
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral
      });
    } catch (error) {
      console.error("[TICKET] Erro ao salvar rascunho da aparência:", error);
      await interaction.reply({ content: "<:offline:1557204568432185454> " + error.message, ephemeral: true }).catch(() => {});
    }
    return;
  }

  if (interaction.isButton() && interaction.customId === "ticket:appearance_save") {
    try {
      const guild = interaction.guild;
      const key = String(guild.id) + ":" + String(interaction.user.id);
      const draft = ticketAppearanceDrafts.get(key);

      if (!draft) {
        await interaction.reply({ content: "<:offline:1557204568432185454> Clique em **EDITAR CAMPOS** primeiro.", ephemeral: true });
        return;
      }

      updateGuildConfig(guild.id, config => {
        config.ticketAppearance = {
          title: draft.title,
          description: draft.description,
          thumbnail: draft.thumbnail || null,
          banner: draft.banner || null,
          color: normalizeTicketColor(draft.color)
        };
      });

      ticketAppearanceDrafts.delete(key);
      await interaction.reply({
        content: "<:online:1557204563675848814> **Salvo**",
        ephemeral: true
      });
    } catch (error) {
      console.error("[TICKET] Erro ao salvar aparência:", error);
      await interaction.reply({ content: "<:offline:1557204568432185454> Não consegui salvar a aparência.", ephemeral: true }).catch(() => {});
    }
    return;
  }

  async function commandReply(interaction, payload) {
    const isEphemeral = Boolean(payload?.ephemeral);
    if (isEphemeral) {
      return interaction.reply(payload);
    }

    if (!interaction.channel?.send) {
      return interaction.reply(payload);
    }

    await interaction.deferReply({ ephemeral: true });
    const cleanPayload = { ...payload };
    delete cleanPayload.ephemeral;

    try {
      const sent = await interaction.channel.send(cleanPayload);
      await interaction.deleteReply().catch(() => {});
      return sent;
    } catch (error) {
      await interaction.deleteReply().catch(() => {});
      throw error;
    }
  }

  if (!interaction.isChatInputCommand()) return;
  try {
  if (interaction.commandName === "suporte") {
    if (!interaction.guildId) {
      await commandReply(interaction, { content: "<:offline:1557204568432185454> O painel de suporte só pode ser usado dentro de um servidor.", ephemeral: true });
      return;
    }
    const canManage = await isBotOwner(interaction.user.id) ||
      Boolean(interaction.member?.permissions?.has?.(PermissionFlagsBits.ManageGuild));
    if (!canManage) {
      await commandReply(interaction, { content: "<:offline:1557204568432185454> Você precisa da permissão **Gerenciar Servidor** para publicar o painel de suporte.", ephemeral: true });
      return;
    }
    await commandReply(interaction, buildSupportPanel(interaction.guild));
    return;
  } else if (interaction.commandName === "painel") {
    if (!interaction.guildId) {
      await commandReply(interaction, { content: uiEmoji("error", "<:offline:1557204568432185454>") + " O painel só pode ser usado dentro de um servidor.", ephemeral: true });
      return;
    }

    const canManage = await isBotOwner(interaction.user.id) ||
      Boolean(interaction.member?.permissions?.has?.(PermissionFlagsBits.ManageGuild));

    if (!canManage) {
      await commandReply(interaction, {
        content: uiEmoji("error", "<:offline:1557204568432185454>") + " Você precisa da permissão **Gerenciar Servidor** para abrir o painel.",
        ephemeral: true
      });
      return;
    }

    try {
      // Reconhece a interação imediatamente para mostrar "Abrindo painel..."
      // e depois substitui o aviso pelo painel privado em Components V2.
      await interaction.reply({
        content: "<:online:1557204563675848814> Abrindo painel...",
        ephemeral: true
      });

      const panel = buildMainPanel(interaction.guildId, interaction.user.id);
      await interaction.editReply({
        ...panel,
        content: null,
        flags: MessageFlags.IsComponentsV2
      });
    } catch (error) {
      console.error("[PANEL] Erro ao abrir /painel:", error);
      const errorMessage = "<:offline:1557204568432185454> Não consegui abrir o painel." +
        (error?.message ? "\n-# Erro: " + String(error.message).slice(0, 180) : "");
      if (interaction.replied || interaction.deferred) {
        await interaction.editReply({ content: errorMessage, embeds: [], components: [] }).catch(() => {});
      } else {
        await interaction.reply({ content: errorMessage, ephemeral: true }).catch(() => {});
      }
    }
    return;
  } else if (interaction.commandName === "server-panel") {
    if (!(await isBotOwner(interaction.user.id))) {
      await commandReply(interaction, { content: uiEmoji("error", "<:offline:1557204568432185454>") + " Apenas o dono da aplicação pode usar o painel de servidores.", ephemeral: true });
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
      await commandReply(interaction, { content: "🔒 Esse servidor é protegido e não pode ser removido do painel.", ephemeral: true });
      return;
    }

    if (action === "list") {
      const entries = config.allowedGuildIds.map(id => {
        const guild = client.guilds.cache.get(id);
        return guild ? "• **" + guild.name + "** — \`" + id + "\`" : "• \`" + id + "\` — servidor não encontrado";
      });
      await commandReply(interaction, {
        content: "🛡️ **Servidores autorizados**\\n\\n" + (entries.join("\\n") || "Nenhum servidor autorizado."),
        ephemeral: true
      });
      return;
    }

    if (!/^\d{17,20}$/.test(String(serverId || ""))) {
      await commandReply(interaction, { content: uiEmoji("error", "<:offline:1557204568432185454>") + " Informe um ID de servidor Discord válido em **server_id**.", ephemeral: true });
      return;
    }

    if (action === "add") {
      if (!config.allowedGuildIds.includes(serverId)) config.allowedGuildIds.push(serverId);
      saveConfig(config);

      const guild = client.guilds.cache.get(serverId);
      await commandReply(interaction, {
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

      await commandReply(interaction, {
        content: uiEmoji("trash", "🗑️") + " Servidor \`" + serverId + "\` removido da lista." + (guild ? " O bot saiu dele automaticamente." : ""),
        ephemeral: true
      });
      return;
    }
  } else if (interaction.commandName === "avatar") {
    await interaction.deferReply({ ephemeral: true });
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
        "<:id_card:1557204892177928272> **ID:** " + avatar.id,
        "<:calendar:1557204788880613437> **Conta criada:** " + createdText,
        "<:user_check:1557205120335224933> **Amigos:** " + avatar.friends.toLocaleString("pt-BR"),
        "<:users:1557205137154637864> **Seguidores:** " + avatar.followers.toLocaleString("pt-BR"),
        "<:user_add:1557205138689495101> **Seguindo:** " + avatar.following.toLocaleString("pt-BR"),
        "<:star:1557205044305072160> **Jogos favoritos:** " + favoriteText
      ].join("\n");

      // Container V2 com cabeçalho mais completo, mantendo a imagem do avatar.
      const avatarHeader = [
        "## <:roblox:1557204761797853234> PERFIL DO ROBLOX",
        "### " + avatar.displayName,
        "-# @" + avatar.username + "  •  Roblox Player"
      ].join("\n");

      const container = new ContainerBuilder()
        .setAccentColor(getBotPanelAccentColor())
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

      await interaction.channel.send({
        components: [container],
        flags: MessageFlags.IsComponentsV2
      });
      await interaction.deleteReply().catch(() => {});
    } catch (error) {
      console.error("Erro no /avatar:", error);
      await interaction.editReply(uiEmoji("error", "<:offline:1557204568432185454>") + (error.message || "Não consegui carregar esse avatar do Roblox."));
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
      await interaction.editReply(uiEmoji("error", "<:offline:1557204568432185454>") + (error.message || "Não consegui falar com a IA agora."));
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
      .setAccentColor(getBotPanelAccentColor())
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(content)
      );

    await commandReply(interaction, {
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
      await commandReply(interaction, { content: uiEmoji("error", "<:offline:1557204568432185454>") + " Apenas o dono da aplicação pode usar /send-stock.", ephemeral: true });
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
        await commandReply(interaction, { content: uiEmoji("error", "<:offline:1557204568432185454>") + " Ainda não existe stock salvo para enviar.", ephemeral: true });
        return;
      }
      await commandReply(interaction, { components, flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } });
    } catch (error) {
      console.error("Erro no /send-stock:", error);
      if (!interaction.replied && !interaction.deferred) {
        await commandReply(interaction, { content: uiEmoji("error", "<:offline:1557204568432185454>") + " Não consegui enviar o stock salvo.", ephemeral: true });
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
      await commandReply(interaction, { components, flags: MessageFlags.IsComponentsV2 });
    } catch (e) {
      console.error("Erro no /stock:", e);
      if (!interaction.replied && !interaction.deferred) await commandReply(interaction, { content: uiEmoji("error", "<:offline:1557204568432185454>") + " Não consegui mostrar o estoque agora.", ephemeral: true });
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
      await interaction.editReply(uiEmoji("error", "<:offline:1557204568432185454>") + " Não consegui reenviar o stock salvo: " + e.message + ".");
    }
  } else if (interaction.commandName === "set-stock-channel") {
    const channel = interaction.options.getChannel("channel", true);
    if (!channel.isTextBased() || !channel.send) {
      await commandReply(interaction, { content: uiEmoji("error", "<:offline:1557204568432185454>") + " Escolha um canal de texto.", ephemeral: true });
      return;
    }
    updateGuildConfig(interaction.guildId, config => { config.channelId = channel.id; });
    await commandReply(interaction, { content: uiEmoji("success", "✅") + " Canal de stock configurado para " + channel + ".", ephemeral: true });
  } else if (interaction.commandName === "set-stock-title") {
    const groupKey = interaction.options.getString("stock_type");
    const title = interaction.options.getString("title").trim();
    updateGuildConfig(interaction.guildId, config => {
      config.titles = config.titles || {};
      config.titles[groupKey] = title;
    });
    await commandReply(interaction, {
      content: `Título do ${groupKey === "mirage" ? "Stock da Mirage" : "Stock Normal"} alterado para **${title}**.`,
      ephemeral: true
    });
  } else if (interaction.commandName === "set-fruit-role") {
    const inputFruit = interaction.options.getString("fruit", true);
    const fruit = resolveFruitName(inputFruit);
    const role = interaction.options.getRole("role", true);

    if (!fruit) {
      await commandReply(interaction, { content: invalidFruitMessage(inputFruit), ephemeral: true });
      return;
    }

    updateGuildConfig(interaction.guildId, config => {
      config.roles = config.roles || {};
      config.roles[fruitKey(fruit)] = role.id;
    });
    await commandReply(interaction, { content: `Cargo ${role} configurado para **${fruit}**. Vou mencionar esse cargo quando a fruta aparecer no stock.`, ephemeral: true });
  } else if (interaction.commandName === "list-roles") {
    const roles = getGuildConfig(interaction.guildId).roles || {};
    const entries = Object.entries(roles).filter(([, id]) => /^\d{17,20}$/.test(String(id)));
    const content = entries.map(([fruit, id]) => `• ${fruitEmoji(fruit)} **${fruit}**: <@&${id}>`).join("\n");
    await commandReply(interaction, { content: content || "Nenhum cargo configurado ainda. Use /configurar-fruta.", ephemeral: true, allowedMentions: { parse: [] } });
  } else if (interaction.commandName === "fruit-role-panel") {
    const panel = buildFruitRolePanel(interaction.guildId);

    if (!panel.configured?.length) {
      await commandReply(interaction, {
        content: uiEmoji("error", "<:offline:1557204568432185454>") + " Nenhuma fruta possui cargo configurado. Use primeiro **/set-fruit-role**.",
        ephemeral: true
      });
      return;
    }

    await commandReply(interaction, {
      ...panel,
      flags: MessageFlags.IsComponentsV2
    });
  } else if (interaction.commandName === "remove-role") {
    const inputFruit = interaction.options.getString("fruit", true);
    const fruit = resolveFruitName(inputFruit);

    if (!fruit) {
      await commandReply(interaction, { content: invalidFruitMessage(inputFruit), ephemeral: true });
      return;
    }

    const fruitKeyName = fruitKey(fruit);
    const config = getGuildConfig(interaction.guildId);
    if (!config.roles[fruitKeyName]) {
      await commandReply(interaction, { content: `Não há cargo configurado para **${fruit}**.`, ephemeral: true });
    } else {
      updateGuildConfig(interaction.guildId, config => { delete config.roles[fruitKeyName]; });
      await commandReply(interaction, { content: `Configuração de cargo removida para **${fruit}**.`, ephemeral: true });
    }
  } else if (interaction.commandName === "stock-alert") {
    const action = interaction.options.getString("action", true);
    const guildConfig = getGuildConfig(interaction.guildId);
    if (action === "set_channel") {
      const channel = interaction.options.getChannel("channel", true);
      if (!channel.isTextBased() || !channel.send) {
        await commandReply(interaction, { content: uiEmoji("error", "<:offline:1557204568432185454>") + " Escolha um canal de texto.", ephemeral: true });
        return;
      }
      updateGuildConfig(interaction.guildId, config => { config.stockAlertChannelId = channel.id; });
      await commandReply(interaction, { content: uiEmoji("success", "✅") + " Canal de alertas definido como " + channel + ".", ephemeral: true });
    } else if (action === "remove_channel") {
      if (!guildConfig.stockAlertChannelId) {
        await commandReply(interaction, { content: "Não há canal de alertas configurado.", ephemeral: true });
      } else {
        updateGuildConfig(interaction.guildId, config => { config.stockAlertChannelId = null; });
        await commandReply(interaction, { content: uiEmoji("mute", "🔕") + " Canal de alertas removido.", ephemeral: true });
      }
    } else if (action === "add_fruit") {
      const inputFruit = interaction.options.getString("fruit", true);
      const fruit = resolveFruitName(inputFruit);
      const role = interaction.options.getRole("role", true);

      if (!fruit) {
        await commandReply(interaction, { content: invalidFruitMessage(inputFruit), ephemeral: true });
        return;
      }

      const fruitKeyName = fruitKey(fruit);
      updateGuildConfig(interaction.guildId, config => {
        config.stockAlerts = config.stockAlerts || {};
        config.stockAlerts[fruitKeyName] = role.id;
      });
      await commandReply(interaction, { content: uiEmoji("alert", "🔔") + " Alerta ativado para **" + fruit + "**. Vou mencionar " + role + " no canal de alertas quando aparecer.", ephemeral: true });
    } else if (action === "remove_fruit") {
      const inputFruit = interaction.options.getString("fruit", true);
      const fruit = resolveFruitName(inputFruit);

      if (!fruit) {
        await commandReply(interaction, { content: invalidFruitMessage(inputFruit), ephemeral: true });
        return;
      }

      const fruitKeyName = fruitKey(fruit);
      if (!guildConfig.stockAlerts?.[fruitKeyName]) {
        await commandReply(interaction, { content: "Não há alerta configurado para **" + fruit + "**.", ephemeral: true });
      } else {
        updateGuildConfig(interaction.guildId, config => { delete config.stockAlerts[fruitKeyName]; });
        await commandReply(interaction, { content: uiEmoji("mute", "🔕") + " Alerta removido para **" + fruit + "**.", ephemeral: true });
      }
    }  } else if (interaction.commandName === "stock-prediction" || interaction.commandName === "stock-statistics") {
    const groupKey = interaction.options.getString("stock_type", true);
    const isPrediction = interaction.commandName === "stock-prediction";
    await commandReply(interaction, { content: analyticsMessage(groupKey, isPrediction), ephemeral: true });
  } else if (interaction.commandName === "stock-history") {
    const history = readState().history || [];
    const content = history.slice(0, 5).map((h, i) =>
      `**${i + 1}.** <t:${Math.floor(new Date(h.at).getTime() / 1000)}:R> • ${(h.stock || []).map(safeName).join(", ") || "Sem dados"}`
    ).join("\n");
    await commandReply(interaction, { content: content || "Ainda não há histórico de alterações.", ephemeral: true });
  }
  } catch (error) {
    console.error(`Erro no comando /${interaction.commandName}:`, error);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: `${uiEmoji("error", "<:offline:1557204568432185454>")} Ocorreu um erro ao executar /${interaction.commandName}. Tente novamente.` });
      } else {
        await interaction.reply({ content: uiEmoji("error", "<:offline:1557204568432185454>") + " Ocorreu um erro ao executar este comando.", ephemeral: true });
      }
    } catch (replyError) {
      console.error("Não foi possível responder à interação:", replyError);
    }
  }
});
client.login(process.env.DISCORD_TOKEN);