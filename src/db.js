import pg from "pg";

const { Pool } = pg;

// Render's Postgres add-on injects DATABASE_URL automatically once the
// database is linked to this web service. Locally, set it in a .env or
// export it before running `npm start` if you want to test against a
// real database; otherwise the server falls back to an in-memory store
// (see memoryStore.js) so local development still works without Postgres.
const connectionString = process.env.DATABASE_URL;

export const hasDatabase = Boolean(connectionString);

export const pool = hasDatabase
  ? new Pool({ connectionString, ssl: connectionString.includes("render.com") ? { rejectUnauthorized: false } : false })
  : null;

export async function migrate() {
  if (!hasDatabase) {
    console.log("Sem DATABASE_URL configurada — rodando com armazenamento em memória (dados não persistem).");
    return;
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      avatar TEXT NOT NULL DEFAULT 'avatar_01',
      last_seen TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen TIMESTAMPTZ;`);
  // Foto de perfil enviada pelo próprio jogador (base64), opcional — quando
  // presente, tem prioridade sobre o avatar de emoji pré-definido (avatar).
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_image TEXT;`);
  // Apelido pessoal, mostrado na mesa/lobby no lugar do username — opcional,
  // conferido como único (case-insensitive) na hora de definir.
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS nickname TEXT;`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS clubs (
      id SERIAL PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      owner_id INTEGER NOT NULL REFERENCES users(id),
      small_blind INTEGER NOT NULL DEFAULT 25,
      big_blind INTEGER NOT NULL DEFAULT 50,
      buy_in INTEGER NOT NULL DEFAULT 5000,
      rake_percent NUMERIC NOT NULL DEFAULT 5,
      treasury_chips BIGINT NOT NULL DEFAULT 10000,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`ALTER TABLE clubs ADD COLUMN IF NOT EXISTS treasury_chips BIGINT NOT NULL DEFAULT 1000;`);
  await pool.query(`ALTER TABLE clubs ALTER COLUMN treasury_chips SET DEFAULT 10000;`);
  // Foto/logo do clube, enviada pelo dono (base64), opcional — quando
  // ausente, o app mostra o ícone de coroa padrão no lugar.
  await pool.query(`ALTER TABLE clubs ADD COLUMN IF NOT EXISTS image TEXT;`);
  // Imagem de capa do cabeçalho do clube (estilo "capa" do Facebook/
  // PPPoker) — separada do logo (image). Pode ser um preset (o próprio
  // app já embute os presets como constantes) ou uma foto enviada pelo
  // dono do dispositivo.
  await pool.query(`ALTER TABLE clubs ADD COLUMN IF NOT EXISTS cover_image TEXT;`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS club_members (
      club_id INTEGER NOT NULL REFERENCES clubs(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      chips BIGINT NOT NULL DEFAULT 0,
      role TEXT NOT NULL DEFAULT 'member',
      nickname TEXT,
      note TEXT,
      joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (club_id, user_id)
    );
  `);
  await pool.query(`ALTER TABLE club_members ADD COLUMN IF NOT EXISTS nickname TEXT;`);
  await pool.query(`ALTER TABLE club_members ADD COLUMN IF NOT EXISTS note TEXT;`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rake_ledger (
      id SERIAL PRIMARY KEY,
      club_id INTEGER NOT NULL REFERENCES clubs(id),
      amount NUMERIC NOT NULL,
      platform_amount NUMERIC NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // "amount" é a parte do CLUBE (ex: 4% do pote); "platform_amount" é a
  // parte do APP (ex: 1% do pote) — gravadas juntas, na mesma mão.
  await pool.query(`ALTER TABLE rake_ledger ADD COLUMN IF NOT EXISTS platform_amount NUMERIC NOT NULL DEFAULT 0;`);
  // Carteira avulsa para as mesas públicas de "Jogar" (fora de clube),
  // separada do saldo de fichas de cada clube. Essa é a "Royalle Coin".
  await pool.query(`
    CREATE TABLE IF NOT EXISTS quick_wallets (
      user_id INTEGER PRIMARY KEY REFERENCES users(id),
      chips BIGINT NOT NULL DEFAULT 50000,
      last_daily_claim DATE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`ALTER TABLE quick_wallets ADD COLUMN IF NOT EXISTS last_daily_claim DATE;`);
  await pool.query(`ALTER TABLE quick_wallets ALTER COLUMN chips SET DEFAULT 50000;`);
  // "Gemas" — segunda moeda (mostrada como diamante no header), separada
  // da Royalle Coin. Hoje só é acumulada por fontes futuras (loja, VIP);
  // começa zerada e é só exibida/consultada por enquanto.
  await pool.query(`ALTER TABLE quick_wallets ADD COLUMN IF NOT EXISTS gems BIGINT NOT NULL DEFAULT 0;`);
  // Solicitações de entrada em clube, aguardando aprovação do dono/admin.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS club_join_requests (
      id SERIAL PRIMARY KEY,
      club_id INTEGER NOT NULL REFERENCES clubs(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (club_id, user_id)
    );
  `);
  // ID do agente que indicou o jogador (opcional, digitado na hora de
  // pedir pra entrar) — vira o vínculo agente/jogador automaticamente
  // quando o dono aprova, sem precisar vincular na mão depois.
  await pool.query(`ALTER TABLE club_join_requests ADD COLUMN IF NOT EXISTS agent_wallet_id INTEGER;`);
  // Mesas configuráveis dentro de um clube — um clube pode ter várias,
  // cada uma com seu próprio tipo de jogo, blinds, rake e buy-in.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS club_tables (
      id SERIAL PRIMARY KEY,
      club_id INTEGER NOT NULL REFERENCES clubs(id),
      variant TEXT NOT NULL DEFAULT 'holdem',
      small_blind INTEGER NOT NULL,
      big_blind INTEGER NOT NULL,
      buy_in INTEGER NOT NULL,
      rake_percent NUMERIC NOT NULL DEFAULT 5,
      max_players INTEGER NOT NULL DEFAULT 9,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // Nome da mesa (pra aparecer no rodapé/lista) — nunca existiu de
  // verdade, mesmo já sendo referenciado em outro lugar do código.
  await pool.query(`ALTER TABLE club_tables ADD COLUMN IF NOT EXISTS name TEXT;`);
  // Configurações reais (com mecanismo de verdade por trás, não só
  // aparência) da tela "Criar mesa" — igual ao pppoker que o Carlos
  // mandou de referência.
  await pool.query(`ALTER TABLE club_tables ADD COLUMN IF NOT EXISTS action_seconds INTEGER NOT NULL DEFAULT 30;`);
  await pool.query(`ALTER TABLE club_tables ADD COLUMN IF NOT EXISTS max_buy_in INTEGER;`);
  await pool.query(`ALTER TABLE club_tables ADD COLUMN IF NOT EXISTS duration_minutes INTEGER NOT NULL DEFAULT 0;`); // 0 = sem limite
  await pool.query(`ALTER TABLE club_tables ADD COLUMN IF NOT EXISTS auto_extend BOOLEAN NOT NULL DEFAULT false;`);
  await pool.query(`ALTER TABLE club_tables ADD COLUMN IF NOT EXISTS auto_extend_times INTEGER NOT NULL DEFAULT 0;`);
  await pool.query(`ALTER TABLE club_tables ADD COLUMN IF NOT EXISTS auto_start BOOLEAN NOT NULL DEFAULT true;`);
  await pool.query(`ALTER TABLE club_tables ADD COLUMN IF NOT EXISTS min_start_players INTEGER NOT NULL DEFAULT 2;`);
  await pool.query(`ALTER TABLE club_tables ADD COLUMN IF NOT EXISTS rake_cap_bb NUMERIC NOT NULL DEFAULT 3;`);
  await pool.query(`ALTER TABLE club_tables ADD COLUMN IF NOT EXISTS exclusive BOOLEAN NOT NULL DEFAULT false;`);
  await pool.query(`ALTER TABLE club_tables ADD COLUMN IF NOT EXISTS buyin_requires_approval BOOLEAN NOT NULL DEFAULT false;`);
  await pool.query(`ALTER TABLE club_tables ADD COLUMN IF NOT EXISTS chat_banned BOOLEAN NOT NULL DEFAULT false;`);
  await pool.query(`ALTER TABLE club_tables ADD COLUMN IF NOT EXISTS show_folded_cards BOOLEAN NOT NULL DEFAULT true;`);
  await pool.query(`ALTER TABLE club_tables ADD COLUMN IF NOT EXISTS see_in_action BOOLEAN NOT NULL DEFAULT false;`);
  // Opções avançadas que ainda são só CONFIGURAÇÃO SALVA — sem mecanismo
  // rodando por trás ainda (straddle automático, bater várias vezes,
  // dividir EV, High Roller, VPIP, tempo decretado, restrições de
  // GPS/IP/PC/e-mail, CAPTCHA). Ficam num JSON só pra não precisar de
  // uma coluna pra cada uma; o campo existe e é salvo, mas o Royalle
  // ainda não FAZ nada com ele — ver aviso na resposta.
  await pool.query(`ALTER TABLE club_tables ADD COLUMN IF NOT EXISTS advanced_flags JSONB NOT NULL DEFAULT '{}';`);
  // Mecanismos que estavam só na aba "Opções avançadas"/"Jogo limpo" e
  // agora ganham coluna própria (mecanismo real, não só configuração
  // salva) — ver detalhe de cada um nos comentários do index.js.
  await pool.query(`ALTER TABLE club_tables ADD COLUMN IF NOT EXISTS high_roller BOOLEAN NOT NULL DEFAULT false;`);
  await pool.query(`ALTER TABLE club_tables ADD COLUMN IF NOT EXISTS high_roller_min INTEGER NOT NULL DEFAULT 0;`);
  await pool.query(`ALTER TABLE club_tables ADD COLUMN IF NOT EXISTS vpip_min INTEGER NOT NULL DEFAULT 0;`); // 0 = desligado
  await pool.query(`ALTER TABLE club_tables ADD COLUMN IF NOT EXISTS vpip_level INTEGER NOT NULL DEFAULT 0;`);
  await pool.query(`ALTER TABLE club_tables ADD COLUMN IF NOT EXISTS vpip_hand_limit INTEGER NOT NULL DEFAULT 30;`);
  await pool.query(`ALTER TABLE club_tables ADD COLUMN IF NOT EXISTS decreed_time BOOLEAN NOT NULL DEFAULT false;`);
  await pool.query(`ALTER TABLE club_tables ADD COLUMN IF NOT EXISTS ip_restriction BOOLEAN NOT NULL DEFAULT false;`);
  await pool.query(`ALTER TABLE club_tables ADD COLUMN IF NOT EXISTS gps_restriction BOOLEAN NOT NULL DEFAULT false;`);
  await pool.query(`ALTER TABLE club_tables ADD COLUMN IF NOT EXISTS gps_min_meters INTEGER NOT NULL DEFAULT 100;`);
  await pool.query(`ALTER TABLE club_tables ADD COLUMN IF NOT EXISTS straddle_enabled BOOLEAN NOT NULL DEFAULT false;`);
  await pool.query(`ALTER TABLE club_tables ADD COLUMN IF NOT EXISTS run_it_multiple BOOLEAN NOT NULL DEFAULT false;`);
  await pool.query(`ALTER TABLE club_tables ADD COLUMN IF NOT EXISTS split_ev BOOLEAN NOT NULL DEFAULT false;`);
  await pool.query(`ALTER TABLE club_tables ADD COLUMN IF NOT EXISTS captcha_enabled BOOLEAN NOT NULL DEFAULT false;`);
  // Estado runtime do "Tempo decretado" e VPIP por jogador/mesa — fica
  // por linha (club_id+table_id+user_id) pra sobreviver a reconexão.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS table_player_stats (
      club_table_id INTEGER NOT NULL REFERENCES club_tables(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      hands_played INTEGER NOT NULL DEFAULT 0,
      hands_vpip INTEGER NOT NULL DEFAULT 0,
      session_profit_chips BIGINT NOT NULL DEFAULT 0,
      PRIMARY KEY (club_table_id, user_id)
    );
  `);
  // Histórico persistente de envio/retirada de Royalle Pay pelo dono/admin.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pay_ledger (
      id SERIAL PRIMARY KEY,
      club_id INTEGER NOT NULL REFERENCES clubs(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      admin_id INTEGER NOT NULL REFERENCES users(id),
      type TEXT NOT NULL,
      amount BIGINT NOT NULL,
      balance_before BIGINT NOT NULL,
      balance_after BIGINT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // Estatísticas simples de jogo (mesas públicas), por usuário.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_stats (
      user_id INTEGER PRIMARY KEY REFERENCES users(id),
      hands_played INTEGER NOT NULL DEFAULT 0,
      hands_won INTEGER NOT NULL DEFAULT 0
    );
  `);
  // Avisos gerais do app (ex: notas de atualização) — o dono do app publica,
  // todo mundo vê. Aparece como pop-up (1x por dia, ou "não mostrar por 7
  // dias") e também numa lista dentro de Mensagens > Avisos.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS announcements (
      id SERIAL PRIMARY KEY,
      version TEXT,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // Notificações pessoais de cada jogador (ex: "fichas recebidas", boas-
  // vindas ao clube). Diferente de announcements: isso é individual, não
  // uma mensagem geral do app.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      club_id INTEGER REFERENCES clubs(id),
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // Resultado (ganho/perda) de cada jogador em cada mão jogada numa mesa
  // de CLUBE (fichas fictícias de "Jogar" fora de clube não entram aqui,
  // de propósito — a Carreira é só sobre fichas de clube). Alimenta o
  // gráfico e os totais da aba Carreira.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hand_ledger (
      id SERIAL PRIMARY KEY,
      club_id INTEGER NOT NULL REFERENCES clubs(id),
      table_id INTEGER,
      user_id INTEGER NOT NULL REFERENCES users(id),
      delta BIGINT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS hand_ledger_user_idx ON hand_ledger(user_id, created_at);`);

  // ============================================================
  // TORNEIOS (MTT) — configuração persistida por torneio, e uma linha por
  // jogador inscrito com o resultado final (posição/prêmio) depois que
  // termina. O estado AO VIVO (nível de blind atual, mesas rodando,
  // stacks em tempo real) fica em memória no servidor (igual a mesa de
  // clube já funciona) — só o que precisa sobreviver um restart entra
  // aqui: config + resultado final.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tournaments (
      id SERIAL PRIMARY KEY,
      club_id INTEGER NOT NULL REFERENCES clubs(id),
      name TEXT NOT NULL,
      variant TEXT NOT NULL DEFAULT 'holdem',
      buy_in BIGINT NOT NULL DEFAULT 1000,
      starting_chips BIGINT NOT NULL DEFAULT 10000,
      max_players INTEGER NOT NULL DEFAULT 90,
      min_players INTEGER NOT NULL DEFAULT 2,
      blind_structure TEXT NOT NULL DEFAULT 'standard',
      level_minutes INTEGER NOT NULL DEFAULT 10,
      late_reg_minutes INTEGER NOT NULL DEFAULT 30,
      rebuy_allowed BOOLEAN NOT NULL DEFAULT false,
      rebuy_max INTEGER NOT NULL DEFAULT 0,
      gtd_prize BIGINT NOT NULL DEFAULT 0,
      start_time TIMESTAMPTZ NOT NULL,
      created_by INTEGER NOT NULL REFERENCES users(id),
      status TEXT NOT NULL DEFAULT 'scheduled',
      current_level INTEGER NOT NULL DEFAULT 0,
      level_started_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // Campos extras de torneio (Early Bird, K.O./bounty, % de premiação) —
  // adicionados depois do lançamento inicial, por isso em ALTER TABLE
  // separado em vez de já no CREATE TABLE acima.
  await pool.query(`ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS early_bird_discount_pct INTEGER NOT NULL DEFAULT 0;`);
  await pool.query(`ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS early_bird_deadline TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS bounty_enabled BOOLEAN NOT NULL DEFAULT false;`);
  await pool.query(`ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS bounty_percent INTEGER NOT NULL DEFAULT 50;`);
  await pool.query(`ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS payout_percent INTEGER NOT NULL DEFAULT 12;`);
  // % de premiação passa a aceitar fração (12.5%, igual o pppoker) — por
  // isso migra pra NUMERIC em vez de INTEGER.
  await pool.query(`ALTER TABLE tournaments ALTER COLUMN payout_percent TYPE NUMERIC USING payout_percent::numeric;`);
  // ---- Configurações avançadas de MTT (rebuy/add-on com multiplicador,
  // K.O. Regular/Progressivo/Misterioso, ITM, blind customizado, Early
  // Bird com bônus de fichas, recorrência) — igual ao pppoker que o
  // Carlos mandou de referência. As chaves menos estruturais (limite de
  // Time Bank, restrições de PC/e-mail/região, Multi-Dias, MTT
  // recorrente) ficam dentro de advanced_flags (JSONB), no mesmo padrão
  // já usado em club_tables — mecanismo real quando descrito como tal
  // no código, senão é só configuração salva (ver comentários abaixo).
  await pool.query(`ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS rebuy_multiplier NUMERIC NOT NULL DEFAULT 1.0;`);
  await pool.query(`ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS rebuy_double BOOLEAN NOT NULL DEFAULT false;`);
  await pool.query(`ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS rebuy_triple BOOLEAN NOT NULL DEFAULT false;`);
  await pool.query(`ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS addon_enabled BOOLEAN NOT NULL DEFAULT false;`);
  await pool.query(`ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS addon_multiplier NUMERIC NOT NULL DEFAULT 1.0;`);
  await pool.query(`ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS addon_double BOOLEAN NOT NULL DEFAULT false;`);
  await pool.query(`ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS addon_triple BOOLEAN NOT NULL DEFAULT false;`);
  await pool.query(`ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS addon_pause_minutes INTEGER NOT NULL DEFAULT 5;`);
  // ko_mode: 'off' | 'regular' | 'progressive' | 'mystery' — ver
  // payKnockoutBounty() no index.js pros três mecanismos reais.
  await pool.query(`ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS ko_mode TEXT NOT NULL DEFAULT 'regular';`);
  // Pote acumulado do K.O. Misterioso antes da fase ITM (ninguém recebe
  // nada por eliminação nessa fase — só acumula; depois vira prêmios
  // sorteados, ver tournamentMysteryPrizes()).
  await pool.query(`ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS mystery_pool BIGINT NOT NULL DEFAULT 0;`);
  // itm_mode: 'players' (conta só jogadores) | 'buyins' (conta total de
  // buy-ins, incluindo rebuys e add-ons). payout_weighting: 'flat' |
  // 'standard' | 'aggressive' — controla o quanto o 1º lugar leva mais
  // que o resto.
  await pool.query(`ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS itm_mode TEXT NOT NULL DEFAULT 'buyins';`);
  await pool.query(`ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS payout_weighting TEXT NOT NULL DEFAULT 'standard';`);
  // Early Bird — bônus de fichas iniciais (além do desconto que já
  // existia), válido pro primeiro buy-in até o nível de blind escolhido.
  await pool.query(`ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS early_bird_chip_bonus_pct INTEGER NOT NULL DEFAULT 0;`);
  await pool.query(`ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS early_bird_chip_bonus_level INTEGER NOT NULL DEFAULT 0;`);
  // Registro tardio por NÍVEL de blind (além do por minutos que já
  // existia) — quando preenchido, tem prioridade sobre late_reg_minutes.
  await pool.query(`ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS late_reg_level INTEGER;`);
  // Estrutura de blind customizada ("Personalizar>>") — array de
  // {sb,bb,ante}; quando preenchida, substitui a fórmula de
  // tournamentBlindLevel() pra esse torneio.
  await pool.query(`ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS custom_blind_levels JSONB;`);
  await pool.query(`ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS advanced_flags JSONB NOT NULL DEFAULT '{}';`);
  // Nível do clube (0-10) — cada nível paga em diamantes por 30 dias e dá
  // mais capacidade de membros/gestores, igual o "Clube Nível" do PPPoker.
  await pool.query(`ALTER TABLE clubs ADD COLUMN IF NOT EXISTS level INTEGER NOT NULL DEFAULT 0;`);
  await pool.query(`ALTER TABLE clubs ADD COLUMN IF NOT EXISTS level_expires_at TIMESTAMPTZ;`);
  // Saldo de RK — o rake coletado vira essa ficha separada, NUNCA se
  // mistura com "treasury_chips" (o saldo normal do clube, usado pra
  // buy-in/prêmio/envio de ficha). Evita confusão no dia do acerto.
  await pool.query(`ALTER TABLE clubs ADD COLUMN IF NOT EXISTS rk_balance BIGINT NOT NULL DEFAULT 0;`);
  // Jackpot do clube — opcional, o dono liga/desliga e escolhe quanto do
  // rake alimenta o pote (0-100%). jackpot_balance é o pote acumulado em
  // si, separado de tudo o mais (nunca se mistura com treasury_chips nem
  // rk_balance) — só cresce por essa fatia do rake e por injeção manual
  // do dono, e só ele decide gastar/zerar.
  await pool.query(`ALTER TABLE clubs ADD COLUMN IF NOT EXISTS jackpot_enabled BOOLEAN NOT NULL DEFAULT false;`);
  await pool.query(`ALTER TABLE clubs ADD COLUMN IF NOT EXISTS jackpot_rake_percent INTEGER NOT NULL DEFAULT 0;`);
  await pool.query(`ALTER TABLE clubs ADD COLUMN IF NOT EXISTS jackpot_balance BIGINT NOT NULL DEFAULT 0;`);
  // Tipo de jackpot (mixed/cooler/cooler_plus) e como a taxa é cobrada
  // (per_hand/per_pot) — igual a tela "Configurações de Jackpot" do
  // pppoker que o Carlos mandou de referência.
  await pool.query(`ALTER TABLE clubs ADD COLUMN IF NOT EXISTS jackpot_type TEXT NOT NULL DEFAULT 'mixed';`);
  await pool.query(`ALTER TABLE clubs ADD COLUMN IF NOT EXISTS jackpot_fee_mode TEXT NOT NULL DEFAULT 'per_pot';`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tournament_entries (
      id SERIAL PRIMARY KEY,
      tournament_id INTEGER NOT NULL REFERENCES tournaments(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      status TEXT NOT NULL DEFAULT 'registered',
      chips BIGINT NOT NULL DEFAULT 0,
      rebuys INTEGER NOT NULL DEFAULT 0,
      rank INTEGER,
      prize BIGINT NOT NULL DEFAULT 0,
      eliminated_at TIMESTAMPTZ,
      registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (tournament_id, user_id)
    );
  `);
  // Quanto esse jogador já ganhou de prêmio de K.O. (bounty) eliminando
  // outros — separado do "prize" (premiação por colocação final).
  await pool.query(`ALTER TABLE tournament_entries ADD COLUMN IF NOT EXISTS bounty_won BIGINT NOT NULL DEFAULT 0;`);
  // Valor REAL cobrado no buy-in (pode ser menor que o buy-in padrão do
  // torneio por causa do desconto Early Bird) — reembolso tem que
  // devolver exatamente isso, nunca o "chips" (que é só a pilha inicial
  // de fichas do torneio, um número totalmente diferente).
  await pool.query(`ALTER TABLE tournament_entries ADD COLUMN IF NOT EXISTS buy_in_paid BIGINT;`);
  // Add-on: só pode ser usado uma vez, na janela depois do fim do
  // registro tardio.
  await pool.query(`ALTER TABLE tournament_entries ADD COLUMN IF NOT EXISTS addon_used BOOLEAN NOT NULL DEFAULT false;`);
  // K.O. Progressivo: pote de bounty PRÓPRIO desse jogador — cresce cada
  // vez que ele elimina alguém (metade na hora, metade fica aqui) e é
  // pago inteiro pra quem eliminar ELE, ou de volta pra ele mesmo se for
  // o campeão (nunca é eliminado).
  await pool.query(`ALTER TABLE tournament_entries ADD COLUMN IF NOT EXISTS bounty_pool BIGINT NOT NULL DEFAULT 0;`);

  // ============================================================
  // SISTEMA DE RAKE / RAKEBACK / AGENTE (comissão) / FECHAMENTO
  // ============================================================
  // "Agente" aqui é um conceito NOVO e SEPARADO do "role='agent'"
  // (Gestor) que já existia — Gestor tem poder total igual ao dono;
  // esse Agente só ganha comissão sobre o rake da própria carteira de
  // membros vinculados, sem nenhum poder administrativo. As duas coisas
  // são independentes (um membro pode ser as duas, uma, ou nenhuma).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_wallets (
      id SERIAL PRIMARY KEY,
      club_id INTEGER NOT NULL REFERENCES clubs(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (club_id, user_id)
    );
  `);
  // Histórico de % de comissão do agente — nunca só faz UPDATE no valor;
  // cada mudança vira uma linha nova com a data em que passou a valer,
  // pra rake antigo continuar usando a taxa antiga (regra explícita).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS commission_rate_history (
      id SERIAL PRIMARY KEY,
      agent_wallet_id INTEGER NOT NULL REFERENCES agent_wallets(id),
      rate_percent NUMERIC NOT NULL,
      effective_from TIMESTAMPTZ NOT NULL DEFAULT now(),
      set_by INTEGER REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // Mesma lógica pro % de rakeback de cada membro.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rakeback_rate_history (
      id SERIAL PRIMARY KEY,
      club_id INTEGER NOT NULL REFERENCES clubs(id),
      member_user_id INTEGER NOT NULL REFERENCES users(id),
      rate_percent NUMERIC NOT NULL,
      effective_from TIMESTAMPTZ NOT NULL DEFAULT now(),
      set_by INTEGER REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // Vínculo membro → agente, com histórico completo (nunca apaga o
  // vínculo antigo, só marca quando ele deixou de valer).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_member_links (
      id SERIAL PRIMARY KEY,
      club_id INTEGER NOT NULL REFERENCES clubs(id),
      member_user_id INTEGER NOT NULL REFERENCES users(id),
      agent_wallet_id INTEGER REFERENCES agent_wallets(id),
      linked_from TIMESTAMPTZ NOT NULL DEFAULT now(),
      linked_until TIMESTAMPTZ,
      changed_by INTEGER REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // O evento em si — um por jogador por mão, com TODOS os valores já
  // calculados e "congelados" no momento em que aconteceu (usando a taxa
  // que estava valendo NAQUELE instante). Isso é o que garante que mudar
  // a % depois não recalcula o passado, e que fechamento nunca conta o
  // mesmo evento duas vezes (closing_id NULL = ainda não fechado).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rake_events (
      id SERIAL PRIMARY KEY,
      club_id INTEGER NOT NULL REFERENCES clubs(id),
      member_user_id INTEGER NOT NULL REFERENCES users(id),
      table_code TEXT,
      gross_amount NUMERIC NOT NULL,
      rakeback_rate NUMERIC NOT NULL DEFAULT 0,
      rakeback_amount NUMERIC NOT NULL DEFAULT 0,
      net_amount NUMERIC NOT NULL DEFAULT 0,
      agent_wallet_id INTEGER REFERENCES agent_wallets(id),
      commission_rate NUMERIC NOT NULL DEFAULT 0,
      commission_amount NUMERIC NOT NULL DEFAULT 0,
      club_result NUMERIC NOT NULL DEFAULT 0,
      closing_id INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rake_closings (
      id SERIAL PRIMARY KEY,
      club_id INTEGER NOT NULL REFERENCES clubs(id),
      type TEXT NOT NULL,
      period_start TIMESTAMPTZ NOT NULL,
      period_end TIMESTAMPTZ NOT NULL,
      closed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      closed_by INTEGER REFERENCES users(id),
      gross_rake NUMERIC NOT NULL,
      rakeback_total NUMERIC NOT NULL,
      commission_total NUMERIC NOT NULL,
      club_result NUMERIC NOT NULL,
      status TEXT NOT NULL DEFAULT 'closed'
    );
  `);

  // ============================================================
  // ROYALLE MASTER — painel administrativo da PLATAFORMA (diferente do
  // "Admin" que o dono de um clube já tem, que só enxerga o próprio
  // clube). Tudo aqui é aditivo — nenhuma tabela existente perde coluna
  // nem dado.
  // ============================================================

  // platform_role: null = usuário normal; 'super_admin' = acesso total
  // ao Royalle Master. status: pra bloquear/suspender uma CONTA (não
  // confundir com o role dentro de um clube, que é outra coisa).
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS platform_role TEXT;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';`);
  // Mesma ideia pro clube — 'active' | 'blocked' | 'suspended'.
  await pool.query(`ALTER TABLE clubs ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';`);

  // Pacotes de diamante configuráveis pelo Master (hoje eram fixos no
  // código do app) — preço em Royalle Coin, igual sempre foi (ver
  // decisão registrada no chat: diamante nesse app não é dinheiro real,
  // "venda manual" é o dono registrando uma venda que ele fechou por
  // fora, em R$, e creditando o diamante correspondente aqui).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS diamond_packages (
      id SERIAL PRIMARY KEY,
      diamonds INTEGER NOT NULL,
      coin_cost BIGINT NOT NULL,
      bonus_diamonds INTEGER NOT NULL DEFAULT 0,
      active BOOLEAN NOT NULL DEFAULT true,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Ledger de diamante — igual ao padrão que o app já usa pra fichas
  // (pay_ledger) e rake (rake_events): nunca só soma saldo, sempre
  // guarda o antes/depois. amount_brl é OPCIONAL e só preenchido numa
  // venda manual (dinheiro real que o dono recebeu por fora, tipo PIX);
  // nas outras origens (bônus, ajuste, uso dentro do app) fica nulo.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS diamond_transactions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      type TEXT NOT NULL, -- 'manual_sale' | 'bonus' | 'admin_adjust' | 'usage' | 'app_purchase'
      diamonds_delta INTEGER NOT NULL,
      balance_before BIGINT NOT NULL,
      balance_after BIGINT NOT NULL,
      amount_brl NUMERIC, -- só em venda manual: quanto dinheiro real foi recebido
      payment_method TEXT, -- 'pix' | 'dinheiro' | outro, só em venda manual
      channel TEXT, -- 'whatsapp' | 'app' | outro
      note TEXT,
      admin_id INTEGER REFERENCES users(id), -- quem executou (null se foi o próprio sistema)
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Condição comercial por clube — histórico completo (nunca
  // sobrescreve, sempre cria uma linha nova e marca a anterior como
  // inativa), com vigência opcional (ends_at) pra voltar sozinho ao
  // padrão. A condição ATIVA de um clube é a de maior id com active=true
  // e (ends_at IS NULL OR ends_at > now()).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS club_commercial_conditions (
      id SERIAL PRIMARY KEY,
      club_id INTEGER NOT NULL REFERENCES clubs(id),
      model TEXT NOT NULL DEFAULT 'standard', -- standard | partner | vip | enterprise | custom
      platform_rake_percent NUMERIC NOT NULL DEFAULT 20,
      club_rake_percent NUMERIC NOT NULL DEFAULT 80,
      renewal_price_brl NUMERIC,
      renewal_periodicity_days INTEGER,
      transfer_fee_percent NUMERIC NOT NULL DEFAULT 5,
      diamond_discount_percent NUMERIC NOT NULL DEFAULT 0,
      member_limit INTEGER,
      table_limit INTEGER,
      benefits TEXT,
      starts_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      ends_at TIMESTAMPTZ,
      active BOOLEAN NOT NULL DEFAULT true,
      created_by INTEGER REFERENCES users(id),
      reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Nível de clube configurável pelo Master — substitui a tabela fixa
  // que existia no código (CLUB_LEVEL_TIERS). Semeado com os MESMOS
  // valores que já estavam no código, pra não mudar nada pra quem já
  // tem clube em algum nível.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS club_level_configs (
      level INTEGER PRIMARY KEY,
      gestor_cap INTEGER NOT NULL,
      membro_cap INTEGER NOT NULL,
      price_diamonds BIGINT NOT NULL,
      benefits TEXT,
      updated_by INTEGER REFERENCES users(id),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  {
    const seed = [
      [0, 1, 10, 0], [1, 3, 60, 1500], [2, 4, 100, 2500], [3, 5, 150, 4000], [4, 6, 250, 8000],
      [5, 10, 600, 20000], [6, 12, 800, 30000], [7, 15, 1200, 45000], [8, 20, 1500, 60000],
      [9, 25, 1800, 80000], [10, 50, 2500, 110000],
    ];
    for (const [level, gestor, membro, price] of seed) {
      await pool.query(
        `INSERT INTO club_level_configs (level, gestor_cap, membro_cap, price_diamonds)
         VALUES ($1,$2,$3,$4) ON CONFLICT (level) DO NOTHING`,
        [level, gestor, membro, price]
      );
    }
  }

  // Log de auditoria — toda ação administrativa importante do Master
  // gera uma linha aqui. before/after em JSON pra guardar "o que era" e
  // "o que virou" sem precisar de uma tabela por tipo de ação.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_audit_logs (
      id SERIAL PRIMARY KEY,
      admin_id INTEGER REFERENCES users(id),
      action TEXT NOT NULL,
      target_type TEXT, -- 'club' | 'user' | 'diamond_package' | 'club_level' | 'commercial_condition' | ...
      target_id TEXT,
      before_json JSONB,
      after_json JSONB,
      reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Bootstrap: se a variável de ambiente SUPER_ADMIN_USERNAME estiver
  // definida e esse usuário já existir (se cadastrou normal no app),
  // promove ele a super_admin automaticamente a cada start do servidor
  // — sem isso não existiria NENHUM jeito de entrar no Master pela
  // primeira vez (ninguém pode se autopromover pelo próprio app).
  if (process.env.SUPER_ADMIN_USERNAME) {
    await pool.query(
      `UPDATE users SET platform_role = 'super_admin' WHERE username = $1 AND platform_role IS DISTINCT FROM 'super_admin'`,
      [process.env.SUPER_ADMIN_USERNAME]
    );
  }

  console.log("Banco de dados migrado com sucesso.");
}
