# Restaurant Reservation Agent

WhatsApp AI agent for restaurant reservations — multi-tenant, built on Meta Cloud API.

## Phase 0 status: CLI simulation ✅

The core conversational engine (field extraction, gap-filling, date normalization, availability check) runs end-to-end in a terminal session. No WhatsApp connection needed yet.

## Requirements

- Node.js 22.5+ (uses built-in `node:sqlite`)
- An Anthropic API key

## Setup

```bash
cp .env.example .env
# Edit .env and add your ANTHROPIC_API_KEY
npm install
```

## Run the simulation

```bash
npm run simulate
```

This starts an interactive CLI session. Type messages as if you were a WhatsApp customer. The bot will guide you through a reservation.

**Example conversation:**
```
Tú: hola
Bot: ¡Hola! Bienvenido a La Buena Mesa. ¿Para qué fecha quieres la reserva? 😊

Tú: quiero reservar el viernes a las 8 para 4 personas
Bot: ¿A nombre de quién hacemos la reserva?

Tú: Carlos Pérez
Bot: *Resumen de tu reserva en La Buena Mesa:*
📅 Fecha: 27 de junio de 2025
🕐 Hora: 20:00
👥 Personas: 4
👤 Nombre: Carlos Pérez

¿Confirmo tu reserva? (sí / no)

Tú: sí
Bot: ¡Listo, Carlos Pérez! 🎉 Tu reserva en *La Buena Mesa* está confirmada.
```

## Run tests

```bash
npm test
```

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key |
| `DATABASE_URL` | No | SQLite file path (default: `./data/agent.db`) |
| `RESTAURANT_ID` | No | Restaurant to simulate (default: `demo`) |
| `SIM_PHONE` | No | Simulated phone number (default: `+52550000001`) |

## Project structure

El proyecto está dividido en dos módulos de producto + código compartido:

```
src/
  whatsapp/           Agente de WhatsApp (reservas y pedidos)
    routes.ts           Rutas Fastify: webhook de Meta + pedidos web
    channels/           Cloud API de WhatsApp + simulación CLI
    core/               Orquestador del agente, gap-filler, prompts, recordatorios
    business/           Dominio de reservas/pedidos, normalizador de fechas
    data/               Persistencia de estado en SQLite
    integrations/       Google Calendar + Sheets (menú, CRM)
  google-reviews/     Respuesta automática a reseñas de Google
    review-responder.ts Ciclo periódico que responde reseñas pendientes
    gbp-client.ts       Cliente de Google Business Profile API
  shared/             Código usado por ambos módulos
    config/             Configuración de restaurantes (tipos, env, demo)
    llm/                Cliente de Claude e interfaz del LLM
    sheets/             Sheet maestro multi-tenant
  server/             Punto de entrada: arranca ambos módulos
tests/                Unit tests (normalizer, gap-filler, webhook, QA)
```

## Roadmap

- **Phase 0** ✅ — CLI simulation, end-to-end reservation flow
- **Phase 1** — Google Calendar integration (real availability)
- **Phase 2** — Multi-tenant config from Google Sheets
- **Phase 3** — Meta WhatsApp Cloud API webhook
- **Phase 4** — Reminders, cancel/reschedule, FAQ, human handoff
