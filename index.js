require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");
const {
  Client, GatewayIntentBits, EmbedBuilder, REST, Routes,
  SlashCommandBuilder, PermissionFlagsBits
} = require("discord.js");

const required = ["DISCORD_TOKEN", "CLIENT_ID", "GUILD_ID", "CHANNEL_ID", "STOCK_API_URL", "STOCK_API_KEY"];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`Configuração ausente: ${key}. Veja o arquivo .env.example.`);
    process.exit(1);
  }
}
const POLL_SECONDS = Math.max(3600, Number(process.env.POLL_SECONDS || 14400));
const CONFIG_PATH = path.join(__dirname, "config.json");
const STATE_PATH = path.join(__dirname, "data", "state.json");
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
let lastSignature = "";
let checking = false;

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); }
  catch { return { roles: {}, aliases: {}, historyLimit: 20 }; }
}
function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, "utf8")); }
  catch { return { history: [] }; }
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
    const id = roles[safeName(item).toLowerCase()];
    if (id && /^\d{17,20}$/.test(String(id))) mentions.push(`<@&${id}>`);
  }
  return [...new Set(mentions)].join(" ");
}
function stockEmbed(stock, title = "🍈 Blox Fruits | Stock atual") {
  const normal = stock.filter(x => x.type === "Normal");
  const mirage = stock.filter(x => x.type === "Mirage");
  const lines = [];
  if (normal.length) {
    lines.push("**🏪 Dealer normal**");
    for (const x of normal) lines.push(`• **${safeName(x)}**${x.money_price ? ` | $ ${Number(x.money_price).toLocaleString("en-US")}` : ""}${x.robux_price ? ` | ${x.robux_price} Robux` : ""}`);
  }
  if (mirage.length) {
    lines.push("**🌙 Dealer Mirage**");
    for (const x of mirage) lines.push(`• **${safeName(x)}**${x.money_price ? ` | $ ${Number(x.money_price).toLocaleString("en-US")}` : ""}${x.robux_price ? ` | ${x.robux_price} Robux` : ""}`);
  }
  if (!lines.length) for (const x of stock) lines.push(`• **${safeName(x)}**`);
  return new EmbedBuilder().setColor(0x7c3aed).setTitle(title)
    .setDescription(lines.join("\n") || "Nenhuma fruta encontrada.")
    .setFooter({ text: "Dados de stock • Confira no jogo antes de negociar" })
    .setTimestamp();
}
async function postStock(stock, announce) {
  const channel = await client.channels.fetch(process.env.CHANNEL_ID);
  if (!channel || !channel.isTextBased() || !channel.send) throw new Error("CHANNEL_ID não é um canal de texto acessível.");
  const content = announce ? roleMentions(stock) : "";
  await channel.send({ content: content || undefined, embeds: [stockEmbed(stock)] });
}
async function checkStock(force = false) {
  if (checking) return;
  checking = true;
  try {
    const stock = await getStock();
    const sig = signature(stock);
    if (force || (lastSignature && sig !== lastSignature)) {
      await postStock(stock, true);
      const state = readState();
      state.history.unshift({ at: new Date().toISOString(), stock });
      state.history = state.history.slice(0, Number(readConfig().historyLimit || 20));
      saveState(state);
    }
    lastSignature = sig;
    console.log(`Stock consultado: ${stock.length} frutas.`);
  } catch (error) {
    console.error("Erro ao consultar/enviar stock:", error.message);
  } finally { checking = false; }
}
const commands = [
  new SlashCommandBuilder().setName("stock").setDescription("Mostra o stock atual de Blox Fruits"),
  new SlashCommandBuilder().setName("atualizar").setDescription("Consulta e publica o stock agora").setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName("historico").setDescription("Mostra as últimas alterações de stock")
];
async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body: commands.map(c => c.toJSON()) });
  console.log("Comandos /stock, /atualizar e /historico registrados.");
}
client.once("ready", async () => {
  console.log(`Bot conectado como ${client.user.tag}`);
  await registerCommands();
  await checkStock(false);
  setInterval(() => checkStock(false), POLL_SECONDS * 1000);
});
client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === "stock") {
    await interaction.deferReply();
    try { await interaction.editReply({ embeds: [stockEmbed(await getStock())] }); }
    catch (e) { await interaction.editReply(`Não consegui consultar o stock: ${e.message}`); }
  } else if (interaction.commandName === "atualizar") {
    await interaction.deferReply({ ephemeral: true });
    try {
      const stock = await getStock();
      lastSignature = signature(stock);
      await postStock(stock, true);
      await interaction.editReply("Stock consultado e publicado!");
    } catch (e) { await interaction.editReply(`Falha: ${e.message}`); }
  } else if (interaction.commandName === "historico") {
    const history = readState().history || [];
    const content = history.slice(0, 5).map((h, i) =>
      `**${i + 1}.** <t:${Math.floor(new Date(h.at).getTime() / 1000)}:R> • ${(h.stock || []).map(safeName).join(", ") || "Sem dados"}`
    ).join("\n");
    await interaction.reply({ content: content || "Ainda não há histórico de alterações.", ephemeral: true });
  }
});
client.login(process.env.DISCORD_TOKEN);
