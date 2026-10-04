require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");
const {
  Client, GatewayIntentBits, MessageFlags, ContainerBuilder, TextDisplayBuilder, REST, Routes,
  SlashCommandBuilder, PermissionFlagsBits
} = require("discord.js");

const required = ["DISCORD_TOKEN", "CLIENT_ID", "GUILD_ID", "CHANNEL_ID", "STOCK_API_URL", "STOCK_API_KEY"];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`Configuração ausente: ${key}. Veja o arquivo .env.example.`);
    process.exit(1);
  }
}
const CONFIG_PATH = path.join(__dirname, "config.json");
const STATE_PATH = path.join(__dirname, "data", "state.json");
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

let checking = false;

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); }
  catch { return { roles: {}, emojis: {}, aliases: {}, historyLimit: 20 }; }
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
    beli: x.money_price || x.price_beli || x.price || "",
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
function stockContainer(stock, title) {
  const lines = stock.map(item =>
    `${fruitEmoji(item)} **${safeName(item)}**${item.money_price ? ` | 💰 ${Number(item.money_price).toLocaleString("en-US")} Beli` : ""}${item.robux_price ? ` | ${item.robux_price} Robux` : ""}`
  );
  const mentions = roleMentions(stock);
  const body = [
    `# ${title}`,
    "",
    mentions,
    ...(lines.length ? lines : ["Nenhuma fruta encontrada."]),
    "",
    "-# Dados de stock • Confira no jogo antes de negociar"
  ].filter(Boolean).join("\n");
  return new ContainerBuilder()
    .setAccentColor(0x7c3aed)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(body));
}
async function postStock(stock, announce, title = "🍈 Blox Fruits | Stock atualizado") {
  const channel = await client.channels.fetch(process.env.CHANNEL_ID);
  if (!channel || !channel.isTextBased() || !channel.send) throw new Error("CHANNEL_ID não é um canal de texto acessível.");
  await channel.send({ components: [stockContainer(stock, title)], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: ["roles"] } });
}
async function checkStock(force = false, onlyGroups = ["normal", "mirage"]) {
  if (checking) return;
  checking = true;
  try {
    const stock = await getStock();
    const state = readState();
    state.stockSignatures = state.stockSignatures || {};
    const groups = [
      { key: "normal", type: "Normal", title: "🏪 Blox Fruits | Stock normal atualizado" },
      { key: "mirage", type: "Mirage", title: "🌙 Blox Fruits | Stock da Mirage atualizado" }
    ].filter(group => onlyGroups.includes(group.key));

    for (const group of groups) {
      const items = stock.filter(item => String(item.type || "").toLowerCase() === group.type.toLowerCase());
      const sig = signature(items);
      const previous = state.stockSignatures[group.key];

      if (items.length && (force || (previous && sig !== previous))) {
        await postStock(items, true, group.title);
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
const ALL_FRUITS = [
  "Rocket", "Spin", "Blade", "Spring", "Bomb", "Smoke", "Spike", "Flame", "Ice", "Sand",
  "Dark", "Eagle", "Diamond", "Light", "Rubber", "Ghost", "Magma", "Quake", "Buddha", "Love",
  "Creation", "Spider", "Sound", "Phoenix", "Portal", "Lightning", "Pain", "Blizzard", "Gravity",
  "Mammoth", "T-Rex", "Dough", "Shadow", "Venom", "Gas", "Spirit", "Tiger", "Yeti", "Kitsune",
  "Control", "Dragon"
];

async function testStockContainers() {
  const config = readConfig();
  const emojis = config.emojis || {};
  const liveStock = await getStock();
  const priceByFruit = new Map(
    liveStock.map(item => [fruitKey(safeName(item)), item.money_price || item.price_beli || item.price || null])
  );
  const groups = [
    { title: "🟢 FRUTAS COMUNS", fruits: ["Rocket", "Spin", "Blade", "Spring", "Bomb", "Smoke", "Spike"] },
    { title: "🔵 FRUTAS RARAS", fruits: ["Flame", "Ice", "Sand", "Dark", "Eagle", "Diamond", "Light", "Rubber", "Ghost", "Magma", "Quake"] },
    { title: "🟣 FRUTAS LENDÁRIAS", fruits: ["Buddha", "Love", "Creation", "Spider", "Sound", "Phoenix", "Portal", "Lightning", "Pain", "Blizzard", "Gravity"] },
    { title: "🟡 FRUTAS MÍTICAS", fruits: ["Mammoth", "T-Rex", "Dough", "Shadow", "Venom", "Gas", "Spirit", "Tiger", "Yeti", "Kitsune", "Control", "Dragon"] }
  ];

  return groups.map(group => {
    const lines = group.fruits.map(name => {
      const emoji = emojis[fruitKey(name)] || "🍈";
      const price = priceByFruit.get(fruitKey(name));
      const priceText = price ? `💰 ${Number(price).toLocaleString("en-US")} Beli` : "💰 Valor não retornado pela API";
      return `${emoji} **${name}** • ${priceText}`;
    });
    const body = [`# ${group.title}`, "", ...lines].join("\\n");
    return new ContainerBuilder()
      .setAccentColor(0x7c3aed)
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(body));
  });
}

const fruitOption = (option) => option.setName("fruta").setDescription("Nome da fruta exatamente como aparece no stock").setRequired(true);
const commands = [
  new SlashCommandBuilder().setName("stock").setDescription("Mostra o stock atual de Blox Fruits"),
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
  console.log("Comandos de stock, cargos e emojis registrados.");
}
client.once("ready", async () => {
  console.log(`Bot conectado como ${client.user.tag}`);
  try {
    await registerCommands();
    await checkStock(false, ["normal", "mirage"]);
  } catch (error) {
    console.error("Erro na inicialização do Astral Stock:", error);
  }

  const NORMAL_INTERVAL = 4 * 60 * 60 * 1000;
  const MIRAGE_INTERVAL = 2 * 60 * 60 * 1000;

  console.log("Agendamento automático: Stock normal a cada 4 horas; Stock da Mirage a cada 2 horas.");
  setInterval(() => checkStock(false, ["normal"]), NORMAL_INTERVAL);
  setInterval(() => checkStock(false, ["mirage"]), MIRAGE_INTERVAL);
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
  if (interaction.commandName === "testeestoque") {
    await interaction.reply({ components: await testStockContainers(), flags: MessageFlags.IsComponentsV2 });
  } else if (interaction.commandName === "stock") {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 });
    try {
      const stock = await getStock();
      const normal = stock.filter(item => item.type === "Normal");
      const mirage = stock.filter(item => item.type === "Mirage");
      const components = [];
      if (normal.length) components.push(stockContainer(normal, "🏪 ESTOQUE NORMAL"));
      if (mirage.length) components.push(stockContainer(mirage, "🌙 ESTOQUE DA MIRAGE"));
      if (!components.length) components.push(stockContainer([], "🍈 STOCK ATUAL"));
      await interaction.editReply({ components });
    } catch (e) {
      await interaction.editReply({ components: [stockContainer([], "Não consegui consultar o stock: " + e.message)] });
    }
  } else if (interaction.commandName === "atualizar") {
    await interaction.deferReply({ ephemeral: true });
    try {
      const stock = await getStock();
      const state = readState();
      state.stockSignatures = state.stockSignatures || {};
      const normal = stock.filter(item => item.type === "Normal");
      const mirage = stock.filter(item => item.type === "Mirage");
      if (normal.length) await postStock(normal, true, "🏪 Blox Fruits | Stock normal atualizado");
      if (mirage.length) await postStock(mirage, true, "🌙 Blox Fruits | Stock da Mirage atualizado");
      state.stockSignatures.normal = signature(normal);
      state.stockSignatures.mirage = signature(mirage);
      state.history.unshift({ at: new Date().toISOString(), stock });
      state.history = state.history.slice(0, Number(readConfig().historyLimit || 20));
      saveState(state);
      await interaction.editReply("Stocks normal e Mirage consultados e publicados em mensagens separadas!");
    } catch (e) { await interaction.editReply(`Falha: ${e.message}`); }
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
    const content = Object.entries(emojis).map(([fruit, emoji]) => `• ${emoji} **${fruit}**`).join("\\n");
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
    const content = entries.map(([fruit, id]) => `• **${fruit}**: <@&${id}>`).join("\\n");
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
