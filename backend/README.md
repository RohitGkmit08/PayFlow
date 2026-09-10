# PayFlow Backend Engine

The core transaction processing and financial ledger backend for **PayFlow**, a production-style fintech wallet system inspired by modern real-time payment systems (such as UPI).

Built with **Node.js**, **Express**, and **MongoDB (Mongoose)**, this backend implements fundamental fintech engineering patterns:
- **Ledger-based double-entry accounting** for both P2P transfers and external wallet funding
- **Strict separation of financial accounts, mutable wallets, and immutable ledger entries**
- **Strict integer arithmetic in Paise** (eliminating floating-point precision errors)
- **Multi-document ACID database transactions** via MongoDB session management
- **Financial limits & velocity controls** (per-transaction caps, daily funding limits, and maximum wallet balance ceilings)
- **Stateful, cryptographically secure session-based authentication** with SHA-256 hashes and HttpOnly cookies
- **Idempotency tracking and request deduplication models**
- **Strict runtime schema validation using Zod**

---

## Table of Contents

- [Architecture & Core Concepts](#architecture--core-concepts)
  - [The Financial Accounting Model](#the-financial-accounting-model)
  - [Double-Entry Accounting in PayFlow](#double-entry-accounting-in-payflow)
  - [Money Representation (Paise vs Rupees)](#money-representation-paise-vs-rupees)
  - [Financial Limits & Velocity Controls](#financial-limits--velocity-controls)
  - [Session Authentication Architecture](#session-authentication-architecture)
  - [Idempotency & Concurrency Safety](#idempotency--concurrency-safety)
- [Directory Structure](#directory-structure)
- [Database Models](#database-models)
- [API Reference](#api-reference)
  - [Health Check](#health-check)
  - [Authentication Endpoints (`/api/auth`)](#authentication-endpoints)
  - [Wallet Endpoints (`/api/wallet`)](#wallet-endpoints)
  - [Payment Endpoints (`/api/payments`)](#payment-endpoints)
- [Getting Started](#getting-started)
  - [Prerequisites](#prerequisites)
  - [Environment Variables](#environment-variables)
  - [Installation & Local Run](#installation--local-run)
- [Validation Rules](#validation-rules)
- [Security & Best Practices](#security--best-practices)

---

## Architecture & Core Concepts

### The Financial Accounting Model

PayFlow enforces a strict separation between **identity**, **financial accounting entities**, **fast mutable balance state**, and **immutable transaction audit logs**:

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

1. **User (`User`)**: Represents the human identity holding login credentials (`hashPswd`), phone number, and email.
2. **Account (`Account`)**: The accounting identity participating in transactions. A user owns an account of type `USER_WALLET`. System accounts (`BANK_SUSPENSE`, `PLATFORM_REVENUE`, `SETTLEMENT_POOL`) represent platform entities and external banking integrations.
3. **Wallet (`Wallet`)**: A fast, cached view of available funds for rapid user balance queries. **The wallet is a mutable projection, not the source of financial truth; the ledger is.** If wallet balances ever desynchronize, they can be reconstructed from ledger history.
4. **Transaction (`Transaction`)**: Represents a high-level business event (`P2P_TRANSFER`, `ADD_MONEY`) along with its lifecycle state (`INITIATED` -> `PROCESSING` -> `SUCCESS` / `FAILED` / `REVERSED`).
5. **Ledger Entry (`LedgerEntry`)**: The immutable proof of money movement following double-entry bookkeeping. Every financial event generates paired debit and credit entries that balance to zero.

---

### Double-Entry Accounting in PayFlow

Every transaction in PayFlow satisfies the fundamental accounting equation:

$$\sum \text{Debits} = \sum \text{Credits}$$

#### 1. Add Money / External Top-Up (`ADD_MONEY`)
When a user loads money into their wallet from an external bank:
- The system's **`BANK_SUSPENSE`** account is **DEBITED**.
- The user's **`USER_WALLET`** account is **CREDITED**.
- The user's `Wallet.availableBalance` increases by the added amount.

```text
[BANK_SUSPENSE Account] ──(DEBIT ₹500)──> [User USER_WALLET Account] ──(CREDIT ₹500)
                                                    │
                                                    ▼
                                       User Wallet Balance += ₹500
```

#### 2. Peer-to-Peer Transfer (`P2P_TRANSFER`)
When User A sends money to User B:
- User A's **`USER_WALLET`** account is **DEBITED**.
- User B's **`USER_WALLET`** account is **CREDITED**.
- User A's `Wallet.availableBalance` decreases, and User B's increases.
- Wrapped in an atomic MongoDB transaction session (`startTransaction()`).

```text
[Sender Account] ──(DEBIT ₹300)──> [Receiver Account] ──(CREDIT ₹300)
       │                                     │
       ▼                                     ▼
Sender Balance -= ₹300              Receiver Balance += ₹300
```

---

### Money Representation (Paise vs Rupees)

> [!IMPORTANT]
> **No floating-point numbers are used for monetary calculations or database storage.**
> Storing amounts as `10.50` in IEEE 754 floating-point numbers causes precision drift (e.g., `0.1 + 0.2 !== 0.3`).
> All balances, limits, and transaction amounts are stored strictly as **integers in Paise** (1 INR = 100 paise).
>
> - ₹1.00 = `100` paise
> - ₹500.00 = `50000` paise
> - ₹50,000.00 = `5000000` paise

---

### Financial Limits & Velocity Controls

To safeguard against fraud, unauthorized loading, and excessive risk exposure, the wallet funding workflow (`addMoney`) enforces strict tiered limits:

| Limit Type | Value in Rupees | Value in Paise | Error Triggered |
| :--- | :--- | :--- | :--- |
| **Max Per-Transaction Add Money** | ₹50,000 | `5,000,000` | `"Transaction amount limit exceeded"` |
| **Max Cumulative Daily Add Money** | ₹1,00,000 | `10,000,000` | `"Daily add-money limit exceeded"` |
| **Max Wallet Balance Cap** | ₹2,00,000 | `20,000,000` | `"Wallet balance limit exceeded"` |

- **Daily limit calculation**: Aggregates all successful `ADD_MONEY` transactions for the user's account between `00:00:00.000` and `23:59:59.999` of the current day.
- **Wallet balance cap**: Verifies that `userWallet.availableBalance + amount <= MAX_WALLET_BALANCE` prior to initiating the movement.

---

### Session Authentication Architecture

Rather than stateless JWTs (which cannot be revoked immediately without distributed blacklists and are often stored in accessible browser storage), PayFlow uses a **stateful, hashed session-cookie pattern**:

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

- **Token Generation**: Raw token is a 64-character hex string generated via `crypto.randomBytes(32)`.
- **Database Storage**: The database stores exclusively the **SHA-256 hash** (`sessionTokenHash`). Even in the event of a database leak, valid session cookies cannot be synthesized.
- **Cookie Security**: Delivered with `HttpOnly: true`, `SameSite: "lax"`, and `Secure: true` in production environments.
- **Automatic TTL Expiry**: Sessions expire after 7 days via a native MongoDB TTL index on `expiresAt`.

---

### Idempotency & Concurrency Safety

Payment APIs must guarantee that retried HTTP requests (e.g., due to client timeouts or network disconnects) never result in duplicate financial execution:
- The `IdempotencyKey` model binds `{ userId, key }` with a deterministic request fingerprint and cached response.
- MongoDB multi-document transactions (`mongoose.startSession()`) wrap all multi-document operations (such as registration and P2P transfers) to guarantee atomicity (ACID).

---

## Directory Structure

```text
backend/
├── src/
│   ├── config/
│   │   └── db.js                 # Mongoose connection setup
│   ├── controllers/
│   │   ├── auth.controller.js    # Register, login, and profile (getMe) handlers
│   │   ├── payment.controller.js # P2P payment HTTP handler
│   │   └── wallet.controller.js  # Add money / wallet top-up HTTP handler
│   ├── middleware/
│   │   └── auth.middleware.js    # Session cookie extractor, SHA-256 hasher & authenticator
│   ├── models/
│   │   ├── Accounts.js           # Financial accounts (USER_WALLET, BANK_SUSPENSE, etc.)
│   │   ├── Idempotency.js        # Request deduplication and replay protection store
│   │   ├── LedgerEntry.js        # Immutable double-entry financial records (DEBIT/CREDIT)
│   │   ├── Session.js            # Stateful sessions with SHA-256 hash & TTL auto-expiry
│   │   ├── Transaction.js        # High-level business transaction records
│   │   ├── User.js               # User identity, phone, email, and bcrypt credentials
│   │   └── Wallet.js             # Fast-access available balance model (Paise)
│   ├── routes/
│   │   ├── auth.routes.js        # Auth route definitions (/api/auth)
│   │   ├── payment.routes.js     # Payment route definitions (/api/payments)
│   │   └── wallet.routes.js      # Wallet route definitions (/api/wallet)
│   ├── services/
│   │   ├── payment.service.js    # Atomic P2P transfer workflow with MongoDB transactions
│   │   └── wallet.service.js     # Wallet top-up (add-money) workflow with velocity limits
│   ├── utils/                    # Shared helper functions
│   ├── validator/
│   │   ├── addMoney.validator.js # Zod schema for wallet funding payloads
│   │   ├── auth.validator.js     # Zod schemas for registration & login
│   │   └── payment.validator.js  # Zod schema for P2P payment requests
│   ├── app.js                    # Express app initialization, middleware, and route mounting
│   └── server.js                 # Server entry point & database initialization
├── .env                          # Local environment variables (gitignored)
├── .env.example                  # Environment variable blueprint
├── package.json                  # Dependencies and run scripts
└── README.md                     # Backend documentation
```

---

## Database Models

| Model | Collection | Purpose | Key Attributes |
| :--- | :--- | :--- | :--- |
| **`User`** | `users` | User identity & authentication credentials | `name`, `phone` (unique), `email` (sparse, unique), `hashPswd`, `status` (`ACTIVE`, `BLOCKED`) |
| **`Account`** | `accounts` | Financial accounting identity | `userId` (ref `User`, null for system accounts), `accountType` (`USER_WALLET`, `BANK_SUSPENSE`, `PLATFORM_REVENUE`, `SETTLEMENT_POOL`), `currency` (`INR`), `status` (`ACTIVE`, `BLOCKED`, `CLOSED`) |
| **`Wallet`** | `wallets` | Fast mutable balance snapshot | `userId` (unique), `accountId` (ref `Account`, unique), `availableBalance` (integer paise, $\ge 0$) |
| **`Transaction`** | `transactions` | Business event record | `transactionId` (unique `TXN-...`), `type` (`P2P_TRANSFER`, `ADD_MONEY`), `senderAccountId` (ref `Account`), `receiverAccountId` (ref `Account`), `amount` (paise), `status` (`INITIATED`, `PROCESSING`, `SUCCESS`, `FAILED`, `REVERSED`), `failureReason` |
| **`LedgerEntry`** | `ledgerentries` | Double-entry financial audit record | `transactionId` (ref `Transaction`), `accountId` (ref `Account`), `entryType` (`DEBIT`, `CREDIT`), `amount` (paise), `currency` (`INR`) |
| **`Session`** | `sessions` | Active authenticated device sessions | `userId` (ref `User`), `sessionTokenHash` (unique), `expiresAt` (TTL index), `revokedAt` |
| **`IdempotencyKey`** | `idempotencykeys`| Request deduplication store | `userId`, `key`, `requestFingerprint`, `status` (`IN_PROGRESS`, `COMPLETED`), `transactionId`, `response`, `expiresAt` (TTL index) |

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

Atomically creates a new `User`, provisions a corresponding `Account` (`accountType: "USER_WALLET"`), and initializes a `Wallet` with `0` balance within an ACID MongoDB transaction session.

- **Request Body**:
```json
{
  "name": "Rohit Sinha",
  "phone": "9876543210",
  "email": "rohit@example.com",
  "password": "SecurePassword123"
}
```
*Notes: `phone` must be a 10-digit number. `email` is optional. `password` minimum length is 6.*

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
  - `400 Bad Request`: Input validation failed (invalid phone format, short password, etc.).
  - `409 Conflict`: Phone number or email is already registered.
  - `500 Internal Server Error`: Transaction aborted or internal server error.

---

#### 2. Login User
`POST /api/auth/login`

Verifies credentials via `bcrypt`, validates that the account is not `BLOCKED`, creates a persistent session with a SHA-256 hashed token, and sends an `HttpOnly` cookie back to the client.

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
  - `400 Bad Request`: Missing or malformed email/password.
  - `401 Unauthorized`: Invalid email or password.
  - `403 Forbidden`: Account status is `BLOCKED`.
  - `500 Internal Server Error`: Server error during authentication.

---

#### 3. Get Current User Profile
`GET /api/auth/me`

Resolves the authenticated user from the active `sessionToken` cookie.

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
  - `401 Unauthorized`: Cookie missing, invalid session hash, or expired session.
  - `404 Not Found`: User document not found.
  - `500 Internal Server Error`: Server error.

---

### Wallet Endpoints

Base Path: `/api/wallet`

#### 1. Add Money to Wallet
`POST /api/wallet/add-money`

Loads funds into the authenticated user's wallet from the platform's external banking suspense account (`BANK_SUSPENSE`).

**Execution & Accounting Lifecycle**:
1. **Resolve Identity & Entities**: Identifies user from `req.userId`, finds active `USER_WALLET` account, and locates user's `Wallet`.
2. **Resolve Bank Suspense Account**: Finds (or lazily creates) the platform's active `BANK_SUSPENSE` account.
3. **Validate Velocity & Balance Limits**:
   - Asserts `amount <= 5,000,000` paise (₹50,000 per transaction limit).
   - Asserts `userWallet.availableBalance + amount <= 20,000,000` paise (₹2,00,000 balance ceiling).
   - Queries all successful `ADD_MONEY` transactions for the account today; asserts `todayTotal + amount <= 10,000,000` paise (₹1,00,000 daily limit).
4. **Create Transaction**: Inserts a `Transaction` with `type: "ADD_MONEY"`, `senderAccountId: bankSuspenseAccount._id`, and status `"INITIATED"`.
5. **Update Wallet Balance**: Increments `userWallet.availableBalance` by `amount`.
6. **Record Ledger Entries**:
   - `DEBIT` against `bankSuspenseAccount._id` for `amount`.
   - `CREDIT` against user's `userAccount._id` for `amount`.
7. **Complete Transaction**: Updates transaction status to `"SUCCESS"`.

- **Authentication**: Required (`sessionToken` cookie)
- **Request Body**:
```json
{
  "amount": 500000
}
```
*Note: `amount` must be a positive integer in paise (e.g., `500000` = ₹5,000.00).*

- **Response `201 Created`**:
```json
{
  "message": "Money added successfully",
  "transaction": {
    "id": "TXN-1725807600000-84729",
    "type": "ADD_MONEY",
    "amount": 500000,
    "currency": "INR",
    "status": "SUCCESS"
  }
}
```

- **Error Responses**:
  - `400 Bad Request`: Validation failure (e.g., non-integer, zero, or negative amount).
    ```json
    {
      "message": "Invalid add-money data",
      "errors": [...]
    }
    ```
  - `401 Unauthorized`: Authentication required or invalid session.
  - `500 Internal Server Error`: Limit exceeded or processing error:
    - `"Transaction amount limit exceeded"`
    - `"Wallet balance limit exceeded"`
    - `"Daily add-money limit exceeded"`
    - `"User account not found"` / `"User wallet not found"`

---

### Payment Endpoints

Base Path: `/api/payments`

#### 1. Execute Peer-to-Peer (P2P) Transfer
`POST /api/payments`

Executes an atomic transfer from the authenticated user's wallet to another user's wallet account using a multi-document MongoDB transaction session.

**Execution Flow**:
1. **Start Transaction**: Opens a MongoDB session with `session.startTransaction()`.
2. **Resolve Parties**:
   - Sender: Resolves `User`, active `USER_WALLET` account, and `Wallet` using `req.userId`.
   - Receiver: Resolves active `USER_WALLET` account and `Wallet` using `receiverAccountId`.
3. **Invariance Checks**:
   - Verifies `senderAccount._id !== receiverAccount._id` (prevents self-transfers).
   - Verifies `senderWallet.availableBalance >= amount` (prevents overdrafts).
4. **Create Transaction**: Inserts `Transaction` with `type: "P2P_TRANSFER"` and status `"INITIATED"`.
5. **Atomic Balance Updates**:
   - Debits sender's `Wallet`: `availableBalance -= amount`.
   - Credits receiver's `Wallet`: `availableBalance += amount`.
6. **Double-Entry Ledger Audit**:
   - Creates `DEBIT` entry for `senderAccount._id`.
   - Creates `CREDIT` entry for `receiverAccount._id`.
7. **Commit**: Updates transaction status to `"SUCCESS"` and commits the MongoDB transaction.

- **Authentication**: Required (`sessionToken` cookie)
- **Request Body**:
```json
{
  "receiverAccountId": "64b8f102a7c1b2c3d4e5f6b2",
  "amount": 50000
}
```
*Note: `amount` must be a positive integer in paise (e.g., `50000` = ₹500.00).*

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
  - `400 Bad Request`: Validation failure (empty receiver ID, non-integer or negative amount).
  - `401 Unauthorized`: Authentication required.
  - `500 Internal Server Error`: Insufficient balance, self-transfer attempt, missing accounts, or transaction abort.

---

## Getting Started

### Prerequisites

- **Node.js**: `v18.x` or higher
- **npm**: `v9.x` or higher
- **MongoDB**: `v5.x` or higher with a **Replica Set** enabled (required for multi-document ACID transactions via `startSession()`). A free cloud cluster on [MongoDB Atlas](https://www.mongodb.com/atlas) works out-of-the-box.

### Environment Variables

Create a `.env` file inside the `backend/` directory by copying `.env.example`:

```bash
cp .env.example .env
```

Configure the following parameters in `backend/.env`:

| Variable | Description | Example / Default |
| :--- | :--- | :--- |
| `PORT` | Port on which the Express server listens | `5000` |
| `NODE_ENV` | Runtime environment (`development` or `production`) | `development` |
| `MONGO_URI` | MongoDB connection URI (must support replica sets / Atlas) | `mongodb+srv://<user>:<password>@cluster0.mongodb.net/payflow` |

### Installation & Local Run

1. Navigate to the `backend` directory:
   ```bash
   cd backend
   ```

2. Install dependencies:
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

Upon a successful startup, the console will log:
```text
database connected successfully
PayFlow API is running on port 5000
```

---

## Validation Rules

Payloads are strictly validated using **Zod** schemas before reaching controllers or services:

| Schema | File | Field | Validation Rules | Error Message |
| :--- | :--- | :--- | :--- | :--- |
| `registerSchema` | `validator/auth.validator.js` | `name` | String, trimmed, min 2 characters | `"Name must contain at least 2 characters"` |
| `registerSchema` | `validator/auth.validator.js` | `phone` | String, 10-digit regex (`^\d{10}$`) | `"Phone must be a valid 10-digit number"` |
| `registerSchema` | `validator/auth.validator.js` | `email` | Optional, trimmed, lowercase, valid email | `"Invalid email address"` |
| `registerSchema` | `validator/auth.validator.js` | `password` | String, min 6 characters | `"Password must contain at least 6 characters"` |
| `loginSchema` | `validator/auth.validator.js` | `email` | String, trimmed, lowercase, valid email | `"Invalid email address"` |
| `loginSchema` | `validator/auth.validator.js` | `password` | String, min 1 character | `"Password is required"` |
| `addMoneySchema` | `validator/addMoney.validator.js` | `amount` | Number, integer, strictly positive ($> 0$) | `"Number must be positive"`, `"amount must be greater than 0"` |
| `paymentSchema` | `validator/payment.validator.js` | `receiverAccountId` | String, non-empty | `"reciever account ID is required"` |
| `paymentSchema` | `validator/payment.validator.js` | `amount` | Number, integer, strictly positive ($> 0$) | `"amount must be an integer"`, `"amount must be greater than 0"` |

---

## Security & Best Practices

1. **Monetary Integrity & Ledger Invariance**:
   - Double-entry bookkeeping guarantees that money is never created or destroyed arbitrarily.
   - External top-ups are sourced from the dedicated `BANK_SUSPENSE` system account.
   - Balances are stored strictly as integers in paise, preventing floating-point inaccuracies.
2. **Password Security**:
   - User passwords are encrypted using `bcrypt` with a salt cost factor of 8. Passwords are never stored or logged in plain text.
3. **Session Hardening**:
   - Session tokens are generated using 32 cryptographically secure random bytes (`crypto.randomBytes(32)`).
   - Only the SHA-256 hash is persisted in MongoDB. Stolen database dumps cannot be leveraged to forge valid session cookies.
   - Cookies are protected with `HttpOnly: true` (blocking client-side JavaScript access) and `SameSite: "lax"`.
4. **Velocity & Fraud Mitigation**:
   - Hard limits on individual top-ups (₹50,000) and cumulative daily top-ups (₹1,00,000).
   - Balance cap (₹2,00,000) prevents runaway wallet exposure.
   - Self-transfer guards prevent loops and balance inflation.
5. **Database Indexing & TTL**:
   - `users.phone`: Unique index.
   - `users.email`: Sparse unique index.
   - `sessions.sessionTokenHash`: Unique index.
   - `sessions.expiresAt`: Native MongoDB TTL index for automatic expiration cleanup without cron jobs.
   - `idempotencykeys.{userId, key}`: Compound unique index.
   - `idempotencykeys.expiresAt`: Native MongoDB TTL index.
   - `transactions.transactionId`: Unique indexed transaction reference.
   - `ledgerentries.transactionId` & `ledgerentries.accountId`: Indexed for fast audit reconciliation.
