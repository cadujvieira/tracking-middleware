# Tracking Middleware

Backend inicial para tracking com Render + PostgreSQL.

## Endpoints

### Teste
GET /

### Clique
GET /redirect?utm_source=kwai&utm_campaign=campanha01&utm_content=criativo01

### Evento
POST /event

Exemplo:
```json
{
  "click_id": "clk_123",
  "event_name": "purchase",
  "event_id": "evt_001",
  "value": 47,
  "currency": "BRL"
}
```

### Dashboard
GET /dashboard/summary  
GET /dashboard/campaigns  
GET /dashboard/creatives  

## Render

Build command:
```bash
npm install
```

Start command:
```bash
npm start
```

Variáveis de ambiente:
```txt
DATABASE_URL
FINAL_DESTINATION_URL
NODE_ENV=production
```
