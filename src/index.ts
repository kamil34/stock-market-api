import cluster from "node:cluster";
import os from "node:os";
import Fastify from "fastify";
import Database from "better-sqlite3";

type OperationType = "buy" | "sell";

class HttpError extends Error {
  statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

const PORT = Number(process.env.PORT || 8080);
const DB_PATH = process.env.DB_PATH || "/data/market.db";
const WORKERS = Number(process.env.WORKERS || Math.max(2, Math.min(os.cpus().length, 4)));

if (cluster.isPrimary) {
  for (let i = 0; i < WORKERS; i += 1) {
    cluster.fork();
  }

  cluster.on("exit", () => {
    cluster.fork();
  });
} else {
  startServer().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

async function startServer() {
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  db.exec(`
    CREATE TABLE IF NOT EXISTS stock_catalog (
      name TEXT PRIMARY KEY
    );

    CREATE TABLE IF NOT EXISTS bank_inventory (
      stock_name TEXT PRIMARY KEY REFERENCES stock_catalog(name),
      quantity INTEGER NOT NULL CHECK (quantity >= 0)
    );

    CREATE TABLE IF NOT EXISTS wallets (
      id TEXT PRIMARY KEY
    );

    CREATE TABLE IF NOT EXISTS wallet_stocks (
      wallet_id TEXT NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
      stock_name TEXT NOT NULL REFERENCES stock_catalog(name),
      quantity INTEGER NOT NULL CHECK (quantity >= 0),
      PRIMARY KEY (wallet_id, stock_name)
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK (type IN ('buy', 'sell')),
      wallet_id TEXT NOT NULL,
      stock_name TEXT NOT NULL
    );
  `);

  const app = Fastify({ logger: false });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof HttpError) {
      reply.code(error.statusCode).send({ error: error.message });
      return;
    }

    console.error(error);
    reply.code(500).send({ error: "internal server error" });
  });

  const stockExistsStmt = db.prepare(`
    SELECT 1 FROM stock_catalog WHERE name = ?
  `);

  const walletExistsStmt = db.prepare(`
    SELECT 1 FROM wallets WHERE id = ?
  `);

  const bankQuantityStmt = db.prepare(`
    SELECT quantity FROM bank_inventory WHERE stock_name = ?
  `);

  const walletQuantityStmt = db.prepare(`
    SELECT quantity FROM wallet_stocks WHERE wallet_id = ? AND stock_name = ?
  `);

  const insertWalletStmt = db.prepare(`
    INSERT OR IGNORE INTO wallets(id) VALUES (?)
  `);

  const insertCatalogStmt = db.prepare(`
    INSERT OR IGNORE INTO stock_catalog(name) VALUES (?)
  `);

  const upsertBankStmt = db.prepare(`
    INSERT INTO bank_inventory(stock_name, quantity)
    VALUES (?, ?)
    ON CONFLICT(stock_name) DO UPDATE SET quantity = excluded.quantity
  `);

  const upsertWalletStmt = db.prepare(`
    INSERT INTO wallet_stocks(wallet_id, stock_name, quantity)
    VALUES (?, ?, ?)
    ON CONFLICT(wallet_id, stock_name) DO UPDATE SET quantity = excluded.quantity
  `);

  const deleteWalletStockStmt = db.prepare(`
    DELETE FROM wallet_stocks WHERE wallet_id = ? AND stock_name = ?
  `);

  const insertLogStmt = db.prepare(`
    INSERT INTO audit_log(type, wallet_id, stock_name)
    VALUES (?, ?, ?)
  `);

  const replaceBankState = db.transaction((stocks: Array<{ name: string; quantity: number }>) => {
    for (const stock of stocks) {
      insertCatalogStmt.run(stock.name);
    }

    db.prepare(`DELETE FROM bank_inventory`).run();

    for (const stock of stocks) {
      upsertBankStmt.run(stock.name, stock.quantity);
    }
  });

  const performWalletOperation = db.transaction((walletId: string, stockName: string, type: OperationType) => {
    const stockExists = stockExistsStmt.get(stockName);
    if (!stockExists) {
      throw new HttpError(404, "stock not found");
    }

    insertWalletStmt.run(walletId);

    const bankRow = bankQuantityStmt.get(stockName) as { quantity: number } | undefined;
    const walletRow = walletQuantityStmt.get(walletId, stockName) as { quantity: number } | undefined;

    const bankQty = bankRow?.quantity ?? 0;
    const walletQty = walletRow?.quantity ?? 0;

    if (type === "buy") {
      if (bankQty <= 0) {
        throw new HttpError(400, "no stock in bank");
      }

      upsertBankStmt.run(stockName, bankQty - 1);
      upsertWalletStmt.run(walletId, stockName, walletQty + 1);
      insertLogStmt.run("buy", walletId, stockName);
      return;
    }

    if (walletQty <= 0) {
      throw new HttpError(400, "no stock in wallet");
    }

    if (walletQty - 1 === 0) {
      deleteWalletStockStmt.run(walletId, stockName);
    } else {
      upsertWalletStmt.run(walletId, stockName, walletQty - 1);
    }

    upsertBankStmt.run(stockName, bankQty + 1);
    insertLogStmt.run("sell", walletId, stockName);
  });

  app.post("/stocks", async (request, reply) => {
    const body = request.body as unknown;

    if (
      !body ||
      typeof body !== "object" ||
      !Array.isArray((body as { stocks?: unknown }).stocks)
    ) {
      throw new HttpError(400, "invalid body");
    }

    const stocks = (body as { stocks: unknown[] }).stocks.map((item) => {
      if (
        !item ||
        typeof item !== "object" ||
        typeof (item as { name?: unknown }).name !== "string" ||
        !Number.isInteger((item as { quantity?: unknown }).quantity) ||
        ((item as { quantity: number }).quantity < 0)
      ) {
        throw new HttpError(400, "invalid body");
      }

      return {
        name: (item as { name: string }).name,
        quantity: (item as { quantity: number }).quantity
      };
    });

    const names = new Set(stocks.map((s) => s.name));
    if (names.size !== stocks.length) {
      throw new HttpError(400, "duplicate stock names");
    }

    replaceBankState(stocks);
    reply.code(200).send();
  });

  app.get("/stocks", async (_request, reply) => {
    const stocks = db.prepare(`
      SELECT stock_name AS name, quantity
      FROM bank_inventory
      ORDER BY stock_name
    `).all() as Array<{ name: string; quantity: number }>;

    reply.send({ stocks });
  });

  app.post("/wallets/:wallet_id/stocks/:stock_name", async (request, reply) => {
    const params = request.params as { wallet_id: string; stock_name: string };
    const body = request.body as { type?: unknown };

    if (body?.type !== "buy" && body?.type !== "sell") {
      throw new HttpError(400, "invalid body");
    }

    performWalletOperation(params.wallet_id, params.stock_name, body.type);
    reply.code(200).send();
  });

  app.get("/wallets/:wallet_id", async (request, reply) => {
    const { wallet_id } = request.params as { wallet_id: string };

    const walletExists = walletExistsStmt.get(wallet_id);
    if (!walletExists) {
      throw new HttpError(404, "wallet not found");
    }

    const stocks = db.prepare(`
      SELECT stock_name AS name, quantity
      FROM wallet_stocks
      WHERE wallet_id = ?
      ORDER BY stock_name
    `).all(wallet_id) as Array<{ name: string; quantity: number }>;

    reply.send({
      id: wallet_id,
      stocks
    });
  });

  app.get("/wallets/:wallet_id/stocks/:stock_name", async (request, reply) => {
    const { wallet_id, stock_name } = request.params as { wallet_id: string; stock_name: string };

    const walletExists = walletExistsStmt.get(wallet_id);
    if (!walletExists) {
      throw new HttpError(404, "wallet not found");
    }

    const stockExists = stockExistsStmt.get(stock_name);
    if (!stockExists) {
      throw new HttpError(404, "stock not found");
    }

    const row = walletQuantityStmt.get(wallet_id, stock_name) as { quantity: number } | undefined;
    reply.send(row?.quantity ?? 0);
  });

  app.get("/log", async (_request, reply) => {
    const log = db.prepare(`
      SELECT type, wallet_id, stock_name
      FROM audit_log
      ORDER BY seq
    `).all() as Array<{ type: OperationType; wallet_id: string; stock_name: string }>;

    reply.send({ log });
  });

  app.post("/chaos", async (_request, reply) => {
    reply.code(200).send();
    setTimeout(() => process.exit(1), 25);
  });

  await app.listen({ port: PORT, host: "0.0.0.0" });
}