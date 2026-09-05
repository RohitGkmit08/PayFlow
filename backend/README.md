# PayFlow Backend Engine

The core transaction processing and financial ledger backend for **PayFlow**, a production-style fintech wallet system inspired by modern real-time payment systems (like UPI).

Built with **Node.js**, **Express**, and **MongoDB (Mongoose)**, this backend implements fundamental fintech engineering patterns:
- **Ledger-based double-entry accounting**
- **Strict separation of financial accounts, wallets, and ledger entries**
- **Integer arithmetic (Paise) to eliminate floating-point precision errors**
- **Atomic operations and multi-document database transactions**
- **Stateful, cryptographically secure session-based authentication with HttpOnly cookies**
- **Idempotency tracking and request deduplication models**
- **Strict schema validation with Zod**

---

## Table of Contents

- [Architecture & Core Concepts](#architecture--core-concepts)
  - [The Financial Accounting Model](#the-financial-accounting-model)
  - [Money Representation (Paise vs Rupees)](#money-representation-paise-vs-rupees)
  - [Session Authentication Architecture](#session-authentication-architecture)
  - [Idempotency & Concurrency Safety](#idempotency--concurrency-safety)
- [Directory Structure](#directory-structure)
- [Database Models](#database-models)
- [API Reference](#api-reference)
  - [Health Check](#health-check)
  - [Authentication Endpoints](#authentication-endpoints)
  - [Payment Endpoints](#payment-endpoints)
- [Getting Started](#getting-started)
  - [Prerequisites](#prerequisites)
  - [Environment Variables](#environment-variables)
  - [Installation & Local Run](#installation--local-run)
- [Validation Rules](#validation-rules)
- [Security & Best Practices](#security--best-practices)

---

## Architecture & Core Concepts

### The Financial Accounting Model

PayFlow enforces a strict separation between **identity**, **financial accounting**, **cached balance**, and **transaction history**:

```text
                         USER (Identity & Auth)
                                   │
                                   ▼
                       ACCOUNT (Financial Entity)
                      (USER_WALLET, BANK_SUSPENSE,
                      PLATFORM_REVENUE, SETTLEMENT_POOL)
                                   │
                  ┌────────────────┴────────────────┐
                  ▼                                 ▼
         LEDGER ENTRIES                     WALLET (Balance State)
     (Immutable Append-Only Audit)          (Fast Mutable View for UI)
```

1. **User (`User`)**: Represents the human identity holding credentials (`hashPswd`), phone, and email.
2. **Account (`Account`)**: The accounting identity participating in transactions. A user owns an account of type `USER_WALLET`. System accounts (e.g., `BANK_SUSPENSE`, `PLATFORM_REVENUE`, `SETTLEMENT_POOL`) handle non-user accounting.
3. **Wallet (`Wallet`)**: A fast, cached view of available funds for rapid user balance queries. **The wallet is not the source of financial truth; the ledger is.** If wallet balances ever desynchronize, they can be recomputed from the ledger.
4. **Transaction (`Transaction`)**: Represents a high-level business movement of money (e.g., P2P transfer between two accounts) along with its lifecycle state (`INITIATED` -> `PROCESSING` -> `SUCCESS` / `FAILED` / `REVERSED`).
5. **Ledger Entry (`LedgerEntry`)**: The immutable proof of money movement following double-entry bookkeeping. Every completed P2P transaction generates **two** ledger entries:
   - One `DEBIT` entry against the sender's account.
   - One `CREDIT` entry against the receiver's account.

### Money Representation (Paise vs Rupees)

> **IMPORTANT:**
> **No floating-point numbers are used for currency values.**
> Storing amounts as `10.50` in IEEE 754 floating-point numbers introduces rounding anomalies (e.g., `0.1 + 0.2 !== 0.3`).
> All balances and transaction amounts are stored strictly as **integers in Paise** (1 INR = 100 paise).
>
> Example: ₹500.00 is represented as `50000`.

### Session Authentication Architecture

Rather than stateless JWTs stored in client-accessible storage (which can be vulnerable to XSS or revocation challenges), PayFlow uses a **stateful, hashed session-cookie pattern**:

```text
Client (Browser)                       Backend API                          MongoDB
      │                                     │                                  │
      │─── POST /api/auth/login ───────────>│                                  │
      │    { email, password }              │─── Verify password (bcrypt) ────>│
      │                                     │─── Generate 32-byte raw token ───│
      │                                     │─── Compute SHA-256 hash ─────────│
      │                                     │─── Store { userId, hash } ──────>│ (TTL: 7 days)
      │<── Set-Cookie: sessionToken ────────│                                  │
      │    (HttpOnly, SameSite=Lax)         │                                  │
      │                                     │                                  │
      │─── Request with Cookie ────────────>│                                  │
      │                                     │─── Hash cookie token (SHA-256) ──│
      │                                     │─── Look up session document ────>│
      │                                     │─── Attach req.userId ────────────│
      │<── Processed Response ──────────────│                                  │
```

- Raw token is a 64-character hex string generated via `crypto.randomBytes(32)`.
- The database stores only the **SHA-256 hash** (`sessionTokenHash`). Even if the database is leaked, valid session tokens cannot be forged.
- The cookie is delivered with `HttpOnly: true`, `SameSite: "lax"`, and `Secure: true` in production.
- Sessions automatically self-delete in MongoDB via a native TTL index on `expiresAt`.

### Idempotency & Concurrency Safety

Payment APIs must handle network retries safely without charging customers twice:
- The `IdempotencyKey` model ties `{ userId, key }` to an operation fingerprint.
- Multi-document transactions (`mongoose.startSession()`) wrap multi-step operations (e.g., User + Account + Wallet creation on registration).

---

## Directory Structure

```text
backend/
├── src/
│   ├── config/
│   │   └── db.js                 # Mongoose connection logic
│   ├── controllers/
│   │   ├── auth.controller.js    # Register, login, and getMe handlers
│   │   └── payment.controller.js # Payment processing HTTP controller
│   ├── middleware/
│   │   └── auth.middleware.js    # Session-token cookie extractor & validator
│   ├── models/
│   │   ├── Accounts.js           # Accounting identity model (USER_WALLET, etc.)
│   │   ├── Idempotency.js        # Request deduplication and replay store
│   │   ├── LedgerEntry.js        # Immutable double-entry ledger records
│   │   ├── Session.js            # Stateful user sessions with SHA-256 hash & TTL
│   │   ├── Transaction.js        # High-level business transaction tracker
│   │   ├── User.js               # Core user model with hashed credentials
│   │   └── Wallet.js             # Fast-access available balance model (Paise)
│   ├── routes/
│   │   ├── auth.routes.js        # Authentication route definitions (/api/auth)
│   │   └── payment.routes.js     # Payment route definitions (/api/payments)
│   ├── services/
│   │   └── payment.service.js    # P2P transaction workflow & double-entry execution
│   ├── utils/                    # Helper utilities and shared functions
│   ├── validator/
│   │   ├── auth.validator.js     # Zod schemas for registration & login
│   │   └── payment.validator.js  # Zod schema for payment payloads
│   ├── app.js                    # Express app configuration & middleware pipeline
│   └── server.js                 # Server entry point & database initializer
├── .env                          # Local environment variables (gitignored)
├── .env.example                  # Template of required environment variables
├── package.json                  # Dependencies and run scripts
└── README.md                     # Backend documentation
```

---

## Database Models

| Model | Collection | Purpose | Key Attributes |
| :--- | :--- | :--- | :--- |
| **`User`** | `users` | User identity & authentication | `name`, `phone` (unique), `email` (sparse, unique), `hashPswd`, `status` (`ACTIVE`, `BLOCKED`) |
| **`Account`** | `accounts` | Accounting identity | `userId` (ref `User`), `accountType` (`USER_WALLET`, `BANK_SUSPENSE`, `PLATFORM_REVENUE`, `SETTLEMENT_POOL`), `currency` (`INR`), `status` |
| **`Wallet`** | `wallets` | Quick balance snapshot | `userId`, `accountId` (ref `Account`), `availableBalance` (integer paise, ≥ 0) |
| **`Transaction`** | `transactions` | Business event record | `transactionId` (unique `TXN-...`), `type` (`P2P_TRANSFER`), `senderAccountId`, `receiverAccountId`, `amount` (paise), `status` (`INITIATED`, `PROCESSING`, `SUCCESS`, `FAILED`, `REVERSED`), `failureReason` |
| **`LedgerEntry`** | `ledgerentries` | Double-entry financial audit record | `transactionId` (ref `Transaction`), `accountId` (ref `Account`), `entryType` (`DEBIT`, `CREDIT`), `amount` (paise), `currency` |
| **`Session`** | `sessions` | Active device sessions | `userId`, `sessionTokenHash` (unique), `expiresAt` (TTL index), `revokedAt` |
| **`IdempotencyKey`** | `idempotencykeys`| Request deduplication | `userId`, `key`, `requestFingerprint`, `status` (`IN_PROGRESS`, `COMPLETED`), `transactionId`, `response`, `expiresAt` (TTL) |

---

## API Reference

### Health Check

#### `GET /`
Checks backend service availability.

- **Request Headers**: None
- **Response `200 OK`**:
```json
{
  "message": "PayFlow Backend",
  "status": "running"
}
```

---

### Authentication Endpoints

Base Path: `/api/auth`

#### 1. Register User
`POST /api/auth/register`

Atomically creates a new `User`, creates an associated `Account` (`accountType: "USER_WALLET"`), and initializes a `Wallet` with `0` balance within an ACID MongoDB transaction.

- **Request Body**:
```json
{
  "name": "Rohit Sinha",
  "phone": "9876543210",
  "email": "rohit@example.com",
  "password": "SecurePassword123"
}
```
*Note: `email` is optional. `phone` must be a 10-digit number. `password` minimum length is 6.*

- **Response `201 Created`**:
```json
{
  "message": "User registered successfully",
  "user": {
    "id": "64b8f0f4a7c1b2c3d4e5f6a1",
    "name": "Rohit Sinha",
    "phone": "9876543210",
    "email": "rohit@example.com"
  }
}
```

- **Error Responses**:
  - `400 Bad Request`: Validation failure on input fields.
  - `409 Conflict`: Phone or email is already registered.
  - `500 Internal Server Error`: Transaction failure or database issue.

---

#### 2. Login User
`POST /api/auth/login`

Validates credentials, verifies account status, creates a persistent session record with a SHA-256 hashed token, and sends an `HttpOnly` cookie back to the browser.

- **Request Body**:
```json
{
  "email": "rohit@example.com",
  "password": "SecurePassword123"
}
```

- **Response `200 OK`**:
- **Headers**:
  ```http
  Set-Cookie: sessionToken=<64-character-hex>; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800
  ```
- **Body**:
```json
{
  "message": "login successful",
  "user": {
    "id": "64b8f0f4a7c1b2c3d4e5f6a1",
    "name": "Rohit Sinha",
    "phone": "9876543210",
    "email": "rohit@example.com"
  }
}
```

- **Error Responses**:
  - `400 Bad Request`: Missing or invalid email/password format.
  - `401 Unauthorized`: Invalid email or password.
  - `403 Forbidden`: Account is `BLOCKED`.

---

#### 3. Get Current User Profile
`GET /api/auth/me`

Resolves the logged-in user from the `sessionToken` cookie.

- **Authentication**: Required (`sessionToken` cookie)
- **Response `200 OK`**:
```json
{
  "user": {
    "id": "64b8f0f4a7c1b2c3d4e5f6a1",
    "name": "Rohit Sinha",
    "phone": "9876543210",
    "email": "rohit@example.com",
    "status": "ACTIVE"
  }
}
```

- **Error Responses**:
  - `401 Unauthorized`: Cookie missing, invalid session, or session expired.
  - `404 Not Found`: User does not exist.

---

### Payment Endpoints

Base Path: `/api/payments`

#### 1. Execute P2P Payment
`POST /api/payments`

Transfers money from the authenticated sender's wallet account to the target receiver account.

**Execution Flow**:
1. Resolves sender `User`, active `Account`, and `Wallet` using `req.userId`.
2. Validates receiver `Account` and `Wallet` exist and are `ACTIVE`.
3. Verifies that `senderAccount._id !== receiverAccount._id` (prevents self-transfers).
4. Asserts `senderWallet.availableBalance >= amount`.
5. Creates a `Transaction` record with status `INITIATED`.
6. Debits sender wallet balance and credits receiver wallet balance.
7. Inserts `DEBIT` and `CREDIT` records into `LedgerEntry`.
8. Updates transaction status to `SUCCESS`.

- **Authentication**: Required (`sessionToken` cookie)
- **Request Body**:
```json
{
  "receiverAccountId": "64b8f102a7c1b2c3d4e5f6b2",
  "amount": 50000
}
```
*Note: `amount` must be a positive integer in paise (e.g. `50000` = ₹500.00).*

- **Response `200 OK`**:
```json
{
  "message": "payment request validated",
  "transaction": {
    "id": "TXN-1725330000000-48291",
    "amount": 50000,
    "currency": "INR",
    "status": "SUCCESS"
  }
}
```

- **Error Responses**:
  - `400 Bad Request`: Validation failure (non-integer or non-positive amount, missing receiver).
  - `401 Unauthorized`: Authentication required.
  - `500 Internal Server Error`: Insufficient balance, invalid accounts, or processing error.

---

## Getting Started

### Prerequisites

- **Node.js**: `v18.x` or higher
- **npm**: `v9.x` or higher
- **MongoDB**: `v5.x` or higher with a **Replica Set** enabled (required for multi-document ACID transactions via `startSession()`). A free cloud instance on [MongoDB Atlas](https://www.mongodb.com/atlas) works out-of-the-box.

### Environment Variables

Create a `.env` file inside the `backend/` directory by copying `.env.example`:

```bash
cp .env.example .env
```

Configure the following parameters in `backend/.env`:

| Variable | Description | Example / Default |
| :--- | :--- | :--- |
| `PORT` | Port on which Express server listens | `5000` |
| `NODE_ENV` | Runtime environment (`development` or `production`) | `development` |
| `MONGO_URI` | MongoDB connection URI (must support replica sets / Atlas) | `mongodb+srv://<user>:<password>@cluster0.mongodb.net/payflow` |

### Installation & Local Run

1. Navigate to the `backend` directory:
   ```bash
   cd backend
   ```

2. Install all dependencies:
   ```bash
   npm install
   ```

3. Start in development mode (with hot-reload via `nodemon`):
   ```bash
   npm run dev
   ```

4. Start in production mode:
   ```bash
   npm start
   ```

Upon a successful startup, you will see:
```text
database connected successfully
PayFlow API is running on port 5000
```

---

## Validation Rules

Inputs are strictly validated using **Zod** before reaching any controller or service logic:

| Schema | Field | Validation Rules | Error Handling |
| :--- | :--- | :--- | :--- |
| `registerSchema` | `name` | String, trimmed, min 2 characters | `"Name must contain at least 2 characters"` |
| `registerSchema` | `phone` | String, 10-digit regex (`^\d{10}$`) | `"Phone must be a valid 10-digit number"` |
| `registerSchema` | `email` | Optional, trimmed, lowercase, valid email | `"Invalid email address"` |
| `registerSchema` | `password`| String, min 6 characters | `"Password must contain at least 6 characters"` |
| `loginSchema` | `email` | String, lowercase, valid email | `"Invalid email address"` |
| `loginSchema` | `password`| String, min 1 character | `"Password is required"` |
| `paymentSchema` | `receiverAccountId` | String, non-empty | `"reciever account ID is required"` |
| `paymentSchema` | `amount` | Number, integer, strictly positive (>0) | `"amount must be an integer"`, `"amount must be greater than 0"` |

---

## Security & Best Practices

1. **Password Security**: Passwords are never stored in plaintext. They are salted and hashed using `bcrypt` with a work factor (salt rounds) of 8.
2. **Session Hijacking Mitigation**:
   - Random 32-byte crypto tokens.
   - Database stores only SHA-256 hashes.
   - Delivered via `HttpOnly` cookies, preventing JavaScript access (mitigating XSS extraction).
3. **Database Indexing**:
   - `users.phone`: Unique index.
   - `users.email`: Sparse unique index.
   - `sessions.expiresAt`: Native TTL index for automatic expiry.
   - `idempotencykeys.{userId, key}`: Compound unique index.
   - `transactions.transactionId`: Unique indexed transaction reference.
4. **Data Integrity**:
   - Multi-document transactions prevent partial writes (e.g. creating a user without a wallet).
   - Invariant checks prevent self-transfers, negative balances, and unauthorized account debits.

