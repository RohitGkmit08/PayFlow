const mongoose = require("mongoose");
const crypto = require("node:crypto");

const User = require("../models/User.js");
const Account = require("../models/Accounts.js");
const Wallet = require("../models/Wallet.js");
const Transaction = require("../models/Transaction.js");
const LedgerEntry = require("../models/LedgerEntry.js");
const PaymentIntent = require("../models/PaymentIntent.js");

const MAX_TRANSACTION_ATTEMPTS = 3;
const MAX_COMMIT_ATTEMPTS = 3;

// Create errors with codes that the controller can interpret.
function createServiceError(message, code, statusCode = 500) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

// Bind an idempotency key to the original payment details.
function createRequestFingerprint({
  senderAccountId,
  receiverAccountId,
  amount,
  currency,
}) {
  const canonicalRequest = JSON.stringify({
    senderAccountId: String(senderAccountId),
    receiverAccountId: String(receiverAccountId),
    amount,
    currency,
  });

  return crypto
    .createHash("sha256")
    .update(canonicalRequest)
    .digest("hex");
}

function isDuplicateKeyError(error) {
  return error?.code === 11000;
}

function hasErrorLabel(error, label) {
  return (
    typeof error?.hasErrorLabel === "function" &&
    error.hasErrorLabel(label)
  );
}

// Check whether this request has already been processed.
async function findExistingIntent({
  userId,
  idempotencyKey,
  receiverAccountId,
  amount,
  requestFingerprint,
}) {
  const intent = await PaymentIntent.findOne({
    userId,
    idempotencyKey,
  });

  if (!intent) return null;

  // A key cannot be reused for different payment details.
  if (
    String(intent.receiverAccountId) !== String(receiverAccountId) ||
    intent.amount !== amount
  ) {
    throw createServiceError(
      "Idempotency-Key was already used with different payment details",
      "IDEMPOTENCY_KEY_REUSED",
      409
    );
  }

  if (
    requestFingerprint &&
    intent.requestFingerprint &&
    intent.requestFingerprint !== requestFingerprint
  ) {
    throw createServiceError(
      "Idempotency-Key was already used with different payment details",
      "IDEMPOTENCY_KEY_REUSED",
      409
    );
  }

  if (intent.status === "SUCCESS") {
    const transaction = intent.transactionId
      ? await Transaction.findById(intent.transactionId)
      : null;

    if (!transaction) {
      throw createServiceError(
        "PaymentIntent points to a missing transaction",
        "PAYMENT_RECORD_INCONSISTENT",
        500
      );
    }

    return { intent, transaction };
  }

  if (intent.status === "FAILED") {
    throw createServiceError(
      "This payment request has already failed",
      "PAYMENT_ALREADY_FAILED",
      409
    );
  }

  if (
    intent.status === "PROCESSING" ||
    intent.status === "RECEIVED"
  ) {
    const transaction = intent.transactionId
      ? await Transaction.findById(intent.transactionId)
      : null;

    if (transaction?.status === "SUCCESS") {
      return { intent, transaction };
    }

    throw createServiceError(
      "Payment is still processing or its outcome is unresolved",
      "PAYMENT_PROCESSING",
      202
    );
  }

  throw createServiceError(
    "Unknown payment intent status",
    "INVALID_PAYMENT_INTENT_STATUS",
    500
  );
}

// Identify the sender and receiver accounts and their wallets.
async function identifyAccounts({
  senderUserId,
  receiverAccountId,
  session,
}) {
  const senderUserQuery = User.findById(senderUserId);

  if (session) senderUserQuery.session(session);

  const senderUser = await senderUserQuery;

  if (!senderUser || senderUser.status !== "ACTIVE") {
    throw createServiceError(
      "Sender user not found or inactive",
      "SENDER_NOT_ACTIVE",
      400
    );
  }

  const senderAccountQuery = Account.findOne({
    userId: senderUser._id,
    accountType: "USER_WALLET",
    status: "ACTIVE",
  });

  if (session) senderAccountQuery.session(session);

  const senderAccount = await senderAccountQuery;

  if (!senderAccount) {
    throw createServiceError(
      "Sender account not found or inactive",
      "SENDER_ACCOUNT_NOT_FOUND",
      400
    );
  }

  const senderWalletQuery = Wallet.findOne({
    userId: senderUser._id,
    accountId: senderAccount._id,
  });

  if (session) senderWalletQuery.session(session);

  const senderWallet = await senderWalletQuery;

  if (!senderWallet) {
    throw createServiceError(
      "Sender wallet not found",
      "SENDER_WALLET_NOT_FOUND",
      400
    );
  }

  const receiverAccountQuery = Account.findOne({
    _id: receiverAccountId,
    accountType: "USER_WALLET",
    status: "ACTIVE",
  });

  if (session) receiverAccountQuery.session(session);

  const receiverAccount = await receiverAccountQuery;

  if (!receiverAccount) {
    throw createServiceError(
      "Receiver account not found or inactive",
      "RECEIVER_ACCOUNT_NOT_FOUND",
      400
    );
  }

  const receiverWalletQuery = Wallet.findOne({
    accountId: receiverAccount._id,
    userId: receiverAccount.userId,
  });

  if (session) receiverWalletQuery.session(session);

  const receiverWallet = await receiverWalletQuery;

  if (!receiverWallet) {
    throw createServiceError(
      "Receiver wallet not found",
      "RECEIVER_WALLET_NOT_FOUND",
      400
    );
  }

  if (senderAccount._id.equals(receiverAccount._id)) {
    throw createServiceError(
      "Cannot transfer money to your own account",
      "SELF_TRANSFER",
      400
    );
  }

  return {
    senderUser,
    senderAccount,
    senderWallet,
    receiverAccount,
    receiverWallet,
  };
}

// Call only when we know the financial transaction did not commit.
async function markIntentFailedIfSafe(intentId) {
  try {
    await PaymentIntent.updateOne(
      {
        _id: intentId,
        status: { $in: ["RECEIVED", "PROCESSING"] },
      },
      {
        $set: { status: "FAILED" },
      }
    );
  } catch (error) {
    // Preserve the original error.
    // A reconciliation process can repair the intent status later.
  }
}
const createP2P = async ({
  senderUserId,
  receiverAccountId,
  amount,
  idempotencyKey,
}) => {
  if (!senderUserId) {
    throw createServiceError(
      "Authenticated sender is required",
      "SENDER_REQUIRED",
      401
    );
  }

  if (
    !idempotencyKey ||
    typeof idempotencyKey !== "string"
  ) {
    throw createServiceError(
      "Idempotency-Key is required",
      "IDEMPOTENCY_KEY_REQUIRED",
      400
    );
  }

  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw createServiceError(
      "Amount must be a positive safe integer representing paise",
      "INVALID_AMOUNT",
      400
    );
  }

  // First, check whether this request has already been processed.
  const existing = await findExistingIntent({
    userId: senderUserId,
    idempotencyKey,
    receiverAccountId,
    amount,
  });

  if (existing) return existing.transaction;

  const initialAccounts = await identifyAccounts({
    senderUserId,
    receiverAccountId,
  });

  const requestFingerprint = createRequestFingerprint({
    senderAccountId: initialAccounts.senderAccount._id,
    receiverAccountId: initialAccounts.receiverAccount._id,
    amount,
    currency: "INR",
  });

  // Create the intent outside the financial transaction so the request
  // record can survive a financial transaction rollback.
  let paymentIntent;

  try {
    paymentIntent = await PaymentIntent.create({
      userId: senderUserId,
      senderAccountId: initialAccounts.senderAccount._id,
      receiverAccountId: initialAccounts.receiverAccount._id,
      amount,
      currency: "INR",
      idempotencyKey,
      requestFingerprint,
      status: "PROCESSING",
    });
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;

    // Another request may have created the intent concurrently.
    const winner = await findExistingIntent({
      userId: senderUserId,
      idempotencyKey,
      receiverAccountId,
      amount,
      requestFingerprint,
    });

    if (winner) return winner.transaction;

    throw createServiceError(
      "Payment request already exists and its status could not be loaded",
      "PAYMENT_PROCESSING",
      202
    );
  }

  for (
    let attempt = 1;
    attempt <= MAX_TRANSACTION_ATTEMPTS;
    attempt += 1
  ) {
    const session = await mongoose.startSession();

    try {
      session.startTransaction();

      // Re-read the relevant records within this transaction attempt.
      const accounts = await identifyAccounts({
        senderUserId,
        receiverAccountId,
        session,
      });

      // Do not transfer if the account identity changed.
      if (
        !accounts.senderAccount._id.equals(
          paymentIntent.senderAccountId
        ) ||
        !accounts.receiverAccount._id.equals(
          paymentIntent.receiverAccountId
        )
      ) {
        throw createServiceError(
          "Payment account details changed; create a new payment request",
          "PAYMENT_ACCOUNT_CHANGED",
          409
        );
      }

      // 1. Create the financial transaction record.
      const transactionDocs = await Transaction.create(
        [
          {
            transactionId: `TXN-${crypto.randomUUID()}`,
            type: "P2P_TRANSFER",
            senderAccountId: accounts.senderAccount._id,
            receiverAccountId: accounts.receiverAccount._id,
            amount,
            currency: "INR",
            status: "INITIATED",
          },
        ],
        { session }
      );

      const createdTransaction = transactionDocs[0];

      // 2. Debit the sender atomically.
      // The balance check and decrement happen in one DB operation.
      const debit = await Wallet.updateOne(
        {
          _id: accounts.senderWallet._id,
          availableBalance: { $gte: amount },
        },
        {
          $inc: { availableBalance: -amount },
        },
        { session }
      );

      if (debit.modifiedCount !== 1) {
        throw createServiceError(
          "Insufficient balance",
          "INSUFFICIENT_BALANCE",
          400
        );
      }

      // 3. Credit the receiver.
      const credit = await Wallet.updateOne(
        { _id: accounts.receiverWallet._id },
        {
          $inc: { availableBalance: amount },
        },
        { session }
      );

      if (credit.modifiedCount !== 1) {
        throw createServiceError(
          "Receiver wallet could not be credited",
          "RECEIVER_CREDIT_FAILED",
          500
        );
      }

      // 4. Record balanced double-entry ledger entries.
      await LedgerEntry.create(
        [
          {
            transactionId: createdTransaction._id,
            accountId: accounts.senderAccount._id,
            entryType: "DEBIT",
            amount,
            currency: "INR",
          },
          {
            transactionId: createdTransaction._id,
            accountId: accounts.receiverAccount._id,
            entryType: "CREDIT",
            amount,
            currency: "INR",
          },
        ],
        { session }
      );

      // 5. Mark the financial transaction successful within the transaction.
      createdTransaction.status = "SUCCESS";
      await createdTransaction.save({ session });

      // 6. Link the PaymentIntent to the transaction.
      // This link rolls back if the financial transaction aborts.
      await PaymentIntent.updateOne(
        { _id: paymentIntent._id },
        {
          $set: {
            transactionId: createdTransaction._id,
          },
        },
        { session }
      );

      // Commit handling is separate from transaction execution.
      let commitConfirmed = false;

      for (
        let commitAttempt = 1;
        commitAttempt <= MAX_COMMIT_ATTEMPTS;
        commitAttempt += 1
      ) {
        try {
          await session.commitTransaction();
          commitConfirmed = true;
          break;
        } catch (error) {
          if (
            hasErrorLabel(
              error,
              "UnknownTransactionCommitResult"
            )
          ) {
            // Retry the commit, not the payment operations.
            if (commitAttempt < MAX_COMMIT_ATTEMPTS) {
              continue;
            }

            error.code = "TRANSACTION_COMMIT_UNKNOWN";
            error.transactionId =
              createdTransaction.transactionId;
            error.paymentIntentId = String(paymentIntent._id);
            error.idempotencyKey = idempotencyKey;

            throw error;
          }

          throw error;
        }
      }

      if (!commitConfirmed) {
        const error = createServiceError(
          "Payment commit could not be confirmed",
          "TRANSACTION_COMMIT_UNKNOWN",
          202
        );
        error.transactionId = createdTransaction.transactionId;
        error.paymentIntentId = String(paymentIntent._id);
        error.idempotencyKey = idempotencyKey;
        throw error;
      }

      // The financial commit is confirmed.
      // This status update is deliberately outside the transaction.
      try {
        await PaymentIntent.updateOne(
          { _id: paymentIntent._id },
          {
            $set: {
              status: "SUCCESS",
              transactionId: createdTransaction._id,
            },
          }
        );
      } catch (error) {
        // Leave PROCESSING for reconciliation.
        // Never execute the payment again because this update failed.
      }

      return createdTransaction;
    } catch (error) {
      // The commit may have succeeded even though confirmation failed.
      // Do not mark FAILED or execute the payment again.
      if (error.code === "TRANSACTION_COMMIT_UNKNOWN") {
        throw error;
      }

      // A transient transaction error allows a bounded retry of the
      // entire transaction, after aborting the current attempt.
      if (hasErrorLabel(error, "TransientTransactionError")) {
        if (session.inTransaction()) {
          await session.abortTransaction();
        }

        if (attempt < MAX_TRANSACTION_ATTEMPTS) {
          continue;
        }

        await markIntentFailedIfSafe(paymentIntent._id);

        throw createServiceError(
          "Payment could not be completed after multiple transaction attempts",
          "TRANSACTION_RETRY_EXHAUSTED",
          503
        );
      }

      if (session.inTransaction()) {
        await session.abortTransaction();
      }

      // Ordinary errors are marked FAILED after aborting the transaction.
      await markIntentFailedIfSafe(paymentIntent._id);

      throw error;
    } finally {
      await session.endSession();
    }
  }

  throw createServiceError(
    "Payment could not be completed",
    "PAYMENT_FAILED",
    500
  );
};

module.exports = { createP2P };