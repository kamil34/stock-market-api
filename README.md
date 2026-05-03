# stock-market-api

A simplified stock market API built with Node.js, allowing management of wallets and stock inventory.

---

## Tech Stack

- Node.js
- SQLite (WAL mode)
- Docker & Docker Compose
- Node.js Cluster (high availability)

---

## Getting Started

### Run application

```bash
PORT=8080 docker compose up --build
```

### Windows (PowerShell)

```powershell
$env:PORT=8080; docker compose up --build
```

Application available at:  
http://localhost:8080

---

## API Endpoints

### Wallets

- POST `/wallets/{wallet_id}/stocks/{stock_name}` — buy/sell stock  
- GET `/wallets/{wallet_id}` — get wallet  
- GET `/wallets/{wallet_id}/stocks/{stock_name}` — get stock from wallet  

### Stocks

- GET `/stocks` — get available stocks  
- POST `/stocks` — set stock inventory  

### System

- GET `/log` — operation log  
- POST `/chaos` — kill current worker (HA test)

---

## Usage Examples

> Recommended way to test API is using `curl`

### Set stock bank

```bash
curl -X POST http://localhost:8080/stocks \
-H "Content-Type: application/json" \
-d '{"stocks":[{"name":"AAPL","quantity":2},{"name":"TSLA","quantity":1}]}'
```

---

### Buy stock

```bash
curl -X POST http://localhost:8080/wallets/w1/stocks/AAPL \
-H "Content-Type: application/json" \
-d '{"type":"buy"}'
```

---

### Sell stock

```bash
curl -X POST http://localhost:8080/wallets/w1/stocks/AAPL \
-H "Content-Type: application/json" \
-d '{"type":"sell"}'
```

---

### Get wallet

```bash
curl http://localhost:8080/wallets/w1
```

---

### Get stocks

```bash
curl http://localhost:8080/stocks
```

---

### Get log

```bash
curl http://localhost:8080/log
```

---

## Architecture

- SQLite in WAL mode for persistence
- Node.js Cluster for high availability
- `/chaos` kills only the worker serving request
- master process automatically respawns workers
- audit log stores only successful wallet operations
- initial state:
  - no wallets
  - empty stock bank