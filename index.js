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

  return response.data.values;
}

function normalizeEvent(body) {
  // 1) Formato interno/teste manual
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

  // 2) Formato padrão da plataforma: Depósito pago
  if (body.action === "invoice_paid" && body.invoice) {
    const invoice = body.invoice || {};
    const user = body.user || {};

    return {
      // Provisório: enquanto a plataforma não devolver click_id real
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
}

app.get("/", (req, res) => {
  res.json({
    status: "online",
    service: "tracking-middleware",
    endpoints: ["/redirect", "/event", "/dashboard/summary", "/dashboard/campaigns", "/dashboard/creatives"],
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
        : 0
    });

  } catch (error) {
    console.error("Erro no dashboard:", error);
    res.status(500).json({
      ok: false,
      error: error.message
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
      const evento = row[idx("evento")];
      const valor = parseFloat(row[idx("valor")]) || 0;

      if (!campaigns[campaign]) {
        campaigns[campaign] = {
          campaign,
          leads: 0,
          pixGerado: 0,
          depositos: 0,
          ftd: 0,
          receita: 0
        };
      }

      if (evento === "lead") campaigns[campaign].leads++;
      if (evento === "pix_gerado") campaigns[campaign].pixGerado++;

      if (evento === "DEPOSITO_WH") {
        campaigns[campaign].depositos++;
        campaigns[campaign].receita += valor;
      }

      if (evento === "FTD_WH") campaigns[campaign].ftd++;
    });

    const result = Object.values(campaigns)
      .map((item) => ({
        ...item,
        ticketMedio: item.depositos ? item.receita / item.depositos : 0,
        conversaoLeadDeposito: item.leads ? item.depositos / item.leads : 0,
        conversaoLeadFTD: item.leads ? item.ftd / item.leads : 0
      }))
      .sort((a, b) => b.receita - a.receita);

    res.json({
      ok: true,
      totalCampaigns: result.length,
      campaigns: result
    });

  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.get("/sheets/top", async (req, res) => {
  try {
    const data = await getSheetData();

    const headers = data[0];
    const rows = data.slice(1);
    const idx = (name) => headers.indexOf(name);

    const campaigns = {};

    rows.forEach((row) => {
      const campaign = row[idx("utm_campaign")] || "sem_campanha";
      const evento = row[idx("evento")];
      const valor = parseFloat(row[idx("valor")]) || 0;

      if (!campaigns[campaign]) {
        campaigns[campaign] = {
          campaign,
          leads: 0,
          depositos: 0,
          receita: 0,
          ftd: 0
        };
      }

      if (evento === "lead") campaigns[campaign].leads++;

      if (evento === "DEPOSITO_WH") {
        campaigns[campaign].depositos++;
        campaigns[campaign].receita += valor;
      }

      if (evento === "FTD_WH") campaigns[campaign].ftd++;
    });

    const result = Object.values(campaigns)
  .filter(c => c.leads >= 10)
  .map(c => ({
    ...c,
    epl: c.leads ? c.receita / c.leads : 0,
    valorPorFTD: c.ftd ? c.receita / c.ftd : 0,
    taxaFTD: c.leads ? c.ftd / c.leads : 0
  }))
  .sort((a, b) => b.receita - a.receita)
  .slice(0, 10);

    res.json({
      ok: true,
      top: result
    });

  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.get("/dashboard-view", async (req, res) => {
  try {
    const data = await getSheetData();

    const headers = data[0];
    const rows = data.slice(1);
    const idx = (name) => headers.indexOf(name);

    const campaigns = {};

    rows.forEach((row) => {
      const campaign = row[idx("utm_campaign")] || "sem_campanha";
      const evento = row[idx("evento")];
      const valor = parseFloat(row[idx("valor")]) || 0;

      if (!campaigns[campaign]) {
        campaigns[campaign] = {
          campaign,
          leads: 0,
          pixGerado: 0,
          depositos: 0,
          receita: 0,
          ftd: 0
        };
      }

      if (evento === "lead") campaigns[campaign].leads++;
      if (evento === "pix_gerado") campaigns[campaign].pixGerado++;

      if (evento === "DEPOSITO_WH") {
        campaigns[campaign].depositos++;
        campaigns[campaign].receita += valor;
      }

      if (evento === "FTD_WH") {
        campaigns[campaign].ftd++;
      }
    });

    const result = Object.values(campaigns)
      .filter(c => c.leads >= 10)
      .map(c => ({
        ...c,
        epl: c.leads ? c.receita / c.leads : 0,
        valorPorFTD: c.ftd ? c.receita / c.ftd : 0,
        taxaFTD: c.leads ? c.ftd / c.leads : 0
      }))
      .sort((a, b) => b.receita - a.receita)
      .slice(0, 20);

    const totalReceita = result.reduce((acc, c) => acc + c.receita, 0);
    const totalLeads = result.reduce((acc, c) => acc + c.leads, 0);
    const totalFtd = result.reduce((acc, c) => acc + c.ftd, 0);
    const totalDepositos = result.reduce((acc, c) => acc + c.depositos, 0);

    const rowsHtml = result.map(c => {

  let rowClass = '';

  if (c.taxaFTD >= 0.5 && c.epl >= 20) {
    rowClass = 'good';
  } else if (c.taxaFTD >= 0.25) {
    rowClass = 'medium';
  } else {
    rowClass = 'bad';
  }

  return `
    <tr>
      <td>${c.campaign}</td>
      <td>${c.leads}</td>
      <td>${c.pixGerado}</td>
      <td>${c.depositos}</td>
      <td>${c.ftd}</td>
      <td class="${rowClass}-cell">R$ ${c.epl.toFixed(2)}</td>
      <td>R$ ${c.valorPorFTD.toFixed(2)}</td>
      <td class="${rowClass}-cell">${(c.taxaFTD * 100).toFixed(2)}%</td>
    </tr>
  `;
}).join('');

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
          }
/* Tooltip escondido */
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
/* Mostrar no hover */
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
          .good {
            background: rgba(34, 197, 94, 0.12);
          }
          .medium {
            background: rgba(234, 179, 8, 0.12);
          }
          .bad {
            background: rgba(239, 68, 68, 0.12);
          }
          .good:hover {
            background: rgba(34, 197, 94, 0.25);
          }
          .medium:hover {
            background: rgba(234, 179, 8, 0.25);
          }
          .bad:hover {
            background: rgba(239, 68, 68, 0.25);
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

    <th>
      Leads
      <span class="info">
        ?
        <span class="tooltip">
          Quantidade total de leads capturados pela campanha.
        </span>
      </span>
    </th>

    <th>
      Pix
      <span class="info">
        ?
        <span class="tooltip">
          Quantidade de Pix gerados pelos usuários vindos dessa campanha.
        </span>
      </span>
    </th>

    <th>
      Depósitos
      <span class="info">
        ?
        <span class="tooltip">
          Quantidade total de depósitos realizados. Um usuário pode depositar mais de uma vez.
        </span>
      </span>
    </th>

    <th>
      FTD
      <span class="info">
        ?
        <span class="tooltip">
          First Time Deposit: quantidade de usuários que fizeram o primeiro depósito.
        </span>
      </span>
    </th>

    <th>
      Receita
      <span class="info">
        ?
        <span class="tooltip">
          Soma total dos valores depositados pelos usuários dessa campanha.
        </span>
      </span>
    </th>

    <th>
      EPL
      <span class="info">
        ?
        <span class="tooltip">
          Earnings Per Lead: receita média por lead. Fórmula: receita / leads.
        </span>
      </span>
    </th>

    <th>
      Valor/FTD
      <span class="info">
        ?
        <span class="tooltip">
          Receita média por FTD. Fórmula: receita / FTD.
        </span>
      </span>
    </th>

    <th>
      Taxa FTD
      <span class="info">
        ?
        <span class="tooltip">
          Percentual de leads que viraram FTD. Fórmula: FTD / leads.
        </span>
      </span>
    </th>

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
