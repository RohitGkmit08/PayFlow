# PayFlow Fintech Engine

A production-style UPI-inspired wallet system built with the MERN stack. PayFlow focuses on robust system design, ledger-based accounting, atomic transactions, idempotency, secure session management, and AI-powered financial insights.

> **Note:** This project is designed as a learning-focused fintech backend and is not connected to real banking or payment networks.

---

## Tech Stack

- **Frontend:** React (Vite), Vanilla CSS, React Query, Axios
- **Backend:** Node.js, Express.js, MongoDB (Mongoose), Zod, JWT
- **AI Layer:** Google Gemini API

---

## Core Concepts & Glossary

Here is a glossary of the key financial and technical terms used in the PayFlow engine:

| Term | Definition |
| :--- | :--- |
| **User** | A person using the PayFlow application. |
| **Account** | The financial identity associated with a user. |
| **Wallet** | A container showing available money for the user to spend. It is a cached view of money, not the absolute source of truth. |
| **Available Balance** | The amount of money that can be spent immediately (`Total Balance - Blocked Balance`). |
| **Blocked Balance** | Balance reserved or held for pending transactions (not spendable). |
| **Total Balance** | The sum of Available Balance and Blocked Balance (`Available + Blocked`). |
| **Ledger** | An immutable book of financial entries. Instead of editing history, every change is appended as a new record. |
| **Ledger Entry** | A single financial movement of type `CREDIT` or `DEBIT`. |
| **Double-Entry Accounting** | A system where every transaction must affect at least two accounts (a debit for one, a credit for the other) such that total debits equal total credits. |
| **Transaction** | A business operation representing a physical movement of money between entities. |
| **Transaction Ref ID** | A unique identifier for tracking and deduplicating a transaction. |
| **Payment Intent** | An object used to track the payment process from start to finish. Essential for idempotency, retry handling, and payment confirmation flows. |
| **Transaction State** | The current lifecycle state of a transaction (e.g., `INITIATED`, `PROCESSING`, `SUCCESS`, `FAILED`, `EXPIRED`, `REVERSED`). |
| **Authorization** | The permission required to execute a transaction (e.g., MPIN, device verification, biometric approval). |
| **Settlement** | The final exchange of money between financial entities (instant for wallets; bank-to-bank settlement is processed later via clearinghouses like NPCI/RBI). |
| **Reversal** | Undoing a completed transaction by creating a new, opposing transaction (never by deleting the old transaction). |
| **Atomicity** | The "all-or-nothing" property ensuring either all operations in a transaction succeed, or none do. |
| **Idempotency** | The property where performing an action multiple times yields the exact same result as doing it once. Managed via an `Idempotency-Key` header. |
| **Concurrency** | The occurrence of multiple operations or transaction requests happening at the exact same time. |
| **VPA / UPI-ID** | Virtual Payment Address (e.g., `rohit@payflow`) mapping to an underlying account or wallet. |
| **PSP (Payment Service Provider)** | The app providing the payment interface (e.g., PayFlow, PhonePe, GooglePay). |
| **Beneficiary** | The recipient receiving the money in a transaction. |
| **Aggregation Pipeline** | A sequence of database operations used to process and transform financial data into analytics or insights. |
| **Running Balance** | The calculated balance of an account after each individual ledger entry, useful for passbook-style audit trails. |
| **Session** | An object representing an active logged-in device session, facilitating authentication, multi-device tracking, and remote logout capabilities. |

---

## Wallet vs. Ledger Architecture

In fintech applications, maintaining speed and auditability requires separating user dashboards from the source of truth:

*   **Wallet (Cached View):** Mutable, optimized for extremely fast reads. Used to load dashboard balances quickly.
*   **Ledger (Source of Truth):** Immutable, append-only, highly reliable audit trail. Balance can always be recalculated/rebuilt from the ledger history.

### Data Schemas

#### Wallet Schema Example
```json
{
  "_id": "W1",
  "userId": "rohit",
  "availableBalance": 8500,
  "blockedBalance": 0,
  "updatedAt": "2026-08-14T10:00:00Z"
}
```

#### Ledger Entry Schema Example
```json
{
  "_id": "L3",
  "walletId": "W1",
  "transactionId": "TXN123",
  "entryType": "DEBIT",
  "amount": 500,
  "balanceAfter": 8500,
  "createdAt": "2026-08-14T10:00:00Z"
}
```

---

## Transaction Lifecycle & Mental Model

### The Flow
```
Transaction Request
        │
        ▼
Creates Ledger Entries (Debit & Credit)
        │
        ▼
Determines Balance Changes
        │
        ▼
Updates Wallet Cached Snapshot
```

### Transfer Walkthrough
Suppose **Rohit** (Wallet `W1`, Balance: ₹10,000) sends **₹500** to **Alice** (Wallet `W2`, Balance: ₹2,000).

1.  **Create Transaction Record:**
    ```json
    {
      "_id": "TXN123",
      "fromWallet": "W1",
      "toWallet": "W2",
      "amount": 500,
      "status": "PROCESSING"
    }
    ```
2.  **Generate Double-Entry Ledger Records:**
    *   **Rohit's Debit Entry:**
        ```json
        { "walletId": "W1", "transactionId": "TXN123", "entryType": "DEBIT", "amount": 500 }
        ```
    *   **Alice's Credit Entry:**
        ```json
        { "walletId": "W2", "transactionId": "TXN123", "entryType": "CREDIT", "amount": 500 }
        ```
3.  **Update Wallet Snapshots:**
    *   `W1` (Rohit) available balance: `10,000 - 500 = 9,500`
    *   `W2` (Alice) available balance: `2,000 + 500 = 2,500`

---

## Transaction Fees & Financial Verification

When a transaction fee is applied (e.g., Rohit pays Alice ₹500, and PayFlow charges Rohit a ₹10 fee):
- **Rohit's Wallet:** Debited ₹510 (total outgo).
- **Alice's Wallet:** Credited ₹500 (payment received).
- **PayFlow Revenue Wallet:** Credited ₹10 (platform fee).

### Ledger Entries
*   **Rohit (Sender):** `DEBIT ₹510`
*   **Alice (Receiver):** `CREDIT ₹500`
*   **PayFlow Revenue:** `CREDIT ₹10`

### Ledger Validation Rule
To guarantee system-wide financial integrity, every operation must satisfy:
$$\text{Total DEBIT} = \text{Total CREDIT}$$
$$\text{e.g., } 510 \text{ (DEBIT)} = 500 \text{ (CREDIT)} + 10 \text{ (CREDIT)}$$

This assertion check (`totalDebit === totalCredit`) must run and succeed before committing any financial transaction.

---

## Supported Payment Types & Categories

PayFlow supports multiple transaction flows, each mapping to a specific real-world business need. While all payment types share the core backend engine (handling authentication, idempotency, state management, ledger entry creation, settlement, and audits), individual transaction flows implement their own distinct business rules.

### Payment Engine Architecture
```
                                 PAYMENT ENGINE
                                       │
                         ┌─────────────┼─────────────┐
                         │             │             │
                        P2P           P2M         COLLECT
                         │             │             │
                         ├─────────────┼─────────────┤
                                       │
                                    REFUND
                                       │
                                    REVERSAL
                                       │
                                   ADD MONEY
                                       │
                                   WITHDRAWAL
```

### 1. Payment Categories
We classify these payment types based on how they route money through the PayFlow ecosystem:

*   **Internal Participant Transfers (Wallet-to-Wallet):**
    *   **P2P (Person-to-Person):** Standard transfer between two PayFlow users (e.g., Rohit transfers ₹700 to Alice). The flow sequences through:
        $$\text{Authenticate} \rightarrow \text{Check Limits/Risk} \rightarrow \text{Validate Balance} \rightarrow \text{Reserve Hold} \rightarrow \text{Capture} \rightarrow \text{Double-Entry Ledger} \rightarrow \text{Settlement}$$
    *   **P2M (Person-to-Merchant):** Initiated when a user purchases from a merchant. This flow maps the destination to a `merchantId` instead of a user ID and supports platform fee rules, customized settlement terms, and merchant account routing.
*   **Inbound Funding:**
    *   **Add Money:** Funds enter the PayFlow system from an external funding source (e.g., bank account, credit card) and credit the user's wallet.
*   **Outbound Liquidation:**
    *   **Withdrawal:** Funds leave the PayFlow system, debiting the user's wallet and transferring it to their verified external bank account.
*   **Return Flows:**
    *   **Refund:** A completed transaction is returned to the sender. Can be full or partial (e.g., returning ₹700 out of a ₹1,000 transaction).
    *   **Reversal:** Corrects a transaction that failed or timed out during execution. Unlike refunds, reversals are systemic corrections ensuring that funds are not stranded in an invalid state.
*   **Requested Obligations:**
    *   **Collect / Payment Request:** A request from a receiver to a sender to authorize a payment. The sender can choose to **Accept** (triggering a P2P/P2M flow) or **Decline** the request.

### 2. Common Foundation for All Payment Flows
Every transaction, regardless of type, is processed through a shared, standardized pipeline:

```
          COMMON FOUNDATION
           Authentication
                 │
                 ▼
             Validation
                 │
                 ▼
            Idempotency
                 │
                 ▼
            Limits / Risk
                 │
                 ▼
         Balance Reservation
                 │
                 ▼
             Transaction
                 │
                 ▼
               Ledger
                 │
                 ▼
             Settlement
                 │
                 ▼
           Reconciliation
                 │
                 ▼
               Audit
```

---

## Session Management

To protect user accounts and securely manage active connections, PayFlow implements secure session tracking per device.

### Session Document Schema
Each session is stored as a document containing the logged-in device's identifiers:
```json
{
  "userId": "rohit",
  "deviceId": "device_mac_9921",
  "refreshTokenHash": "a9f39d1b... (SHA-256 hash of refresh token)",
  "expiresAt": "2026-08-27T10:00:00Z"
}
```

### Core Security Features
- **Multi-Device Support:** A user can be logged in on multiple devices concurrently, each tracked by a unique `deviceId`.
- **Single-Device Logout:** Revokes authentication for a specific device by removing its matching session object.
- **All-Device Logout:** Forces re-authentication on all devices by deleting all session documents matching the user's `userId`.
- **Token Rotation & Hashing:** Session checks enforce verification against hashed refresh tokens, protecting against replay and hijack attacks.

---

## Fintech Authentication & Security

To ensure high-grade security, data integrity, and compliance, PayFlow enforces a rigorous authentication and authorization model across both browser sessions and financial API endpoints.

### 1. Multi-Stage Authentication Lifecycle
* **Initial Login:** The user provides their `Email` and `Password`. The backend validates the credentials against the hashed password stored in the database. Upon success, a secure session is created.
  $$\text{User Login} \rightarrow \text{Credentials Validated} \rightarrow \text{Session Created}$$
* **Session vs. JWT:** Instead of standard client-side JWTs, PayFlow employs an HttpOnly cookie-based session verification pattern:
  ```
  Browser
     │
     │ HttpOnly Session Cookie (Session ID)
     ▼
  Access Token / Refresh Token
     │
     ▼
  PayFlow Server
     │
     ▼
  Session Lookup (Database validation)
  ```
* **Cookie Protection:** Set as `HttpOnly`, preventing client-side JavaScript from accessing session identifiers directly. To guarantee production-grade security, this should be paired with `Secure` flags (HTTPS only), appropriate `SameSite` policies, and CSRF protection.

### 2. Token Lifecycle & Rotation
* **Access Tokens:** Short-lived credentials (e.g., 15 minutes) used to access protected financial routes (e.g., `GET /wallet`, `POST /payments`, `GET /transactions`).
* **Refresh Tokens:** Long-lived credentials stored securely and used solely to acquire new access tokens:
  $$\text{Refresh Token} \rightarrow \text{Session Validation} \rightarrow \text{New Access Token}$$
* **Refresh Token Rotation:** Every time a refresh token is used, it is rotated. A new refresh token is issued, and the previous one is revoked. If a revoked token is reused, the engine flags it as a potential token theft and automatically invalidates the entire session.
  ```
  Token A (Used) ──► Token B Issued (Token A becomes invalid)
  ```

### 3. MPIN (Mobile Personal Identification Number)
For payment authorization, PayFlow implements a secondary security challenge similar to real-world UPI systems:
* **MPIN Verification:** A 4- or 6-digit PIN used exclusively to authorize money movements, distinct from the account password.
* **Storage:** Hashed using secure hashing algorithms; never stored in plaintext.
* **Rate Limiting:** Failed attempts are tracked and rate-limited. Too many consecutive failures trigger a temporary account lock to prevent brute-force attacks.
  $$\text{Account Authentication (Password)} \rightarrow \text{Payment Authorization (MPIN)}$$

### 4. Transaction Authorization Flow
Before any money is reserved or transferred, the request goes through multiple validation layers:
```
                    Payment Request
                           │
                           ▼
                    Authentication (Session Check)
                           │
                           ▼
                    Authorization (Permission Check)
                           │
                           ▼
                    MPIN Verification
                           │
                           ▼
                    Limits & Risk Engine
                           │
                           ▼
                    Balance & Hold Reservation
                           │
                           ▼
                    Payment Execution
```

### 5. Financial API Security Principles
* **Independent Browser Contexts:** Each browser tab or profile maintains its own session, cookies, and authentication state (e.g., Browser A runs User 1, Incognito runs User 2).
* **Never Trust the Frontend:** The backend must never rely on user identity parameters sent in the request body (e.g., `{ "sender": "rohit", "amount": 500 }`). Instead, the identity must be resolved server-side from the authenticated session.
* **Security vs. Audit:** Security controls prevent unauthorized actions, while the audit system records all attempts (both successful and blocked) for future compliance and forensics.
  ```
  Initiate Request ──► Authentication/MPIN/Limits ──► [Success] ──► Execute Payment
                               │
                               └──► [Fail] ──► Reject & Log Audit Event
  ```

---

## Transaction Engine & Execution Lifecycle

The PayFlow transaction pipeline executes sequentially to protect user funds, validate logic, and prevent consistency errors.

```
[Payment Request] ──► 1. [Limits & Risk checks] ──► 2. [Idempotency Verification] ──► 3. [Balance Hold (Reservation)] ──► 4. [Atomic Execution (with concurrency control)]
```

### 1. Limits & Risk Engine

Before a transaction enters the ledger or places a balance hold, the engine evaluates whether the payment should be allowed based on business rules and security policies.

```
                    Payment Request
                          │
             ┌────────────┼────────────┐
             ▼            ▼            ▼
        Can afford?   Within limits?  Safe?
             │            │            │
          Balance       Limits        Risk
```

*   **Balance Check:** Verifies if the sender has sufficient `Available Balance` (i.e., `Total Balance - Reserved Holds >= Transaction Amount`).
*   **Limits Engine:** Applies explicit business checks:
    *   *Per-Transaction Limits:* Maximum limit of ₹20,000 per payment.
    *   *Daily Accumulative Limits:* Maximum daily limit of ₹50,000. If a user has already sent ₹45,000, attempting a new ₹10,000 transfer is rejected with `LIMIT_EXCEEDED` (since $45,000 + 10,000 = \text{₹55,000}$).
    *   *Velocity/Frequency Limits:* E.g., a maximum of 5 payments allowed in a rolling 10-minute window to prevent spam or automated abuse.
*   **Risk Engine:** Evaluates transaction risk profiles and outputs a policy decision:
    *   `ALLOW`: Proceed with the transaction.
    *   `VERIFY`: Trigger step-up authentication (e.g., MPIN verification or biometric approval).
    *   `REVIEW`: Route to admin review queue.
    *   `REJECT`: Block the transaction.

### 2. Idempotency Engine

Idempotency ensures that performing the same transaction request multiple times yields the exact same result as doing it once. This protects against double-spend events caused by user double-clicks, network retries, or server crashes.

> [!IMPORTANT]
> **Idempotency vs. Concurrency:** Idempotency does *not* mean "Don't allow two payments at the same time." It means "Don't process the exact same payment request more than once."

#### Deduplication Lifecycle
When a request with an `Idempotency-Key` (e.g., `Idempotency-Key: key_txn_98765`) is received:

```
First Time Key is Seen:
  Key doesn't exist
         ↓
  Process payment
         ↓
  Payment succeeds
         ↓
  Store key + Response payload
```

*   **Subsequent Submissions:** If the server sees the same key again, it skips the execution logic entirely and immediately returns the stored response payload, preventing double-debits.

### 3. Balance Reservations (Holds)

When a user initiates a transaction (e.g., Rohit has a ₹1,000 balance and starts a ₹700 transfer), the external payment system may take up to 30 seconds to respond. During this delay, to prevent double-spending or overdrafts, the engine places a temporary hold on the transaction amount.

```
RESERVED
   │
   ├── SUCCESS ──► CAPTURE ──► money moves
   │
   ├── FAILED  ──► RELEASE ──► money becomes available
   │
   └── EXPIRED ──► RELEASE (unless external system actually committed the transaction)
```

#### Double-Spending Prevention Example
If a wallet has a total balance of ₹2,000 and the user initiates three parallel transfers:
*   `PAY-A` = ₹500
*   `PAY-B` = ₹700
*   `PAY-C` = ₹300

The system records:
$$\text{Total Reserved} = 500 + 700 + 300 = \text{₹1,500}$$
$$\text{Available Balance} = \text{Total Balance} - \text{Reserved Amount}$$
$$\text{Available Balance} = 2,000 - 1,500 = \text{₹500}$$

The user can only initiate another concurrent payment of up to ₹500.

#### Timeout Handling (EXPIRED States)
*   **Merely Reserved:** If a payment expires without being committed or debited externally, the reservation is released (`RELEASE`).
*   **Already Debited:** If money was debited but the transaction timed out locally, the system must hold the reservation, investigate the external simulator's state, and trigger a `REVERSED` state to refund/correct the balance.

### 4. Atomicity & Failure Recovery

All balance updates and ledger entries for a single payment must be handled as one **Atomic Unit**. If any individual step fails (e.g., receiver's account is suspended, or system goes offline mid-operation), the entire set of changes must roll back automatically, leaving the balances untouched.

```
                  PAYMENT
                     │
           ┌─────────┴─────────┐
           │                   │
        Sender              Receiver
        - ₹500               + ₹500
           │                   │
           └─────────┬─────────┘
                     │
               ONE ATOMIC UNIT
```

We implement this in Node.js/Mongoose using MongoDB Sessions:

```javascript
const mongoose = require('mongoose');

const session = await mongoose.startSession();
try {
  await session.withTransaction(async () => {
    // 1. Debit sender's wallet snapshot (with balance check)
    // 2. Credit receiver's wallet snapshot
    // 3. Create debit/credit ledger entries
    // 4. Update the main Transaction/Payment Intent status to 'SUCCESS'
  });
} catch (error) {
  // Transaction is automatically rolled back if any error is thrown
  console.error("Transaction aborted:", error);
} finally {
  await session.endSession();
}
```

### 5. Concurrency, Race Conditions & Mitigation

#### The Double-Spend / Overdraft Problem
When multiple transactions execute at the exact same time, a race condition can occur if they read the same initial state before writing their updates:

```
Time   Request A (Send ₹80)               Request B (Send ₹50)
 │     (User Wallet Balance: ₹100)        (User Wallet Balance: ₹100)
 │
 ├────► Reads Balance (₹100)
 │                                        Reads Balance (₹100) ◄────┤
 ├────► Validates: ₹100 >= ₹80 (OK)
 │                                        Validates: ₹100 >= ₹50 (OK) ◄┤
 ├────► Calculates: 100 - 80 = ₹20
 │                                        Calculates: 100 - 50 = ₹50 ◄─┤
 ├────► Writes Balance: ₹20
 │                                        Writes Balance: ₹50 ◄─────┤ (Overwrites A's write!)
 ▼
```
In this scenario, the user successfully sent ₹130, but their wallet balance ends up at ₹50 (or ₹20 if Request A wrote last). The system has allowed an overdraft and lost money.

#### Mitigations

##### A. Atomic Database Updates (Failsafe Condition)
Instead of reading the balance into application memory, verifying it, and saving it, run atomic update operations directly in the database using conditional queries.
*   **Vulnerable (Anti-pattern):**
    ```javascript
    const wallet = await Wallet.findById(id);
    if (wallet.availableBalance >= amount) {
      wallet.availableBalance -= amount;
      await wallet.save();
    }
    ```
*   **Secure (Atomic):**
    ```javascript
    const res = await Wallet.updateOne(
      { _id: id, availableBalance: { $gte: amount } },
      { $inc: { availableBalance: -amount } },
      { session }
    );
    if (res.modifiedCount === 0) {
      throw new Error("Insufficient funds or wallet inactive");
    }
    ```
    This ensures that the balance check (`$gte: amount`) and decrement (`$inc`) happen in a single, thread-safe database action.

##### B. Optimistic Concurrency Control (OCC)
For complex updates that cannot be easily done with a simple `$inc`, use version keys. Each document contains a version field (`version` or `__v`). When writing back, the database verifies that the version has not changed since it was read.
```javascript
const wallet = await Wallet.findOne({ userId });
const currentVersion = wallet.version;

// Perform complex operations...
const updatedBalance = wallet.availableBalance - amount;

const res = await Wallet.updateOne(
  { _id: wallet._id, version: currentVersion },
  { availableBalance: updatedBalance, $inc: { version: 1 } },
  { session }
);

if (res.modifiedCount === 0) {
  throw new Error("Concurrency conflict: document modified by another process. Please retry.");
}
```

##### C. Distributed/Pessimistic Locking
In distributed systems or high-concurrency environments, transactions on the same wallet resource can be serialized using locking mechanisms.
*   **Redis Locks (Redlock):** A lock is acquired on the resource key `lock:wallet:<walletId>` before processing the transaction. Any parallel request trying to acquire the same lock will block or fail fast, preventing database-level contention entirely.

### 6. Payment Lifecycle & State Machine

Payments in PayFlow transition through a series of states to handle delays, retries, and failures gracefully:

```
 [INITIATED] ──► [PROCESSING] ──┬──► [SUCCESS]
                                 ├──► [FAILED]
                                 └──► [EXPIRED] ──► [REVERSED] (if debited)
```

#### State Definitions
*   **INITIATED:** The user has requested a payment. The payment intent is created, but no money has moved yet.
*   **PROCESSING:** The system is waiting for network/bank confirmations, or processing database modifications.
*   **SUCCESS:** The payment completed successfully. Balances are updated and ledger entries are locked.
*   **FAILED:** Something went wrong (e.g., network error, insufficient funds). No money is moved.
*   **REVERSED:** Undoing a completed transaction. A new transaction is created to credit the sender and debit the receiver.
*   **EXPIRED:** The payment request remained unresolved in `PROCESSING` for too long.
    *   *Note:* `EXPIRED` does not automatically return money. It indicates timeout. If funds were debited during `PROCESSING` before timeout, the system must trigger a `REVERSED` state to return the funds.

### 7. Timeout Handling & Uncertain Outcomes (TIMEOUT)

A timeout during processing represents an uncertain transaction outcome. When an external network fails to respond within a given window (e.g., 10 seconds), the engine must **never assume failure**. Assuming failure and immediately releasing funds can lead to double-spending or overdrafts if the transaction eventually succeeds on the external network.

#### The Mental Model
```
            TIMEOUT
               │
               ▼
      Don't assume failure
               │
               ▼
     Keep money protected
               │
               ▼
     Find out what happened
```

#### Walkthrough of a Timeout Scenario
Suppose **Rohit** has a total balance of **₹1,000** and initiates a payment of **₹700**:
1. **Reservation:** The system reserves ₹700.
   - `Total Balance` = ₹1,000, `Reserved` = ₹700, `Available Balance` = ₹300.
2. **External Call:** PayFlow sends transaction `PAY123` for ₹700 to the external system.
3. **No Response:** After 10 seconds, the connection times out.
4. **Transition to Uncertain State:** Conceptually, `PAY123` is marked as `PROCESSING` or `UNKNOWN` (not `FAILED`). The reserved ₹700 remains blocked.

#### Resolution Mechanisms
To discover the actual state of the transaction, the engine employs two primary mechanisms:

*   **Querying the External System (Direct Status API):**
    The system queries the external provider's status endpoint: *"What is the status of PAY123?"*.
    - **If SUCCESS:** The reservation is transitioned to `CAPTURE` and a `DEBIT` ledger entry is made. Rohit's final available balance is ₹300.
    - **If FAILED:** The reservation is transitioned to `RELEASE`. Rohit's ₹700 hold is freed, making his available balance ₹1,000.
*   **Reconciliation (Delayed Audits):**
    If the external provider does not support real-time status queries or is down, the system waits for the external network's transaction records to arrive (e.g., end-of-day batch files). The reconciliation worker compares the local `PROCESSING`/`TIMEOUT` record with the external record:
    - **Mismatch Found:** PayFlow sees `TIMEOUT`, External sees `SUCCESS` for ₹700.
    - **Resolution:** The engine executes the correction flow to finalize the state.

#### Unresolved/Investigating State
If the transaction state still cannot be determined after querying and reconciliation:
- The payment intent transitions to an `INVESTIGATING` status (e.g., `PAY123` status = `INVESTIGATING`).
- The reserved funds remain protected and locked in accordance with business risk policy until manual verification or final reconciliation settles the dispute.

### 8. Reconciliation & Discrepancy Auditing

Reconciliation is the process of comparing our internal system records (the database and immutable ledger) with another external source of truth to ensure consistency and correctness.

```
             RECONCILIATION
                   │
                   ▼
          Compare two records
                   │
          ┌────────┴────────┐
          ▼                 ▼
       MATCH            MISMATCH
          │                 │
        Done         Investigate/Resolve
                            │
                  ┌─────────┼─────────┐
                  ▼         ▼         ▼
               Update    Reverse    Manual
               state     money      review
```

#### The Concept
*   **Match:** When both records agree. E.g., PayFlow logs `PAY123` as `SUCCESS` for ₹500, and the external payment network logs `PAY123` as `SUCCESS` for ₹500.
*   **Mismatch:** When status, amount, or details differ. E.g., PayFlow logs `PAY123` as `SUCCESS` for ₹500, but the external network logs it as `SUCCESS` for ₹450 (Amount Mismatch) or logs it as `FAILED` (Status Mismatch).

#### Handling Mismatches
When a discrepancy is detected, the reconciliation system flags it for resolution based on the scenario:

| Scenario | Local Status | External Status | Action |
| :--- | :--- | :--- | :--- |
| **Scenario A** | `PROCESSING` | `SUCCESS` | Update local transaction state: `PROCESSING` → `SUCCESS` and execute ledger balance changes. |
| **Scenario B** | `SUCCESS` | `FAILED` | Investigate the root cause (e.g., timeout handling error) and perform a new **Reversal** / refund transaction to return the money. |
| **Scenario C** | Any | Mismatched Amount | Halt automatic processing, flag the transaction, and route it to **Manual review**. |

#### Project Implementation (External Simulator)
To simulate this process, PayFlow compares its database with an isolated external simulated payment network:

```
┌──────────────────────┐
│       PayFlow        │
│    Local Database    │
└──────────┬───────────┘
           │
           │ Payment Request
           ▼
┌──────────────────────┐
│ Fake Payment Network │
│  External Simulator  │
└──────────────────────┘
```

The fake network maintains its own records independent of our local system. Our reconciliation service pulls these records, checks for inconsistencies, and runs discrepancy logic:

```
             PAY123
                │
        ┌───────┴───────┐
        ▼               ▼
     PayFlow        External
     SUCCESS         FAILED
        │               │
        └───────┬───────┘
                ▼
            MISMATCH -> Trigger Reversal & Alerts
```

#### Reconciliation vs. Resolution

While **Reconciliation** is the analytical phase (detecting and classifying mismatches), **Resolution** is the operational phase (applying corrections to the ledger to fix those mismatches).

```
                External System
                      │
                      │ Reconciliation Data
                      ▼
              ┌─────────────────┐
              │ Reconciliation  │
              │     Engine      │
              └────────┬────────┘
                       │
                 Compare Records
                       │
          ┌────────────┴────────────┐
          │                         │
       MATCH                    MISMATCH
          │                         │
      No Action               Classify Issue
                                    │
                           ┌────────┴────────┐
                           │                 │
                       Fee Difference    Actual Issue
                           │                 │
                       No Correction      Investigate
                                             │
                                      Resolution Decision
                                             │
                                  ┌──────────┴─────────┐
                                  │                    │
                              Reversal             Adjustment
                                  │                    │
                                  └────────┬───────────┘
                                           │
                                      New Ledger Entry
```

*   **Fee Difference:** A common mismatch is a discrepancy due to varying transaction/network fees. Often, no balance correction is needed.
*   **Actual Issue:** A structural failure or processing discrepancy that requires investigation. The system makes a resolution decision (e.g., automated Reversal or manual Adjustment) and appends a **new ledger entry** to correct the balance.

---

## Settlement & Finalization (SETTLEMENT)

Settlement is the process by which financial obligations between transacting parties are finalized and actual money is transferred between their respective financial institutions.

> [!IMPORTANT]
> **Key Principle:** Payment success is distinct from settlement completeness:
> $$\text{PAYMENT SUCCESS} \neq \text{SETTLEMENT COMPLETE}$$
> A successful payment signifies that the transaction has been authorized and captured locally. Settlement signifies that the underlying funds have physically shifted between banking networks.

### The Flow
```
Payment Instruction
        │
        ▼
     SUCCESS (Local authorization & record)
        │
        ▼
Financial Obligations Created
        │
        ▼
    SETTLEMENT (Obligation finalized)
```

### Settlement States
To track this background process, settlements progress through their own lifecycle states:
*   `PENDING`: The obligation is recorded but not yet cleared.
*   `SETTLED`: The external bank or clearing system confirmed final clearing.
*   `FAILED`: Settlement failed (requires rollback, reversal, or manual intervention).
*   `INVESTIGATING`: Stuck in verification or requiring manual audit.

```
PENDING
   │
   ├── SETTLED
   │
   ├── FAILED
   │
   └── INVESTIGATING
```

### Ensuring Settlement Completion
In production systems, settlement finalization is guaranteed using several layers:
1. **Settlement Records:** Explicitly tracking unsettled obligations as separate entities in the database.
2. **Background Workers:** Asynchronous worker queues that pull pending settlements and process them against external networks/clearers.
3. **Retries:** Standardizing automated retries for temporary bank downtime (`PENDING` $\rightarrow$ `Retry` $\rightarrow$ `SETTLED`).
4. **Monitoring & Alerts:** Paging engineers if a record remains `PENDING` for longer than a predefined window (e.g., $X$ minutes).
5. **Reconciliation:** Running audits to verify local database settlement states against the external clearer's daily transaction settlement logs.

### Project Implementation Model
To simulate settlement in PayFlow, payments and settlements are kept as separate concepts:
*   **Payment Event:** `PAY123` is marked `SUCCESS` when authorized.
*   **Settlement Event:** A settlement record is initialized as `PENDING`.
*   **Clearance Simulator:** A settlement background worker runs, transitions `PENDING` to `SETTLED` or `FAILED`, and the reconciliation engine compares PayFlow's records with a simulated external settlement database.

---

## Audit Trails & Logging System

Audit logs record the exact history of events, state changes, and actors surrounding a financial transaction. They serve as the "CCTV" of the system.

### Actors in the System
Audit events are created by distinct actors to ensure clear accountability:
*   `USER`: The person initiating the action (e.g., Rohit sending money).
*   `ADMIN`: A platform administrator investigating or overriding an issue.
*   `API`: Automated system components responding to incoming webhooks.
*   `PAYMENT_WORKER`: The worker queue executing transfers and state commitments.
*   `RECONCILIATION_WORKER`: The worker identifying inconsistencies and triggers.
*   `SYSTEM`: Core scheduler or fallback automation daemon.

#### Example Event Object
```json
{
  "timestamp": "2026-08-16T10:05:01Z",
  "actorType": "SYSTEM",
  "actorId": "reconciliation-worker",
  "event": "RECONCILIATION_MISMATCH",
  "details": { "transactionId": "PAY123", "mismatchType": "AMOUNT_MISMATCH" }
}
```

### Timeline of a Discrepancy
```
10:00:01 ──► [USER / rohit] Payment initiated (PAYMENT_INITIATED)
10:00:02 ──► [USER / rohit] MPIN verified (MPIN_VERIFIED)
10:00:03 ──► [SYSTEM / payment-worker] Wallet debit completed (DEBIT_COMPLETED)
10:00:03 ──► [SYSTEM / payment-worker] Transaction marked SUCCESS (PAYMENT_SUCCESS)
10:05:00 ──► [SYSTEM / reconciliation-worker] Reconciliation started (RECONCILIATION_STARTED)
10:05:01 ──► [SYSTEM / reconciliation-worker] Amount mismatch detected (MISMATCH_DETECTED)
10:10:42 ──► [ADMIN / admin123] Investigation completed (DISCREPANCY_REVIEWED)
10:10:43 ──► [SYSTEM / payment-worker] Reversal created (REVERSAL_CREATED)
```

---

## The Three Layers of PayFlow

Every payment operation in the PayFlow engine is tracked across three independent but connected layers:

```
                PAYMENT
                   │
       ┌───────────┼────────────┐
       │           │            │
       ▼           ▼            ▼
   Transaction    Ledger      Audit
       │           │            │
   Business      Money        History
    State        Movement      of Actions
```

1.  **Transaction Layer (Business State):** Stores the current business story and user-facing status of the payment intent (e.g., `PAY123`, amount: ₹500, status: `SUCCESS`).
2.  **Ledger Layer (Money Movement):** The immutable accounting book. Every movement is recorded as double-entry ledger items (e.g., Rohit: `DEBIT ₹500`, Alice: `CREDIT ₹500`).
3.  **Audit Layer (History of Actions):** The step-by-step security record of everything that occurred (e.g., `PAYMENT_INITIATED`, `MPIN_VERIFIED`, `RECONCILIATION_STARTED`, `MISMATCH_DETECTED`, `REVERSAL_CREATED`).

**Fintech Core Principle:** Never rewrite history to make the present look correct. If an error occurs or a correction is needed, always write a new record (ledger/audit log) explaining what happened, preserving the historical timeline.

---

## MongoDB Aggregation Pipelines

In fintech architectures, loading dashboards, generating passbooks, and analyzing transaction volume require aggregating massive amounts of data efficiently. PayFlow utilizes MongoDB Aggregation Pipelines to process, transform, and compute metrics directly inside the database engine.

### Why Use Aggregation Pipelines?
Instead of fetching thousands of raw records into the application memory and processing them in Node.js (which consumes significant bandwidth and CPU), aggregation pipelines process data in stages before returning only the final, computed result.

### Conceptual Pipeline
An aggregation pipeline passes documents through a sequence of stages:
```
  Transactions (Raw Documents)
               │
               ▼
           $match (Filter by status/date)
               │
               ▼
           $group (Group by sender/receiver)
               │
               ▼
           Calculate (Sum, count, average)
               │
               ▼
           $sort (Sort by total volume)
               │
               ▼
            Result (Aggregated Analytics)
```

#### Example Scenario
Suppose the database has the following transactions:
* `PAY001` → ₹500
* `PAY002` → ₹700
* `PAY003` → ₹200
* `PAY004` → ₹1,000

To calculate the total transaction volume, the aggregation pipeline sums these values inside the database, returning a single result: `₹2,400`.

### Key Aggregation Stages Used in PayFlow
1. **`$match`:** Filters documents to pass only those matching specified conditions (e.g., status is `SUCCESS`, or timestamp is within the current day).
2. **`$group`:** Groups input documents by a specified identifier (e.g., grouping transactions by `userId`) and computes accumulated values (such as `$sum` for total spent or `$avg` for average transaction amount).
3. **`$sum`:** Calculates the cumulative mathematical sum of numeric values.
4. **`$count`:** Counts the number of documents in a stage (e.g., counting failed vs. successful transactions).
5. **`$sort`:** Sorts the resulting documents by a specific field (e.g., sorting users descending by their total transaction volume).
6. **`$limit`:** Restricts the number of output documents (e.g., fetching only the top 10 users).
