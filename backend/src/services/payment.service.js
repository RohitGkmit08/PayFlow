const mongoose = require("mongoose");

const User = require("../models/User.js");
const Account = require("../models/Accounts.js");
const Wallet = require("../models/Wallet.js");
const Transaction = require("../models/Transaction.js");
const LedgerEntry = require("../models/LedgerEntry.js");
const IdempotencyKey = require("../models/Idempotency.js");

// IDENTIFY → VALIDATE → CREATE → MOVE → RECORD → COMPLETE

const createP2P = async ({
    senderUserId,
    receiverAccountId,
    amount,
    idempotencyKey
}) => {

    /*
     * IDEMPOTENCY CHECK
     *
     * If this request has already been completed,
     * return the existing transaction.
     */

    const existingKey = await IdempotencyKey.findOne({
        userId: senderUserId,
        key: idempotencyKey
    });

    if (existingKey) {

        const existingTransaction = await Transaction.findById(
            existingKey.transactionId
        );

        if (!existingTransaction) {
            throw new Error(
                "Idempotency record points to a missing transaction"
            );
        }

        if (
            existingTransaction.status === "INITIATED" ||
            existingTransaction.status === "PROCESSING"
        ) {
            throw new Error("Payment is already in progress");
        }

        if (
            existingTransaction.status === "SUCCESS" ||
            existingTransaction.status === "FAILED"
        ) {
            return existingTransaction;
        }

        throw new Error("Unknown transaction status");
    }

    /*
     * TRANSACTION ATTEMPTS
     *
     * A transient transaction conflict causes the
     * entire transaction to be retried.
     */

    const MAX_ATTEMPTS = 3;

    for (
        let attempt = 1;
        attempt <= MAX_ATTEMPTS;
        attempt++
    ) {

        const session = await mongoose.startSession();

        try {

            session.startTransaction();

            // IDENTIFY

            const senderUser = await User
                .findById(senderUserId)
                .session(session);

            if (!senderUser) {
                throw new Error("No such user found");
            }

            const senderAccount = await Account.findOne({
                userId: senderUser._id,
                accountType: "USER_WALLET",
                status: "ACTIVE"
            }).session(session);

            if (!senderAccount) {
                throw new Error("Sender account not found");
            }

            const senderWallet = await Wallet.findOne({
                userId: senderUser._id,
                accountId: senderAccount._id
            }).session(session);

            if (!senderWallet) {
                throw new Error("Sender wallet not found");
            }

            const receiverAccount = await Account.findOne({
                _id: receiverAccountId,
                accountType: "USER_WALLET",
                status: "ACTIVE"
            }).session(session);

            if (!receiverAccount) {
                throw new Error("Receiver account not found");
            }

            const receiverWallet = await Wallet.findOne({
                accountId: receiverAccount._id
            }).session(session);

            if (!receiverWallet) {
                throw new Error("Receiver wallet not found");
            }

            // VALIDATE

            if (senderAccount._id.equals(receiverAccount._id)) {
                throw new Error(
                    "Cannot transfer money to your own account"
                );
            }

            // CREATE TRANSACTION

            const transaction = await Transaction.create(
                [{
                    transactionId:
                        `TXN-${Date.now()}-${Math.floor(
                            Math.random() * 100000
                        )}`,

                    type: "P2P_TRANSFER",

                    senderAccountId: senderAccount._id,
                    receiverAccountId: receiverAccount._id,

                    amount,
                    currency: "INR",

                    status: "INITIATED"
                }],
                { session }
            );

            const createdTransaction = transaction[0];

            // CREATE IDEMPOTENCY RECORD

            try {

                await IdempotencyKey.create(
                    [{
                        userId: senderUserId,

                        key: idempotencyKey,

                        transactionId: createdTransaction._id,

                        expiresAt: new Date(
                            Date.now() + 24 * 60 * 60 * 1000
                        )
                    }],
                    { session }
                );

            } catch (err) {

                /*
                 * Another concurrent request created this
                 * idempotency key first.
                 */

                if (err.code === 11000) {

                    /*
                     * This transaction belongs to the losing
                     * request, so it must be aborted.
                     */

                    await session.abortTransaction();

                    /*
                     * Find the idempotency record created by
                     * the winning request.
                     */

                    const existingKey = await IdempotencyKey.findOne({
                        userId: senderUserId,
                        key: idempotencyKey
                    });

                    if (!existingKey) {
                        throw new Error(
                            "Idempotency key was not found after duplicate-key error"
                        );
                    }

                    /*
                     * Find the transaction associated with
                     * the winning request.
                     */

                    const existingTransaction =
                        await Transaction.findById(
                            existingKey.transactionId
                        );

                    if (!existingTransaction) {
                        throw new Error(
                            "Idempotency record points to a missing transaction"
                        );
                    }

                    /*
                     * The winning request may still be processing.
                     */

                    if (
                        existingTransaction.status === "INITIATED" ||
                        existingTransaction.status === "PROCESSING"
                    ) {
                        throw new Error(
                            "Payment is already in progress"
                        );
                    }

                    /*
                     * The winning request has already finished.
                     *
                     * Return its result instead of performing
                     * the payment again.
                     */

                    if (
                        existingTransaction.status === "SUCCESS" ||
                        existingTransaction.status === "FAILED"
                    ) {
                        return existingTransaction;
                    }

                    throw new Error(
                        "Unknown transaction status"
                    );
                }

                throw err;
            }

            // MOVE

            /*
             * Atomic conditional debit.
             *
             * MongoDB checks:
             *
             *     availableBalance >= amount
             *
             * and decrements the balance as one operation.
             */

            const senderDebit = await Wallet.updateOne(
                {
                    _id: senderWallet._id,
                    availableBalance: { $gte: amount }
                },
                {
                    $inc: {
                        availableBalance: -amount
                    }
                },
                {
                    session
                }
            );

            if (senderDebit.modifiedCount === 0) {
                throw new Error("Insufficient balance");
            }

            /*
             * Credit receiver.
             */

            const receiverCredit = await Wallet.updateOne(
                {
                    _id: receiverWallet._id
                },
                {
                    $inc: {
                        availableBalance: amount
                    }
                },
                {
                    session
                }
            );

            if (receiverCredit.modifiedCount === 0) {
                throw new Error(
                    "Failed to credit receiver wallet"
                );
            }

            // RECORD

            await LedgerEntry.create(
                [{
                    transactionId: createdTransaction._id,

                    accountId: senderAccount._id,

                    entryType: "DEBIT",

                    amount,
                    currency: "INR"
                }],
                { session }
            );

            await LedgerEntry.create(
                [{
                    transactionId: createdTransaction._id,

                    accountId: receiverAccount._id,

                    entryType: "CREDIT",

                    amount,
                    currency: "INR"
                }],
                { session }
            );

            // COMPLETE

            createdTransaction.status = "SUCCESS";

            await createdTransaction.save({ session });

            // COMMIT

            /*
             * All payment operations are complete.
             *
             * If the result of COMMIT is unknown, retry ONLY
             * the commit. Do NOT repeat the payment operations.
             */

            const MAX_COMMIT_ATTEMPTS = 3;

            for (
                let commitAttempt = 1;
                commitAttempt <= MAX_COMMIT_ATTEMPTS;
                commitAttempt++
            ) {

                try {

                    await session.commitTransaction();

                    break;

                } catch (err) {

                    if (
                        err.hasErrorLabel &&
                        err.hasErrorLabel(
                            "UnknownTransactionCommitResult"
                        ))
                    {

                        /*
                         * We don't know whether the commit
                         * succeeded.
                         *
                         * Retry ONLY COMMIT.
                         */

                        if (
                            commitAttempt < MAX_COMMIT_ATTEMPTS
                        ) {
                            continue;
                        }

                        err.code = "TRANSACTION_COMMIT_UNKNOWN";
                        err.transactionId =
                            createdTransaction.transactionId;
                        err.idempotencyKey = idempotencyKey;

                        throw err;
                    }

                    throw err;
                }
            }

            return createdTransaction;

        } catch (err) {

            /*
             * Commit outcome is unknown.
             *
             * Do NOT retry the payment and do NOT start
             * another transaction.
             */

            if (err.code === "TRANSACTION_COMMIT_UNKNOWN") {
                throw err;
            }

            /*
             * A transient transaction error means this
             * transaction attempt cannot safely continue.
             *
             * Abort it and start a completely new attempt.
             */

            if (
                err.hasErrorLabel &&
                err.hasErrorLabel(
                    "TransientTransactionError"
                )
            ) {

                if (session.inTransaction()) {
                    await session.abortTransaction();
                }

                continue;
            }

            /*
             * All other errors are not automatically retryable.
             */

            if (session.inTransaction()) {
                await session.abortTransaction();
            }

            throw err;

        } finally {

            await session.endSession();
        }
    }

    /*
     * All transaction attempts were exhausted.
     */

    throw new Error(
        "Payment could not be completed after multiple attempts"
    );
};

module.exports = { createP2P };