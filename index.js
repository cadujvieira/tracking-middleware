require("dotenv").config();

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { Pool } = require("pg");
const { v4: uuidv4 } = require("uuid");
const { google } = require("googleapis");

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

function getCell(headers, row, possibleNames) {
  for (const name of possibleNames) {
    const index = headers.indexOf(name);
    if (index >= 0 && row[index] !== undefined && row[index] !== null && row[index] !== "") {
      return row[index];
    }
  }
  return "";
}

function parseMetaDateToSheetDate(dateISO) {
  if (!dateISO) return "";
  const [ano, mes, dia] = dateISO.split("-");
  return `${dia}/${mes}/${ano}`;
}

function formatSheetDateToISO(dateBR) {
  if (!dateBR || !dateBR.includes("/")) return "";
  const [dia, mes, ano] = dateBR.split("/");
  return `${ano}-${mes}-${dia}`;
}

function normalizeCampaignName(name) {
  return String(name || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\[\]\(\){}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function calcularMetricasFinanceiras(receita, custo) {
  const receitaNum = Number(receita || 0);
  const custoNum = Number(custo || 0);
  const lucro = receitaNum - custoNum;
  const roi = custoNum > 0 ? lucro / custoNum : 0;
  const roas = custoNum > 0 ? receitaNum / custoNum : 0;

  return {
    custo: custoNum,
    lucro,
    roi,
    roas,
  };
}

async function buildMetaSpendMaps({ since, until } = {}) {
  const spendRows = await fetchMetaAdSpend({ since, until });
  const byCampaignName = {};
  const byDateCampaignName = {};

  spendRows.forEach((row) => {
    const campaignNameKey = normalizeCampaignName(row.campaign_name);
    const dateKey = row.data || "sem_data";
    const dateCampaignKey = `${dateKey}__${campaignNameKey}`;

    if (!byCampaignName[campaignNameKey]) {
      byCampaignName[campaignNameKey] = {
        campaign_name: row.campaign_name,
        campaign_id: row.campaign_id,
        spend: 0,
      };
    }

    byCampaignName[campaignNameKey].spend += Number(row.spend || 0);

    if (!byDateCampaignName[dateCampaignKey]) {
      byDateCampaignName[dateCampaignKey] = {
        data: dateKey,
        campaign_name: row.campaign_name,
        campaign_id: row.campaign_id,
        spend: 0,
      };
    }

    byDateCampaignName[dateCampaignKey].spend += Number(row.spend || 0);
  });

  return {
    rows: spendRows,
    byCampaignName,
    byDateCampaignName,
  };
}

async function fetchMetaAdSpend({ since, until } = {}) {
  const accessToken = process.env.META_ACCESS_TOKEN;
  const accountIdsRaw = process.env.META_AD_ACCOUNT_IDS || "";

  if (!accessToken) {
    throw new Error("META_ACCESS_TOKEN nao configurado no Render.");
  }

  if (!accountIdsRaw) {
    throw new Error("META_AD_ACCOUNT_IDS nao configurado no Render.");
  }

  const accountIds = accountIdsRaw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((id) => (id.startsWith("act_") ? id : `act_${id}`));

  const allRows = [];

  for (const accountId of accountIds) {
    const params = new URLSearchParams({
      fields: "account_id,account_name,campaign_id,campaign_name,spend,date_start,date_stop",
      level: "campaign",
      time_increment: "1",
      access_token: accessToken,
      limit: "500",
    });

    if (since && until) {
      params.set("time_range", JSON.stringify({ since, until }));
    } else {
      params.set("date_preset", "last_30d");
    }

    let url = `https://graph.facebook.com/v20.0/${accountId}/insights?${params.toString()}`;

    while (url) {
      const response = await fetch(url);
      const json = await response.json();

      if (!response.ok) {
        throw new Error(`Erro Meta Ads ${accountId}: ${JSON.stringify(json)}`);
      }

      (json.data || []).forEach((row) => {
        allRows.push({
          account_id: row.account_id || accountId.replace("act_", ""),
          account_name: row.account_name || "",
          campaign_id: row.campaign_id || "",
          campaign_name: row.campaign_name || "",
          spend: Number(row.spend || 0),
          date_start: row.date_start || "",
          date_stop: row.date_stop || "",
          data: parseMetaDateToSheetDate(row.date_start || ""),
        });
      });

      url = json.paging?.next || null;
    }
  }

  return allRows;
}

function calcularQualidadeCampanha(ticketMedioDeposito, frequenciaDeposito, ftd) {
  if (ftd === 0) return "sem_ftd";
  if (ticketMedioDeposito >= 50 && frequenciaDeposito >= 2) return "diamante";
  if (ticketMedioDeposito >= 50) return "ouro";
  if (ticketMedioDeposito >= 30) return "muito_bom";
  if (ticketMedioDeposito >= 20) return "bom";
  return "ruim";
}

function calcularQualidadePublico(ticketMedioDeposito, depositos) {
  if (depositos === 0) return "sem_deposito";
  if (ticketMedioDeposito >= 50 && depositos >= 2) return "diamante";
  if (ticketMedioDeposito >= 50) return "ouro";
  if (ticketMedioDeposito >= 30) return "muito_bom";
  if (ticketMedioDeposito >= 20) return "bom";
  return "ruim";
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
      "/sheets/events",
      "/sheets/dashboard",
      "/sheets/campaigns",
      "/sheets/top",
      "/sheets/daily",
      "/sheets/audience",
      "/meta/ad-spend",
      "/dashboard-view",
      "/dashboard-daily",
      "/dashboard-audience",
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

    res.json({
      ok: true,
      rows: data.length,
      preview: data.slice(0, 5),
    });
  } catch (error) {
    console.error("Erro no /test-sheet:", error);
    res.status(500).json({
      ok: false,
      error: error.message,
    });
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

      if (!summary[item.evento]) {
        summary[item.evento] = {
          total: 0,
          valor: 0,
        };
      }

      summary[item.evento].total += 1;
      summary[item.evento].valor += item.valor;
    });

    res.json({
      ok: true,
      totalRows: events.length,
      summary,
      events: events.slice(0, 100),
    });
  } catch (error) {
    console.error("Erro no /sheets/events:", error);
    res.status(500).json({
      ok: false,
      error: error.message,
    });
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

      if (evento === "pix_gerado") {
        pixGerado++;
      }

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
      conversaoLeadDepositanteUnico: leadsUnicos.size
        ? depositantesUnicos.size / leadsUnicos.size
        : 0,
    });
  } catch (error) {
    console.error("Erro no dashboard:", error);
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.get("/sheets/campaigns", async (req, res) => {
  try {
    const data = await getSheetData();

    const headers = data[0];
    const rows = data.slice(1);
    const idx = (name) => headers.indexOf(name);

    const campaigns = {};

    rows.forEach((row) => {
      const campaign = row[idx("utm_campaign")] || "sem_campanha";
      const campaignId = getCell(headers, row, ["campaign_id", "campaignid", "utm_campaign_id", "id_campanha", "campaign id"]);
      const campaignKey = campaignId || campaign;
      const evento = row[idx("evento")];
      const valor = parseFloat(row[idx("valor")]) || 0;

      if (!campaigns[campaignKey]) {
        campaigns[campaignKey] = {
          campaign,
          campaignId,
          campaignKey,
          leads: 0,
          pixGerado: 0,
          depositos: 0,
          ftd: 0,
          receita: 0,
        };
      }

      if (evento === "lead") campaigns[campaignKey].leads++;
      if (evento === "pix_gerado") campaigns[campaignKey].pixGerado++;

      if (evento === "DEPOSITO_WH") {
        campaigns[campaignKey].depositos++;
        campaigns[campaignKey].receita += valor;
      }

      if (evento === "FTD_WH") campaigns[campaignKey].ftd++;
    });

    const spendMaps = await buildMetaSpendMaps();

      const result = Object.values(campaigns)
        .filter(c => c.leads >= 10)
        .map(c => {
          const campaignNameKey = normalizeCampaignName(c.campaign);
          const custo = spendMaps.byCampaignName[campaignNameKey]?.spend || 0;
          const financeiro = calcularMetricasFinanceiras(c.receita, custo);

          return {
            ...c,
            epl: c.leads ? c.receita / c.leads : 0,
            valorPorFTD: c.ftd ? c.receita / c.ftd : 0,
            taxaFTD: c.leads ? c.ftd / c.leads : 0,
            ticketMedioDeposito: c.depositos ? c.receita / c.depositos : 0,
            frequenciaDeposito: c.ftd ? c.depositos / c.ftd : 0,
            qualidade: calcularQualidadeCampanha(
              c.depositos ? c.receita / c.depositos : 0,
              c.ftd ? c.depositos / c.ftd : 0
            ),
            custo: financeiro.custo,
            lucro: financeiro.lucro,
            roi: financeiro.roi,
            roas: financeiro.roas,
          };
        })
        .sort((a, b) => b.receita - a.receita)
        .slice(0, 20);

    const totalReceita = result.reduce((acc, c) => acc + c.receita, 0);
    const totalCusto = result.reduce((acc, c) => acc + (c.custo || 0), 0);
    const totalLucro = totalReceita - totalCusto;
    const totalRoi = totalCusto > 0 ? totalLucro / totalCusto : 0;
    const totalRoas = totalCusto > 0 ? totalReceita / totalCusto : 0;
    const totalLeads = result.reduce((acc, c) => acc + c.leads, 0);
    const totalFtd = result.reduce((acc, c) => acc + c.ftd, 0);
    const totalDepositos = result.reduce((acc, c) => acc + c.depositos, 0);

    const rowsHtml = result
      .map((c) => {
        let rowClass = "";

        if (c.taxaFTD >= 0.5 && c.epl >= 20) {
          rowClass = "good";
        } else if (c.taxaFTD >= 0.25) {
          rowClass = "medium";
        } else {
          rowClass = "bad";
        }

        const lucroClass = (c.lucro || 0) >= 0 ? "good-cell" : "bad-cell";
        const roiClass = (c.roi || 0) >= 0 ? "good-cell" : "bad-cell";

        return `
          <tr>
            <td>${c.campaign}</td>
            <td>${c.leads}</td>
            <td>${c.pixGerado}</td>
            <td>${c.depositos}</td>
            <td>${c.ftd}</td>
            <td>R$ ${c.receita.toFixed(2)}</td>
            <td>R$ ${(c.custo || 0).toFixed(2)}</td>
            <td class="${lucroClass}">R$ ${(c.lucro || 0).toFixed(2)}</td>
            <td class="${roiClass}">${((c.roi || 0) * 100).toFixed(2)}%</td>
            <td>${(c.roas || 0).toFixed(2)}x</td>
            <td class="${rowClass}-cell">R$ ${c.epl.toFixed(2)}</td>
            <td>R$ ${c.valorPorFTD.toFixed(2)}</td>
            <td class="${rowClass}-cell">${(c.taxaFTD * 100).toFixed(2)}%</td>
            <td>R$ ${c.ticketMedioDeposito.toFixed(2)}</td>
            <td>${c.frequenciaDeposito.toFixed(2)}x</td>
            <td class="${c.qualidade}">${c.qualidade}</td>
          </tr>
        `;
      })
      .join("");

    res.send(`
      <!DOCTYPE html>
      <html lang="pt-BR">
      <head>
        <meta charset="UTF-8" />
        <title>Dashboard Meta Ads</title>
        <style>
          body {
            font-family: Arial, sans-serif;
            background: #0f172a;
            color: #e5e7eb;
            padding: 30px;
          }
          h1 {
            margin-bottom: 20px;
          }
          .info {
            position: relative;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 16px;
            height: 16px;
            margin-left: 4px;
            border-radius: 50%;
            background: #334155;
            color: #bfdbfe;
            font-size: 11px;
            font-weight: bold;
            cursor: pointer;
          }
          .tooltip {
            position: absolute;
            bottom: 120%;
            left: 50%;
            transform: translateX(-50%);
            background: #020617;
            color: #e5e7eb;
            padding: 8px 10px;
            border-radius: 6px;
            font-size: 12px;
            white-space: nowrap;
            opacity: 0;
            pointer-events: none;
            transition: 0.2s;
            border: 1px solid #1f2937;
            z-index: 10;
          }
          .info:hover .tooltip {
            opacity: 1;
          }
          .cards {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 16px;
            margin-bottom: 30px;
          }
          .card {
            background: #111827;
            padding: 20px;
            border-radius: 12px;
            border: 1px solid #1f2937;
          }
          .card span {
            color: #94a3b8;
            font-size: 14px;
          }
          .card strong {
            display: block;
            font-size: 26px;
            margin-top: 8px;
          }
          table {
            width: 100%;
            border-collapse: collapse;
            background: #111827;
            border-radius: 12px;
            overflow: hidden;
          }
          th, td {
            padding: 12px;
            border-bottom: 1px solid #1f2937;
            text-align: left;
            font-size: 14px;
          }
          th {
            background: #1e293b;
            color: #93c5fd;
          }
          tr:hover {
            background: #1f2937;
          }
          .good-cell {
            color: #22c55e;
            font-weight: bold;
          }
          .medium-cell {
            color: #eab308;
            font-weight: bold;
          }
          .bad-cell {
            color: #ef4444;
            font-weight: bold;
          }
          .diamante {
            color: #60a5fa;
            font-weight: bold;
          }
          .ouro {
            color: #22c55e;
            font-weight: bold;
          }
          .muito_bom {
            color: #4ade80;
            font-weight: bold;
          }
          .bom {
            color: #eab308;
            font-weight: bold;
          }
          .ruim {
            color: #ef4444;
            font-weight: bold;
          }
          .sem_ftd {
            color: #6b7280;
            font-weight: bold;
          }
        </style>
      </head>
      <body>
        <h1>Dashboard Meta Ads</h1>

        <div class="cards">
          <div class="card"><span>Receita Top 20</span><strong>R$ ${totalReceita.toFixed(2)}</strong></div>
          <div class="card"><span>Custo Meta</span><strong>R$ ${totalCusto.toFixed(2)}</strong></div>
          <div class="card"><span>Lucro</span><strong>R$ ${totalLucro.toFixed(2)}</strong></div>
          <div class="card"><span>ROI</span><strong>${(totalRoi * 100).toFixed(2)}%</strong></div>
          <div class="card"><span>ROAS</span><strong>${totalRoas.toFixed(2)}x</strong></div>
          <div class="card"><span>Leads</span><strong>${totalLeads}</strong></div>
          <div class="card"><span>Depósitos</span><strong>${totalDepositos}</strong></div>
          <div class="card"><span>FTDs</span><strong>${totalFtd}</strong></div>
        </div>

        <table>
          <thead>
            <tr>
              <th>Campanha</th>
              <th>Leads <span class="info">?<span class="tooltip">Quantidade total de leads capturados pela campanha.</span></span></th>
              <th>Pix <span class="info">?<span class="tooltip">Quantidade de Pix gerados pelos usuários vindos dessa campanha.</span></span></th>
              <th>Depósitos <span class="info">?<span class="tooltip">Quantidade total de depósitos realizados. Um usuário pode depositar mais de uma vez.</span></span></th>
              <th>FTD <span class="info">?<span class="tooltip">First Time Deposit: quantidade de usuários que fizeram o primeiro depósito.</span></span></th>
              <th>Receita <span class="info">?<span class="tooltip">Soma total dos valores depositados pelos usuários dessa campanha.</span></span></th>
              <th>Custo <span class="info">?<span class="tooltip">Gasto da campanha puxado automaticamente da Meta Ads API.</span></span></th>
              <th>Lucro <span class="info">?<span class="tooltip">Receita menos custo. Fórmula: receita - custo.</span></span></th>
              <th>ROI <span class="info">?<span class="tooltip">Retorno sobre investimento. Fórmula: lucro / custo.</span></span></th>
              <th>ROAS <span class="info">?<span class="tooltip">Retorno sobre gasto em mídia. Fórmula: receita / custo.</span></span></th>
              <th>EPL <span class="info">?<span class="tooltip">Earnings Per Lead: receita média por lead. Fórmula: receita / leads.</span></span></th>
              <th>Valor/FTD <span class="info">?<span class="tooltip">Receita média por FTD. Fórmula: receita / FTD.</span></span></th>
              <th>Taxa FTD <span class="info">?<span class="tooltip">Percentual de leads que viraram FTD. Fórmula: FTD / leads.</span></span></th>
              <th>Ticket Depósito <span class="info">?<span class="tooltip">Valor médio por depósito. Fórmula: receita / depósitos.</span></span></th>
              <th>Frequência <span class="info">?<span class="tooltip">Média de depósitos por usuário FTD. Fórmula: depósitos / FTD.</span></span></th>
              <th>Segmentação <span class="info">?<span class="tooltip">Classificação: diamante = ticket >= R$50 e frequência >= 2x; ouro = ticket >= R$50; muito bom = ticket >= R$30; bom = ticket >= R$20.</span></span></th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml}
          </tbody>
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
      if (!grouped[item.data]) {
        grouped[item.data] = [];
      }
      grouped[item.data].push(item);
    });

    let html = "";

    Object.keys(grouped).forEach((date) => {
      const totalDepositoDia = grouped[date].reduce((acc, c) => acc + c.receita, 0);

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
              <th>Leads</th>
              <th>Depósitos</th>
              <th>FTD</th>
              <th>Receita</th>
              <th>EPL</th>
              <th>Taxa FTD</th>
              <th>Ticket Depósito <span class="info">?<span class="tooltip">Valor médio por depósito. Fórmula: receita / depósitos.</span></span></th>
              <th>Frequência <span class="info">?<span class="tooltip">Média de depósitos por usuário FTD. Fórmula: depósitos / FTD.</span></span></th>
              <th>Segmentação <span class="info">?<span class="tooltip">Classificação: diamante = ticket >= R$50 e frequência >= 2x; ouro = ticket >= R$50; muito bom = ticket >= R$30; bom = ticket >= R$20.</span></span></th>
            </tr>
          </thead>
          <tbody>
            ${grouped[date]
              .map(
                (c) => `
                  <tr>
                    <td>${c.campaign}</td>
                    <td>${c.leads}</td>
                    <td>${c.depositos}</td>
                    <td>${c.ftd}</td>
                    <td>R$ ${c.receita.toFixed(2)}</td>
                    <td>R$ ${c.epl.toFixed(2)}</td>
                    <td>${(c.taxaFTD * 100).toFixed(2)}%</td>
                    <td>R$ ${c.ticketMedioDeposito.toFixed(2)}</td>
                    <td>${c.frequenciaDeposito.toFixed(2)}x</td>
                    <td class="${c.qualidade}">${c.qualidade}</td>
                  </tr>
                `
              )
              .join("")}
          </tbody>
        </table>
      `;
    });

    const filtroUI = `
      <form method="GET" style="margin-bottom:20px; display:flex; gap:10px; align-items:center;">
        <input
          type="date"
          name="dataInicio"
          value="${dataInicio ? dataInicio.split("/").reverse().join("-") : ""}"
          style="padding:10px; border-radius:6px; border:none;"
        />
        <span style="color:#93c5fd;">até</span>
        <input
          type="date"
          name="dataFim"
          value="${dataFim ? dataFim.split("/").reverse().join("-") : ""}"
          style="padding:10px; border-radius:6px; border:none;"
        />
        <button style="padding:10px 15px; background:#2563eb; border:none; color:white; border-radius:6px; cursor:pointer;">
          Filtrar
        </button>
      </form>
    `;

    res.send(`
      <html>
      <head>
        <style>
          body {
            font-family: Arial;
            background: #0f172a;
            color: #e5e7eb;
            padding: 20px;
          }
          table {
            width: 100%;
            border-collapse: collapse;
            margin-bottom: 20px;
            background: #111827;
          }
          th, td {
            padding: 10px;
            border-bottom: 1px solid #1f2937;
            text-align: left;
          }
          th {
            background: #1e293b;
            color: #93c5fd;
          }
          .info {
            margin-left: 6px;
            cursor: pointer;
            color: #93c5fd;
            position: relative;
            font-weight: bold;
          }
          .tooltip {
            visibility: hidden;
            opacity: 0;
            position: absolute;
            background: #0f172a;
            color: #e5e7eb;
            padding: 6px 8px;
            border-radius: 6px;
            font-size: 12px;
            top: 20px;
            left: 0;
            white-space: nowrap;
            transition: 0.2s;
            z-index: 10;
          }
          .info:hover .tooltip {
            visibility: visible;
            opacity: 1;
          }
          .diamante {
            color: #60a5fa;
            font-weight: bold;
          }
          .ouro {
            color: #22c55e;
            font-weight: bold;
          }
          .muito_bom {
            color: #4ade80;
            font-weight: bold;
          }
          .bom {
            color: #eab308;
            font-weight: bold;
          }
          .ruim {
            color: #ef4444;
            font-weight: bold;
          }
          .sem_ftd {
            color: #6b7280;
            font-weight: bold;
          }
        </style>
      </head>
      <body>
        <h1>📊 Dashboard por Data</h1>
        ${filtroUI}
        ${html}
      </body>
      </html>
    `);
  } catch (err) {
    res.send(err.message);
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
      [
        data.click_id,
        data.utm_source,
        data.utm_medium,
        data.utm_campaign,
        data.utm_content,
        data.utm_term,
        data.campaign_id,
        data.adset_id,
        data.ad_id,
        data.creative_id,
        data.page_url,
        data.referrer,
        data.user_agent,
        data.ip_hash,
        data.raw_payload,
      ]
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
    console.error("Erro no /redirect:", error);
    return res.status(500).json({ error: "Erro ao registrar clique" });
  }
});

app.post("/event", async (req, res) => {
  try {
    const body = req.body || {};

    console.log("Webhook recebido:", JSON.stringify(body));

    const normalized = normalizeEvent(body);

    if (!normalized) {
      return res.status(400).json({
        error: "payload não reconhecido",
        received: body,
      });
    }

    const { click_id, event_name, event_id, value, currency } = normalized;

    const existing = await pool.query(
      "SELECT id FROM events WHERE event_id = $1 LIMIT 1",
      [event_id]
    );

    const is_duplicate = existing.rows.length > 0;

    if (!is_duplicate) {
      await pool.query(
        `INSERT INTO events 
        (click_id, event_id, event_name, value, currency, page_url, referrer, user_agent, ip_hash, is_duplicate, raw_payload)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          click_id,
          event_id,
          event_name,
          value,
          currency,
          body.page_url || "",
          body.referrer || "",
          req.headers["user-agent"] || "",
          hashIp(getClientIp(req)),
          false,
          body,
        ]
      );
    } else {
      await pool.query(
        `INSERT INTO postback_logs 
        (event_id, click_id, destination, status, request_payload, response_body)
        VALUES ($1,$2,$3,$4,$5,$6)`,
        [event_id, click_id, "internal", "duplicate", body, "Evento duplicado"]
      );
    }

    return res.json({
      ok: true,
      click_id,
      event_id,
      event_name,
      value,
      currency,
      is_duplicate,
    });
  } catch (error) {
    console.error("Erro no /event:", error);
    return res.status(500).json({ error: "Erro ao registrar evento" });
  }
});

app.get("/dashboard/summary", async (req, res) => {
  try {
    const clicks = await pool.query("SELECT COUNT(*)::int AS total FROM clicks");
    const events = await pool.query(`
      SELECT 
        event_name,
        COUNT(*)::int AS total,
        COALESCE(SUM(value), 0)::float AS value
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

    res.json({
      clicks: clicks.rows[0].total,
      revenue: revenue.rows[0].total,
      events: events.rows,
    });
  } catch (error) {
    console.error("Erro no dashboard:", error);
    res.status(500).json({ error: "Erro ao gerar dashboard" });
  }
});

app.get("/dashboard/campaigns", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        COALESCE(c.utm_campaign, 'sem_campanha') AS campaign,
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
    console.error("Erro campaigns:", error);
    res.status(500).json({ error: "Erro ao listar campanhas" });
  }
});

app.get("/dashboard/creatives", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        COALESCE(c.utm_content, c.creative_id, 'sem_criativo') AS creative,
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
    console.error("Erro creatives:", error);
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
