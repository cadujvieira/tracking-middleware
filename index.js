require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const csv = require("csv-parser");
const fs = require("fs");

const upload = multer({
  dest:"uploads/"
});

const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const { Pool } = require("pg");
const { v4: uuidv4 } = require("uuid");
const { google } = require("googleapis");

const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const META_AD_ACCOUNT_IDS = process.env.META_AD_ACCOUNT_IDS
  ? process.env.META_AD_ACCOUNT_IDS.split(",")
  : [];

const app = express();

app.use(cors());
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));

const crmCampaigns = [];

const PORT = process.env.PORT || 3000;
const EXPORT_PASSWORD = process.env.EXPORT_PASSWORD || "123456";
const FINAL_DESTINATION_URL = process.env.FINAL_DESTINATION_URL || "https://seudestino.com";
const DATABASE_URL = process.env.DATABASE_URL;

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

function hashIp(ip) {
  return crypto.createHash("sha256").update(ip || "").digest("hex");
}

function getClientIp(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.socket.remoteAddress ||
    ""
  );
}

function buildUrlWithParams(baseUrl, params) {
  const url = new URL(baseUrl);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, value);
    }
  });
  return url.toString();
}

function calcularQualidadeCampanha(ticketMedioDeposito, frequenciaDeposito, ftd) {
  if (ftd === 0) return "sem_ftd";
  if (ticketMedioDeposito >= 50 && frequenciaDeposito >= 2) return "diamante";
  if (ticketMedioDeposito >= 50) return "ouro";
  if (ticketMedioDeposito >= 30) return "muito_bom";
  if (ticketMedioDeposito >= 20) return "bom";
  return "ruim";
}

function normalizeName(name) {
  return String(name || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\[|\]/g, "")
    .replace(/__/g, "_")
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9 ]/g, "")
    .trim();
}

function calcularQualidadePublico(ticketMedioDeposito, depositos) {
  if (depositos === 0) return "sem_deposito";
  if (ticketMedioDeposito >= 50 && depositos >= 2) return "diamante";
  if (ticketMedioDeposito >= 50) return "ouro";
  if (ticketMedioDeposito >= 30) return "muito_bom";
  if (ticketMedioDeposito >= 20) return "bom";
  return "ruim";
}

function calcularScoreUsuario({ ticketMedioDeposito, frequenciaDeposito, depositos, receita }) {
  let score = 0;

  // Ticket médio
  if (ticketMedioDeposito >= 100) score += 35;
  else if (ticketMedioDeposito >= 50) score += 25;
  else if (ticketMedioDeposito >= 30) score += 15;
  else if (ticketMedioDeposito >= 20) score += 8;

  // Frequência
  if (frequenciaDeposito >= 5) score += 35;
  else if (frequenciaDeposito >= 3) score += 25;
  else if (frequenciaDeposito >= 2) score += 15;
  else if (frequenciaDeposito >= 1) score += 5;

  // Quantidade de depósitos
  if (depositos >= 10) score += 20;
  else if (depositos >= 5) score += 15;
  else if (depositos >= 2) score += 8;
  else if (depositos >= 1) score += 3;

  // Receita total
  if (receita >= 1000) score += 10;
  else if (receita >= 500) score += 7;
  else if (receita >= 200) score += 4;
  else if (receita >= 50) score += 2;

  if (score >= 85) return { score, nivel: "whale" };
  if (score >= 70) return { score, nivel: "vip" };
  if (score >= 50) return { score, nivel: "high_value" };
  if (score >= 30) return { score, nivel: "mid_value" };
  return { score, nivel: "low_value" };
}

function calcularDiasDesde(dataBR) {
  if (!dataBR || !dataBR.includes("/")) return null;

  const [dia, mes, ano] = dataBR.split("/");
  const dataEvento = new Date(`${ano}-${mes}-${dia}T00:00:00`);
  const hoje = new Date();

  hoje.setHours(0, 0, 0, 0);

  const diffMs = hoje - dataEvento;
  const diffDias = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  return diffDias >= 0 ? diffDias : 0;
}

function classificarSegmentoCRM(user, diasSemAtividade) {

  if (user.leads > 0 && user.ftd === 0) {
    return "lead_sem_deposito";
  }

  if (user.depositos > 0 && diasSemAtividade === 0) {
    return "d0";
  }

  if (user.depositos > 0 && diasSemAtividade >= 3 && diasSemAtividade < 7) {
    return "d3";
  }

  if (user.depositos > 0 && diasSemAtividade >= 7 && diasSemAtividade < 15) {
    return "d7";
  }

  if (user.depositos > 0 && diasSemAtividade >= 15 && diasSemAtividade < 30) {
    return "d15";
  }

  if (user.depositos > 0 && diasSemAtividade >= 30) {
    return "d30_plus";
  }

  return "ativo";
}

function definirOfertaCRM(user) {

  if (user.nivelScore === "whale" && user.segmentoCRM === "d7") {
    return "BONUS_100";
  }

  if (user.segmentoCRM === "lead_sem_deposito") {
    return "PIX_2000";
  }

  if (
    user.ticketMedioDeposito <= 20 &&
    user.segmentoCRM !== "lead_sem_deposito"
  ) {
    return "SORTEIO_015";
  }

  if (
    user.nivelScore === "vip" ||
    user.nivelScore === "whale"
  ) {
    return "VIP_1500";
  }

  if (
    user.segmentoCRM === "d15" ||
    user.segmentoCRM === "d30_plus"
  ) {
    return "REATIVACAO_URGENTE";
  }

  return "BONUS_PADRAO";
}

function gerarCopyCRM(user) {

  const nome = user.usuario || "Jogador";

  // WHALE / VIP
  if (
    user.nivelScore === "whale" ||
    user.nivelScore === "vip"
  ) {

    return {
      sms:
        "🔥 Condição VIP liberada hoje + sorteio exclusivo às 22h.",

      imagem:
        `Headline: ${nome}, condição VIP liberada | Oferta: bônus de 100% + sorteio de R$1.500 | CTA: Entrar agora`
    };
  }

  // LEAD SEM DEPÓSITO
  if (user.segmentoCRM === "lead_sem_deposito") {

    return {
      sms:
        "🎁 100% bônus liberado + sorteios de R$2.000 disponíveis hoje.",

      imagem:
        `Headline: ${nome}, seu bônus ainda está ativo | Oferta: 100% bônus + sorteios até R$2.000 | CTA: Ativar agora`
    };
  }

  // USUÁRIO D7+
  if (
    user.segmentoCRM === "d7" ||
    user.segmentoCRM === "d15" ||
    user.segmentoCRM === "d30_plus"
  ) {

    return {
      sms:
        "⚡ Seu perfil recebeu nova chance de reativação hoje.",

      imagem:
        `Headline: ${nome}, você recebeu nova chance | Oferta: R$2.000 no PIX + bônus | CTA: Voltar hoje`
    };
  }

  // BAIXO TICKET
  if (user.ticketMedioDeposito <= 20) {

    return {
      sms:
        "🎰 Sorteios a partir de R$0,15 liberados hoje.",

      imagem:
        `Headline: Sorteios a partir de R$0,15 | Oferta: mais de R$50 MIL em prêmios | CTA: Participar agora`
    };
  }

  // PADRÃO
  return {
    sms:
      "🔥 Novas promoções liberadas hoje no seu perfil.",

    imagem:
      `Headline: Promoções liberadas hoje | Oferta: bônus + sorteios | CTA: Entrar agora`
  };
}

function mascararUsuario(valor) {
  if (!valor) return "sem_identificacao";
  if (valor.includes("@")) {
    const [nome, dominio] = valor.split("@");
    return `${nome.slice(0, 3)}***@${dominio}`;
  }
  const limpo = String(valor).replace(/\D/g, "");
  if (limpo.length >= 4) return `***${limpo.slice(-4)}`;
  return valor;
}

function sha256(value) {
  return crypto
    .createHash("sha256")
    .update(String(value || "").trim().toLowerCase())
    .digest("hex");
}

function normalizePhone(phone) {
  return String(phone || "").replace(/[^0-9]/g, "");
}

function buildMetaUserData(user) {
  const userData = {};

  if (user.email) {
    userData.em = [sha256(user.email)];
  }

  const phone = normalizePhone(user.phone);
  if (phone) {
    userData.ph = [sha256(phone)];
  }

  return userData;
}

async function sendMetaConversionEvent(user, eventName = "Purchase") {
  const pixelId = process.env.META_PIXEL_ID;
  const accessToken = process.env.META_ACCESS_TOKEN;
  const testEventCode = process.env.META_TEST_EVENT_CODE;

  if (!pixelId || !accessToken) {
    throw new Error("META_PIXEL_ID ou META_ACCESS_TOKEN nao configurado no Render.");
  }

  const userData = buildMetaUserData(user);

  if (!userData.em && !userData.ph) {
    return {
      sent: false,
      reason: "Usuario sem email/telefone para enviar ao Meta.",
      user: user.usuario,
    };
  }

  const payload = {
    data: [
      {
        event_name: eventName,
        event_time: Math.floor(Date.now() / 1000),
        action_source: "website",
        event_source_url: "https://tracking-middleware.onrender.com/dashboard-audience",
        user_data: userData,
        custom_data: {
          currency: "BRL",
          value: Number(user.receita || 0),
          content_name: "High Value User",
          content_category: user.qualidade,
          quality: user.qualidade,
          deposits: Number(user.depositos || 0),
          ticket_medio_deposito: Number(user.ticketMedioDeposito || 0),
          frequencia_deposito: Number(user.frequenciaDeposito || 0),
          campanha_origem: user.campanhaOrigem || "",
        },
      },
    ],
  };

  if (testEventCode) {
    payload.test_event_code = testEventCode;
  }

  const response = await fetch(
    `https://graph.facebook.com/v20.0/${pixelId}/events?access_token=${accessToken}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    }
  );

  const responseBody = await response.json();

  return {
    sent: response.ok,
    status: response.status,
    user: user.usuario,
    qualidade: user.qualidade,
    receita: user.receita,
    meta: responseBody,
  };
}

async function getMetaCosts(sinceParam, untilParam) {
  try {
    const hoje = new Date();
    const ontem = new Date();

    ontem.setDate(hoje.getDate() - 1);

    const since = sinceParam || ontem.toISOString().split("T")[0];
    const until = untilParam || hoje.toISOString().split("T")[0];

    const costs = {};

    for (const accountId of META_AD_ACCOUNT_IDS) {
      const url = `https://graph.facebook.com/v19.0/act_${accountId}/insights`;

      const params = new URLSearchParams({
        access_token: META_ACCESS_TOKEN,
        level: "campaign",
        fields: "campaign_name,spend",
        time_range: JSON.stringify({
          since,
          until
        }),
        limit: "500"
      });

      const response = await fetch(`${url}?${params.toString()}`);
      const data = await response.json();

      if (!data.data) {
        console.log("ERRO META:", data);
        continue;
      }

      data.data.forEach((item) => {
        const normalized = normalizeName(item.campaign_name);

        if (!costs[normalized]) {
          costs[normalized] = 0;
        }

        costs[normalized] += parseFloat(item.spend || 0);
      });
    }

    console.log(costs);

    return costs;
  } catch (error) {
    console.log("ERRO META:", error.message);
    return {};
  }
}

async function getDefaultTenantId() {
  const result = await pool.query(
    "SELECT id FROM tenants WHERE slug = $1 LIMIT 1",
    ["bola-da-sorte"]
  );

  if (!result.rows.length) {
    throw new Error("Tenant padrão não encontrado.");
  }

  return result.rows[0].id;
}

function authMiddleware(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.replace("Bearer ", "");

    if (!token) {
      return res.status(401).json({
        ok: false,
        error: "Token não enviado"
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    req.user = decoded;
    req.tenantId = decoded.tenantId;

    next();

  } catch (error) {
    return res.status(401).json({
      ok: false,
      error: "Token inválido"
    });
  }
}

async function getSheetData() {
  const auth = new google.auth.GoogleAuth({
    keyFile: "/etc/secrets/credentials.json",
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });

  const sheets = google.sheets({ version: "v4", auth });

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range: "Página1!A:Z",
  });

  return response.data.values || [];
}

function normalizeEvent(body) {
  if (body.click_id && body.event_name) {
    return {
      click_id: body.click_id,
      event_name: body.event_name,
      event_id: body.event_id || `evt_${body.event_name}_${body.click_id}_${Date.now()}`,
      value: Number(body.value || 0),
      currency: body.currency || "BRL",
      raw: body,
    };
  }

  if (body.action === "invoice_paid" && body.invoice) {
    const invoice = body.invoice || {};
    const user = body.user || {};

    return {
      click_id:
        body.click_id ||
        body.subid ||
        body.sub_id ||
        body.utm_content ||
        body.utm_campaign ||
        `user_${user.id || "unknown"}`,
      event_name: "purchase",
      event_id: `invoice_${invoice.id || Date.now()}`,
      value: Number(invoice.value || 0),
      currency: "BRL",
      raw: body,
    };
  }

  return null;
}

async function initDb() {
  await pool.query(`
  CREATE TABLE IF NOT EXISTS tenants (
    id SERIAL PRIMARY KEY,
    nome TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    status TEXT DEFAULT 'ativo',
    created_at TIMESTAMP DEFAULT NOW()
  );
`);

  await pool.query(`
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER REFERENCES tenants(id),
  nome TEXT,
  email TEXT UNIQUE,
  senha TEXT,
  plano TEXT DEFAULT 'starter',
  created_at TIMESTAMP DEFAULT NOW()
);
`);

  await pool.query(`
  INSERT INTO tenants (nome, slug)
  VALUES ('Bola da Sorte', 'bola-da-sorte')
  ON CONFLICT (slug) DO NOTHING;
`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS clicks (
      id SERIAL PRIMARY KEY,
      click_id TEXT UNIQUE NOT NULL,
      utm_source TEXT,
      utm_medium TEXT,
      utm_campaign TEXT,
      utm_content TEXT,
      utm_term TEXT,
      campaign_id TEXT,
      adset_id TEXT,
      ad_id TEXT,
      creative_id TEXT,
      page_url TEXT,
      referrer TEXT,
      user_agent TEXT,
      ip_hash TEXT,
      raw_payload JSONB,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS events (
      id SERIAL PRIMARY KEY,
      click_id TEXT,
      event_id TEXT UNIQUE NOT NULL,
      event_name TEXT NOT NULL,
      value NUMERIC DEFAULT 0,
      currency TEXT DEFAULT 'BRL',
      utm_source TEXT,
      utm_medium TEXT,
      utm_campaign TEXT,
      utm_content TEXT,
      utm_term TEXT,
      campaign_id TEXT,
      adset_id TEXT,
      ad_id TEXT,
      creative_id TEXT,
      page_url TEXT,
      referrer TEXT,
      user_agent TEXT,
      ip_hash TEXT,
      is_duplicate BOOLEAN DEFAULT FALSE,
      raw_payload JSONB,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
CREATE TABLE IF NOT EXISTS audience (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER DEFAULT 1,

  click_id TEXT,
  user_id TEXT,
  telefone TEXT,
  email TEXT,

  receita NUMERIC DEFAULT 0,
  depositos INTEGER DEFAULT 0,
  ftd INTEGER DEFAULT 0,

  ultimo_evento TEXT,
  ultimo_evento_at TIMESTAMP,

  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,

  score NUMERIC DEFAULT 0,
  segmento TEXT,
  qualidade TEXT,

  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
`);

  await pool.query(`
    ALTER TABLE events
      ADD COLUMN IF NOT EXISTS tenant_id INTEGER REFERENCES tenants(id);
  `);

  await pool.query(`
    ALTER TABLE clicks
      ADD COLUMN IF NOT EXISTS tenant_id INTEGER DEFAULT 1
  `);

  await pool.query(`
    ALTER TABLE events
      ADD COLUMN IF NOT EXISTS tenant_id INTEGER DEFAULT 1
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS postback_logs (
      id SERIAL PRIMARY KEY,
      event_id TEXT,
      click_id TEXT,
      destination TEXT,
      status TEXT,
      request_payload JSONB,
      response_body TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS meta_audience_sent (
      id SERIAL PRIMARY KEY,
      user_key_hash TEXT NOT NULL,
      event_name TEXT NOT NULL,
      user_label TEXT,
      qualidade TEXT,
      receita NUMERIC DEFAULT 0,
      depositos INTEGER DEFAULT 0,
      ticket_medio_deposito NUMERIC DEFAULT 0,
      frequencia_deposito NUMERIC DEFAULT 0,
      meta_status INTEGER,
      meta_response JSONB,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(user_key_hash, event_name)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS crm_campaigns (
  id SERIAL PRIMARY KEY,
  tenant_id INTEGER REFERENCES tenants(id),
  nome TEXT,
  segmento TEXT,
  canal TEXT,
  custo NUMERIC DEFAULT 0,
  receita NUMERIC DEFAULT 0,
  lucro NUMERIC DEFAULT 0,
  reativados INTEGER DEFAULT 0,
  usuarios_impactados JSONB,
  usuarios_reativados JSONB,
  data_disparo TIMESTAMP DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW()
);
`);

  await pool.query(`
  CREATE TABLE IF NOT EXISTS crm_export_logs (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER DEFAULT 1,
    nome_lista TEXT,
    segmento TEXT,
    min_score NUMERIC DEFAULT 0,
    total_usuarios INTEGER DEFAULT 0,
    total_com_telefone INTEGER DEFAULT 0,
    receita_total NUMERIC DEFAULT 0,
    depositos_total INTEGER DEFAULT 0,
    data_exportacao TIMESTAMP DEFAULT NOW()
  );
`);

  await pool.query(`
  CREATE TABLE IF NOT EXISTS crm_imported_leads (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER DEFAULT 1,
    lista_id INTEGER,
    cpf TEXT,
    email TEXT,
    telefone TEXT,
    dias_sem_logar INTEGER DEFAULT 0,
    status TEXT,
    temperatura TEXT,
    possui_cadastro BOOLEAN DEFAULT FALSE,
    ja_depositou BOOLEAN DEFAULT FALSE,
    ftd BOOLEAN DEFAULT FALSE,
    receita NUMERIC DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW()
  );
`);

  await pool.query(`
  ALTER TABLE crm_imported_leads
  ADD COLUMN IF NOT EXISTS prioridade_disparo TEXT;
`);

  await pool.query(`
  ALTER TABLE crm_imported_leads
  ADD COLUMN IF NOT EXISTS status_disparo TEXT DEFAULT 'novo';
`);

await pool.query(`
  ALTER TABLE crm_imported_leads
  ADD COLUMN IF NOT EXISTS data_disparo TIMESTAMP;
`);

await pool.query(`
  ALTER TABLE crm_imported_leads
  ADD COLUMN IF NOT EXISTS tentativas INTEGER DEFAULT 0;
`);
}  

app.post("/crm/nova-campanha", authMiddleware, express.json(), async (req, res) => {

  try {

    const {
      nome,
      segmento,
      canal,
      oferta,
      custo,
      enviados
    } = req.body;

    const tenantId = req.user.tenantId;

    const campanha = {
      id: Date.now().toString(),
      tenant_id: tenantId,
      nome,
      segmento,
      canal,
      oferta,
      custo: Number(custo || 0),
      enviados: Number(enviados || 0),
      data: new Date(),
      reativados: 0,
      receita: 0,
      lucro: 0,
      usuariosReativados: []
    };

    await pool.query(`
  INSERT INTO crm_campaigns (
    tenant_id,
    nome,
    segmento,
    canal,
    custo,
    receita,
    lucro,
    reativados,
    usuarios_impactados,
    usuarios_reativados
  )
  VALUES (
    $1,$2,$3,$4,$5,$6,$7,$8,$9,$10
  )
`, [
  campanha.tenant_id,
  campanha.nome,
  campanha.segmento,
  campanha.canal,
  campanha.custo,
  campanha.receita,
  campanha.lucro,
  campanha.reativados,
  JSON.stringify(campanha.enviados || []),
  JSON.stringify(campanha.usuariosReativados || [])
]);

res.json({
  ok: true,
  campanha
});

} catch (error) {
  res.status(500).json({
    ok: false,
    error: error.message
  });
}
});

app.post("/auth/register", express.json(), async (req, res) => {
  try {
    const { nome, email, senha } = req.body;

    if (!nome || !email || !senha) {
      return res.status(400).json({
        ok: false,
        error: "Nome, email e senha são obrigatórios"
      });
    }

    const senhaHash = await bcrypt.hash(senha, 10);

    const tenantResult = await pool.query(`
      INSERT INTO tenants (nome, slug)
      VALUES ($1, $2)
      RETURNING id, nome, slug
    `, [
      nome,
      email.toLowerCase().replace(/[^a-z0-9]/g, "-")
    ]);

    const tenant = tenantResult.rows[0];

    const userResult = await pool.query(`
      INSERT INTO users (
        tenant_id,
        nome,
        email,
        senha
      )
      VALUES ($1, $2, $3, $4)
      RETURNING id, tenant_id, nome, email, plano
    `, [
      tenant.id,
      nome,
      email.toLowerCase(),
      senhaHash
    ]);

    const user = userResult.rows[0];

    const token = jwt.sign(
      {
        userId: user.id,
        tenantId: user.tenant_id
      },
      process.env.JWT_SECRET,
      { expiresIn: "30d" }
    );

    res.json({
      ok: true,
      token,
      user
    });

  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.post("/auth/login", express.json(), async (req, res) => {
  try {
    const { email, senha } = req.body;

    if (!email || !senha) {
      return res.status(400).json({
        ok: false,
        error: "Email e senha são obrigatórios"
      });
    }

    const result = await pool.query(`
      SELECT *
      FROM users
      WHERE email = $1
      LIMIT 1
    `, [
      email.toLowerCase()
    ]);

    if (!result.rows.length) {
      return res.status(401).json({
        ok: false,
        error: "Usuário não encontrado"
      });
    }

    const user = result.rows[0];

    const senhaValida = await bcrypt.compare(senha, user.senha);

    if (!senhaValida) {
      return res.status(401).json({
        ok: false,
        error: "Senha inválida"
      });
    }

    const token = jwt.sign(
      {
        userId: user.id,
        tenantId: user.tenant_id
      },
      process.env.JWT_SECRET,
      { expiresIn: "30d" }
    );

    res.json({
      ok: true,
      token,
      user: {
        id: user.id,
        tenant_id: user.tenant_id,
        nome: user.nome,
        email: user.email,
        plano: user.plano
      }
    });

  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});    

app.post("/upload-lista", upload.single("file"), async (req, res) => {

  try{

    const resultados = [];

    fs.createReadStream(req.file.path)
      .pipe(csv())
      .on("data", (data) => {

        resultados.push(data);

      })
      .on("end", async () => {

        const listaResult = await pool.query(`
          INSERT INTO crm_export_logs (
           nome_lista,
           segmento,
           total_usuarios,
           total_com_telefone
  )
  VALUES ($1,$2,$3,$4)
  RETURNING id
`, [
  req.file.originalname,
  "importada",
  resultados.length,
  resultados.filter(item => {
  const telefone =
    item.telefone ||
    item.Telefone ||
    item.TELEFONE ||
    item.phone ||
    item.Phone ||
    item.celular ||
    item.Celular ||
    item.whatsapp ||
    item.WhatsApp ||
    item.numero ||
    item.Numero ||
    item["número"] ||
    item["Número"] ||
    item["telefone "] ||
    item["Telefone "] ||
    item.telefone_celular ||
    item.mobile ||
    item["Phone Number"] ||
    item["Número de telefone"];

  return telefone && String(telefone).replace(/\D/g, "").length >= 8;
}).length
]);

const listaId = listaResult.rows[0].id;

        for(const item of resultados){

          const diasSemLogar = Number(
  item.dias_sem_logar ||
  item.diasSemLogar ||
  item["dias sem logar"] ||
  item["Dias sem logar"] ||
  item["DIAS SEM LOGAR"] ||
  item["dias_sem_login"] ||
  item["dias sem login"] ||
  item["Dias sem login"] ||
  item["ultimo_login_dias"] ||
  item["dias_inativo"] ||
  item["Dias Inativo"] ||
  0
);

          let temperatura = "FRIO";
let prioridadeDisparo = "BAIXA";

if(diasSemLogar <= 7){
  temperatura = "QUENTE";
  prioridadeDisparo = "ALTA";
}
else if(diasSemLogar <= 30){
  temperatura = "MORNO";
  prioridadeDisparo = "MEDIA";
}
else if(diasSemLogar <= 90){
  temperatura = "FRIO";
  prioridadeDisparo = "BAIXA";
}
else{
  temperatura = "MORTO";
  prioridadeDisparo = "REATIVACAO_PESADA";
}

          await pool.query(`
            INSERT INTO crm_imported_leads (
              lista_id,
              cpf,
              email,
              telefone,
              dias_sem_logar,
              status,
              temperatura,
              prioridade_disparo
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
          `,[
              listaId,
              item.cpf || null,
              item.email || null,
              item.telefone || item.Telefone || item.TELEFONE || item.phone || item.Phone || item.celular || item.Celular || item.whatsapp || item.WhatsApp || item.numero || item.Numero || item["número"] || item["Número"] || item["telefone "] || item["Telefone "] || item.telefone_celular || item.mobile || item["Phone Number"] || item["Número de telefone"] || null,
              diasSemLogar,
              item.status || item.situacao || null,
              temperatura,
              prioridadeDisparo
          ]);

        }

        fs.unlinkSync(req.file.path);

        res.json({
          success:true,
          imported:resultados.length,
          message:"Lista importada com sucesso"
        });

      });

  }catch(error){

    console.error(error);

    res.status(500).json({
      success:false,
      error:error.message
    });

  }

});

app.get("/dashboard-performance", (req, res) => {
  res.redirect("/dashboard-crm-performance");
});

app.get("/dashboard-crm-performance", (req, res) => {

  const rows = crmCampaigns.map((c) => {

    const roi = c.custo > 0
      ? (((c.receita - c.custo) / c.custo) * 100).toFixed(2)
      : 0;

   const taxaReativacao =
  c.enviados > 0
    ? ((c.reativados / c.enviados) * 100).toFixed(2)
    : 0;   

    return `
      <tr>
        <td>${c.nome}</td>
        <td>${c.segmento}</td>
        <td>${c.canal}</td>
        <td>${c.oferta}</td>
        <td>${c.enviados}</td>
        <td>${c.reativados}</td>
        <td>R$ ${c.receita.toFixed(2)}</td>
        <td>R$ ${c.custo.toFixed(2)}</td>
        <td>${roi}%</td>
        <td>${taxaReativacao}%</td>
      </tr>
    `;

  }).join("");

  const performance = crmCampaigns.map((c) => {
  const conversao = c.enviados > 0
    ? ((c.reativados / c.enviados) * 100).toFixed(2)
    : 0;

  return {
    campaign: c.nome || "Sem campanha",
    leads: c.enviados || 0,
    depositos: c.reativados || 0,
    ftd: c.reativados || 0,
    conversao,
    receita: Number(c.receita || 0)
  };
});

const totalRevenue = performance.reduce((acc, item) => acc + Number(item.receita || 0), 0);
const totalFtd = performance.reduce((acc, item) => acc + Number(item.ftd || 0), 0);
const totalDepositos = performance.reduce((acc, item) => acc + Number(item.depositos || 0), 0);
const totalLeads = performance.reduce((acc, item) => acc + Number(item.leads || 0), 0);

  res.send(`
    <html>

    <head>

      <title>CRM Performance</title>

      <style>

        body {
          font-family: Arial;
          background:#0f172a;
          color:#e5e7eb;
          padding:30px;
        }

        h1 {
          margin-bottom:20px;
        }

        table {
          width:100%;
          border-collapse:collapse;
          background:#111827;
          border-radius:12px;
          overflow:hidden;
        }

        th, td {
          padding:14px;
          border-bottom:1px solid #1f2937;
          text-align:left;
        }

        th {
          background:#1e293b;
          color:#93c5fd;
        }

        tr:hover {
          background:#1f2937;
        }

        .container{
display:flex;
min-height:100vh;
}

.sidebar{
width:240px;
background:#07101f;
border-right:1px solid #13203a;
padding:30px 22px;
}

.logo{
font-size:38px;
font-weight:800;
margin-bottom:42px;
}

.nav-item{
display:block;
padding:14px 18px;
border-radius:14px;
color:#94a3b8;
text-decoration:none;
margin-bottom:10px;
font-weight:700;
}

.nav-item:hover{
background:#13203a;
color:white;
}

.active{
background:#2563eb;
color:white;
}

.main{
flex:1;
padding:32px;
}

.topbar{
display:flex;
justify-content:space-between;
align-items:center;
margin-bottom:30px;
}

.page-title{
font-size:48px;
font-weight:800;
}

.status-badge{
background:#2563eb;
padding:12px 18px;
border-radius:14px;
font-weight:700;
}

.stats-grid{
display:grid;
grid-template-columns: repeat(auto-fit,minmax(140px,1fr));
gap:20px;
margin-bottom:24px;
}

.stat-card{
background:#081428;
border:1px solid #13203a;
border-radius:22px;
padding:24px;
}

.stat-label{
color:#94a3b8;
margin-bottom:10px;
}

.stat-value{
font-size:42px;
font-weight:800;
}

.big-card{
background:#081428;
border:1px solid #13203a;
border-radius:24px;
padding:24px;
}

.big-title{
font-size:30px;
font-weight:800;
margin-bottom:24px;
}

.table-header{
display:grid;
grid-template-columns:2fr .8fr .8fr .8fr 1fr 1fr;
gap:12px;
background:#0f172a;
border:1px solid #13203a;
padding:16px;
border-radius:14px;
font-size:13px;
font-weight:800;
color:#94a3b8;
margin-bottom:12px;
}

.table-row{
display:grid;
grid-template-columns:2fr .8fr .8fr .8fr 1fr 1fr;
gap:12px;
align-items:center;
background:#081428;
border:1px solid #13203a;
padding:18px;
border-radius:16px;
margin-bottom:10px;
}

.campaign-name{
font-weight:800;
}

.green{
color:#4ade80;
font-weight:800;
}

.blue{
color:#60a5fa;
font-weight:800;
}

      </style>

    </head>

    <body>

      <div class="container">

  <div class="sidebar">

    <div class="logo">
      RetentionOS
    </div>

    <a href="/painel-auth" class="nav-item">📊 Painel</a>
    <a href="/dashboard-view" class="nav-item">🚀 Campanhas</a>
    <a href="/dashboard-daily" class="nav-item">📅 Por Data</a>
    <a href="/dashboard-performance" class="nav-item active">📈 Performance</a>
    <a href="/dashboard-crm" class="nav-item">📬 CRM</a>

  </div>

  <div class="main">

    <div class="topbar">

      <div>

        <div style="
          color:#94a3b8;
          font-size:14px;
          margin-bottom:6px;
        ">
          RetentionOS Platform
        </div>

        <div class="page-title">
          Performance
        </div>

      </div>

      <div class="status-badge">
        Dados em tempo real
      </div>

    </div>

    <div class="stats-grid">

      <div class="stat-card">
        <div class="stat-label">Revenue Total</div>
        <div class="stat-value">
          R$ ${totalRevenue.toLocaleString("pt-BR")}
        </div>
      </div>

      <div class="stat-card">
        <div class="stat-label">FTD</div>
        <div class="stat-value">
          ${totalFtd}
        </div>
      </div>

      <div class="stat-card">
        <div class="stat-label">Depósitos</div>
        <div class="stat-value">
          ${totalDepositos}
        </div>
      </div>

      <div class="stat-card">
        <div class="stat-label">Leads</div>
        <div class="stat-value">
          ${totalLeads}
        </div>
      </div>

    </div>

    <div class="big-card">

      <div class="big-title">
        Ranking operacional
      </div>

      <div class="table-header">

        <div>Campanha</div>
        <div>Leads</div>
        <div>Depósitos</div>
        <div>FTD</div>
        <div>Conversão</div>
        <div>Revenue</div>

      </div>

 ${performance.map(function(item) {
  return (
    '<div class="table-row">' +
      '<div class="campaign-name">' + item.campaign + '</div>' +
      '<div>' + item.leads + '</div>' +
      '<div>' + item.depositos + '</div>' +
      '<div class="blue">' + item.ftd + '</div>' +
      '<div>' + item.conversao + '%</div>' +
      '<div class="green">R$ ' + Number(item.receita || 0).toLocaleString("pt-BR") + '</div>' +
    '</div>'
  );
}).join("")}

    </div>

  </div>

</div>

        <tbody>
          ${rows}
        </tbody>

      </table>

    </body>

    </html>
  `);

});

app.get("/dashboard-listas", async (req, res) => {
  try {

    const listas = await pool.query(`
  SELECT
    l.*,
    COUNT(i.id)::int AS total_importados,
    COUNT(i.id) FILTER (WHERE i.temperatura = 'QUENTE')::int AS quente,
    COUNT(i.id) FILTER (WHERE i.temperatura = 'MORNO')::int AS morno,
    COUNT(i.id) FILTER (WHERE i.temperatura = 'FRIO')::int AS frio,
    COUNT(i.id) FILTER (WHERE i.temperatura = 'MORTO')::int AS morto,
    COUNT(i.id) FILTER (WHERE i.prioridade_disparo = 'ALTA')::int AS prioridade_alta,
    COUNT(i.id) FILTER (WHERE i.prioridade_disparo = 'MEDIA')::int AS prioridade_media,
    COUNT(i.id) FILTER (WHERE i.prioridade_disparo = 'BAIXA')::int AS prioridade_baixa,
    COUNT(i.id) FILTER (WHERE i.prioridade_disparo = 'REATIVACAO_PESADA')::int AS prioridade_reativacao, 

    COUNT(i.id) FILTER (
  WHERE COALESCE(i.status_disparo, 'novo') = 'novo'
)::int AS novos,

COUNT(i.id) FILTER (
  WHERE i.status_disparo = 'exportado'
)::int AS exportados,

SUM(COALESCE(i.tentativas,0))::int AS tentativas_total

  FROM crm_export_logs l
  LEFT JOIN crm_imported_leads i ON i.lista_id = l.id
  GROUP BY l.id
  ORDER BY l.data_exportacao DESC
  LIMIT 100
`);

    const rows = listas.rows;

    const totalListas = rows.length;

    const totalLeads = rows.reduce(
      (acc, item) => acc + Number(item.total_usuarios || 0),
      0
    );

    const totalTelefones = rows.reduce(
      (acc, item) => acc + Number(item.total_com_telefone || 0),
      0
    );

    const totalReceita = rows.reduce(
      (acc, item) => acc + Number(item.receita_total || 0),
      0
    );

    const totalDepositos = rows.reduce(
      (acc, item) => acc + Number(item.depositos_total || 0),
      0
    );

    res.send(`
<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">

<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>

<style>

*{
  box-sizing:border-box;
}      

body{
  margin:0;
  background:#020817;
  color:white;
  font-family:Inter,sans-serif;
}

.container{
  display:flex;
}

.sidebar{
  width:240px;
  min-height:100vh;
  background:#031133;
  padding:32px 20px;
  border-right:1px solid rgba(255,255,255,0.05);
}

.logo{
  font-size:42px;
  font-weight:800;
  margin-bottom:40px;
}

.menu-item{
  padding:14px 16px;
  border-radius:14px;
  margin-bottom:10px;
  background:#2563eb;
  font-weight:700;
}

.content{
  flex:1;
  padding:40px;
}

.title{
  font-size:52px;
  font-weight:800;
  margin-bottom:30px;
}

.stats{
  display:grid;
  grid-template-columns:repeat(auto-fit,minmax(160px,1fr));
  gap:20px;
  margin-bottom:30px;
}

.card{
  background:#071a44;
  border:1px solid rgba(255,255,255,0.05);
  border-radius:22px;
  padding:24px;
}

.label{
  color:#94a3b8;
  font-size:14px;
}

.value{
  font-size:42px;
  font-weight:800;
  margin-top:12px;
}

.big-card{
  background:#071a44;
  border-radius:22px;
  padding:30px;
  margin-bottom:30px;
}

.table-header,
.table-row{
  display:grid;
  grid-template-columns:2fr 1fr 1fr 1fr 1fr 1fr;
  gap:16px;
  align-items:center;
}

.table-header{
  color:#94a3b8;
  font-size:13px;
  font-weight:700;
  margin-bottom:20px;
}

.table-row{
  background:#081428;
  padding:18px;
  border-radius:16px;
  margin-bottom:12px;
  border:1px solid #13203a;
}

.green{
  color:#4ade80;
  font-weight:700;
}

</style>
</head>

<body>

<div class="container">

<div class="sidebar">
<div class="logo">📦</div>

<div class="menu-item">
Listas Exportadas
</div>
</div>

<div class="content">

<div style="
display:flex;
justify-content:space-between;
align-items:center;
margin-bottom:30px;
">

<div class="title" style="margin-bottom:0;">
Dashboard de Listas
</div>

<button onclick="document.getElementById('csvFile').click()" style="
background:#2563eb;
border:none;
color:white;
padding:14px 22px;
border-radius:14px;
font-weight:700;
cursor:pointer;
font-size:15px;
">
➕ Importar Lista
</button>

<input
type="file"
id="csvFile"
accept=".csv"
style="display:none;"
/>

</div>

<div class="stats">

<div class="card">
<div class="label">Listas</div>
<div class="value">${totalListas}</div>
</div>

<div class="card">
<div class="label">Leads</div>
<div class="value">${totalLeads}</div>
</div>

<div class="card">
<div class="label">Telefones</div>
<div class="value">${totalTelefones}</div>
</div>

<div class="card">
<div class="label">Revenue</div>
<div class="value">
R$ ${totalReceita.toLocaleString("pt-BR")}
</div>
</div>

</div>

<div class="big-card">

<h2 style="margin-top:0;">
Listas exportadas
</h2>

<div style="
display:grid;
grid-template-columns:repeat(auto-fit,minmax(520px,1fr));
gap:24px;
align-items:start;
">

${listas.rows.map(item => `

<div class="lista-card" style="
background:linear-gradient(180deg,#081428,#091b3f);
border:1px solid rgba(255,255,255,0.06);
border-radius:24px;
padding:32px;
margin-bottom:28px;
width:100%;
box-shadow:0 20px 60px rgba(0,0,0,0.28);
transition:0.2s ease;
">

  <div style="
  display:flex;
  justify-content:space-between;
  align-items:center;
  margin-bottom:20px;
  ">

    <div>
      <div style="font-size:20px;font-weight:900;color:white;">
        📦 ${item.nome_lista}
      </div>

      <div style="font-size:13px;color:#94a3b8;margin-top:4px;">
        Segmento: ${item.segmento || "importada"}
      </div>
    </div>

    <div style="
    background:#16a34a20;
    color:#4ade80;
    padding:10px 16px;
    border-radius:999px;
    font-weight:900;
    ">
      R$ ${Number(item.receita_total || 0).toLocaleString("pt-BR")}
    </div>

  </div>

  <div style="
  display:grid;
  grid-template-columns:repeat(4,minmax(90px,1fr));
  gap:14px;
  margin-top:18px;
  ">

    <div style="background:#2563eb20;padding:16px;border-radius:16px;">
      <div style="color:#93c5fd;font-size:12px;font-weight:800;">🔥 QUENTE</div>
      <div style="font-size:36px;line-height:36px;font-weight:900;color:white;">
        ${item.quente || 0}
      </div>
    </div>

    <div style="background:#f59e0b20;padding:16px;border-radius:16px;">
      <div style="color:#fcd34d;font-size:12px;font-weight:800;">🌤 MORNO</div>
      <div style="font-size:36px;line-height:36px;font-weight:900;color:white;">
        ${item.morno || 0}
      </div>
    </div>

    <div style="background:#06b6d420;padding:16px;border-radius:16px;">
      <div style="color:#67e8f9;font-size:12px;font-weight:800;">❄ FRIO</div>
      <div style="font-size:36px;line-height:36px;font-weight:900;color:white;">
        ${item.frio || 0}
      </div>
    </div>

    <div style="background:#ef444420;padding:16px;border-radius:16px;">
      <div style="color:#fca5a5;font-size:12px;font-weight:800;">💀 MORTO</div>
      <div style="font-size:36px;line-height:36px;font-weight:900;color:white;">
        ${item.morto || 0}
      </div>
    </div>

    <div style="
</div>

<div style="
display:grid;
grid-template-columns:repeat(3,1fr);
gap:12px;
margin-top:18px;
">

<div style="background:#1e293b;padding:14px;border-radius:14px;">
  <div style="font-size:12px;color:#94a3b8;font-weight:700;">NOVOS</div>
  <div style="font-size:28px;font-weight:900;color:white;margin-top:4px;">${item.novos || 0}</div>
</div>

<div style="background:#065f46;padding:14px;border-radius:14px;">
  <div style="font-size:12px;color:#6ee7b7;font-weight:700;">EXPORTADOS</div>
  <div style="font-size:28px;font-weight:900;color:white;margin-top:4px;">${item.exportados || 0}</div>
</div>

<div style="background:#7c2d12;padding:14px;border-radius:14px;">
  <div style="font-size:12px;color:#fdba74;font-weight:700;">TENTATIVAS</div>
  <div style="font-size:28px;font-weight:900;color:white;margin-top:4px;">${item.tentativas_total || 0}</div>
</div>

</div>

<div style="
display:grid;
grid-template-columns:repeat(5,1fr);
gap:12px;
margin-top:18px;
">

<button onclick="exportarSegmento('${item.id}','QUENTE')" style="background:#ff6b00;border:none;height:52px;border-radius:12px;color:white;font-weight:800;cursor:pointer;font-size:12px;">
🔥 Exportar<br>Quente
</button>

<button onclick="exportarSegmento('${item.id}','MORNO')" style="background:#eab308;border:none;height:52px;border-radius:12px;color:white;font-weight:800;cursor:pointer;font-size:12px;">
🌤 Exportar<br>Morno
</button>

<button onclick="exportarSegmento('${item.id}','FRIO')" style="background:#06b6d4;border:none;height:52px;border-radius:12px;color:white;font-weight:800;cursor:pointer;font-size:12px;">
❄ Exportar<br>Frio
</button>

<button onclick="exportarSegmento('${item.id}','MORTO')" style="background:#7f1d1d;border:none;height:52px;border-radius:12px;color:white;font-weight:800;cursor:pointer;font-size:12px;">
💀 Exportar<br>Morto
</button>

<button onclick="apagarLista(${item.id})" style="background:#ef4444;border:none;height:52px;border-radius:12px;color:white;font-weight:800;cursor:pointer;font-size:12px;">
🗑 Apagar<br>Lista
</button>

</div>

`).join("")}

</div>

</div>
</div>

<script>

document.getElementById("csvFile").addEventListener("change", async function(e){

  const file = e.target.files[0];

  if(!file){
    return;
  }

  const formData = new FormData();

  formData.append("file", file);

  try{

    const response = await fetch("/upload-lista", {
      method:"POST",
      body:formData
    });

    const result = await response.json();

    alert(result.message);

    location.reload();

  }catch(error){

    alert("Erro ao importar lista");

  }

});

async function apagarLista(id){
  if(!confirm("Tem certeza que deseja apagar esta lista?")){
    return;
  }

  const response = await fetch("/dashboard-listas/delete/" + id, {
    method:"POST"
  });

  const result = await response.json();

  alert(result.message || "Lista apagada");

  location.reload();
}

function exportarSegmento(listaId, segmento){

  const senha = prompt("Digite a senha para exportar:");

  if(!senha){
    return;
  }

  window.open(
    "/exportar-lista/" + listaId + "/" + segmento + "?senha=" + encodeURIComponent(senha),
    "_blank"
  );
}

async function apagarLista(id){
  if(!confirm("Tem certeza que deseja apagar esta lista?")){
    return;
  }

  const response = await fetch("/dashboard-listas/delete/" + id, {
    method:"POST"
  });

  const result = await response.json();

  if(result.success){
    alert("Lista apagada com sucesso");
    location.reload();
  } else {
    alert("Erro ao apagar lista: " + (result.error || ""));
  }
}

</script>

</body>
</html>
    `);

  } catch (error) {

    console.error(error);

    res.status(500).send(error.message);

  }
});

app.delete("/apagar-lista/:id", async (req, res) => {
  try {
    const { id } = req.params;

    await pool.query("DELETE FROM crm_leads WHERE lista_id = $1", [id]);

    await pool.query("DELETE FROM crm_listas WHERE id = $1", [id]);

    res.json({
      success: true
    });

  } catch (error) {
    console.error("Erro ao apagar lista:", error);

    res.status(500).json({
      error: "Erro ao apagar lista"
    });
  }
});

app.post("/dashboard-listas/delete/:id", async (req, res) => {
  try {
    const id = req.params.id;

    await pool.query(`
      DELETE FROM crm_imported_leads
      WHERE lista_id = $1
    `, [id]);

    await pool.query(`
      DELETE FROM crm_export_logs
      WHERE id = $1
    `, [id]);

    res.json({
      success:true,
      message:"Lista apagada com sucesso"
    });

  } catch (error) {
    res.status(500).json({
      success:false,
      error:error.message
    });
  }
});

app.get("/exportar-lista/:listaId/:temperatura", async (req, res) => {
  try {

    const { senha } = req.query;

if (senha !== EXPORT_PASSWORD) {
  return res.status(401).send("Senha inválida");
}

    const { listaId, temperatura } = req.params;

    const resultado = await pool.query(`
      SELECT
        cpf,
        email,
        telefone,
        dias_sem_logar,
        status,
        temperatura,
        prioridade_disparo
      FROM crm_imported_leads
      WHERE lista_id = $1
      AND temperatura = $2
      AND COALESCE(status_disparo, 'novo') = 'novo'
      ORDER BY dias_sem_logar ASC
    `, [listaId, temperatura]);

    const header = [
      "cpf",
      "email",
      "telefone",
      "dias_sem_logar",
      "status",
      "temperatura",
      "prioridade_disparo"
    ];

    const lines = resultado.rows.map(item => [
      item.cpf || "",
      item.email || "",
      item.telefone || "",
      item.dias_sem_logar || "",
      item.status || "",
      item.temperatura || "",
      item.prioridade_disparo || ""
    ]);

    const csv = [
      header.join(";"),
      ...lines.map(line =>
        line.map(value => `"${String(value).replace(/"/g, '""')}"`).join(";")
      )
    ].join("\n");

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="lista_${temperatura}.csv"`);

    await pool.query(`
  UPDATE crm_imported_leads
  SET
    status_disparo = 'exportado',
    data_disparo = NOW(),
    tentativas = COALESCE(tentativas, 0) + 1
  WHERE lista_id = $1
  AND temperatura = $2
  AND COALESCE(status_disparo, 'novo') = 'novo'
`, [listaId, temperatura]);

    res.send("\uFEFF" + csv);

  } catch (error) {
    res.status(500).send("Erro ao exportar lista: " + error.message);
  }
});

app.post("/crm/marcar-usuarios", express.json(), (req, res) => {

  try {

    const {
      campanhaId,
      usuarios
    } = req.body;

    const campanha = crmCampaigns.find(c => c.id === campanhaId);

    if (!campanha) {

      return res.status(404).json({
        ok: false,
        error: "Campanha não encontrada"
      });

    }

    campanha.usuariosImpactados = usuarios || [];

    campanha.dataDisparo = new Date();

    res.json({
      ok: true,
      campanha
    });

  } catch (error) {

    res.status(500).json({
      ok: false,
      error: error.message
    });

  }

});

app.get("/", (req, res) => {
  res.json({
    status: "online",
    service: "tracking-middleware",
    endpoints: [
      "/redirect",
      "/event",
      "/test-sheet-2",
      "/sheets/events",
      "/sheets/dashboard",
      "/sheets/campaigns",
      "/sheets/top",
      "/sheets/daily",
      "/sheets/audience",
      "/painel",
      "/dashboard-view",
      "/dashboard-daily",
      "/dashboard-audience",
      "/dashboard-crm",
      "/meta/send-valued-audience",
      "/meta/sent-audience-status",
      "/dashboard/summary",
      "/dashboard/campaigns",
      "/dashboard/creatives",
    ],
  });
});

app.get("/test-sheet-2", async (req, res) => {
  try {
    const data = await getSheetData();
    res.json({ ok: true, rows: data.length, preview: data.slice(0, 5) });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/sheets/events", async (req, res) => {
  try {
    const data = await getSheetData();
    const headers = data[0];
    const rows = data.slice(1);
    const idx = (name) => headers.indexOf(name);

    const filterEvent = req.query.evento;
    const filterCampaign = req.query.utm_campaign;
    const filterSource = req.query.utm_source;
    const filterMedium = req.query.utm_medium;

    const summary = {};
    const events = [];

    rows.forEach((row) => {
      const item = {
        hora: row[idx("hora")] || "",
        data: row[idx("data")] || "",
        email: row[idx("email")] || "",
        phone: row[idx("phone")] || "",
        evento: row[idx("evento")] || "",
        valor: Number(row[idx("valor")] || 0),
        utm_campaign: row[idx("utm_campaign")] || "",
        utm_medium: row[idx("utm_medium")] || "",
        utm_source: row[idx("utm_source")] || "",
        referral_code: row[idx("referral_code")] || "",
        utm_campaign_atual: row[idx("utm_campaign_atual")] || "",
        utm_medium_atual: row[idx("utm_medium_atual")] || "",
        utm_source_atual: row[idx("utm_source_atual")] || "",
      };

      if (filterEvent && item.evento !== filterEvent) return;
      if (filterCampaign && item.utm_campaign !== filterCampaign) return;
      if (filterSource && item.utm_source !== filterSource) return;
      if (filterMedium && item.utm_medium !== filterMedium) return;

      events.push(item);

      if (!summary[item.evento]) summary[item.evento] = { total: 0, valor: 0 };
      summary[item.evento].total += 1;
      summary[item.evento].valor += item.valor;
    });

    res.json({ ok: true, totalRows: events.length, summary, events: events.slice(-100) });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/sheets/dashboard", async (req, res) => {
  try {
    const data = await getSheetData();
    const headers = data[0];
    const rows = data.slice(1);
    const idx = (name) => headers.indexOf(name);

    let receita = 0;
    let leads = 0;
    let pixGerado = 0;
    let depositos = 0;
    let ftd = 0;

    const leadsUnicos = new Set();
    const depositantesUnicos = new Set();
    const ftdUnicos = new Set();

    rows.forEach((row) => {
      const evento = row[idx("evento")];
      const valor = parseFloat(row[idx("valor")]) || 0;
      const email = row[idx("email")] || "";
      const phone = row[idx("phone")] || "";
      const userKey = email || phone;

      if (evento === "lead") {
        leads++;
        if (userKey) leadsUnicos.add(userKey);
      }

      if (evento === "pix_gerado") pixGerado++;

      if (evento === "DEPOSITO_WH") {
        depositos++;
        receita += valor;
        if (userKey) depositantesUnicos.add(userKey);
      }

      if (evento === "FTD_WH") {
        ftd++;
        if (userKey) ftdUnicos.add(userKey);
      }
    });

    res.json({
      ok: true,
      receita,
      leads,
      leadsUnicos: leadsUnicos.size,
      pixGerado,
      depositos,
      depositantesUnicos: depositantesUnicos.size,
      ftd,
      ftdUnicos: ftdUnicos.size,
      ticketMedioDeposito: depositos ? receita / depositos : 0,
      depositoPorLead: leads ? depositos / leads : 0,
      depositoPorLeadUnico: leadsUnicos.size ? depositos / leadsUnicos.size : 0,
      conversaoLeadFTD: leads ? ftd / leads : 0,
      conversaoLeadUnicoFTD: leadsUnicos.size ? ftdUnicos.size / leadsUnicos.size : 0,
      conversaoLeadDepositanteUnico: leadsUnicos.size ? depositantesUnicos.size / leadsUnicos.size : 0,
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

function buildCampaignsFromRows(headers, rows) {
  const idx = (name) => headers.indexOf(name);
  const campaigns = {};

  rows.forEach((row) => {
    const campaign = row[idx("utm_campaign")] || "sem_campanha";
    const email = row[idx("email")] || "";
    const phone = row[idx("phone")] || "";
    const userKey = email || phone;
    const evento = row[idx("evento")];
    const valor = parseFloat(row[idx("valor")]) || 0;

    if (!campaigns[campaign]) {
       campaigns[campaign] = {
       campaign,
       leads: 0,
       leadsUnicos: new Set(),
       pixGerado: 0,
       depositos: 0,
       depositantesUnicos: new Set(),
       receita: 0,
       custo: 0,
       ftd: 0,
    };
  }

    if (evento === "lead") {
      campaigns[campaign].leads++;

    if (userKey) {
      campaigns[campaign].leadsUnicos.add(userKey);
    }
  }
    if (evento === "pix_gerado") campaigns[campaign].pixGerado++;

    if (evento === "DEPOSITO_WH") {
      campaigns[campaign].depositos++;
      campaigns[campaign].receita += valor;
    if (userKey) campaigns[campaign].depositantesUnicos.add(userKey);
  }

    if (evento === "FTD_WH") campaigns[campaign].ftd++;
  });

  return campaigns;
}

function enrichCampaign(item) {
  const ticketMedioDeposito = item.depositos ? item.receita / item.depositos : 0;
  const leadsUnicos = item.leadsUnicos instanceof Set ? item.leadsUnicos.size : 0;
  const depositantesUnicos = item.depositantesUnicos instanceof Set ? item.depositantesUnicos.size : 0;
  const frequenciaDeposito = depositantesUnicos ? item.depositos / depositantesUnicos : 0;
  const qualidade = calcularQualidadeCampanha(ticketMedioDeposito, frequenciaDeposito, item.ftd);

  return {
    ...item,
    depositantesUnicos,
    leadsUnicos,
    epl: item.leads ? item.receita / item.leads : 0,
    valorPorFTD: item.ftd ? item.receita / item.ftd : 0,
    taxaFTD: item.leads ? item.ftd / item.leads : 0,
    eplUnico: leadsUnicos ? item.receita / leadsUnicos : 0,
    taxaFTDUnico: leadsUnicos ? item.ftd / leadsUnicos : 0,
    conversaoLeadUnicoDeposito: leadsUnicos ? depositantesUnicos / leadsUnicos : 0,
    ticketMedio: ticketMedioDeposito,
    conversaoLeadDeposito: item.leads ? item.depositos / item.leads : 0,
    conversaoLeadFTD: item.leads ? item.ftd / item.leads : 0,
    ticketMedioDeposito,
    frequenciaDeposito,
    qualidade,
  };
}

app.get("/sheets/campaigns", async (req, res) => {
  try {
    const data = await getSheetData();
    const headers = data[0];
    const rows = data.slice(1);
    const campaigns = buildCampaignsFromRows(headers, rows);

    const result = Object.values(campaigns).map(enrichCampaign).sort((a, b) => b.receita - a.receita);

    res.json({ ok: true, totalCampaigns: result.length, campaigns: result });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/sheets/top", async (req, res) => {
  try {
    const data = await getSheetData();
    const headers = data[0];
    const rows = data.slice(1);
    const campaigns = buildCampaignsFromRows(headers, rows);

    const result = Object.values(campaigns)
      .filter((c) => c.leads >= 10)
      .map(enrichCampaign)
      .sort((a, b) => b.receita - a.receita)
      .slice(0, 10);

    res.json({ ok: true, top: result });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/sheets/daily", async (req, res) => {
  try {
    const data = await getSheetData();
    const headers = data[0];
    const rows = data.slice(1);
    const idx = (name) => headers.indexOf(name);
    const daily = {};

    rows.forEach((row) => {
      const dataEvento = row[idx("data")] || "sem_data";
      const campaign = row[idx("utm_campaign")] || "sem_campanha";
      const evento = row[idx("evento")];
      const valor = parseFloat(row[idx("valor")]) || 0;
      const email = row[idx("email")] || "";
      const phone = row[idx("phone")] || "";
      const userKey = email || phone;
      const key = `${dataEvento}__${campaign}`;

      if (!daily[key]) {
        daily[key] = {
          data: dataEvento,
          campaign,
          leads: 0,
          pixGerado: 0,
          depositos: 0,
          depositantesUnicos: new Set(),
          ftd: 0,
          receita: 0,
          custo: 0,
       };
     }

      if (evento === "lead") daily[key].leads++;
      if (evento === "pix_gerado") daily[key].pixGerado++;
      if (evento === "DEPOSITO_WH") {
        daily[key].depositos++;
        daily[key].receita += valor;
      if (userKey) daily[key].depositantesUnicos.add(userKey);
     }
      if (evento === "FTD_WH") daily[key].ftd++;
    });

    const result = Object.values(daily)
      .map((item) => enrichCampaign(item))
      .sort((a, b) => {
        const [da, ma, ya] = a.data.split("/");
        const [db, mb, yb] = b.data.split("/");
        const dateA = new Date(`${ya}-${ma}-${da}`);
        const dateB = new Date(`${yb}-${mb}-${db}`);
        if (dateB - dateA !== 0) return dateB - dateA;
        return b.receita - a.receita;
      });

    res.json({ ok: true, total: result.length, daily: result });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/sheets/audience", async (req, res) => {
  try {
    const data = await getSheetData();
    const headers = data[0];
    const rows = data.slice(1);
    const idx = (name) => headers.indexOf(name);
    const audience = {};

    rows.forEach((row, rowIndex) => {
      const email = row[idx("email")] || "";
      const phone = row[idx("phone")] || "";
      const userKey = email || phone;
      if (!userKey) return;

      const evento = row[idx("evento")];
      const valor = parseFloat(row[idx("valor")]) || 0;
      const dataEvento = row[idx("data")] || "";
      const campaign = row[idx("utm_campaign")] || "sem_campanha";
      const source = row[idx("utm_source")] || "";
      const medium = row[idx("utm_medium")] || "";
      const contentIndex = headers.indexOf("utm_content");
      const content = contentIndex >= 0 ? row[contentIndex] || "" : "";

      if (!audience[userKey]) {
        audience[userKey] = {
          userKey,
          usuario: mascararUsuario(userKey),
          email,
          phone,
          primeiraData: dataEvento,
          ultimaData: dataEvento,
          campanhaOrigem: campaign,
          sourceOrigem: source,
          mediumOrigem: medium,
          campanhas: new Set(),
          sources: new Set(),
          mediums: new Set(),
          contents: new Set(),
          leads: 0,
          pixGerado: 0,
          depositos: 0,
          ftd: 0,
          receita: 0,
          eventos: 0,
          primeiraLinha: rowIndex + 2,
        };
      }

      const user = audience[userKey];
      user.eventos++;
      if (
      dataEvento &&
   (
      !user.ultimaData ||
      new Date(dataEvento.split("/").reverse().join("-")) >
      new Date(user.ultimaData.split("/").reverse().join("-"))
   )
   ) {
      user.ultimaData = dataEvento;
     }
      user.campanhas.add(campaign);
      if (source) user.sources.add(source);
      if (medium) user.mediums.add(medium);
      if (content) user.contents.add(content);

      if (evento === "lead") user.leads++;
      if (evento === "pix_gerado") user.pixGerado++;
      if (evento === "DEPOSITO_WH") {
        user.depositos++;
        user.receita += valor;
      }
      if (evento === "FTD_WH") user.ftd++;
    });

    const result = Object.values(audience)
      .map((user) => {
        const ticketMedioDeposito = user.depositos ? user.receita / user.depositos : 0;
        const frequenciaDeposito = user.depositos;
        const diasSemAtividade = calcularDiasDesde(user.ultimaData);
        const qualidade = calcularQualidadePublico(ticketMedioDeposito, user.depositos);
        const scoreUsuario = calcularScoreUsuario({ticketMedioDeposito, frequenciaDeposito, depositos: user.depositos, receita: user.receita});
        const segmentoCRM = classificarSegmentoCRM(user, diasSemAtividade);
        const ofertaCRM = definirOfertaCRM({
           ...user,
           score: scoreUsuario.score,
           nivelScore: scoreUsuario.nivel,
           diasSemAtividade,
           segmentoCRM,
           ticketMedioDeposito,
           frequenciaDeposito
     });
        const copyCRM = gerarCopyCRM({
           ...user,
           score: scoreUsuario.score,
           nivelScore: scoreUsuario.nivel,
           diasSemAtividade,
           segmentoCRM,
           ticketMedioDeposito,
           frequenciaDeposito
     });
        const enviarPixelValioso = qualidade === "ouro" || qualidade === "diamante";

        return {
          ...user,
          campanhas: Array.from(user.campanhas),
          sources: Array.from(user.sources),
          mediums: Array.from(user.mediums),
          contents: Array.from(user.contents),
          ticketMedioDeposito,
          frequenciaDeposito,
          qualidade,
          score: scoreUsuario.score,
          nivelScore: scoreUsuario.nivel,
          diasSemAtividade,
          segmentoCRM,
          ofertaCRM,
          copySMS: copyCRM.sms,
          copyImagem: copyCRM.imagem,
          enviarPixelValioso,
        }
      })
      .sort((a, b) => {
        if (b.receita !== a.receita) return b.receita - a.receita;
        return b.depositos - a.depositos;
      });

    const resumo = result.reduce(
  (acc, user) => {
    acc.totalUsuarios++;
    acc.receita += user.receita;
    acc.depositos += user.depositos;
    acc.ftd += user.ftd;

    acc[user.qualidade] = (acc[user.qualidade] || 0) + 1;
    acc[user.segmentoCRM] = (acc[user.segmentoCRM] || 0) + 1;

    if (user.enviarPixelValioso) acc.publicosValiosos++;

    return acc;
  },
  {
    totalUsuarios: 0,
    publicosValiosos: 0,
    receita: 0,
    depositos: 0,
    ftd: 0,
    diamante: 0,
    ouro: 0,
    muito_bom: 0,
    bom: 0,
    ruim: 0,
    sem_deposito: 0,
    lead_sem_deposito: 0,
    d0: 0,
    d3: 0,
    d7: 0,
    d15: 0,
    d30_plus: 0,
    ativo: 0
  }
);

return res.json({
  ok: true,
  total: result.length,
  resumo,
  audience: result
});

} catch (error) {
  return res.status(500).json({
    ok: false,
    error: error.message
  });
}

});

app.get("/login", (req, res) => {
  res.send(`
<html>
<head>
  <title>Login</title>
  <style>
    body { font-family: Arial; background:#0f172a; color:white; padding:40px; }
    .box { max-width:400px; margin:80px auto; background:#111827; padding:30px; border-radius:16px; }
    input { width:100%; padding:12px; margin-bottom:12px; border-radius:8px; border:none; }
    button { width:100%; padding:12px; background:#2563eb; color:white; border:none; border-radius:8px; font-weight:bold; cursor:pointer; }
    .erro { color:#f87171; margin-top:12px; }
  </style> 
</head>
<body>
  <div class="box">
    <h1>Login</h1>
    <input id="email" placeholder="Email" />
    <input id="senha" type="password" placeholder="Senha" />
    <button onclick="login()">Entrar</button>
    <div id="msg" class="erro"></div>
  </div>

  <script>
    async function login() {
      const email = document.getElementById("email").value;
      const senha = document.getElementById("senha").value;

      const response = await fetch("/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, senha })
      });

      const json = await response.json();

      if (!json.ok) {
        document.getElementById("msg").innerText = json.error;
        return;
      }

      localStorage.setItem("token", json.token);
      window.location.href = "/painel-auth";
    }
  </script>
</body>
</html>
  `);
});

app.get("/painel", authMiddleware, (req, res) => {
  res.send(`
<html>
<script 
  src="https://cdn.jsdelivr.net/npm/chart.js">
</script>     
<head>
<title>RetentionOS</title>

<style>
:root{
  --bg:#081225;
  --bg2:#0f172a;
  --card:#111827;
  --card2:#1e293b;
  --border:#243041;
  --text:#f8fafc;
  --muted:#94a3b8;
  --primary:#3b82f6;
}

*{
  margin:0;
  padding:0;
  box-sizing:border-box;
}

body{
  background:var(--bg);
  color:var(--text);
  font-family:Inter,sans-serif;
}

.container{
  display:flex;
  min-height:100vh;
}

.sidebar{
  width:260px;
  background:var(--bg2);
  border-right:1px solid var(--border);
  padding:30px 20px;
}

.logo{
  font-size:30px;
  font-weight:800;
  margin-bottom:40px;
}

.menu{
  display:flex;
  flex-direction:column;
  gap:10px;
}

.menu a{
  padding:14px 18px;
  border-radius:14px;
  color:var(--muted);
  text-decoration:none;
  font-weight:600;
}

.menu a:hover{
  background:var(--card2);
  color:white;
}

.main{
  flex:1;
  padding:32px;
}

.topbar{
  display:flex;
  justify-content:space-between;
  align-items:center;
  margin-bottom:30px;
}

.page-title{
  font-size:34px;
  font-weight:800;
}

.cards{
  display:grid;
  grid-template-columns:repeat(auto-fit,minmax(220px,1fr));
  gap:20px;
  margin-bottom:30px;
}

.card{
  background:var(--card);
  border:1px solid var(--border);
  border-radius:24px;
  padding:24px;
}

.card-title{
  color:var(--muted);
  margin-bottom:12px;
}

.card-value{
  font-size:38px;
  font-weight:800;
}

.big-card{
  background:var(--card);
  border:1px solid var(--border);
  border-radius:24px;
  padding:30px;
  margin-top:20px;
}

.big-title{
  font-size:24px;
  font-weight:700;
  margin-bottom:20px;
}

.btn{
  background:var(--primary);
  border:none;
  color:white;
  padding:14px 20px;
  border-radius:14px;
  font-weight:700;
  cursor:pointer;
}
</style>
</head>

<body>

<div class="container">

<div class="sidebar">

<div class="logo">
RetentionOS
</div>

<div class="menu">
<a href="/dashboard-campaigns">📊 Campanhas</a>
<a href="/dashboard-daily">📅 Por Data</a>
<a href="/dashboard-audience">🧠 Público</a>
<a href="/dashboard-crm">📬 CRM</a>
<a href="/dashboard-performance">📈 Performance</a>
<a href="/dashboard-status">⚙️ Status</a>
</div>

</div>

<div class="main">

<div class="topbar">

<div>
<div style="color:var(--muted);margin-bottom:8px;">
RetentionOS Platform
</div>

<div class="page-title">
Painel Operacional
</div>
</div>

<div>
<button class="btn">
Sistema Online
</button>
</div>

</div>

<div class="cards">

<div class="card">
  <div class="card-title">Tracking</div>
  <div class="card-value" id="trackingStatus">Online</div>
</div>

<div class="card">
  <div class="card-title">Eventos</div>
  <div class="card-value" id="totalEventos">0</div>
</div>

<div class="card">
  <div class="card-title">Audiências</div>
  <div class="card-value" id="totalAudiencias">0</div>
</div>

<div class="card">
  <div class="card-title">Revenue</div>
  <div class="card-value" id="totalRevenue">R$ 0</div>
</div>

</div>

<div class="big-card">
  
  <div class="big-title">
    Notificações Recentes
  </div>

  <div id="liveFeed" style="
    display:flex;
    flex-direction:column;
    gap:14px;
    margin-top:24px;
  ">

  </div>

</div>

<div class="big-card">

<div class="big-title">
Central de inteligência operacional
</div>

<div style="color:var(--muted);
line-height:28px;
font-size:17px;">

Sistema centralizado de tracking, CRM, segmentação,
pixel valioso, retenção e análise avançada de audiência.

<br><br>

• Tracking avançado  
• CRM inteligente  
• Segmentação automática  
• Público valioso  
• Revenue attribution  
• Retenção operacional  

</div>

</div>

<div class="card" style="margin-top:24px;">
  <div style="
    display:flex;
    justify-content:space-between;
    align-items:center;
    margin-bottom:20px;
  ">
    
    <div>
      <div style="
        color:var(--muted);
        font-size:14px;
        margin-bottom:4px;
      ">
        Analytics
      </div>

      <div style="
        font-size:28px;
        font-weight:800;
      ">
        Eventos por dia
      </div>
    </div>

  </div>

  <canvas id="eventsChart" height="90"></canvas>
</div>

</div>

<script>

async function carregarDashboard(){
  try{
    const dashboardResponse = await fetch("/sheets/dashboard");
    const dashboardJson = await dashboardResponse.json();

    const audienceResponse = await fetch("/sheets/audience");
    const audienceJson = await audienceResponse.json();

    const totalEventos =
      Number(dashboardJson.leads || 0) +
      Number(dashboardJson.pixGerado || 0) +
      Number(dashboardJson.depositos || 0) +
      Number(dashboardJson.ftd || 0);

    document.getElementById("totalEventos").innerText = totalEventos;

    document.getElementById("totalRevenue").innerText =
      "R$ " + Number(dashboardJson.receita || 0).toLocaleString("pt-BR");

    document.getElementById("totalAudiencias").innerText =
      Number(audienceJson.total || 0);

    document.getElementById("trackingStatus").innerText = "Online";

    console.log("dashboardJson", dashboardJson);

    const feed = document.getElementById("liveFeed");

const eventsResponse = await fetch("/sheets/events");
const eventsJson = await eventsResponse.json();

console.log(eventsJson);

const ultimoDeposito = (eventsJson.events || [])
  .filter(e => e.evento === "DEPOSITO_WH")
  .slice(-1)[0];

feed.innerHTML =
  '<div style="background:#081428;border:1px solid #1e3a5f;padding:18px;border-radius:16px;display:flex;justify-content:space-between;align-items:center;">' +
    '<div>' +
      '<div style="font-weight:700;">🔥 Novo depósito confirmado</div>' +
      '<div style="color:#94a3b8;font-size:14px;margin-top:4px;">' +
        'Usuário realizou depósito de R$ ' +
         Number(ultimoDeposito?.valor || 0).toLocaleString("pt-BR") +
          ' às ' +
         (ultimoDeposito?.hora || "--:--") +
    '</div>' +
    '</div>' +
    '<div style="background:#16a34a20;color:#4ade80;padding:8px 12px;border-radius:999px;font-size:13px;font-weight:700;">AGORA</div>' +
  '</div>';

console.log("feed renderizado");

    const ctx = document.getElementById("eventsChart");

    new Chart(ctx, {
      type: "line",
      data: {
        labels: ["Leads", "Pix Gerado", "Depósitos", "FTD"],
        datasets: [{
          label: "Eventos",
          data: [
            Number(dashboardJson.leads || 0),
            Number(dashboardJson.pixGerado || 0),
            Number(dashboardJson.depositos || 0),
            Number(dashboardJson.ftd || 0)
          ],
          borderColor: "#3b82f6",
          backgroundColor: "rgba(59,130,246,0.15)",
          tension: 0.4,
          fill: true
        }]
      },
      options: {
        plugins: {
          legend: {
            display: false
          }
        },
        scales: {
          x: {
            ticks: { color: "#94a3b8" },
            grid: { color: "#1e293b" }
          },
          y: {
            ticks: { color: "#94a3b8" },
            grid: { color: "#1e293b" }
          }
        }
      }
    });

  }catch(err){
    console.log(err);
    document.getElementById("trackingStatus").innerText = "Erro";
  }
}

carregarDashboard();
setInterval(() => {
  carregarDashboard();
}, 15000);    
</script>
</body>
</html>
`);
});

app.get("/painel-auth", (req, res) => {
  res.send(`
<html>
<head>
  <title>Entrando...</title>
</head>
<body style="
background:#0f172a;
color:white;
font-family:Arial;
display:flex;
align-items:center;
justify-content:center;
height:100vh;
">
  <div>Validando sessão...</div>

  <script>
    const token = localStorage.getItem("token");

    if (!token) {
      window.location.href = "/login";
    } else {

      fetch("/painel", {
        headers: {
          Authorization: "Bearer " + token
        }
      })
      .then(res => res.text())
      .then(html => {
        document.open();
        document.write(html);
        document.close();
      })
      .catch(() => {
        localStorage.removeItem("token");
        window.location.href = "/login";
      });

    }
  </script>
</body>
</html>
  `);
});

app.get("/dashboard-campaigns", (req, res) => {
  res.redirect("/dashboard-view");
});

app.get("/dashboard-view", async (req, res) => {
  try {
    const data = await getSheetData();
    const headers = data[0];
    const rows = data.slice(1);
    const campaigns = buildCampaignsFromRows(headers, rows);
    const dataInicio = req.query.dataInicio;
    const dataFim = req.query.dataFim;

    const metaCosts = {};

    const result = Object.values(campaigns)
      .filter((c) => c.leads >= 10)
      .map(enrichCampaign)
      .sort((a, b) => b.receita - a.receita)
      .slice(0, 100);

    const totalReceita = result.reduce((acc, c) => acc + c.receita, 0);
    const totalLeads = result.reduce((acc, c) => acc + c.leads, 0);
    const totalFtd = result.reduce((acc, c) => acc + c.ftd, 0);
    const totalDepositos = result.reduce((acc, c) => acc + c.depositos, 0);

    const rowsHtml = result.map((c) => {
      let rowClass = "";
      const custo = metaCosts[normalizeName(c.campaign)] || 0;
      const lucro = c.receita - custo;
      const roi = custo > 0 ? (lucro / custo) * 100 : 0;
      if (c.taxaFTD >= 0.5 && c.epl >= 20) rowClass = "good";
      else if (c.taxaFTD >= 0.25) rowClass = "medium";
      else rowClass = "bad";

      return `
        <tr>
          <td>${c.campaign}</td>
          <td>${c.leads}</td>
          <td>${c.leadsUnicos}</td>
          <td>${c.pixGerado}</td>
          <td>${c.depositos}</td>
          <td>${c.depositantesUnicos}</td>
          <td>${c.ftd}</td>
          <td>R$ ${c.receita.toFixed(2)}</td>
          <td class="${rowClass}-cell">R$ ${c.epl.toFixed(2)}</td>
          <td>R$ ${c.eplUnico.toFixed(2)}</td>
          <td>R$ ${c.valorPorFTD.toFixed(2)}</td>
          <td class="${rowClass}-cell">${(c.taxaFTD * 100).toFixed(2)}%</td>
          <td>${(c.taxaFTDUnico * 100).toFixed(2)}%</td>
          <td>R$ ${c.ticketMedioDeposito.toFixed(2)}</td>
          <td>${c.frequenciaDeposito.toFixed(2)}x</td>
          <td class="${c.qualidade}">${c.qualidade}</td>
        </tr>
      `;
    }).join("");

    res.send(`
<html>
<head>

<title>Dashboard Campanhas</title>

<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>

<style>

:root{
  --bg:#081225;
  --card:#081428;
  --border:#13203a;
  --text:#f8fafc;
  --muted:#94a3b8;
  --primary:#2563eb;
}

*{
  margin:0;
  padding:0;
  box-sizing:border-box;
}

body{
  background:var(--bg);
  color:var(--text);
  font-family:Inter,sans-serif;
}

.container{
  display:flex;
  min-height:100vh;
}

.sidebar{
  width:240px;
  background:#07101f;
  border-right:1px solid var(--border);
  padding:30px 22px;
}

.logo{
  font-size:36px;
  font-weight:800;
  margin-bottom:40px;
}

.nav-item{
  display:block;
  padding:14px 18px;
  border-radius:14px;
  color:#94a3b8;
  text-decoration:none;
  margin-bottom:10px;
  font-weight:700;
}

.nav-item:hover{
  background:#13203a;
  color:white;
}

.active{
  background:#2563eb;
  color:white;
}

.main{
  flex:1;
  padding:32px;
}

.topbar{
  display:flex;
  justify-content:space-between;
  align-items:center;
  margin-bottom:30px;
}

.page-title{
  font-size:42px;
  font-weight:800;
}

.badge{
  background:#2563eb;
  padding:12px 18px;
  border-radius:14px;
  font-weight:700;
}

.cards{
  display:grid;
  grid-template-columns:repeat(4,1fr);
  gap:20px;
  margin-bottom:24px;
}

.card{
  background:var(--card);
  border:1px solid var(--border);
  border-radius:22px;
  padding:24px;
}

.card-label{
  color:var(--muted);
  margin-bottom:12px;
}

.card-value{
  font-size:36px;
  font-weight:800;
}

.big-card{
  background:var(--card);
  border:1px solid var(--border);
  border-radius:24px;
  padding:24px;
  margin-top:24px;
}

.big-title{
  font-size:28px;
  font-weight:800;
  margin-bottom:24px;
}

.table-header{
  display:grid;
  grid-template-columns:2fr .7fr .7fr .7fr .7fr .9fr .9fr;
  gap:12px;
  background:#0f172a;
  border:1px solid var(--border);
  border-radius:14px;
  padding:16px;
  color:#94a3b8;
  font-size:13px;
  font-weight:800;
  margin-bottom:12px;
}

.table-row{
  display:grid;
  grid-template-columns:2fr .7fr .7fr .7fr .7fr .9fr .9fr;
  gap:12px;
  align-items:center;
  background:#081428;
  border:1px solid var(--border);
  border-radius:16px;
  padding:18px;
  margin-bottom:10px;
}

.revenue{
  background:#16a34a20;
  color:#4ade80;
  padding:8px 12px;
  border-radius:999px;
  text-align:center;
  font-weight:800;
}

.ftd{
  color:#60a5fa;
  font-weight:800;
}

</style>
</head>

<body>

<div class="container">

<div class="sidebar">

<div class="logo">
RetentionOS
</div>

<a href="/painel-auth" class="nav-item">📊 Painel</a>
<a href="/dashboard-view" class="nav-item active">🚀 Campanhas</a>
<a href="/dashboard-daily" class="nav-item">📅 Por Data</a>
<a href="/dashboard-audience" class="nav-item">🧠 Público</a>
<a href="/dashboard-crm" class="nav-item">📬 CRM</a>

</div>

<div class="main">

<div class="topbar">

<div>
<div style="color:#94a3b8;margin-bottom:6px;">
RetentionOS Platform
</div>

<div class="page-title">
Campanhas
</div>
</div>

<div class="badge">
Google Sheets Live
</div>

</div>

<div class="cards">

<div class="card">
<div class="card-label">Receita</div>
<div class="card-value">
R$ ${totalReceita.toLocaleString("pt-BR")}
</div>
</div>

<div class="card">
<div class="card-label">Leads</div>
<div class="card-value">
${totalLeads}
</div>
</div>

<div class="card">
<div class="card-label">Depósitos</div>
<div class="card-value">
${totalDepositos}
</div>
</div>

<div class="card">
<div class="card-label">FTD</div>
<div class="card-value">
${totalFtd}
</div>
</div>

</div>

<div class="big-card">

<div class="big-title">
Performance das campanhas
</div>

<div class="table-header">
<div>Campanha</div>
<div>Leads</div>
<div>Depósitos</div>
<div>FTD</div>
<div>Taxa FTD</div>
<div>Ticket</div>
<div>Receita</div>
</div>

${result.map(c => `

<div class="table-row">

<div style="font-weight:800;">
${c.campaign}
</div>

<div>
${c.leads}
</div>

<div>
${c.depositos}
</div>

<div class="ftd">
${c.ftd}
</div>

<div>
${(c.taxaFTD * 100).toFixed(1)}%
</div>

<div>
R$ ${c.ticketMedioDeposito.toFixed(2)}
</div>

<div class="revenue">
R$ ${c.receita.toLocaleString("pt-BR")}
</div>

</div>

`).join("")}

</div>

</div>

</div>

</body>
</html>
`);
  } catch (error) {
    res.status(500).send("Erro ao gerar dashboard: " + error.message);
  }
});

app.get("/dashboard-daily", async (req, res) => {
  try {
    const formatarData = (dataISO) => {
      if (!dataISO) return null;
      const [ano, mes, dia] = dataISO.split("-");
      return `${dia}/${mes}/${ano}`;
    };

    const dataInicio = formatarData(req.query.dataInicio);
    const dataFim = formatarData(req.query.dataFim);
    const response = await fetch("https://tracking-middleware.onrender.com/sheets/daily");
    const json = await response.json();
    let data = json.daily || [];

    if (dataInicio && dataFim) {
      data = data.filter((item) => {
        const [d, m, a] = item.data.split("/");
        const dataItem = new Date(`${a}-${m}-${d}`);
        const [di, mi, ai] = dataInicio.split("/");
        const inicio = new Date(`${ai}-${mi}-${di}`);
        const [df, mf, af] = dataFim.split("/");
        const fim = new Date(`${af}-${mf}-${df}`);
        return dataItem >= inicio && dataItem <= fim;
      });
    }

    const grouped = {};
    data.forEach((item) => {
      if (!grouped[item.data]) grouped[item.data] = [];
      grouped[item.data].push(item);
    });

    const metaCosts = await getMetaCosts(
    req.query.dataInicio,
    req.query.dataFim
     );

    let html = "";
    Object.keys(grouped).forEach((date) => {
      const totalDepositoDia = grouped[date].reduce((acc, c) => acc + c.receita, 0);
      const totalLeadsDia = grouped[date].reduce((acc, c) => acc + c.leads, 0);

      const totalDepositosDia = grouped[date].reduce((acc, c) => acc + c.depositos, 0);

      const totalDepositantesDia = grouped[date].reduce((acc, c) => acc + c.depositantesUnicos, 0);

      const totalFTDDia = grouped[date].reduce((acc, c) => acc + c.ftd, 0);

      const mediaTaxaFTD =
         grouped[date].reduce((acc, c) => acc + (c.taxaFTD || 0), 0) /
         grouped[date].length;

      const mediaTicket =
        grouped[date].reduce((acc, c) => acc + (c.ticketMedioDeposito || 0), 0) /
        grouped[date].length;

      const mediaFrequencia =
        grouped[date].reduce((acc, c) => acc + (c.frequenciaDeposito || 0), 0) /
        grouped[date].length;
      html += `
        <div style="margin-top:30px; display:flex; align-items:center; gap:15px;">
          <h2 style="margin:0;">📅 ${date}</h2>
          <div style="background:#0f172a; 
          border:1px solid #1f2937; 
          padding:8px 12px; 
          border-radius:8px; 
          font-size:14px; 
          color:#93c5fd;">
            💰 Total depositado: <strong style="color:#22c55e;">R$ ${totalDepositoDia.toFixed(2)}</strong>
          </div>
        </div>
        <table>
          <thead>
            <tr>
              <th>Campanha</th>
              <th>Leads <span class="info">?<span class="tooltip">Quantidade total de leads capturados pela campanha.</span></span></th>
              <th>Depósitos <span class="info">?<span class="tooltip">Quantidade total de depósitos realizados. Um usuário pode depositar mais de uma vez.</span></span></th>
              <th>Depositantes <span class="info">?<span class="tooltip">Quantidade total de pessoas que depositaram na casa.</span></span></th>
              <th>FTD <span class="info">?<span class="tooltip">First Time Deposit: quantidade de usuários que fizeram o primeiro depósito.</span></span></th>
              <th>Receita <span class="info">?<span class="tooltip">Soma total dos valores depositados pelos usuários dessa campanha.</span></span></th>
              <th>Taxa FTD <span class="info">?<span class="tooltip">Percentual de leads que viraram FTD. Fórmula: FTD / leads.</span></span></th>
              <th>Ticket Depósito <span class="info">?<span class="tooltip">Valor médio por depósito. Fórmula: receita / depósitos.</span></span></th>
              <th>Frequência <span class="info">?<span class="tooltip">Média de depósitos por depositante único. Fórmula: depósitos / depositantes.</span></span></th>
              <th>Segmentação <span class="info">?<span class="tooltip">Diamante = ticket >= 50 e frequência >= 2x; Ouro = ticket >= 50; Muito bom = ticket >= 30; Bom = ticket >= 20.</span></span></th>
            </tr>
          </thead>
          <tbody>
            ${grouped[date].map((c) => {
            const custo = metaCosts[normalizeName(c.campaign)] || 0;

            return `
              <tr>
                <td>${c.campaign}</td>
                <td>${c.leads}</td>
                <td>${c.depositos}</td>
                <td>${c.depositantesUnicos}</td>
                <td>${c.ftd}</td>
                <td>R$ ${c.receita.toFixed(2)}</td>
                <td>${(c.taxaFTD * 100).toFixed(2)}%</td>
                <td>R$ ${c.ticketMedioDeposito.toFixed(2)}</td>
                <td>${c.frequenciaDeposito.toFixed(2)}x</td>
                <td class="${c.qualidade}">${c.qualidade}</td>
              </tr>`;
                }).join("")}

             <tr style="background:#0f172a; font-weight:bold; border-top:2px solid #334155;">
               <td>Total do dia</td>
               <td>${totalLeadsDia}</td>
               <td>${totalDepositosDia}</td>
               <td>${totalDepositantesDia}</td>
               <td>${totalFTDDia}</td>
               <td>R$ ${totalDepositoDia.toFixed(2)}</td>
               <td>${(mediaTaxaFTD * 100).toFixed(2)}%</td>
               <td>R$ ${mediaTicket.toFixed(2)}</td>
               <td>${mediaFrequencia.toFixed(2)}x</td>
               <td>-</td>
               </tr>

             </tbody>
        </table>
      `;
    });

    const filtroUI = `
      <form method="GET" style="margin-bottom:20px; display:flex; gap:10px; align-items:center;">
        <input type="date" name="dataInicio" value="${dataInicio ? dataInicio.split("/").reverse().join("-") : ""}" style="padding:10px; border-radius:6px; border:none;" />
        <span style="color:#93c5fd;">até</span>
        <input type="date" name="dataFim" value="${dataFim ? dataFim.split("/").reverse().join("-") : ""}" style="padding:10px; border-radius:6px; border:none;" />
        <button style="padding:10px 15px; background:#2563eb; border:none; color:white; border-radius:6px; cursor:pointer;">Filtrar</button>
      </form>
    `;

    res.send(`
      <html>
      <head>
      <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
      <style>
        body { font-family: Arial, sans-serif; background: #0f172a; color: #e5e7eb; padding: 30px; }
          h1 { margin-bottom: 20px; }
          .cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 30px; }
          .card { background: #111827; padding: 20px; border-radius: 12px; border: 1px solid #1f2937; }
          .card span { color: #94a3b8; font-size: 14px; }
          .card strong { display: block; font-size: 26px; margin-top: 8px; }
          table { width:100%; border-collapse: collapse; background: #111827; border-radius:12px; }
          th, td { padding: 12px; border-bottom: 1px solid #1f2937; text-align: left; font-size: 14px; }
          th { background: #1e293b; color: #93c5fd; }
          tr:hover { background: #1f2937; }
          .info { position: relative; display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; margin-left: 4px; border-radius: 50%; background: #334155; color: #bfdbfe; font-size: 11px; font-weight: bold; cursor: pointer; }
          .tooltip { position: absolute; bottom: 120%; left: 50%; transform: translateX(-50%); background: #020617; color: #e5e7eb; padding: 8px 10px; border-radius: 6px; font-size: 12px; white-space: nowrap; opacity: 0; pointer-events: none; transition: 0.2s; border: 1px solid #1f2937; z-index: 10; }
          .info:hover .tooltip { opacity: 1; }
          .good-cell { color: #22c55e; font-weight: bold; }
          .medium-cell { color: #eab308; font-weight: bold; }
          .bad-cell { color: #ef4444; font-weight: bold; }
          .diamante { color: #60a5fa; font-weight: bold; }
          .ouro { color: #22c55e; font-weight: bold; }
          .muito_bom { color: #4ade80; font-weight: bold; }
          .bom { color: #eab308; font-weight: bold; }
          .ruim { color: #ef4444; font-weight: bold; }
          .sem_ftd { color: #6b7280; font-weight: bold; }
          .container{
display:flex;
min-height:100vh;
}

.sidebar{
width:240px;
background:#081225;
border-right:1px solid #13203a;
padding:32px 22px;
}

.logo{
font-size:42px;
font-weight:800;
margin-bottom:50px;
}

.nav-item{
display:block;
padding:14px 18px;
border-radius:12px;
color:#94a3b8;
text-decoration:none;
margin-bottom:10px;
font-weight:600;
transition:.2s;
}

.nav-item:hover{
background:#13203a;
color:white;
}

.active{
background:#2563eb;
color:white;
}

.main{
flex:1;
padding:34px;
}

.topbar{
display:flex;
justify-content:space-between;
align-items:center;
margin-bottom:32px;
}

.page-title{
font-size:48px;
font-weight:800;
}

.status-badge{
background:#2563eb;
padding:12px 22px;
border-radius:14px;
font-weight:700;
}

.filters-card{
background:#081428;
border:1px solid #13203a;
padding:24px;
border-radius:22px;
display:flex;
gap:20px;
align-items:end;
margin-bottom:24px;
}

.filter-group{
display:flex;
flex-direction:column;
gap:8px;
}

.filter-group label{
font-size:14px;
color:#94a3b8;
}

.filter-group input{
background:#0f172a;
border:1px solid #1e293b;
padding:14px;
border-radius:12px;
color:white;
}

.btn-primary{
background:#2563eb;
border:none;
padding:14px 24px;
border-radius:12px;
font-weight:700;
color:white;
cursor:pointer;
}

.stats-grid{
display:grid;
grid-template-columns:repeat(4,1fr);
gap:22px;
margin-bottom:24px;
}

.stat-card{
background:#081428;
border:1px solid #13203a;
padding:28px;
border-radius:22px;
}

.stat-label{
font-size:15px;
color:#94a3b8;
margin-bottom:12px;
}

.stat-value{
font-size:42px;
font-weight:800;
}

.big-card{
background:#081428;
border:1px solid #13203a;
border-radius:24px;
padding:28px;
margin-bottom:24px;
}

.big-title{
font-size:30px;
font-weight:800;
margin-bottom:24px;
}
      </style>
      </head>
      <body>

<div class="container">

  <div class="sidebar">

    <div class="logo">
      RetentionOS
    </div>

    <a href="/painel-auth" class="nav-item">📊 Painel</a>
    <a href="/dashboard-daily" class="nav-item active">📅 Por Data</a>
    <a href="/dashboard-crm" class="nav-item">🧠 CRM</a>

  </div>

  <div class="main">

    <div class="topbar">

      <div>
        <div style="
          color:var(--muted);
          font-size:14px;
          margin-bottom:6px;
        ">
          RetentionOS Platform
        </div>

        <div class="page-title">
          Dashboard por Data
        </div>
      </div>

      <div class="status-badge">
        Dados em tempo real
      </div>

    </div>

    <div class="filters-card">

      <div class="filter-group">

        <label>Data Inicial</label>

        <input type="date" id="startDate">

      </div>

      <div class="filter-group">

        <label>Data Final</label>

        <input type="date" id="endDate">

      </div>

      <button onclick="buscarDados()" class="btn-primary">
        Buscar Dados
      </button>

    </div>

    <div class="stats-grid">

      <div class="stat-card">
        <div class="stat-label">Leads</div>
        <div class="stat-value" id="totalLeads">0</div>
      </div>

      <div class="stat-card">
        <div class="stat-label">Pix Gerado</div>
        <div class="stat-value" id="totalPix">0</div>
      </div>

      <div class="stat-card">
        <div class="stat-label">Depósitos</div>
        <div class="stat-value" id="totalDepositos">0</div>
      </div>

      <div class="stat-card">
        <div class="stat-label">Revenue</div>
        <div class="stat-value" id="totalRevenue">R$ 0</div>
      </div>

    </div>

    <div class="big-card">

      <div class="big-title">
        Performance diária
      </div>

      <canvas id="dailyChart" height="90"></canvas>

    </div>

    <div class="big-card">

      <div class="big-title">
        Eventos registrados
      </div>

      <div id="eventsTable"></div>

    </div>

  </div>

      <script>
async function buscarDados(){

  const dataInicio = document.getElementById("startDate").value;
  const dataFim = document.getElementById("endDate").value;

  const response = await fetch("/sheets/daily");
  const json = await response.json();

  let dados = json.daily || [];

  if(dataInicio && dataFim){
    dados = dados.filter(item => {
      const [dia, mes, ano] = item.data.split("/");
      const dataItem = new Date(ano + "-" + mes + "-" + dia);

      const inicio = new Date(dataInicio);
      const fim = new Date(dataFim);

      return dataItem >= inicio && dataItem <= fim;
    });
  }

  const totalLeads = dados.reduce((acc, item) => acc + Number(item.leads || 0), 0);
  const totalPix = dados.reduce((acc, item) => acc + Number(item.pixGerado || 0), 0);
  const totalDepositos = dados.reduce((acc, item) => acc + Number(item.depositos || 0), 0);
  const totalRevenue = dados.reduce((acc, item) => acc + Number(item.receita || 0), 0);

  document.getElementById("totalLeads").innerText = totalLeads.toLocaleString("pt-BR");
  document.getElementById("totalPix").innerText = totalPix.toLocaleString("pt-BR");
  document.getElementById("totalDepositos").innerText = totalDepositos.toLocaleString("pt-BR");
  document.getElementById("totalRevenue").innerText = "R$ " + totalRevenue.toLocaleString("pt-BR");

  let htmlEventos = "";

htmlEventos += '<div style="display:grid;grid-template-columns:1.1fr 1.5fr .7fr .7fr .7fr .7fr .9fr;gap:12px;background:#0f172a;border:1px solid #13203a;border-radius:14px;padding:14px 18px;color:#94a3b8;font-size:13px;font-weight:800;margin-bottom:12px;">';
htmlEventos += '<div>Data</div>';
htmlEventos += '<div>Campanha</div>';
htmlEventos += '<div>Leads</div>';
htmlEventos += '<div>Pix</div>';
htmlEventos += '<div>Depósitos</div>';
htmlEventos += '<div>FTD</div>';      
htmlEventos += '<div>Receita</div>';
htmlEventos += '</div>';

dados.forEach(function(item){

  htmlEventos += '<div style="display:grid;grid-template-columns:1.1fr 1.5fr .7fr .7fr .7fr .7fr .9fr;gap:12px;align-items:center;background:#081428;border:1px solid #13203a;border-radius:16px;padding:16px 18px;margin-bottom:10px;">';
 
  htmlEventos += '<div style="font-weight:800;">' + item.data + '</div>';

  htmlEventos += '<div style="color:#e5e7eb;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + item.campaign + '</div>';

  htmlEventos += '<div style="color:#94a3b8;">' + item.leads + '</div>';

  htmlEventos += '<div style="color:#94a3b8;">' + item.pixGerado + '</div>';

  htmlEventos += '<div style="color:#94a3b8;">' + item.depositos + '</div>';

  htmlEventos += '<div style="color:#94a3b8;">' + item.ftd + '</div>';    

  htmlEventos += '<div style="background:#16a34a20;color:#4ade80;padding:8px 12px;border-radius:999px;font-weight:800;text-align:center;">R$ ' + Number(item.receita || 0).toLocaleString("pt-BR") + '</div>';

  htmlEventos += '</div>';

});

document.getElementById("eventsTable").innerHTML = htmlEventos;

  const ctx = document.getElementById("dailyChart");

  new Chart(ctx, {
    type: "line",
    data: {
      labels: dados.map(item => item.data),
      datasets: [{
        label: "Revenue",
        data: dados.map(item => Number(item.receita || 0)),
        borderColor: "#3b82f6",
        backgroundColor: "rgba(59,130,246,0.18)",
        fill: true,
        tension: 0.4
      }]
    },
    options: {
      plugins: {
        legend: { display: false }
      },
      scales: {
        x: {
          ticks: { color: "#94a3b8" },
          grid: { color: "#13203a" }
        },
        y: {
          ticks: { color: "#94a3b8" },
          grid: { color: "#13203a" }
        }
      }
    }
  });
}

buscarDados();
</script>

</div>
      </html>
    `);
  } catch (error) {
    res.status(500).send("Erro ao gerar dashboard por data: " + error.message);
  }
});

app.get("/dashboard-audience", async (req, res) => {
  try {
    const response = await fetch("https://tracking-middleware.onrender.com/sheets/audience");
    const json = await response.json();
    const audience = json.audience || [];
    const resumo = json.resumo || {};

    const rowsHtml = audience.slice(0, 200).map((u) => `
      <td>${u.usuario}</td>
<td>${u.campanhaOrigem}</td>
<td>${u.campanhas.join("<br>")}</td>
<td>${u.depositos}</td>
<td>R$ ${u.receita.toFixed(2)}</td>
<td>${u.score || 0}</td>
<td><span class="${u.nivelScore || ""}">${u.nivelScore || "-"}</span></td>
<td>${u.diasSemAtividade ?? "-"}</td>
<td class="${u.segmentoCRM || ""}">${u.segmentoCRM || "-"}</td>
<td class="good-cell">${u.ofertaCRM || "-"}</td>      
<td>R$ ${u.ticketMedioDeposito.toFixed(2)}</td>
<td>${u.frequenciaDeposito}x</td>
<td class="${u.qualidade}">${u.qualidade}</td>
<td class="${u.enviarPixelValioso ? "enviar" : "nao-enviar"}">${u.enviarPixelValioso ? "SIM" : "NÃO"}</td>
      </tr>
    `).join("");

    res.send(`
      <!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8" /><title>Dashboard Audience</title><style>
        body { font-family: Arial, sans-serif; background: #0f172a; color: #e5e7eb; padding: 30px; }
        .cards { display: grid; grid-template-columns: repeat(5, 1fr); gap: 16px; margin-bottom: 30px; }
        .card { background: #111827; padding: 20px; border-radius: 12px; border: 1px solid #1f2937; }
        .card span { color: #94a3b8; font-size: 14px; }
        .card strong { display: block; font-size: 24px; margin-top: 8px; }
        table { width:100%; border-collapse: collapse; background: #111827; border-radius:12px; }
        th, td { padding: 12px; border-bottom: 1px solid #1f2937; text-align: left; font-size: 14px; vertical-align: top; }
        th { background: #1e293b; color: #93c5fd; }
        tr:hover { background: #1f2937; }
        .info { position: relative; display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; margin-left: 4px; border-radius: 50%; background: #334155; color: #bfdbfe; font-size: 11px; font-weight: bold; cursor: pointer; }
        .tooltip { position: absolute; bottom: 120%; left: 50%; transform: translateX(-50%); background: #020617; color: #e5e7eb; padding: 8px 10px; border-radius: 6px; font-size: 12px; white-space: nowrap; opacity: 0; pointer-events: none; transition: 0.2s; border: 1px solid #1f2937; z-index: 10; }
        .info:hover .tooltip { opacity: 1; } 
        .diamante { color: #60a5fa; font-weight: bold; }
        .ouro { color: #22c55e; font-weight: bold; }
        .muito_bom { color: #4ade80; font-weight: bold; }
        .bom { color: #eab308; font-weight: bold; }
        .ruim { color: #ef4444; font-weight: bold; }
        .sem_deposito { color: #6b7280; font-weight: bold; }
        .enviar { color: #22c55e; font-weight: bold; }
        .nao-enviar { color: #94a3b8; font-weight: bold; }
        .note { color: #94a3b8; margin-bottom: 18px; }
        .whale { color: #b26bff; font-weight: bold; }
        .vip { color: #ffd700; font-weight: bold; }
        .high_value { color: #22c55e; font-weight: bold; }
        .lead_sem_ftd { color: #f97316; font-weight: bold; }
        .d0 { color: #22c55e; font-weight: bold; }
        .d3 { color: #eab308; font-weight: bold; }
        .d7 { color: #f97316; font-weight: bold; }
        .d15 { color: #ef4444; font-weight: bold; }
        .d30_plus { color: #b91c1c; font-weight: bold; }
        .ativo { color: #93c5fd; font-weight: bold; }
        .mid_value { color: #facc15; font-weight: bold; }
        .low_value { color: #ef4444; font-weight: bold; }
      </style>
       </head>
        <body>
        <h1>Dashboard de Público Valioso</h1>
        <div class="note">Esta visão classifica usuários, não campanhas. A ideia é identificar quais públicos devem ensinar o pixel futuramente.</div>
        <div class="cards">
          <div class="card"><span>Usuários identificados</span><strong>${resumo.totalUsuarios || 0}</strong></div>
          <div class="card"><span>Públicos valiosos</span><strong>${resumo.publicosValiosos || 0}</strong></div>
          <div class="card"><span>Diamante</span><strong>${resumo.diamante || 0}</strong></div>
          <div class="card"><span>Ouro</span><strong>${resumo.ouro || 0}</strong></div>
          <div class="card"><span>Receita usuários</span><strong>R$ ${Number(resumo.receita || 0).toFixed(2)}</strong></div>
        </div>
        <table>
        <thead>
        <tr>
        <tr>
  <th>Usuário</th>
  <th>Origem <span class="info">?<span class="tooltip">Origem principal identificada do usuário através dos parâmetros UTM.</span></span></th>
  <th>Campanhas tocadas <span class="info">?<span class="tooltip">Lista de campanhas que tiveram interação com este usuário.</span></span></th>
  <th>Depósitos <span class="info">?<span class="tooltip">Quantidade total de depósitos realizados.</span></span></th>
  <th>Receita <span class="info">?<span class="tooltip">Receita total gerada pelo usuário.</span></span></th>
  <th>Score <span class="info">?<span class="tooltip">Pontuação comportamental baseada em depósitos, frequência e receita.</span></span></th>
  <th>Nível <span class="info">?<span class="tooltip">Classificação avançada baseada no score final.</span></span></th>
  <th>Dias sem atividade <span class="info">?<span class="tooltip">Dias desde a última atividade registrada.</span></span></th>
  <th>Segmento CRM <span class="info">?<span class="tooltip">Segmentação automática usada para CRM e reativação.</span></span></th>
  <th>Oferta CRM <span class="info">?<span class="tooltip">Oferta automaticamente recomendada para este usuário com base em comportamento, score, frequência, ticket e tempo sem atividade.</span></span></th>   
  <th>Ticket Depósito <span class="info">?<span class="tooltip">Valor médio por depósito realizado.</span></span></th>
  <th>Frequência <span class="info">?<span class="tooltip">Quantidade média/total de depósitos do usuário.</span></span></th>
  <th>Segmentação <span class="info">?<span class="tooltip">Qualidade geral do usuário para CRM/pixel.</span></span></th>
  <th>Enviar Pixel Valioso <span class="info">?<span class="tooltip">Define se este usuário deve ensinar o pixel com evento qualificado.</span></span></th>
</tr>
        </thead>
        <tbody>
        ${rowsHtml}
     </span>
   </td>
        </tbody>
        </table>
      </body>
      </html>
    `);
  } catch (error) {
    res.status(500).send("Erro ao gerar dashboard audience: " + error.message);
  }
});

app.get("/dashboard-crm", async (req, res) => {
  try {
    const response = await fetch("https://tracking-middleware.onrender.com/sheets/audience");
    const json = await response.json();

    const audience = json.audience || [];
    const segmentos = {};

    audience.forEach((user) => {
      const segmento = user.segmentoCRM || "outros";

      if (!segmentos[segmento]) {
        segmentos[segmento] = {
          total: 0,
          receita: 0,
          depositos: 0,
          scoreMedio: 0,
          usuarios: [],
          copySMS: user.copySMS || "",
          copyImagem: user.copyImagem || ""
        };
      }

      segmentos[segmento].total++;
      segmentos[segmento].receita += Number(user.receita || 0);
      segmentos[segmento].depositos += Number(user.depositos || 0);
      segmentos[segmento].scoreMedio += Number(user.score || 0);
      segmentos[segmento].usuarios.push(user);

      if (!segmentos[segmento].copySMS && user.copySMS) {
        segmentos[segmento].copySMS = user.copySMS;
      }

      if (!segmentos[segmento].copyImagem && user.copyImagem) {
        segmentos[segmento].copyImagem = user.copyImagem;
      }
    });

    Object.keys(segmentos).forEach((key) => {
      const item = segmentos[key];
      item.scoreMedio = item.total ? item.scoreMedio / item.total : 0;
    });

    const ordem = [
      "lead_sem_deposito",
      "d0",
      "d3",
      "d7",
      "d15",
      "d30_plus",
      "ativo",
      "outros"
    ];

    const cardsHtml = ordem.map((key) => {
  const item = segmentos[key];
  if (!item) return "";

  const statusMap = {
    lead_sem_deposito: ["🔵 EM ANÁLISE", "#60a5fa"],
    d0: ["🟢 ATIVO HOJE", "#22c55e"],
    d3: ["🟡 RISCO MODERADO", "#facc15"],
    d7: ["🟠 REATIVAÇÃO", "#fb923c"],
    d15: ["🔴 CHURN AVANÇADO", "#ef4444"],
    d30_plus: ["🟣 QUASE PERDIDO", "#c084fc"],
    ativo: ["🟢 ATIVO", "#22c55e"],
    outros: ["🔵 EM ANÁLISE", "#60a5fa"]
  };

  const status = statusMap[key] || statusMap.outros;

  return `
    <div class="crm-card">

      <div class="crm-top">
        <div>
          <div class="crm-label">${key.replaceAll("_", " ").toUpperCase()}</div>
          <div class="crm-users">${item.total} usuários</div>
        </div>

        <div style="display:flex; flex-direction:column; gap:10px; align-items:flex-end;">
          <div class="crm-score">Score ${item.scoreMedio.toFixed(0)}</div>

          <div style="
            color:${status[1]};
            background:rgba(255,255,255,.05);
            border:1px solid rgba(255,255,255,.08);
            padding:8px 12px;
            border-radius:12px;
            font-size:12px;
            font-weight:800;
            white-space:nowrap;
          ">
            ${status[0]}
          </div>
        </div>
      </div>

      <div class="crm-grid">
        <div class="mini-box">
          <span>Receita</span>
          <strong>R$ ${item.receita.toLocaleString("pt-BR")}</strong>
        </div>

        <div class="mini-box">
          <span>Depósitos</span>
          <strong>${item.depositos}</strong>
        </div>

        <div class="mini-box">
          <span>Usuários</span>
          <strong>${item.total}</strong>
        </div>
      </div>

      <div class="copy-box">
        <div class="copy-title">COPY SMS</div>
        <textarea readonly>${item.copySMS || "Sem copy cadastrada."}</textarea>
      </div>

      <div class="copy-box">
        <div class="copy-title">COPY IMAGEM</div>
        <textarea readonly>${item.copyImagem || "Sem copy cadastrada."}</textarea>
      </div>

      <div class="actions">
        <a class="btn blue" href="/crm/export?segmento=${encodeURIComponent(key)}&senha=123456">Exportar CSV</a>
        <button class="btn green" onclick="copiarTexto(this.dataset.copy)" data-copy="${String(item.copySMS || "").replace(/"/g, "&quot;")}">Copiar SMS</button>
        <button class="btn purple" onclick="copiarTexto(this.dataset.copy)" data-copy="${String(item.copyImagem || "").replace(/"/g, "&quot;")}">Copiar Imagem</button>
      </div>

    </div>
  `;
}).join("");

    res.send(`
<html>
<head>
<title>CRM Visual</title>

<style>
:root{
  --bg:#081225;
  --bg2:#0f172a;
  --card:#111827;
  --card2:#1e293b;
  --border:#243041;
  --text:#f8fafc;
  --muted:#94a3b8;
  --primary:#3b82f6;
  --green:#22c55e;
  --purple:#9333ea;
}

*{
  margin:0;
  padding:0;
  box-sizing:border-box;
}

body{
  background:var(--bg);
  color:var(--text);
  font-family:Inter, Arial, sans-serif;
  padding:32px;
}

.header{
  display:flex;
  justify-content:space-between;
  align-items:center;
  margin-bottom:32px;
}

.title{
  font-size:42px;
  font-weight:800;
  margin-bottom:8px;
}

.subtitle{
  color:var(--muted);
}

.back{
  background:var(--card);
  border:1px solid var(--border);
  color:white;
  text-decoration:none;
  padding:12px 18px;
  border-radius:14px;
  font-weight:700;
}

.crm-container{
  display:grid;
  grid-template-columns:repeat(auto-fit,minmax(420px,1fr));
  gap:24px;
}

.crm-card{
  background:rgba(17,24,39,.78);
  border:1px solid rgba(255,255,255,.07);
  border-radius:24px;
  padding:24px;
  box-shadow:0 20px 60px rgba(0,0,0,.18);
}

.crm-top{
  display:flex;
  justify-content:space-between;
  align-items:center;
  margin-bottom:24px;
}

.crm-label{
  font-size:13px;
  color:var(--muted);
  margin-bottom:6px;
  letter-spacing:.06em;
}

.crm-users{
  font-size:28px;
  font-weight:800;
}

.crm-score{
  background:rgba(59,130,246,.15);
  color:#60a5fa;
  padding:10px 16px;
  border-radius:14px;
  font-weight:700;
}

.crm-grid{
  display:grid;
  grid-template-columns:repeat(3,1fr);
  gap:14px;
  margin-bottom:24px;
}

.mini-box{
  background:rgba(255,255,255,.03);
  border:1px solid rgba(255,255,255,.05);
  border-radius:16px;
  padding:16px;
}

.mini-box span{
  display:block;
  color:var(--muted);
  font-size:13px;
  margin-bottom:8px;
}

.mini-box strong{
  font-size:20px;
}

.copy-box{
  margin-top:18px;
}

.copy-title{
  font-size:13px;
  color:var(--muted);
  margin-bottom:10px;
  font-weight:700;
}

textarea{
  width:100%;
  min-height:110px;
  background:#0b1324;
  border:1px solid rgba(255,255,255,.06);
  border-radius:16px;
  padding:16px;
  color:white;
  resize:none;
  font-size:14px;
  line-height:24px;
}

.actions{
  display:flex;
  flex-wrap:wrap;
  gap:10px;
  margin-top:18px;
}

.btn{
  border:none;
  color:white;
  padding:11px 14px;
  border-radius:12px;
  font-weight:800;
  cursor:pointer;
  text-decoration:none;
  font-size:13px;
}

.blue{
  background:var(--primary);
}

.green{
  background:var(--green);
}

.purple{
  background:var(--purple);
}

.empty{
  background:var(--card);
  border:1px solid var(--border);
  border-radius:24px;
  padding:32px;
  color:var(--muted);
}
</style>
</head>

<body>

<div class="header">
  <div>
    <div class="title">CRM Inteligente</div>
    <div class="subtitle">Segmentação automática baseada em comportamento, score e retenção.</div>
  </div>

  <a class="back" href="/painel-auth">Voltar ao painel</a>
</div>

<div class="crm-container">
  ${cardsHtml || '<div class="empty">Nenhum segmento CRM encontrado ainda.</div>'}
</div>

<script>
function copiarTexto(texto) {
  navigator.clipboard.writeText(texto || "");
  alert("Texto copiado!");
}
</script>

</body>
</html>
    `);

  } catch (error) {
    res.status(500).send("Erro CRM: " + error.message);
  }
});

app.get("/crm/export", async (req, res) => {
  try {
    const senha = req.query.senha || "";
    const senhaCorreta = process.env.CRM_EXPORT_PASSWORD || "123456";

 if (senha !== senhaCorreta) {
   return res.status(401).send("Senha inválida para exportação.");
}
    const segmento = req.query.segmento || "";
    const minScore = Number(req.query.minScore || 0);

    const response = await fetch("https://tracking-middleware.onrender.com/sheets/audience");
    const json = await response.json();

    let users = json.audience || [];

    if (segmento) {
      users = users.filter((user) => user.segmentoCRM === segmento);
    }

    if (minScore > 0) {
      users = users.filter((user) => Number(user.score || 0) >= minScore);
    }

    users = users.filter((user) => user.phone);

    const header = [
      "usuario",
      "telefone",
      "segmento_crm",
      "dias_sem_atividade",
      "score",
      "nivel",
      "depositos",
      "receita",
      "campanha_origem"
    ];

    const lines = users.map((user) => [
      user.usuario || "",
      user.phone || "",
      user.segmentoCRM || "",
      user.diasSemAtividade ?? "",
      user.score || 0,
      user.nivelScore || "",
      user.depositos || 0,
      Number(user.receita || 0).toFixed(2),
      user.campanhaOrigem || ""
    ]);

    const csv = [
      header.join(";"),
      ...lines.map((line) =>
        line
          .map((value) => `"${String(value).replace(/"/g, '""')}"`)
          .join(";")
      )
    ].join("\n");

    const fileName = segmento
      ? `crm_${segmento}.csv`
      : "crm_todos.csv";

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);

    return res.send("\uFEFF" + csv);
  } catch (error) {
    res.status(500).send("Erro ao exportar CRM: " + error.message);
  }
});

app.get("/meta/sent-audience-status", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT event_name, qualidade, COUNT(*)::int AS total, COALESCE(SUM(receita), 0)::float AS receita
      FROM meta_audience_sent
      GROUP BY event_name, qualidade
      ORDER BY event_name, qualidade
    `);

    const recent = await pool.query(`
      SELECT user_label, event_name, qualidade, receita::float AS receita, depositos, meta_status, created_at
      FROM meta_audience_sent
      ORDER BY created_at DESC
      LIMIT 20
    `);

    res.json({ ok: true, summary: result.rows, recent: recent.rows });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/meta/send-valued-audience", async (req, res) => {
  try {
    const confirm = req.query.confirm === "SIM";
    const limit = Number(req.query.limit || 50);
    const eventName = req.query.eventName || "Purchase";
    const quality = req.query.quality || "ouro,diamante";
    const allowedQualities = quality.split(",").map((item) => item.trim()).filter(Boolean);

    const response = await fetch("https://tracking-middleware.onrender.com/sheets/audience");
    const json = await response.json();

    const sentRows = await pool.query("SELECT user_key_hash FROM meta_audience_sent WHERE event_name = $1", [eventName]);
    const alreadySent = new Set(sentRows.rows.map((row) => row.user_key_hash));

    const valuableUsers = (json.audience || [])
      .filter((user) => allowedQualities.includes(user.qualidade))
      .map((user) => ({ ...user, userKeyHash: sha256(user.userKey) }))
      .filter((user) => !alreadySent.has(user.userKeyHash))
      .slice(0, limit);

    if (!confirm) {
      return res.json({
        ok: true,
        mode: "preview",
        message: "Nenhum evento foi enviado. Para enviar, use ?confirm=SIM",
        regra: "Somente usuarios ainda nao enviados e com qualidade permitida entram no envio.",
        eventName,
        limit,
        allowedQualities,
        totalJaEnviadosNesseEvento: alreadySent.size,
        totalNovosValiososEncontrados: valuableUsers.length,
        preview: valuableUsers.map((user) => ({
          usuario: user.usuario,
          qualidade: user.qualidade,
          receita: user.receita,
          depositos: user.depositos,
          ticketMedioDeposito: user.ticketMedioDeposito,
          frequenciaDeposito: user.frequenciaDeposito,
          campanhaOrigem: user.campanhaOrigem,
        })),
      });
    }

    const results = [];
    for (const user of valuableUsers) {
      const result = await sendMetaConversionEvent(user, eventName);
      results.push(result);

      if (result.sent) {
        await pool.query(
          `INSERT INTO meta_audience_sent
          (user_key_hash, event_name, user_label, qualidade, receita, depositos, ticket_medio_deposito, frequencia_deposito, meta_status, meta_response)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
          ON CONFLICT (user_key_hash, event_name) DO NOTHING`,
          [user.userKeyHash, eventName, user.usuario, user.qualidade, user.receita, user.depositos, user.ticketMedioDeposito, user.frequenciaDeposito, result.status || null, result.meta || {}]
        );
      }
    }

    res.json({
      ok: true,
      mode: "sent",
      eventName,
      allowedQualities,
      requestedLimit: limit,
      totalJaEnviadosAntes: alreadySent.size,
      totalAttempted: results.length,
      sent: results.filter((item) => item.sent).length,
      failed: results.filter((item) => !item.sent).length,
      results,
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/redirect", async (req, res) => {
  try {
    const click_id = `clk_${Date.now()}_${uuidv4().slice(0, 8)}`;
    const ip_hash = hashIp(getClientIp(req));
    const user_agent = req.headers["user-agent"] || "";
    const referrer = req.headers.referer || req.headers.referrer || "";

    const data = {
      click_id,
      utm_source: req.query.utm_source || "",
      utm_medium: req.query.utm_medium || "",
      utm_campaign: req.query.utm_campaign || "",
      utm_content: req.query.utm_content || "",
      utm_term: req.query.utm_term || "",
      campaign_id: req.query.campaign_id || "",
      adset_id: req.query.adset_id || "",
      ad_id: req.query.ad_id || "",
      creative_id: req.query.creative_id || "",
      page_url: req.originalUrl,
      referrer,
      user_agent,
      ip_hash,
      raw_payload: req.query,
    };

    await pool.query(
      `INSERT INTO clicks
      (tenant_id, click_id, utm_source, utm_medium, utm_campaign, utm_content, utm_term, campaign_id, adset_id, ad_id, creative_id, page_url, referrer, user_agent, ip_hash, raw_payload)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [data.tenant_id || 1, data.click_id, data.utm_source, data.utm_medium, data.utm_campaign, data.utm_content, data.utm_term, data.campaign_id, data.adset_id, data.ad_id, data.creative_id, data.page_url, data.referrer, data.user_agent, data.ip_hash, data.raw_payload]
    );

    const destination = buildUrlWithParams(FINAL_DESTINATION_URL, {
      click_id,
      utm_source: data.utm_source,
      utm_medium: data.utm_medium,
      utm_campaign: data.utm_campaign,
      utm_content: data.utm_content,
      utm_term: data.utm_term,
      campaign_id: data.campaign_id,
      adset_id: data.adset_id,
      ad_id: data.ad_id,
      creative_id: data.creative_id,
    });

    return res.redirect(destination);
  } catch (error) {
    return res.status(500).json({ error: "Erro ao registrar clique" });
  }
});

app.post("/event", async (req, res) => {
  try {
    const body = req.body || {};
    const normalized = normalizeEvent(body);

    const tenantId = body.tenant_id || 1;

    if (!normalized) {
      return res.status(400).json({ error: "payload não reconhecido", received: body });
    }

    const { click_id, event_name, event_id, value, currency } = normalized;
    const existing = await pool.query("SELECT id FROM events WHERE event_id = $1 LIMIT 1", [event_id]);
    const is_duplicate = existing.rows.length > 0;

    if (!is_duplicate) {
      await pool.query(
        `INSERT INTO events
        (tenant_id, click_id, event_id, event_name, value, currency, page_url, referrer, user_agent, ip_hash, is_duplicate, raw_payload)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [tenantId, click_id, event_id, event_name, value, currency, body.page_url || "", body.referrer || "", req.headers["user-agent"] || "", hashIp(getClientIp(req)), false, body]
      );
    } else {
      await pool.query(
        `INSERT INTO postback_logs
        (event_id, click_id, destination, status, request_payload, response_body)
        VALUES ($1,$2,$3,$4,$5,$6)`,
        [event_id, click_id, "internal", "duplicate", body, "Evento duplicado"]
      );
    }

    return res.json({ ok: true, click_id, event_id, event_name, value, currency, is_duplicate });
  } catch (error) {
    return res.status(500).json({ error: "Erro ao registrar evento" });
  }
});

app.get("/dashboard/summary", authMiddleware, async (req, res) => {
  try {

    const tenantId = req.user.tenantId;

    const clicks = await pool.query(`
      SELECT COUNT(*)::int AS total
      FROM clicks
      WHERE tenant_id = $1
    `, [tenantId]);

    const events = await pool.query(`
     SELECT
      event_name,
      COUNT(*)::int AS total,
      COALESCE(SUM(value), 0)::float AS value
     FROM events
     WHERE is_duplicate = false
     AND tenant_id = $1
     GROUP BY event_name
     ORDER BY total DESC
  `, [tenantId]);

    const revenue = await pool.query(`
      SELECT COALESCE(SUM(value), 0)::float AS total
      FROM events
      WHERE is_duplicate = false
      AND tenant_id = $1
      AND event_name IN ('purchase', 'deposit_success')
    `, [tenantId]);

    res.json({
      tenantId,
      clicks: clicks.rows[0].total,
      revenue: revenue.rows[0].total,
      events: events.rows
    });

  } catch (error) {

    console.log(error);

    res.status(500).json({
      error: "Erro ao gerar dashboard",
      details: error.message
    });
  }
});

app.get("/dashboard/campaigns", authMiddleware, async (req, res) => {
  try {
    const tenantId = req.user.tenantId;

    const result = await pool.query(`
      SELECT COALESCE(c.utm_campaign, 'sem_campanha') AS campaign,
        COUNT(DISTINCT c.click_id)::int AS clicks,
        COUNT(e.id)::int AS events,
        COUNT(CASE WHEN e.event_name = 'purchase' THEN 1 END)::int AS purchases,
        COALESCE(SUM(CASE WHEN e.event_name = 'purchase' THEN e.value ELSE 0 END), 0)::float AS revenue
      FROM clicks c
      LEFT JOIN events e ON e.click_id = c.click_id AND e.is_duplicate = false
      WHERE c.tenant_id = $1
      GROUP BY campaign
      ORDER BY revenue DESC
     `, [tenantId]
     );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: "Erro ao listar campanhas" });
  }
});

app.get("/dashboard/creatives", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT COALESCE(c.utm_content, c.creative_id, 'sem_criativo') AS creative,
        COUNT(DISTINCT c.click_id)::int AS clicks,
        COUNT(e.id)::int AS events,
        COUNT(CASE WHEN e.event_name = 'purchase' THEN 1 END)::int AS purchases,
        COALESCE(SUM(CASE WHEN e.event_name = 'purchase' THEN e.value ELSE 0 END), 0)::float AS revenue
      FROM clicks c
      LEFT JOIN events e ON e.click_id = c.click_id AND e.is_duplicate = false
      GROUP BY creative
      ORDER BY revenue DESC
    `);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: "Erro ao listar criativos" });
  }
});

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Tracking middleware rodando na porta ${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Erro ao iniciar banco:", error);
    process.exit(1);
  });
