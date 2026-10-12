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
  welcomeThumbnailUrl: "",
  goodbyeThumbnailUrl: "",
  welcomeBannerUrl: "",
  goodbyeBannerUrl: "",
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
  const createdAt = Number(member.user?.createdTimestamp || member.user?.createdAt?.getTime?.() || Date.now());
  const accountAge = Math.max(0, Math.floor((Date.now() - createdAt) / 86400000));
  const displayName = member.displayName || member.user?.globalName || member.user?.username || "membro";
  return String(template || "")
    .replaceAll("{member}", "<@" + member.id + ">")
    .replaceAll("{user}", "<@" + member.id + ">")
    .replaceAll("{username}", member.user?.username || "usuário")
    .replaceAll("{displayname}", displayName)
    .replaceAll("{server}", member.guild.name)
    .replaceAll("{membercount}", String(member.guild.memberCount))
    .replaceAll("{memberCount}", String(member.guild.memberCount))
    .replaceAll("{createdat}", "<t:" + Math.floor(createdAt / 1000) + ":R>")
    .replaceAll("{accountage}", String(accountAge))
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
    new ButtonBuilder().setCustomId("panel:main").setLabel("Voltar").setEmoji("<:arrow_left:1557204764834537534>").setStyle(ButtonStyle.Secondary)
  );
  const container = new ContainerBuilder()
    .setAccentColor(0x00FFFF)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(description))
    .addActionRowComponents(categoryRow, channelRow, buttonsRow);
  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}
function buildWelcomeLandingPanel(guild) {
  const s = getSettings(guild.id);
  const welcomeChannel = s.welcomeChannelId ? "<#" + s.welcomeChannelId + ">" : "`Não configurado`";
  const goodbyeChannel = s.goodbyeChannelId ? "<#" + s.goodbyeChannelId + ">" : "`Não configurado`";
  const container = new ContainerBuilder()
    .setAccentColor(0x00FFFF)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent([
      "# <:entrada:1559285231301951569> BOAS-VINDAS / SAÍDAS",
      "┃ Configure as mensagens de entrada e saída separadamente.",
      "",
      "<:62565:1559293995840970764> **Boas-vindas**",
      "┃ Canal: " + welcomeChannel,
      "┃ Status: " + (s.welcomeEnabled ? "Ativado" : "Desativado"),
      "",
      "<:62548:1559294145737138218> **Saída**",
      "┃ Canal: " + goodbyeChannel,
      "┃ Status: " + (s.goodbyeEnabled ? "Ativado" : "Desativado"),
      "-# ASTRAL STORE • Mensagens de membros"
    ].join("\n")))
    .addActionRowComponents(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("guildcfg:open_welcome").setLabel("Boas-vindas").setEmoji("<:62565:1559293995840970764>").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("guildcfg:open_goodbye").setLabel("Saída").setEmoji("<:62548:1559294145737138218>").setStyle(ButtonStyle.Danger)
    ))
    .addActionRowComponents(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("panel:main").setLabel("Voltar").setEmoji("<:arrow_left:1557204764834537534>").setStyle(ButtonStyle.Secondary)
    ));
  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

const messageDrafts = new Map();
function draftKey(guildId, userId, prefix) {
  return String(guildId) + ":" + String(userId) + ":" + prefix;
}
function editableMessageSettings(guildId, userId, prefix) {
  const saved = getSettings(guildId);
  const key = draftKey(guildId, userId, prefix);
  if (!messageDrafts.has(key)) {
    messageDrafts.set(key, {
      title: saved[prefix + "Title"] || (prefix === "welcome" ? "**Bem-Vindo a {server}**" : "**Até logo!**"),
      message: saved[prefix + "Message"] || "",
      thumbnail: saved[prefix + "ThumbnailUrl"] || "",
      banner: saved[prefix + "BannerUrl"] || saved[prefix + "ImageUrl"] || ""
    });
  }
  return messageDrafts.get(key);
}
function messageEditorPanel(guild, type, userId) {
  const welcome = type === "welcome";
  const prefix = welcome ? "welcome" : "goodbye";
  const draft = editableMessageSettings(guild.id, userId, prefix);
  const saved = getSettings(guild.id);
  const original = {
    title: saved[prefix + "Title"] || (welcome ? "**Bem-Vindo a {server}**" : "**Até logo!**"),
    message: saved[prefix + "Message"] || "",
    thumbnail: saved[prefix + "ThumbnailUrl"] || "",
    banner: saved[prefix + "BannerUrl"] || saved[prefix + "ImageUrl"] || ""
  };
  const dirty = Object.keys(original).some(key => draft[key] !== original[key]);
  const container = new ContainerBuilder()
    .setAccentColor(0x00FFFF)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent([
      "# " + (welcome ? "<:62565:1559293995840970764> EDITAR BOAS-VINDAS" : "<:62548:1559294145737138218> EDITAR SAÍDA"),
      "┃ Edite os campos pelo botão abaixo. A prévia usa o rascunho atual.",
      "",
      "┃ **Título**",
      safeText(draft.title || "`Não configurado`", 180),
      "",
      "┃ **Descrição**",
      safeText(draft.message || "`Não configurada`", 500),
      "",
      "┃ **Thumbnail:** " + (draft.thumbnail ? "Configurada" : "Avatar do membro"),
      "┃ **Banner:** " + (draft.banner ? "Configurado" : "Não configurado"),
      "",
      "┃ **Variáveis**",
      "┃ `{member}` • `{username}` • `{displayname}` • `{server}`",
      "┃ `{membercount}` • `{createdat}` • `{accountage}`"
    ].join("\n")))
    .addActionRowComponents(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("guildcfg:fields_" + prefix).setLabel("Editar campos").setEmoji("✏️").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("guildcfg:preview_" + prefix).setLabel("Prévia").setEmoji("👁️").setStyle(ButtonStyle.Secondary)
    ));
  if (dirty) {
    container.addActionRowComponents(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("guildcfg:save_" + prefix).setLabel("Salvar").setEmoji("<:save:1557205052974960780>").setStyle(ButtonStyle.Success)
    ));
  }
  container.addActionRowComponents(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("guildcfg:back_editor_" + prefix).setLabel("Voltar").setEmoji("<:arrow_left:1557204764834537534>").setStyle(ButtonStyle.Secondary)
  ));
  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

function messagePanel(guild, type, userId) {
  const s = getSettings(guild.id);
  const welcome = type === "welcome";
  const prefix = welcome ? "welcome" : "goodbye";
  const channelId = s[prefix + "ChannelId"];
  const enabled = Boolean(s[prefix + "Enabled"]);
  const container = new ContainerBuilder()
    .setAccentColor(0x00FFFF)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent([
      "# " + (welcome ? "<:62565:1559293995840970764> BOAS-VINDAS" : "<:62548:1559294145737138218> SAÍDA"),
      "┃ Configure o canal, a mensagem e quando ela será enviada.",
      "",
      "┃ **Canal:** " + (channelId ? "<#" + channelId + ">" : "`Não configurado`"),
      "┃ **Status:** " + (enabled ? "Ativado" : "Desativado"),
      "┃ **Mensagem:** " + ((s[prefix + "Message"] || "").trim() ? "Personalizada" : "Padrão")
    ].join("\n")))
    .addActionRowComponents(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("guildcfg:editor_" + prefix).setLabel("Editar mensagem").setEmoji("✏️").setStyle(ButtonStyle.Primary)
    ))
    .addActionRowComponents(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("guildcfg:toggle_" + prefix).setLabel(enabled ? "Desabilitar" : "Usar mensagem").setEmoji(enabled ? "🔕" : "🔔").setStyle(enabled ? ButtonStyle.Danger : ButtonStyle.Success),
      new ButtonBuilder().setCustomId("guildcfg:preview_" + prefix).setLabel("Prévia").setEmoji("👁️").setStyle(ButtonStyle.Secondary)
    ))
    .addActionRowComponents(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("guildcfg:home").setLabel("Voltar").setEmoji("<:arrow_left:1557204764834537534>").setStyle(ButtonStyle.Secondary)
    ));
  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}
function makeWelcomePayload(member, settings, type) {
  const welcome = type === "welcome";
  const prefix = welcome ? "welcome" : "goodbye";
  const text = render(settings[prefix + "Message"], member);
  const title = render(settings[prefix + "Title"] || (welcome ? "**Bem-Vindo a {server}**" : "**Até logo!**"), member);
  const thumbnail = settings[prefix + "ThumbnailUrl"];
  const banner = settings[prefix + "BannerUrl"] || settings[prefix + "ImageUrl"];
  const hex = String(settings[prefix + "Color"] || (welcome ? "301934" : "ED4245")).replace(/^#/, "");
  const color = /^[0-9a-f]{6}$/i.test(hex) ? parseInt(hex, 16) : (welcome ? 0x301934 : 0xED4245);
  const embed = new EmbedBuilder().setColor(color).setDescription(safeText(text, 3900));
  if (title) embed.setTitle(safeText(title, 256));
  if (thumbnail) embed.setThumbnail(thumbnail);
  else embed.setThumbnail(member.user.displayAvatarURL({ size: 256 }));
  if (banner) embed.setImage(banner);
  if (settings[prefix + "Mode"] === "v2") {
    const { MediaGalleryBuilder, MediaGalleryItemBuilder } = require("discord.js");
    const container = new ContainerBuilder().setAccentColor(color)
      .addTextDisplayComponents(new TextDisplayBuilder().setContent((title ? "## " + title + "\n\n" : "") + text));
    if (banner) container.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(banner)));
    return { components: [container], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [], users: welcome ? [member.id] : [] } };
  }
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
  const isApplicationOwner = interaction.user?.id === "904829627799834684";
  if (!interaction.guild || (!isApplicationOwner && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild))) {
    await interaction.reply({ content: "Você precisa ser o dono da aplicação ou ter a permissão Gerenciar Servidor.", ephemeral: true }).catch(() => {});
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
    const prefix = id.endsWith("open_welcome") ? "welcome" : "goodbye";
    await interaction.update(messagePanel(interaction.guild, prefix, interaction.user.id));
    return true;
  }
  if (interaction.isButton() && id === "guildcfg:home") {
    await interaction.update(buildWelcomeLandingPanel(interaction.guild));
    return true;
  }
  if (interaction.isButton() && /^guildcfg:editor_(welcome|goodbye)$/.test(id)) {
    const prefix = id.endsWith("_welcome") ? "welcome" : "goodbye";
    await interaction.update(messageEditorPanel(interaction.guild, prefix, interaction.user.id));
    return true;
  }
  if (interaction.isButton() && /^guildcfg:back_editor_(welcome|goodbye)$/.test(id)) {
    const prefix = id.endsWith("_welcome") ? "welcome" : "goodbye";
    await interaction.update(messagePanel(interaction.guild, prefix, interaction.user.id));
    return true;
  }
  if (interaction.isButton() && /^guildcfg:toggle_(welcome|goodbye)$/.test(id)) {
    const prefix = id.endsWith("_welcome") ? "welcome" : "goodbye";
    updateSettings(interaction.guildId, s => { s[prefix + "Enabled"] = !s[prefix + "Enabled"]; });
    await interaction.update(messagePanel(interaction.guild, prefix, interaction.user.id));
    return true;
  }
  if (interaction.isButton() && /^guildcfg:fields_(welcome|goodbye)$/.test(id)) {
    const prefix = id.endsWith("_welcome") ? "welcome" : "goodbye";
    const draft = editableMessageSettings(interaction.guildId, interaction.user.id, prefix);
    const modal = new ModalBuilder()
      .setCustomId("guildcfg:modal_fields_" + prefix)
      .setTitle(prefix === "welcome" ? "Editar Boas-vindas" : "Editar mensagem de saída")
      .addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("title").setLabel("Título").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(256).setValue(draft.title || "")),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("message").setLabel("Descrição da mensagem").setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1800).setValue(draft.message || "")),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("thumbnail").setLabel("Thumbnail URL HTTPS (opcional)").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(500).setValue(draft.thumbnail || "")),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("banner").setLabel("Banner URL HTTPS (opcional)").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(500).setValue(draft.banner || ""))
      );
    await interaction.showModal(modal);
    return true;
  }
  if (interaction.isModalSubmit() && /^guildcfg:modal_fields_(welcome|goodbye)$/.test(id)) {
    const prefix = id.endsWith("_welcome") ? "welcome" : "goodbye";
    const title = interaction.fields.getTextInputValue("title");
    const message = interaction.fields.getTextInputValue("message");
    const thumbnail = interaction.fields.getTextInputValue("thumbnail").trim();
    const banner = interaction.fields.getTextInputValue("banner").trim();
    for (const [label, url] of [["Thumbnail", thumbnail], ["Banner", banner]]) {
      if (url && !/^https:\/\//i.test(url)) {
        await interaction.reply({ content: label + " precisa ser uma URL HTTPS direta para uma imagem.", ephemeral: true });
        return true;
      }
    }
    messageDrafts.set(draftKey(interaction.guildId, interaction.user.id, prefix), { title, message, thumbnail, banner });
    await interaction.update(messageEditorPanel(interaction.guild, prefix, interaction.user.id));
    return true;
  }
  if (interaction.isButton() && /^guildcfg:save_(welcome|goodbye)$/.test(id)) {
    const prefix = id.endsWith("_welcome") ? "welcome" : "goodbye";
    const key = draftKey(interaction.guildId, interaction.user.id, prefix);
    const draft = messageDrafts.get(key);
    if (!draft) {
      await interaction.update(messageEditorPanel(interaction.guild, prefix, interaction.user.id));
      return true;
    }
    updateSettings(interaction.guildId, s => {
      s[prefix + "Title"] = draft.title;
      s[prefix + "Message"] = draft.message;
      s[prefix + "ThumbnailUrl"] = draft.thumbnail;
      s[prefix + "BannerUrl"] = draft.banner;
      s[prefix + "ImageUrl"] = draft.banner;
    });
    messageDrafts.delete(key);
    await interaction.update(messageEditorPanel(interaction.guild, prefix, interaction.user.id));
    return true;
  }
  if (interaction.isButton() && /^guildcfg:preview_(welcome|goodbye)$/.test(id)) {
    const prefix = id.endsWith("_welcome") ? "welcome" : "goodbye";
    const s = getSettings(interaction.guildId);
    const draft = messageDrafts.get(draftKey(interaction.guildId, interaction.user.id, prefix));
    if (draft) {
      s[prefix + "Title"] = draft.title;
      s[prefix + "Message"] = draft.message;
      s[prefix + "ThumbnailUrl"] = draft.thumbnail;
      s[prefix + "BannerUrl"] = draft.banner;
      s[prefix + "ImageUrl"] = draft.banner;
    }
    const channelId = s[prefix + "ChannelId"];
    const channel = channelId ? await interaction.guild.channels.fetch(channelId).catch(() => null) : null;
    if (!channel?.isTextBased?.() || !channel.send) {
      await interaction.reply({ content: "Configure primeiro um canal válido para esta mensagem.", ephemeral: true });
      return true;
    }
    const fakeMember = { id: interaction.user.id, user: interaction.user, guild: interaction.guild, displayName: interaction.member?.displayName || interaction.user.globalName || interaction.user.username };
    const payload = makeWelcomePayload(fakeMember, s, prefix);
    const sent = await channel.send(payload);
    const seconds = Number(s[prefix + "DeleteAfter"] || 0);
    if (seconds > 0) setTimeout(() => sent.delete().catch(() => {}), seconds * 1000).unref?.();
    await interaction.reply({ content: "Prévia enviada para " + channel.toString() + ".", ephemeral: true });
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
