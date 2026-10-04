# Astral Stock | Blox Fruits

Bot Discord para publicar automaticamente o stock de Blox Fruits, separar Stock Normal e Stock da Mirage, mencionar cargos por fruta, usar emojis da Application do Discord e mostrar preços em Beli.

## O que o bot faz

- Consulta a API de stock do Blox Fruits.
- Faz uma consulta automática a cada 2 horas.
- Detecta Stock Normal e Stock da Mirage na mesma consulta.
- Publica Normal e Mirage em mensagens separadas.
- Normal: ciclo global de 4 horas.
- Mirage: ciclo global de 2 horas.
- Mostra contagem regressiva para o próximo reset.
- Mostra o horário do próximo reset em Brasília.
- Usa Components V2.
- Usa emoji personalizado de cada fruta.
- Permite configurar um cargo para cada fruta.
- Menciona os cargos configurados quando a fruta aparece.
- Mostra preço em Beli com o emoji personalizado.
- Tem preços de fallback salvos no código quando a API não envia o preço.
- Guarda histórico e assinaturas localmente.
- Evita publicar novamente o mesmo stock.
- Registra os slash commands automaticamente no servidor configurado.

## Comandos

### Consulta
- /stock
- /historico

### Administração
- /atualizar
- /testeestoque
- /configurar-fruta
- /configurar-emoji
- /configurar-titulo
- /listar-cargos
- /remover-cargo
- /listar-emojis
- /remover-emoji

Os comandos administrativos usam a permissão Gerenciar servidor.

## Emojis da Application

O bot aceita:
- Emoji Unicode.
- Emoji personalizado do servidor.
- Emoji da Application criado no Discord Developer Portal.
- Nome do emoji da Application.

No /configurar-emoji, pode informar o nome do emoji ou o emoji completo, por exemplo:
<:nome:ID>
<a:nome:ID>

O código já usa:
- Blox Fruits: <:emoji_001:1539652915050971226>
- Beli: <:emoji_232:1556366446257242112>
- Relógio: <a:emoji_233:1556370328135925931>

## Configuração dos cargos

1. Ative o Modo Desenvolvedor no Discord.
2. Copie o ID do cargo.
3. Faça /configurar-fruta.
4. Escolha a fruta.
5. Escolha o cargo.
6. Deixe o cargo configurado como mencionável no servidor para garantir que a menção seja exibida.

O bot usa o ID do cargo, não o nome. Isso evita problemas se o nome do cargo mudar.

## Variáveis de ambiente

Crie um arquivo .env na hospedagem com:

DISCORD_TOKEN=TOKEN_DO_BOT
CLIENT_ID=ID_DA_APLICACAO
GUILD_ID=ID_DO_SERVIDOR
CHANNEL_ID=ID_DO_CANAL
STOCK_API_URL=https://api.parse.bot/scraper/78cf8155-3819-45d0-b799-92f840a94827/get_stock
STOCK_API_KEY=CHAVE_DA_API

Nunca coloque DISCORD_TOKEN ou STOCK_API_KEY no GitHub.

## Discord Developer Portal

A aplicação precisa ter um Bot criado.

O convite do bot deve incluir:
- bot
- applications.commands

No canal de stock, o bot precisa conseguir:
- Ver canal
- Ver histórico de mensagens
- Enviar mensagens
- Usar comandos de aplicação

Os cargos que serão mencionados precisam permitir menção.

Para criar emojis da Application:
1. Abra a aplicação no Discord Developer Portal.
2. Abra a área de emojis da aplicação.
3. Crie os emojis.
4. Use os nomes/IDs gerados no bot.

## API

Endpoint configurado:

https://api.parse.bot/scraper/78cf8155-3819-45d0-b799-92f840a94827/get_stock

A chave é enviada no cabeçalho:

X-API-Key

A API é externa ao jogo. Se ela estiver fora do ar, com limite atingido ou mudar o formato da resposta, o bot registra o erro no log e continua tentando no próximo ciclo.

## Estrutura de arquivos

- index.js: código principal.
- package.json: dependências e comando de inicialização.
- .env.example: modelo das variáveis secretas.
- config.example.json: modelo de configuração.
- config.json: configuração criada pelo bot em execução.
- data/state.json: histórico e assinaturas de stock criados em execução.
- discloud.config: configuração da Discloud.
- .gitignore: impede o envio de .env, config.json, data e node_modules.

## Discloud

Configuração atual:

NAME=Astral Stock
TYPE=bot
MAIN=index.js
RAM=100
VERSION=latest

A versão do Node precisa ser 20 ou superior.

Na Discloud, cadastre todas as variáveis do .env no painel da aplicação.

Não envie o arquivo .env para o GitHub.

## Instalação local

Requer Node.js 20+.

npm install
npm start

O package.json já usa:

node index.js

## Como testar depois de colocar online

1. Confirme no log: Bot conectado como ...
2. Confirme: Comandos de stock, cargos e emojis registrados.
3. Use /testeestoque.
4. Configure um emoji com /configurar-emoji.
5. Configure um cargo com /configurar-fruta.
6. Use /stock.
7. Use /atualizar para forçar uma publicação.
8. Confira se Normal e Mirage aparecem em mensagens separadas.
9. Aguarde o próximo reset global para testar a automação.

## Proteções

- Token e API key ficam somente em variáveis de ambiente.
- O .gitignore bloqueia arquivos sensíveis.
- O bot não entra em loop rápido de API.
- O bot faz uma única consulta a cada 2 horas e usa essa resposta para verificar Normal e Mirage.
- Um erro de API não encerra o processo.
- Um erro de interação não encerra o processo.
- Assinaturas impedem republicação do mesmo stock.
- Cargos inválidos são ignorados.
- O histórico é limitado por historyLimit.

## Observação importante sobre preços

Os preços em Beli são separados do valor de trade. O bot mostra o preço de compra em Beli. Se a API não enviar esse campo, ele usa o preço salvo em SAVED_BELI_PRICES no index.js.

## Atualização

Depois de alterar arquivos no GitHub, faça redeploy/restart da aplicação na Discloud e confira o log antes de testar os comandos.
