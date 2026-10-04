require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");
const {
  Client, GatewayIntentBits, MessageFlags, ContainerBuilder, TextDisplayBuilder, REST, Routes,
  SlashCommandBuilder, PermissionFlagsBits
} = require("discord.js");
const OpenAI = require("openai");

const required = ["DISCORD_TOKEN", "CLIENT_ID", "GUILD_ID", "CHANNEL_ID", "STOCK_API_URL", "STOCK_API_KEY", "OPENAI_API_KEY"];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`Configuração ausente: ${key}. Veja o arquivo .env.example.`);
    process.exit(1);
  }
}
const CONFIG_PATH = path.join(__dirname, "config.json");
const STATE_PATH = path.join(__dirname, "data", "state.json");
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const aiHistory = new Map();

let checking = false;
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
async function getStock() {
  const response = await fetch(process.env.STOCK_API_URL, {
    headers: { "Accept": "application/json", "X-API-Key": process.env.STOCK_API_KEY },
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`API respondeu HTTP ${response.status}`);
  return normalizeStock(await response.json());
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
    return `${fruitEmoji(item)} **${safeName(item)}**${price != null ? ` | <:emoji_232:1556366446257242112> \`${Number(price).toLocaleString("en-US")}\`` : ""}${item.robux_price != null ? ` | ${item.robux_price} Robux` : ""}`;
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
async function postStock(stock, announce, title, groupKey = null) {
  const channel = await client.channels.fetch(process.env.CHANNEL_ID);
  if (!channel || !channel.isTextBased() || !channel.send) throw new Error("CHANNEL_ID não é um canal de texto acessível.");
  await channel.send({ components: [stockContainer(stock, title, groupKey)], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: ["roles"] } });
}
async function checkStock(force = false, onlyGroups = ["normal", "mirage"]) {
  if (checking) return;
  checking = true;
  try {
    const stock = await getStock();
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
      const previous = state.stockSignatures[group.key];

      if (items.length && (force || !previous || sig !== previous)) {
        await postStock(items, true, group.title, group.key);
        state.latestStock[group.key] = items;
        state.history.unshift({ at: new Date().toISOString(), stock: items, type: group.type });
        state.history = state.history.slice(0, Number(readConfig().historyLimit || 20));
      }
      state.stockSignatures[group.key] = sig;
    }

    saveState(state);
    console.log(`Stock consultado: ${groups.map(g => `${g.type} ${stock.filter(x => String(x.type || "").toLowerCase() === g.type.toLowerCase()).length} frutas`).join("; ")}.`);
  } catch (error) {
    console.error("Erro ao consultar/enviar stock:", error.message);
  } finally {
    checking = false;
  }
}


async function askAI(userId, question) {
  const history = aiHistory.get(userId) || [];
  const stock = await getStock().catch(() => []);
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
  new SlashCommandBuilder().setName("ia").setDescription("Conversa com a IA do Astral Stock").addStringOption(option => option.setName("pergunta").setDescription("O que você quer perguntar").setRequired(true).setMaxLength(1000)),
  new SlashCommandBuilder().setName("testeestoque").setDescription("Mostra todas as frutas para testar os emojis").setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName("atualizar").setDescription("Consulta e publica o stock agora").setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName("historico").setDescription("Mostra as últimas alterações de stock"),
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
    await checkStock(false, ["normal", "mirage"]);
  } catch (error) {
    console.error("Erro na inicialização do Astral Stock:", error);
  }

  nextStockAt.normal = nextGlobalReset("normal").getTime();
  nextStockAt.mirage = nextGlobalReset("mirage").getTime();

  console.log("Agendamento automático global: uma consulta a cada 2 horas para detectar Normal e Mirage.");

  const checkAtReset = async () => {
    // Algumas APIs demoram alguns segundos para atualizar depois do reset.
    // Reconsultamos em pequenos intervalos; a assinatura evita mensagens duplicadas.
    const delays = [0, 15000, 45000, 90000, 180000];
    for (const delay of delays) {
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      await checkStock(false, ["normal", "mirage"]);
    }
  };

  const schedule = () => {
    const next = nextGlobalReset("mirage");
    nextStockAt.mirage = next.getTime();
    nextStockAt.normal = nextGlobalReset("normal").getTime();

    setTimeout(async () => {
      // Aguarda 1 minuto após o reset para evitar consultar a API enquanto ela ainda atualiza.
      await new Promise(resolve => setTimeout(resolve, 60000));
      await checkStock(false, ["normal", "mirage"]);
      schedule();
    }, Math.max(1000, next.getTime() - Date.now()));
  };
  schedule();
});

process.on("unhandledRejection", error => {
  console.error("Promise rejeitada sem tratamento:", error);
});

process.on("uncaughtException", error => {
  console.error("Erro não tratado:", error);
});
client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;
  try {
  if (interaction.commandName === "ia") {
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
      const stock = await getStock();
      const state = readState();
      state.stockSignatures = state.stockSignatures || {};
      const normal = stock.filter(item => String(item.type || "").toLowerCase() === "normal");
      const mirage = stock.filter(item => String(item.type || "").toLowerCase() === "mirage");
      if (normal.length) await postStock(normal, true, stockTitle("normal"), "normal");
      if (mirage.length) await postStock(mirage, true, stockTitle("mirage"), "mirage");
      state.stockSignatures.normal = signature(normal);
      state.stockSignatures.mirage = signature(mirage);
      state.latestStock = state.latestStock || {};
      if (normal.length) state.latestStock.normal = normal;
      if (mirage.length) state.latestStock.mirage = mirage;
      state.history.unshift({ at: new Date().toISOString(), stock });
      state.history = state.history.slice(0, Number(readConfig().historyLimit || 20));
      saveState(state);
      await interaction.editReply("Stocks normal e Mirage consultados e publicados em mensagens separadas!");
    } catch (e) { await interaction.editReply(`Falha: ${e.message}`); }
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
