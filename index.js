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