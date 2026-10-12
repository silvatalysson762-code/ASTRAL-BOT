const fs = require("node:fs");
const path = require("node:path");
const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ContainerBuilder,
  TextDisplayBuilder,
  MessageFlags
} = require("discord.js");

const CONFIG_PATH = path.join(__dirname, "config.json");
const CHANNELS = {
  welcomeChannelId: "Canal de boas-vindas",
  goodbyeChannelId: "Canal de saída de membros",
  memberLogChannelId: "Logs de membros",
  messageLogChannelId: "Logs de mensagens",
  moderationLogChannelId: "Logs de moderação",
  serverLogChannelId: "Logs do servidor",
  ticketLogChannelId: "Logs de tickets",
  announcementChannelId: "Anúncios",
  suggestionChannelId: "Sugestões",
  stockChannelId: "Stock Blox Fruits (Normal/Mirage)",
  stockAlertChannelId: "Alertas do Stock Blox Fruits"
};
const DEFAULTS = {
  welcomeEnabled: true,
  goodbyeEnabled: true,
  welcomeMessage: "👋 Bem-vindo(a) {user} ao **{server}**! Você é o membro **#{memberCount}**.",
  goodbyeMessage: "👋 **{username}** saiu do servidor **{server}**.",
  welcomeImageUrl: "",
  goodbyeImageUrl: "",
  welcomeTitle: "**Bem-Vindo a {server}**",
  goodbyeTitle: "**Até logo!**",
  welcomeColor: "301934",
  goodbyeColor: "ED4245",
  welcomeDeleteAfter: 0,
  goodbyeDeleteAfter: 0,
  welcomeMode: "embed",
  goodbyeMode: "embed"
};

function readConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    parsed.guilds = parsed.guilds || {};
    return parsed;
  } catch {
    return { guilds: {}, historyLimit: 20 };
  }
}
function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}
function getSettings(guildId) {
  const root = readConfig();
  root.guilds[guildId] = root.guilds[guildId] || {};
  const guildConfig = root.guilds[guildId];
  return {
    ...DEFAULTS,
    ...(guildConfig.serverSettings || {}),
    stockChannelId: guildConfig.channelId || guildConfig.serverSettings?.stockChannelId || null,
    stockAlertChannelId: guildConfig.stockAlertChannelId || guildConfig.serverSettings?.stockAlertChannelId || null
  };
}
function updateSettings(guildId, updater) {
  const root = readConfig();
  root.guilds[guildId] = root.guilds[guildId] || {};
  const guildConfig = root.guilds[guildId];
  const settings = {
    ...DEFAULTS,
    ...(guildConfig.serverSettings || {}),
    stockChannelId: guildConfig.channelId || guildConfig.serverSettings?.stockChannelId || null,
    stockAlertChannelId: guildConfig.stockAlertChannelId || guildConfig.serverSettings?.stockAlertChannelId || null
  };
  updater(settings);
  const stockChannelId = settings.stockChannelId;
  const stockAlertChannelId = settings.stockAlertChannelId;
  delete settings.stockChannelId;
  delete settings.stockAlertChannelId;
  guildConfig.serverSettings = settings;
  if (stockChannelId !== undefined) guildConfig.channelId = stockChannelId;
  if (stockAlertChannelId !== undefined) guildConfig.stockAlertChannelId = stockAlertChannelId;
  saveConfig(root);
  return { ...settings, stockChannelId, stockAlertChannelId };
}
function render(template, member) {
  return String(template || "")
    .replaceAll("{user}", "<@" + member.id + ">")
    .replaceAll("{username}", member.user.username)
    .replaceAll("{server}", member.guild.name)
    .replaceAll("{memberCount}", String(member.guild.memberCount))
    .replaceAll("{id}", member.id);
}
function safeText(value, max = 1800) {
  return String(value || "").slice(0, max);
}
async function sendLog(guild, key, embed) {
  try {
    const settings = getSettings(guild.id);
    const channelId = settings[key];
    if (!channelId) return;
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased() || !channel.send) return;
    await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
  } catch (error) {
    console.warn("[GUILD SETTINGS] Falha ao enviar log:", error?.message || error);
  }
}

async function logTicket(guild, title, description, color = 0x5865F2) {
  if (!guild) return;
  await sendLog(guild, "ticketLogChannelId", makeEmbed(title, description, color));
}
function makeEmbed(title, description, color = 0x5865F2) {
  return new EmbedBuilder().setColor(color).setTitle(title).setDescription(safeText(description, 3900)).setTimestamp();
}
function panel(guild) {
  const s = getSettings(guild.id);
  const channelValue = key => s[key] ? "<#" + s[key] + ">" : "`Não configurado`";
  const description = [
    "# 📡 CANAIS DO SERVIDOR",
    "> Selecione uma categoria e depois escolha o canal.",
    ">",
    "> **👋 Boas-vindas:** " + channelValue("welcomeChannelId"),
    "> **🚪 Saídas:** " + channelValue("goodbyeChannelId"),
    "> **🧾 Logs de membros:** " + channelValue("memberLogChannelId"),
    "> **💬 Logs de mensagens:** " + channelValue("messageLogChannelId"),
    "> **🛡️ Logs de moderação:** " + channelValue("moderationLogChannelId"),
    "> **🗂️ Logs do servidor:** " + channelValue("serverLogChannelId"),
    "> **🎫 Logs de tickets:** " + channelValue("ticketLogChannelId"),
    "> **📢 Anúncios:** " + channelValue("announcementChannelId"),
    "> **💡 Sugestões:** " + channelValue("suggestionChannelId"),
    "> **🍈 Stock:** " + channelValue("stockChannelId"),
    "> **🔔 Alertas de stock:** " + channelValue("stockAlertChannelId"),
    "-# ASTRAL STORE • Configuração de canais"
  ].join("\n");
  const categoryRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("guildcfg:category")
      .setPlaceholder("① Escolha o tipo de canal")
      .addOptions(Object.entries(CHANNELS).map(([value, label]) => ({
        label,
        value,
        description: "Configurar " + label.toLowerCase()
      })))
  );
  const channelRow = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId("guildcfg:channel")
      .setPlaceholder("② Selecione o canal do servidor")
      .setChannelTypes(ChannelType.GuildText)
  );
  const buttonsRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("panel:config").setLabel("Voltar").setEmoji("<:arrow_left:1557204764834537534>").setStyle(ButtonStyle.Secondary)
  );
  const container = new ContainerBuilder()
    .setAccentColor(0x00FFFF)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(description))
    .addActionRowComponents(categoryRow, channelRow, buttonsRow);
  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}
function buildWelcomeLandingPanel(guild) {
  const s = getSettings(guild.id);
  const welcomeChannel = s.welcomeChannelId ? "<#" + s.welcomeChannelId + ">" : "Não configurado";
  const goodbyeChannel = s.goodbyeChannelId ? "<#" + s.goodbyeChannelId + ">" : "Não configurado";
  const container = new ContainerBuilder()
    .setAccentColor(0x00FFFF)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent([
      "# <:entrada:1559285231301951569> BOAS-VINDAS / SAÍDAS",
      "┃ Configure separadamente as mensagens de entrada e saída do servidor.",
      "┃",
      "┃ **<:62565:1559293995840970764> Boas-vindas**",
      "┃ Canal: " + welcomeChannel,
      "┃ Status: " + (s.welcomeEnabled ? "Ativado" : "Desativado"),
      "┃",
      "┃ **<:62548:1559294145737138218> Saída**",
      "┃ Canal: " + goodbyeChannel,
      "┃ Status: " + (s.goodbyeEnabled ? "Ativado" : "Desativado"),
      "-# ASTRAL STORE • Mensagens de membros"
    ].join("\n")))
    .addActionRowComponents(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("guildcfg:open_welcome").setLabel("Boas-vindas").setEmoji("<:62565:1559293995840970764>").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("guildcfg:open_goodbye").setLabel("Saída").setEmoji("<:62548:1559294145737138218>").setStyle(ButtonStyle.Danger)
    ))
    .addActionRowComponents(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("panel:config").setLabel("Voltar").setEmoji("<:arrow_left:1557204764834537534>").setStyle(ButtonStyle.Secondary)
    ));
  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

function messagePanel(guild, type) {
  const s = getSettings(guild.id);
  const welcome = type === "welcome";
  const prefix = welcome ? "welcome" : "goodbye";
  const title = welcome ? "BOAS-VINDAS" : "SAÍDAS";
  const channelId = s[prefix + "ChannelId"];
  const mode = s[prefix + "Mode"] || "embed";
  const message = s[prefix + "Message"];
  const appearance = s[prefix + "Title"] || (welcome ? "**Bem-Vindo a {server}**" : "**Até logo!**");
  const color = s[prefix + "Color"] || (welcome ? "301934" : "ED4245");
  const image = s[prefix + "ImageUrl"];
  const deleteAfter = Number(s[prefix + "DeleteAfter"] || 0);
  return {
    embeds: [new EmbedBuilder().setColor(welcome ? 0x57F287 : 0xED4245)
      .setTitle("┃ " + (welcome ? "👋 " : "🚪 ") + title)
      .setDescription([
        "┃ **Canal:** " + (channelId ? "<#" + channelId + ">" : "`Não configurado`"),
        "┃ **Status:** " + (s[prefix + "Enabled"] ? "Ativado" : "Desativado"),
        "┃ **Modo atual:** " + (mode === "v2" ? "Container V2" : "Mensagem normal"),
        "┃",
        "┃ **Mensagem**",
        ...safeText(message, 900).split("\n").map(line => "┃ " + line),
        "┃",
        "┃ **Tempo para apagar:** " + (deleteAfter === 0 ? "Nunca" : deleteAfter + " segundos"),
        "┃ **Título:** " + safeText(appearance, 150),
        "┃ **Cor:** #" + color,
        "┃ **Imagem/GIF:** " + (image || "Não configurada"),
        "┃",
        "┃ **Variáveis disponíveis**",
        "┃ `{user}` • `{username}` • `{server}` • `{memberCount}` • `{id}`"
      ].join("\n"))
      .setFooter({ text: "ASTRAL STORE • Mensagens de entrada e saída" })],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("guildcfg:edit_" + prefix).setLabel("Mensagem & Tempo").setEmoji("✏️").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("guildcfg:appearance_" + prefix).setLabel("Aparência").setEmoji("⚙️").setStyle(ButtonStyle.Primary)
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("guildcfg:toggle_mode_" + prefix).setLabel(mode === "v2" ? "Usar Mensagem" : "Usar Container V2").setEmoji(mode === "v2" ? "👁️" : "📦").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("guildcfg:preview_" + prefix).setLabel("Preview").setEmoji("👁️").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("guildcfg:toggle_" + prefix).setLabel(s[prefix + "Enabled"] ? "Desabilitar" : "Habilitar").setEmoji("🔄").setStyle(s[prefix + "Enabled"] ? ButtonStyle.Danger : ButtonStyle.Success)
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("guildcfg:home").setLabel("Voltar").setEmoji("<:arrow_left:1557204764834537534>").setStyle(ButtonStyle.Secondary)
      )
    ]
  };
}
function makeWelcomePayload(member, settings, type) {
  const welcome = type === "welcome";
  const prefix = welcome ? "welcome" : "goodbye";
  const text = render(settings[prefix + "Message"], member);
  const title = render(settings[prefix + "Title"] || (welcome ? "**Bem-Vindo a {server}**" : "**Até logo!**"), member);
  const image = settings[prefix + "ImageUrl"];
  const hex = String(settings[prefix + "Color"] || (welcome ? "301934" : "ED4245")).replace(/^#/, "");
  const color = /^[0-9a-f]{6}$/i.test(hex) ? parseInt(hex, 16) : (welcome ? 0x301934 : 0xED4245);
  if (settings[prefix + "Mode"] === "v2") {
    const container = new ContainerBuilder().setAccentColor(color)
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(title + "\n\n" + text));
    if (image) container.addTextDisplayComponents(new TextDisplayBuilder().setContent(image));
    return { components: [container], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [], users: welcome ? [member.id] : [] } };
  }
  const embed = new EmbedBuilder().setColor(color).setDescription(safeText(text, 3900));
  if (title) embed.setTitle(safeText(title, 256));
  embed.setThumbnail(member.user.displayAvatarURL({ size: 256 }));
  if (image) embed.setImage(image);
  return { embeds: [embed], allowedMentions: { parse: [], users: welcome ? [member.id] : [] } };
}
const selectedCategory = new Map();
const commands = [];
async function handleInteraction(interaction) {
  if (interaction.isChatInputCommand() && interaction.commandName === "config-servidor") {
    if (!interaction.guild) {
      await interaction.reply({ content: "Use este comando dentro de um servidor.", ephemeral: true });
      return true;
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({ content: "Você precisa da permissão Gerenciar Servidor.", ephemeral: true });
      return true;
    }
    await interaction.reply({ ...panel(interaction.guild), ephemeral: true });
    return true;
  }
  if (!interaction.customId?.startsWith("guildcfg:")) return false;
  if (!interaction.guild || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({ content: "Você precisa da permissão Gerenciar Servidor.", ephemeral: true }).catch(() => {});
    return true;
  }
  const id = interaction.customId;
  if (interaction.isStringSelectMenu() && id === "guildcfg:category") {
    selectedCategory.set(interaction.guildId + ":" + interaction.user.id, interaction.values[0]);
    await interaction.update(panel(interaction.guild));
    return true;
  }
  if (interaction.isChannelSelectMenu() && id === "guildcfg:channel") {
    const key = selectedCategory.get(interaction.guildId + ":" + interaction.user.id);
    if (!key || !Object.hasOwn(CHANNELS, key)) {
      await interaction.reply({ content: "Primeiro escolha a categoria no seletor de cima.", ephemeral: true });
      return true;
    }
    const channelId = interaction.values[0];
    updateSettings(interaction.guildId, s => { s[key] = channelId; });
    await interaction.update(panel(interaction.guild));
    return true;
  }
  if (interaction.isButton() && (id === "guildcfg:open_welcome" || id === "guildcfg:open_goodbye")) {
    await interaction.update(messagePanel(interaction.guild, id.endsWith("open_welcome") ? "welcome" : "goodbye"));
    return true;
  }
  if (interaction.isButton() && id === "guildcfg:home") {
    await interaction.update(panel(interaction.guild));
    return true;
  }
  if (interaction.isButton() && /^guildcfg:toggle_mode_(welcome|goodbye)$/.test(id)) {
    const prefix = id.endsWith("_welcome") ? "welcome" : "goodbye";
    updateSettings(interaction.guildId, s => { s[prefix + "Mode"] = s[prefix + "Mode"] === "v2" ? "embed" : "v2"; });
    await interaction.update(messagePanel(interaction.guild, prefix));
    return true;
  }
  if (interaction.isButton() && /^guildcfg:toggle_(welcome|goodbye)$/.test(id)) {
    const prefix = id.endsWith("_welcome") ? "welcome" : "goodbye";
    updateSettings(interaction.guildId, s => { s[prefix + "Enabled"] = !s[prefix + "Enabled"]; });
    await interaction.update(messagePanel(interaction.guild, prefix));
    return true;
  }
  if (interaction.isButton() && /^guildcfg:(edit|appearance)_(welcome|goodbye)$/.test(id)) {
    const parts = id.split("_");
    const kind = parts[0].split(":")[1];
    const prefix = parts[1];
    const s = getSettings(interaction.guildId);
    const welcome = prefix === "welcome";
    const modal = new ModalBuilder()
      .setCustomId("guildcfg:modal_" + kind + "_" + prefix)
      .setTitle(kind === "edit" ? (welcome ? "Mensagem & Tempo" : "Mensagem & Tempo") : "Aparência da Mensagem");
    if (kind === "edit") {
      modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("message").setLabel("Mensagem enviada (use variáveis)").setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1800).setValue(s[prefix + "Message"])),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("deleteAfter").setLabel("Auto-deletar em segundos (0 = nunca)").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(6).setValue(String(s[prefix + "DeleteAfter"] || 0)))
      );
    } else {
      modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("title").setLabel("Título da mensagem (opcional)").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(256).setValue(s[prefix + "Title"] || (welcome ? "**Bem-Vindo a {server}**" : "**Até logo!**"))),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("color").setLabel("Cor da embed (hex)").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(7).setValue("#" + (s[prefix + "Color"] || (welcome ? "301934" : "ED4245")))),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("image").setLabel("Imagem/GIF - URL (opcional)").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(500).setValue(s[prefix + "ImageUrl"] || ""))
      );
    }
    await interaction.showModal(modal);
    return true;
  }
  if (interaction.isModalSubmit() && /^guildcfg:modal_(edit|appearance)_(welcome|goodbye)$/.test(id)) {
    const parts = id.split("_");
    const kind = parts[1];
    const prefix = parts[2];
    if (kind === "edit") {
      const message = interaction.fields.getTextInputValue("message");
      const rawSeconds = interaction.fields.getTextInputValue("deleteAfter").trim();
      const seconds = Number(rawSeconds);
      if (!Number.isInteger(seconds) || seconds < 0 || seconds > 86400) {
        await interaction.reply({ content: "O tempo deve ser um número inteiro entre 0 e 86400 segundos.", ephemeral: true });
        return true;
      }
      updateSettings(interaction.guildId, s => { s[prefix + "Message"] = message; s[prefix + "DeleteAfter"] = seconds; });
    } else {
      const title = interaction.fields.getTextInputValue("title");
      const rawColor = interaction.fields.getTextInputValue("color").trim().replace(/^#/, "");
      const image = interaction.fields.getTextInputValue("image").trim();
      if (!/^[0-9a-f]{6}$/i.test(rawColor)) {
        await interaction.reply({ content: "A cor precisa ser HEX, por exemplo #301934.", ephemeral: true });
        return true;
      }
      if (image && !/^https:\/\//i.test(image)) {
        await interaction.reply({ content: "A imagem precisa usar um endereço HTTPS.", ephemeral: true });
        return true;
      }
      updateSettings(interaction.guildId, s => { s[prefix + "Title"] = title; s[prefix + "Color"] = rawColor.toUpperCase(); s[prefix + "ImageUrl"] = image; });
    }
    await interaction.reply({ content: "Configuração salva! Reabra o painel da mensagem para conferir.", ephemeral: true });
    return true;
  }
  if (interaction.isButton() && /^guildcfg:preview_(welcome|goodbye)$/.test(id)) {
    const prefix = id.endsWith("_welcome") ? "welcome" : "goodbye";
    const s = getSettings(interaction.guildId);
    const channelId = s[prefix + "ChannelId"];
    const channel = channelId ? await interaction.guild.channels.fetch(channelId).catch(() => null) : null;
    if (!channel?.isTextBased?.() || !channel.send) {
      await interaction.reply({ content: "Configure primeiro um canal válido para esta mensagem.", ephemeral: true });
      return true;
    }
    const fakeMember = { id: interaction.user.id, user: interaction.user, guild: interaction.guild };
    const payload = makeWelcomePayload(fakeMember, s, prefix);
    const sent = await channel.send(payload);
    const seconds = Number(s[prefix + "DeleteAfter"] || 0);
    if (seconds > 0) setTimeout(() => sent.delete().catch(() => {}), seconds * 1000).unref?.();
    await interaction.reply({ content: "Preview enviada para " + channel.toString() + ".", ephemeral: true });
    return true;
  }


  return false;
}
function register(client) {
  client.on("guildMemberAdd", async member => {
    const s = getSettings(member.guild.id);
    if (s.welcomeEnabled && s.welcomeChannelId) {
      const channel = await member.guild.channels.fetch(s.welcomeChannelId).catch(() => null);
      if (channel?.isTextBased?.() && channel.send) {
        const sent = await channel.send(makeWelcomePayload(member, s, "welcome")).catch(error => { console.warn("[WELCOME] Falha:", error?.message || error); return null; });
        const seconds = Number(s.welcomeDeleteAfter || 0);
        if (sent && seconds > 0) setTimeout(() => sent.delete().catch(() => {}), seconds * 1000).unref?.();
      }
    }
    await sendLog(member.guild, "memberLogChannelId", makeEmbed("Membro entrou", member.user.tag + " (" + member.id + ")", 0x57F287));
  });
  client.on("guildMemberRemove", async member => {
    const s = getSettings(member.guild.id);
    if (s.goodbyeEnabled && s.goodbyeChannelId) {
      const channel = await member.guild.channels.fetch(s.goodbyeChannelId).catch(() => null);
      if (channel?.isTextBased?.() && channel.send) {
        const sent = await channel.send(makeWelcomePayload(member, s, "goodbye")).catch(error => { console.warn("[GOODBYE] Falha:", error?.message || error); return null; });
        const seconds = Number(s.goodbyeDeleteAfter || 0);
        if (sent && seconds > 0) setTimeout(() => sent.delete().catch(() => {}), seconds * 1000).unref?.();
      }
    }
    await sendLog(member.guild, "memberLogChannelId", makeEmbed("Membro saiu", member.user.tag + " (" + member.id + ")", 0xED4245));
  });
  client.on("messageDelete", async message => {
    if (!message.guild || message.author?.bot) return;
    const detail = "Canal: <#" + message.channelId + ">\nAutor: " + (message.author ? message.author.tag + " (" + message.author.id + ")" : "desconhecido") + "\nConteúdo: " + (message.content ? safeText(message.content, 2500) : "(sem conteúdo em cache)");
    await sendLog(message.guild, "messageLogChannelId", makeEmbed("Mensagem apagada", detail, 0xED4245));
  });
  client.on("messageUpdate", async (oldMessage, newMessage) => {
    if (!newMessage.guild || newMessage.author?.bot) return;
    if (oldMessage.content === newMessage.content) return;
    const detail = "Canal: <#" + newMessage.channelId + ">\nAutor: " + (newMessage.author?.tag || "desconhecido") + "\nAntes: " + safeText(oldMessage.content || "(não estava em cache)", 1400) + "\nDepois: " + safeText(newMessage.content || "(vazio)", 1400);
    await sendLog(newMessage.guild, "messageLogChannelId", makeEmbed("Mensagem editada", detail, 0xFEE75C));
  });
  client.on("guildMemberUpdate", async (oldMember, newMember) => {
    const added = newMember.roles.cache.filter(role => !oldMember.roles.cache.has(role.id)).map(role => "<@&" + role.id + ">");
    const removed = oldMember.roles.cache.filter(role => !newMember.roles.cache.has(role.id)).map(role => "<@&" + role.id + ">");
    const changes = [];
    if (added.length) changes.push("Cargos adicionados: " + added.join(", "));
    if (removed.length) changes.push("Cargos removidos: " + removed.join(", "));
    if (oldMember.nickname !== newMember.nickname) changes.push("Apelido: " + (oldMember.nickname || oldMember.user.username) + " → " + (newMember.nickname || newMember.user.username));
    if (changes.length) await sendLog(newMember.guild, "memberLogChannelId", makeEmbed("Membro atualizado", newMember.user.tag + " (" + newMember.id + ")\\n" + changes.join("\\n"), 0xFEE75C));
  });
  client.on("channelCreate", channel => {
    if (channel.guild) sendLog(channel.guild, "serverLogChannelId", makeEmbed("Canal criado", channel.name + " (" + channel.id + ")", 0x57F287));
  });
  client.on("channelDelete", channel => {
    if (channel.guild) sendLog(channel.guild, "serverLogChannelId", makeEmbed("Canal excluído", channel.name + " (" + channel.id + ")", 0xED4245));
  });
  client.on("roleCreate", role => sendLog(role.guild, "serverLogChannelId", makeEmbed("Cargo criado", role.name + " (" + role.id + ")", 0x57F287)));
  client.on("roleDelete", role => sendLog(role.guild, "serverLogChannelId", makeEmbed("Cargo excluído", role.name + " (" + role.id + ")", 0xED4245)));
  client.on("guildBanAdd", ban => sendLog(ban.guild, "moderationLogChannelId", makeEmbed("Membro banido", ban.user.tag + " (" + ban.user.id + ")", 0xED4245)));
  client.on("guildBanRemove", ban => sendLog(ban.guild, "moderationLogChannelId", makeEmbed("Banimento removido", ban.user.tag + " (" + ban.user.id + ")", 0x57F287)));
}
module.exports = { commands, handleInteraction, register, buildPanel: panel, buildWelcomeLandingPanel, logTicket };
