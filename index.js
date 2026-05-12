require("dotenv").config();

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
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

const PORT = process.env.PORT || 3000;
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
}

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

    res.json({ ok: true, totalRows: events.length, summary, events: events.slice(0, 100) });
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
          enviarPixelValioso,
        };
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
      { totalUsuarios: 0, 
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
        lead_sem_ftd: 0,
        d0: 0,
        d3: 0,
        d7: 0,
        d15: 0,
        d30_plus: 0,
        ativo: 0
      }
    );

    res.json({ ok: true, total: result.length, resumo, audience: result });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/painel", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head>
      <meta charset="UTF-8" />
      <title>Painel Operacional</title>
      <style>
        body {
          font-family: Arial, sans-serif;
          background: #0f172a;
          color: #e5e7eb;
          padding: 40px;
        }

        h1 {
          font-size: 34px;
          margin-bottom: 10px;
        }

        p {
          color: #94a3b8;
          margin-bottom: 30px;
        }

        .grid {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 20px;
        }

        .card {
          background: #111827;
          border: 1px solid #1f2937;
          border-radius: 16px;
          padding: 24px;
          text-decoration: none;
          color: #e5e7eb;
          transition: .2s;
        }

        .card:hover {
          transform: translateY(-3px);
          border-color: #2563eb;
          background: #172554;
        }

        .icon {
          font-size: 34px;
          margin-bottom: 14px;
        }

        .title {
          font-size: 20px;
          font-weight: bold;
          margin-bottom: 8px;
        }

        .desc {
          color: #94a3b8;
          font-size: 14px;
          line-height: 1.5;
        }
      </style>
    </head>

    <body>
      <h1>⚡ Painel Operacional</h1>
      <p>Central única para análise, CRM, segmentação, retenção e exportação.</p>

      <div class="grid">
        <a class="card" href="/dashboard-view">
          <div class="icon">📊</div>
          <div class="title">Campanhas</div>
          <div class="desc">Visão geral de performance por campanha.</div>
        </a>

        <a class="card" href="/dashboard-daily">
          <div class="icon">📅</div>
          <div class="title">Por Data</div>
          <div class="desc">Análise diária de leads, depósitos, FTD e receita.</div>
        </a>

        <a class="card" href="/dashboard-audience">
          <div class="icon">👥</div>
          <div class="title">Público Valioso</div>
          <div class="desc">Score, nível, segmentação e comportamento dos usuários.</div>
        </a>

        <a class="card" href="/dashboard-crm">
          <div class="icon">📲</div>
          <div class="title">CRM</div>
          <div class="desc">Listas por segmento, exportação CSV e reativação.</div>
        </a>

        <a class="card" href="/sheets/audience">
          <div class="icon">🧠</div>
          <div class="title">Audience JSON</div>
          <div class="desc">Dados brutos de audiência, score e CRM.</div>
        </a>

        <a class="card" href="/health">
          <div class="icon">⚙️</div>
          <div class="title">Status</div>
          <div class="desc">Verificação rápida do middleware/API.</div>
        </a>
      </div>
    </body>
    </html>
  `);
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
      .slice(0, 20);

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
      <!DOCTYPE html>
      <html lang="pt-BR">
      <head>
        <meta charset="UTF-8" />
        <title>Dashboard Meta Ads</title>
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
        </style>
      </head>
      <body>
        <h1>Dashboard Meta Ads</h1>
        <div class="cards">
          <div class="card"><span>Receita Top 20</span><strong>R$ ${totalReceita.toFixed(2)}</strong></div>
          <div class="card"><span>Leads</span><strong>${totalLeads}</strong></div>
          <div class="card"><span>Depósitos</span><strong>${totalDepositos}</strong></div>
          <div class="card"><span>FTDs</span><strong>${totalFtd}</strong></div>
        </div>
        <table>
          <thead>
            <tr>
              <th>Campanha</th>
              <th>Leads <span class="info">?<span class="tooltip">Quantidade total de leads capturados pela campanha.</span></span></th>
              <th>Leads Únicos <span class="info">?<span class="tooltip">Quantidade de usuários únicos que geraram lead nessa campanha.</span></span></th>
              <th>Pix <span class="info">?<span class="tooltip">Quantidade de Pix gerados pelos usuários vindos dessa campanha.</span></span></th>
              <th>Depósitos <span class="info">?<span class="tooltip">Quantidade total de depósitos realizados. Um usuário pode depositar mais de uma vez.</span></span></th>
              <th>Depositantes <span class="info">?<span class="tooltip">Quantidade total de pessoas que depositaram na casa.</span></span></th>
              <th>FTD <span class="info">?<span class="tooltip">First Time Deposit: quantidade de usuários que fizeram o primeiro depósito.</span></span></th>
              <th>Receita <span class="info">?<span class="tooltip">Soma total dos valores depositados pelos usuários dessa campanha.</span></span></th>
              <th>EPL <span class="info">?<span class="tooltip">Receita média por lead. Fórmula: receita / leads.</span></span></th>
              <th>EPL Real <span class="info">?<span class="tooltip">Receita média por lead único. Fórmula: receita / leads únicos.</span></span></th>
              <th>Valor/FTD <span class="info">?<span class="tooltip">Receita média por FTD. Fórmula: receita / FTD.</span></span></th>
              <th>Taxa FTD <span class="info">?<span class="tooltip">Percentual de leads que viraram FTD. Fórmula: FTD / leads.</span></span></th>
              <th>Taxa FTD Real <span class="info">?<span class="tooltip">Percentual de leads únicos que viraram FTD. Fórmula: FTD / leads únicos.</span></span></th>
              <th>Ticket Depósito <span class="info">?<span class="tooltip">Valor médio por depósito. Fórmula: receita / depósitos.</span></span></th>
              <th>Frequência <span class="info">?<span class="tooltip">Média de depósitos por FTD. Fórmula: depósitos / FTD.</span></span></th>
              <th>Segmentação <span class="info">?<span class="tooltip">Diamante = ticket >= 50 e frequência >= 2x; Ouro = ticket >= 50; Muito bom = ticket >= 30; Bom = ticket >= 20.</span></span></th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
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
          <div style="background:#0f172a; border:1px solid #1f2937; padding:8px 12px; border-radius:8px; font-size:14px; color:#93c5fd;">
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
      <html><head><style>
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
      </style></head><body>
        <h1>📊 Dashboard por Data</h1>
        ${filtroUI}
        ${html}
      </body></html>
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
<td>${u.ftd}</td>
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
  <th>FTD <span class="info">?<span class="tooltip">First Time Deposit do usuário.</span></span></th>
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

    const mensagensSMS = {
  lead_sem_deposito: "🎁 100% bônus liberado + sorteios de R$2.000. Ative agora.",
  d0: "🔥 Sorteio R$1.500 às 22h + bônus de 100% ativo no seu perfil.",
  d3: "👀 Seu bônus + sorteio de R$2.000 ainda estão disponíveis.",
  d7: "⚡ R$2.000 no PIX + bônus liberado hoje.",
  d15: "🚨 Reativamos seu bônus VIP hoje.",
  d30_plus: "🔥 Última chance: bônus + R$2.000 disponíveis hoje.",
  ativo: "✅ Usuário ativo recentemente."
};

const briefingImagem = {
  lead_sem_deposito:
    "Headline: 100% de bônus liberado | Oferta: Sorteios até R$2.000 + prêmios diários | CTA: Ativar bônus agora",

  d0:
    "Headline: Sorteio R$1.500 hoje às 22h | Oferta: 100% bônus ativo | CTA: Entrar agora",

  d3:
    "Headline: Sua condição especial ainda está ativa | Oferta: Sorteios + bônus de 100% | CTA: Voltar hoje",

  d7:
    "Headline: Você recebeu uma nova chance | Oferta: R$2.000 no PIX + bônus | CTA: Reativar agora",

  d15:
    "Headline: Reativação VIP liberada | Oferta: Sorteios especiais + bônus | CTA: Aproveitar hoje",

  d30_plus:
    "Headline: Última chance de reativação | Oferta: +50 mil em prêmios hoje | CTA: Voltar agora",

  ativo:
    "Headline: Usuário ativo | Oferta: Continuidade de campanhas e eventos"
};

    audience.forEach(user => {

      const segmento = user.segmentoCRM || "outros";

      if (!segmentos[segmento]) {
        segmentos[segmento] = {
          total: 0,
          receita: 0,
          usuarios: []
        };
      }

      segmentos[segmento].total++;
      segmentos[segmento].receita += Number(user.receita || 0);

      segmentos[segmento].usuarios.push(user);

    });

    const rows = Object.entries(segmentos)
      .sort((a, b) => b[1].receita - a[1].receita)
      .map(([segmento, dados]) => `
        <tr>
          <td>${segmento}</td>
          <td>${dados.total}</td>
          <td>R$ ${dados.receita.toFixed(2)}</td>
          <td>
            <button
            onclick="exportarCRM('${segmento}')"
             style="
              background:#2563eb;
              color:white;
              padding:8px 14px;
              border-radius:8px;
              border:none;
              cursor:pointer;
              font-weight:bold;
           ">
          Exportar CSV
       </button>
        <button
  <button
  onclick="copiarSMS('${segmento}')"
  style="
    background:#16a34a;
    color:white;
    padding:8px 14px;
    border-radius:8px;
    border:none;
    cursor:pointer;
    font-weight:bold;
    margin-left:8px;
  ">
  Copiar SMS
</button>

<button
  onclick="copiarImagem('${segmento}')"
  style="
    background:#9333ea;
    color:white;
    padding:8px 14px;
    border-radius:8px;
    border:none;
    cursor:pointer;
    font-weight:bold;
    margin-left:8px;
  ">
  Copiar Imagem
</button>
          </td>
        </tr>
      `).join("");

    res.send(`
      <html>
      <head>
        <title>Dashboard CRM</title>

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
            padding:16px;
            border-bottom:1px solid #1f2937;
            text-align:left;
          }

          th {
            background:#1e293b;
            color:#93c5fd;
          }

          tr:hover {
            background:#172554;
          }

        </style>

      </head>

      <body>

        <h1>📲 Dashboard CRM</h1>

        <table>

          <thead>
            <tr>
              <th>Segmento</th>
              <th>Usuários</th>
              <th>Receita</th>
              <th>Ação</th>
            </tr>
          </thead>

          <tbody>
            ${rows}
          </tbody>

        </table>
      
      <script>
        function exportarCRM(segmento) {
        const senha = prompt("Digite a senha para exportar:");
  
    if (!senha) return;

    window.location.href =
      "/crm/export?segmento=" +
      encodeURIComponent(segmento) +
      "&senha=" +
      encodeURIComponent(senha);
     }
      const mensagensSMS = {
  lead_sem_deposito: "🎁 100% bônus liberado + sorteios de R$2.000. Ative agora.",
  d0: "🔥 Sorteio R$1.500 às 22h + bônus de 100% ativo no seu perfil.",
  d3: "👀 Seu bônus + sorteio de R$2.000 ainda estão disponíveis.",
  d7: "⚡ R$2.000 no PIX + bônus liberado hoje.",
  d15: "🚨 Reativamos seu bônus VIP hoje.",
  d30_plus: "🔥 Última chance: bônus + R$2.000 disponíveis hoje.",
  ativo: "✅ Usuário ativo recentemente."
};

const briefingImagem = {
  lead_sem_deposito: "Headline: 100% de bônus liberado | Oferta: Sorteios até R$2.000 + prêmios diários | CTA: Ativar bônus agora",
  d0: "Headline: Sorteio R$1.500 hoje às 22h | Oferta: 100% bônus ativo | CTA: Entrar agora",
  d3: "Headline: Sua condição especial ainda está ativa | Oferta: Sorteios + bônus de 100% | CTA: Voltar hoje",
  d7: "Headline: Você recebeu uma nova chance | Oferta: R$2.000 no PIX + bônus | CTA: Reativar agora",
  d15: "Headline: Reativação VIP liberada | Oferta: Sorteios especiais + bônus | CTA: Aproveitar hoje",
  d30_plus: "Headline: Última chance de reativação | Oferta: +50 mil em prêmios hoje | CTA: Voltar agora",
  ativo: "Headline: Usuário ativo | Oferta: Continuidade de campanhas e eventos"
};

function copiarTexto(texto) {
  navigator.clipboard.writeText(texto);
  alert("Texto copiado!");
}

function copiarSMS(segmento) {
  copiarTexto(mensagensSMS[segmento] || "");
}

function copiarImagem(segmento) {
  copiarTexto(briefingImagem[segmento] || "");
}
     </script>

      </body>
      </html>
    `);

  } catch (error) {

    res.status(500).send(error.message);

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
      (click_id, utm_source, utm_medium, utm_campaign, utm_content, utm_term, campaign_id, adset_id, ad_id, creative_id, page_url, referrer, user_agent, ip_hash, raw_payload)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [data.click_id, data.utm_source, data.utm_medium, data.utm_campaign, data.utm_content, data.utm_term, data.campaign_id, data.adset_id, data.ad_id, data.creative_id, data.page_url, data.referrer, data.user_agent, data.ip_hash, data.raw_payload]
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

    if (!normalized) {
      return res.status(400).json({ error: "payload não reconhecido", received: body });
    }

    const { click_id, event_name, event_id, value, currency } = normalized;
    const existing = await pool.query("SELECT id FROM events WHERE event_id = $1 LIMIT 1", [event_id]);
    const is_duplicate = existing.rows.length > 0;

    if (!is_duplicate) {
      await pool.query(
        `INSERT INTO events
        (click_id, event_id, event_name, value, currency, page_url, referrer, user_agent, ip_hash, is_duplicate, raw_payload)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [click_id, event_id, event_name, value, currency, body.page_url || "", body.referrer || "", req.headers["user-agent"] || "", hashIp(getClientIp(req)), false, body]
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

app.get("/dashboard/summary", async (req, res) => {
  try {
    const clicks = await pool.query("SELECT COUNT(*)::int AS total FROM clicks");
    const events = await pool.query(`
      SELECT event_name, COUNT(*)::int AS total, COALESCE(SUM(value), 0)::float AS value
      FROM events
      WHERE is_duplicate = false
      GROUP BY event_name
      ORDER BY total DESC
    `);

    const revenue = await pool.query(`
      SELECT COALESCE(SUM(value), 0)::float AS total
      FROM events
      WHERE is_duplicate = false
      AND event_name IN ('purchase', 'deposit_success')
    `);

    res.json({ clicks: clicks.rows[0].total, revenue: revenue.rows[0].total, events: events.rows });
  } catch (error) {
    res.status(500).json({ error: "Erro ao gerar dashboard" });
  }
});

app.get("/dashboard/campaigns", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT COALESCE(c.utm_campaign, 'sem_campanha') AS campaign,
        COUNT(DISTINCT c.click_id)::int AS clicks,
        COUNT(e.id)::int AS events,
        COUNT(CASE WHEN e.event_name = 'purchase' THEN 1 END)::int AS purchases,
        COALESCE(SUM(CASE WHEN e.event_name = 'purchase' THEN e.value ELSE 0 END), 0)::float AS revenue
      FROM clicks c
      LEFT JOIN events e ON e.click_id = c.click_id AND e.is_duplicate = false
      GROUP BY campaign
      ORDER BY revenue DESC
    `);
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
