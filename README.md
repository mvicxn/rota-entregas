# 🚚 Rota Entregas

![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933?logo=node.js&logoColor=white) ![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black) ![Vite](https://img.shields.io/badge/Vite-6-646CFF?logo=vite&logoColor=white) ![Express](https://img.shields.io/badge/Express-4-000000?logo=express&logoColor=white) ![SQLite](https://img.shields.io/badge/SQLite-node%3Asqlite-003B57?logo=sqlite&logoColor=white) ![License](https://img.shields.io/badge/License-MIT-green)

Painel para quem despacha várias entregas no mesmo turno e cansou de montar rota no papel e ficar respondendo “já saiu?” no WhatsApp. Você organiza as paradas, vê o entregador no mapa e manda o cliente consultar o pedido por um código — com confirmação na hora e opção de cobrar Pix na porta (modo demonstração, sem gateway pago).

## O que ele faz

- **Portal do cliente:** consulta por código de rastreio (`ENT-2026-…`), mapa das paradas na região de Bauru/SP, paradas à frente, distância estimada e linha do tempo de eventos.
- **Confirmação de entrega (POD):** o recebedor informa nome e PIN de 4 dígitos gerado no cadastro da parada.
- **Pix na entrega (demo):** cobrança simulada com QR em SVG e código copia e cola; botão na interface simula o webhook de pagamento.
- **Torre de controle (login):** painel com totais de rotas, entregas, km planejados, economia após otimização e valores Pix pendentes/recebidos.
- **Rotas e paradas:** criar rota, escolher entregador, incluir paradas (CPF/CNPJ, endereço, prioridade, pagamento online ou Pix), geocodificação simplificada por bairro quando lat/lng não são informados.
- **Otimização de ordem:** algoritmo nearest neighbor + refinamento 2-Opt, com km e minutos economizados registrados na rota.
- **Telemetria ao vivo:** atualização em tempo real via SSE (`/api/live/stream`) e WebSocket; simulação de avanço do entregador no mapa (público ou pelo painel).
- **Romaneio em PDF:** download por código da rota (`/api/routes/ROTA-2026-101/manifest.pdf`, por exemplo).
- **Dados iniciais:** ao subir o servidor pela primeira vez, o SQLite em `server/data/rotas.db` é criado com usuário admin, entregadores, duas rotas de exemplo e entregas de demonstração.

## Como rodar no seu computador

### Pré-requisitos

- [Node.js](https://nodejs.org/) **22.5 ou superior** (o projeto usa `node:sqlite` nativo).
- Git instalado.

### Passo a passo

1. Clone o repositório:

   ```bash
   git clone https://github.com/mvicxn/rota-entregas.git
   ```

2. Entre na pasta:

   ```bash
   cd rota-entregas
   ```

3. Instale as dependências do servidor e do cliente:

   ```bash
   npm run install:all
   ```

4. (Opcional) Variáveis de ambiente: copie `server/.env.example` para `server/.env` se quiser alterar porta, segredo JWT ou modos de mapa/Pix. Sem arquivo `.env`, valem os padrões (`PORT=4015`, `MAP_MODE=mock`, `PIX_MODE=mock`).

5. Suba API e interface juntas em modo desenvolvimento:

   ```bash
   npm run dev
   ```

6. Abra no navegador:

   - **Interface (Vite):** [http://localhost:5173](http://localhost:5173) — o proxy encaminha `/api` e `/ws` para a API.
   - **API direta:** [http://localhost:4015](http://localhost:4015) — health check em `/api/health`.

### Produção local (build + um único servidor)

```bash
npm run build
npm start
```

A aplicação compilada fica servida pela API na porta **4015**.

### Credenciais e códigos de demonstração

| Uso | Valor |
|-----|--------|
| Despachante (aba “Torre de controle”) | usuário **`admin`**, senha **`admin123`** |
| Rastreio (aba “Portal de rastreio”) | **`ENT-2026-1001`** … **`ENT-2026-1006`** (botões de atalho na tela para os quatro primeiros) |
| PIN de exemplo | **`4821`** na entrega **`ENT-2026-1002`** (Clínica Sorriso Pleno — Pix pendente) |

Outros PINs de seed: `3419` (1001, já entregue), `7750` (1003), `9164` (1004), `5512` (1005), `6038` (1006).

## Testes

Na raiz do projeto:

```bash
npm test
```

Isso executa a suíte em `server/test/api.test.js` com o runner nativo **`node:test`** (health, rastreio, PDF, confirmação com PIN, webhook Pix mock, login JWT, otimização, SSE/WebSocket, entre outros).

## Tecnologias

- **Frontend:** React 19, Vite 6
- **Backend:** Node.js, Express, JWT (`jsonwebtoken`), bcrypt para senha do admin
- **Banco:** SQLite via módulo **`node:sqlite`** (arquivo local; variável opcional `DB_PATH`)
- **Roteirização:** distância Haversine com fator de via urbana, 2-Opt
- **Pix / mapa:** modos **`mock`** por padrão (sem Google Maps, OSRM ou Asaas obrigatórios)
- **Tempo real:** SSE + WebSocket no mesmo processo HTTP
- **PDF:** romaneio gerado no servidor (`pdfGenerator.js`)

## Licença

MIT — uso, cópia e modificação permitidos nos termos habituais da licença MIT (declarada no `package.json` do projeto).

## Autor

**Maicon Manoel** — [https://github.com/mvicxn](https://github.com/mvicxn)
