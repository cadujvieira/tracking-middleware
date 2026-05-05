require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { google } = require("googleapis");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

/* =========================
   GOOGLE SHEETS
========================= */

async function getSheetData() {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });

  const sheets = google.sheets({ version: "v4", auth });

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SHEET_ID,
    range: "Página1!A:Z",
  });

  return response.data.values;
}

/* =========================
   FUNÇÕES UTILITÁRIAS
========================= */

function normalizeCampaignName(name) {
  return String(name || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\[\]\(\){}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function calcularQualidadeCampanha(ticket, frequencia, ftd) {
  if (ftd === 0) return "sem_ftd";
  if (ticket >= 50 && frequencia >= 2) return "diamante";
  if (ticket >= 50) return "ouro";
  if (ticket >= 30) return "muito_bom";
  if (ticket >= 20) return "bom";
  return "ruim";
}

/* =========================
   ROTAS API
========================= */

app.get("/sheets/campaigns", async (req, res) => {
  try {
    const data = await getSheetData();

    const headers = data[0];
    const rows = data.slice(1);
    const idx = (name) => headers.indexOf(name);

    const campaigns = {};

    rows.forEach((row) => {
      const campaign = row[idx("utm_campaign")] || "sem_campanha";
      const event = row[idx("evento")];
      const valor = parseFloat(row[idx("valor")]) || 0;

      if (!campaigns[campaign]) {
        campaigns[campaign] = {
          campaign,
          leads: 0,
          pixGerado: 0,
          depositos: 0,
          receita: 0,
          ftd: 0,
        };
      }

      if (event === "lead") campaigns[campaign].leads++;
      if (event === "pix_gerado") campaigns[campaign].pixGerado++;

      if (event === "DEPOSITO_WH") {
        campaigns[campaign].depositos++;
        campaigns[campaign].receita += valor;
      }

      if (event === "FTD_WH") {
        campaigns[campaign].ftd++;
      }
    });

    const result = Object.values(campaigns)
      .map((item) => {
        const ticketMedioDeposito = item.depositos
          ? item.receita / item.depositos
          : 0;

        const frequenciaDeposito = item.ftd
          ? item.depositos / item.ftd
          : 0;

        const qualidade = calcularQualidadeCampanha(
          ticketMedioDeposito,
          frequenciaDeposito,
          item.ftd
        );

        return {
          ...item,
          ticketMedio: ticketMedioDeposito,
          conversaoLeadDeposito: item.leads
            ? item.depositos / item.leads
            : 0,
          conversaoLeadFTD: item.leads
            ? item.ftd / item.leads
            : 0,
          ticketMedioDeposito,
          frequenciaDeposito,
          qualidade,
        };
      })
      .sort((a, b) => b.receita - a.receita);

    res.json({
      ok: true,
      totalCampaigns: result.length,
      campaigns: result,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

/* =========================
   TOP CAMPANHAS
========================= */

app.get("/sheets/top", async (req, res) => {
  try {
    const data = await getSheetData();

    const headers = data[0];
    const rows = data.slice(1);
    const idx = (name) => headers.indexOf(name);

    const campaigns = {};

    rows.forEach((row) => {
      const campaign = row[idx("utm_campaign")] || "sem_campanha";
      const event = row[idx("evento")];
      const valor = parseFloat(row[idx("valor")]) || 0;

      if (!campaigns[campaign]) {
        campaigns[campaign] = {
          campaign,
          leads: 0,
          pixGerado: 0,
          depositos: 0,
          receita: 0,
          ftd: 0,
        };
      }

      if (event === "lead") campaigns[campaign].leads++;
      if (event === "pix_gerado") campaigns[campaign].pixGerado++;

      if (event === "DEPOSITO_WH") {
        campaigns[campaign].depositos++;
        campaigns[campaign].receita += valor;
      }

      if (event === "FTD_WH") {
        campaigns[campaign].ftd++;
      }
    });

    const result = Object.values(campaigns)
      .map((c) => {
        const ticketMedioDeposito = c.depositos
          ? c.receita / c.depositos
          : 0;

        const frequenciaDeposito = c.ftd
          ? c.depositos / c.ftd
          : 0;

        const qualidade = calcularQualidadeCampanha(
          ticketMedioDeposito,
          frequenciaDeposito,
          c.ftd
        );

        return {
          ...c,
          epl: c.leads ? c.receita / c.leads : 0,
          valorPorFTD: c.ftd ? c.receita / c.ftd : 0,
          taxaFTD: c.leads ? c.ftd / c.leads : 0,
          ticketMedioDeposito,
          frequenciaDeposito,
          qualidade,
        };
      })
      .sort((a, b) => b.receita - a.receita)
      .slice(0, 10);

    res.json({
      ok: true,
      top: result,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

/* =========================
   SERVER
========================= */

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
