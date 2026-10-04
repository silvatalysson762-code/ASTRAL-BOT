# Blox Fruits Stock Bot

Bot Discord que consulta o stock de Blox Fruits, publica alterações, menciona cargos configurados e oferece /stock, /atualizar e /historico.

## Requisitos
- Node.js 20+
- Aplicação/bot criado no Discord Developer Portal
- Chave de API Parse (plano gratuito disponível)

## Instalação
1. Copie .env.example para .env e preencha as variáveis.
2. Crie uma conta no Parse e gere uma API key: https://parse.bot/
3. Coloque a chave em STOCK_API_KEY no arquivo .env. Não coloque a chave no GitHub.
4. Copie config.example.json para config.json.
5. Em config.json, substitua os valores de exemplo pelos IDs reais dos cargos. As chaves são nomes de frutas em letras minúsculas.
6. Execute npm install e npm start.

## Configuração do Discord
Ative o bot e convide-o ao servidor com permissões View Channels, Send Messages, Embed Links e Use Application Commands. Dê permissão para mencionar os cargos que serão notificados. Copie os IDs com o Modo Desenvolvedor ativado.

## API de stock
O bot está configurado para usar o endpoint de stock da API comunitária baseada na wiki do Blox Fruits:
https://api.parse.bot/scraper/78cf8155-3819-45d0-b799-92f840a94827/get_stock

A chamada usa o cabeçalho X-API-Key. A API não é oficial do jogo. O plano gratuito listado oferece 200 créditos por mês; esta integração consulta automaticamente a cada 4 horas (cerca de 180 consultas em 30 dias). Comandos manuais /stock e /atualizar também fazem consultas e consomem créditos, então evite usá-los repetidamente.

## Hospedagem
Mantenha o processo ligado em um host Node.js. Configure as variáveis de ambiente no painel do host. Nunca publique o token do bot nem a chave da API no GitHub ou no chat.

## Observações
- O bot consulta a API a cada 4 horas por padrão.
- O primeiro stock pode ser visto com /stock. Notificações automáticas são enviadas quando o resultado muda.
- /atualizar força uma publicação (requer Gerenciar servidor).
- /historico mostra alterações salvas localmente.
- A API e o bot ainda precisam ser iniciados e testados com as credenciais do servidor.


## Configuração de cargos pelo Discord

Depois que o bot estiver online, administradores podem configurar as menções sem editar arquivos:

- `/configurar-fruta fruta:Dragon East cargo:@Dragon East` define o cargo para uma fruta.
- `/listar-cargos` mostra as configurações existentes.
- `/remover-cargo fruta:Dragon East` remove uma configuração.

Digite o nome da fruta exatamente como aparece no stock da API. Dragon East, Dragon West e Control podem ter cargos separados. Os comandos de configuração exigem a permissão **Gerenciar servidor**.
