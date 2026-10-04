# Blox Fruits Stock Bot

Bot Discord que consulta uma API de stock, publica alterações, menciona cargos configurados e oferece /stock, /atualizar e /historico.

## Requisitos
- Node.js 20+
- Aplicação/bot criado no Discord Developer Portal
- URL de uma API de stock funcional e autorizada

## Instalação
1. Copie .env.example para .env e preencha as variáveis.
2. Copie config.example.json para config.json.
3. Em config.json, substitua os valores de exemplo pelos IDs reais dos cargos. As chaves são nomes de frutas em letras minúsculas.
4. Execute npm install e npm start.

## Configuração do Discord
Ative o bot e convide-o ao servidor com permissões View Channels, Send Messages, Embed Links e Use Application Commands. Dê permissão para mencionar os cargos que serão notificados. Copie os IDs com o Modo Desenvolvedor ativado.

## API de stock
Defina STOCK_API_URL para um endpoint que retorne JSON. O bot aceita listas de frutas ou objetos com listas por categoria, mas cada API pode ter um formato diferente. A URL precisa ser testada antes de usar. O endereço antigo de exemplo pode estar fora do ar; não existe garantia de que uma API pública gratuita esteja disponível.

## Hospedagem
Mantenha o processo ligado em um host Node.js. Configure as variáveis de ambiente no painel do host. Nunca publique o token do bot no GitHub nem envie-o no chat.

## Observações
- O bot consulta a API a cada 5 minutos por padrão (mínimo 60 segundos).
- O primeiro stock é consultável por /stock. Notificações automáticas são enviadas quando o resultado muda.
- /atualizar força uma publicação (requer Gerenciar servidor).
- /historico mostra alterações salvas localmente.
