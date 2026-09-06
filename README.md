# Royalle Poker — Servidor

Servidor de poker multiplayer real (WebSocket). Guarda as cartas em segredo
no servidor — cada jogador só recebe a própria mão até o showdown.

## Rodar localmente
npm install
npm start
# Servidor sobe em http://localhost:3001 (ajustável via variável PORT)

## Publicar de graça (Render.com)
1. Crie uma conta em render.com (dá pra usar login do GitHub)
2. Suba esta pasta pro GitHub (veja instruções que o Claude te deu)
3. No Render: New + -> Web Service -> conecte o repositório
4. Build Command: npm install
5. Start Command: npm start
6. Deploy. Em alguns minutos você tem uma URL tipo:
   https://royalle-poker-server.onrender.com

## Importante
- Os dados (clubes, saldos) ficam só na MEMÓRIA do servidor. Se ele reiniciar
  (ou o Render "hibernar" no plano grátis), tudo zera. Isso é esperado nesta
  fase — a próxima etapa é conectar um banco de dados de verdade.
