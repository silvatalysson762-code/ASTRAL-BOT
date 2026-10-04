require("dotenv").config();
const fs = require("node:fs");
const path = require("node:path");
const {
  Client, GatewayIntentBits, EmbedBuilder, REST, Routes,
  SlashCommandBuilder, PermissionFlagsBits
} = require("discord.js");

const required = ["DISCORD_TOKEN", "CLIENT_ID", "GUILD_ID", "CHANNEL_ID", "STOCK_API_URL"];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`Configuração ausente: ${key}. Veja o arquivo .env.example.`);
    process.exit(1);
  }
}
const POLL_SECONDS = Math.max(60, Number(process.env.POLL_SECONDS || 300));
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
  for (let i = 0; i < 2 && typeof data === "string"; i++) {
    try { data = JSON.parse(data); } catch { break; }
  }
  if (data && data.data) data = data.data;
  if (data && data.stock) data = data.stock;
  if (data && data.result) data = data.result;
  if (data && data.normal) {
    const list = [];
    for (const item of data.normal || []) list.push({ name: item.name || item, price: item.price, type: "Normal" });
    for (const item of data.raren || data.rare || []) list.push({ name: item.name || item, price: item.price, type: "Rare" });
    if (list.length) return list;
  }
  if (Array.isArray(data)) return data.map(x => typeof x === "string" ? { name:x } : x);
  if (data && typeof data === "object") {
    const list = [];
    for (const [type, value] of Object.entries(data)) {
      if (Array.isArray(value)) for (const x of value) list.push(typeof x === "string" ? {name:x,type} : {...x,type:x.type || type});
    }
    if (list.length) return list;
  }
  throw new Error("Formato da API não reconhecido. Confira STOCK_API_URL e o formato retornado.");
}
async function getStock() {
  const response = await fetch(process.env.STOCK_API_URL, {
    headers: { "Accept":"application/json", ...(process.env.STOCK_API_KEY ? { "Authorization": `Bearer ${process.env.STOCK_API_KEY}` } : {}) },
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`API respondeu HTTP ${response.status}`);
  return normalizeStock(await response.json());
}
function signature(stock) {
  return JSON.stringify(stock.map(x => ({name:String(x.name || x.Name || x фрукт || "Desconhecida").toLowerCase(), price:x.price || x.Price || "", type:x.type || ""})).sort((a,b)=>a.name.localeCompare(b.name)));
}
function safeName(item) { return String(item.name || item.Name || item.fruit || item.Fruit || "Fruta desconhecida"); }
function roleMentions(stock) {
  const roles = readConfig().roles || {};
  const mentions = [];
  for (const item of stock) {
    const key = safeName(item).toLowerCase();
    const id = roles[key];
    if (id && /^\d{17,20}$/.test(String(id))) mentions.push(`<@&${id}>`);
  }
  return [...new Set(mentions)].join(" ");
}
function stockEmbed(stock, title = "🍈 Blox Fruits | Stock atual") {
  const embed = new EmbedBuilder().setColor(0x7c3aed).setTitle(title)
    .setDescription(stock.length ? stock.map(x => {
      const price = x.price || x.Price;
      const type = x.type ? ` • ${x.type}` : "";
      return `• **${safeName(x)}**${price ? ` | ${price}` : ""}${type}`;
    }).join("\n") : "Nenhuma fruta encontrada.")
    .setFooter({ text:"Atualização automática • Confira no jogo antes de negociar" })
    .setTimestamp();
  return embed;
}
async function postStock(stock, announce) {
  const channel = await client.channels.fetch(process.env.CHANNEL_ID);
  if (!channel || !channel.isTextBased() || !channel.send) throw new Error("CHANNEL_ID não é um canal de texto acessível.");
  const content = announce ? roleMentions(stock) : "";
  await channel.send({ content: content || undefined, embeds:[stockEmbed(stock)] });
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
      state.history.unshift({ at:new Date().toISOString(), stock });
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
  const rest = new REST({ version:"10" }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body:commands.map(c=>c.toJSON()) });
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
    try { await interaction.editReply({ embeds:[stockEmbed(await getStock())] }); }
    catch (e) { await interaction.editReply(`Não consegui consultar o stock: ${e.message}`); }
  } else if (interaction.commandName === "atualizar") {
    await interaction.deferReply({ ephemeral:true });
    try { const stock = await getStock(); lastSignature = signature(stock); await postStock(stock, true); await interaction.editReply("Stock consultado e publicado!"); }
    catch (e) { await interaction.editReply(`Falha: ${e.message}`); }
  } else if (interaction.commandName === "historico") {
    const history = readState().history || [];
    const text = history.slice(0,5).map((h,i)=>`**${i+1}.** <t:${Math.floor(new Date(h.at).getTime()/1000)}:R> • ${(h.stock||[]).map(safeName).join(", ") || "Sem dados"}`).join("\n");
    await interaction.reply({ content:text || "Ainda não há histórico de alterações.", ephemeral:true });
  }
});
client.login(process.env.DISCORD_TOKEN);
