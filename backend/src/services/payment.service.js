const mongoose = require("mongoose");

const User = require("../models/User.js");
const Account = require("../models/Accounts.js");
const Wallet = require("../models/Wallet.js");
const Transaction = require("../models/Transaction.js");
const LedgerEntry = require("../models/LedgerEntry.js");
const PaymentIntent = require("../models/PaymentIntent.js");

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
     * PaymentIntent is the durable record for the payment request.
     *
     * Unlike the financial transaction, PaymentIntent is created
     * outside the MongoDB transaction so that it survives if the
     * financial transaction is rolled back.
     */

    const existingPaymentIntent = await PaymentIntent.findOne({
        userId: senderUserId,
        idempotencyKey
    });

    if (existingPaymentIntent) {

        /*
         * The same payment request has already been seen.
         *
         * SUCCESS → return the existing transaction.
         *
         * PROCESSING → do not execute the payment again.
         *
         * FAILED → return the same failed result.
         */

        if (existingPaymentIntent.status === "PROCESSING") {

            const existingTransaction =
                existingPaymentIntent.transactionId
                    ? await Transaction.findById(
                        existingPaymentIntent.transactionId
                    )
                    : null;

            if (existingTransaction) {
                return existingTransaction;
            }

            throw new Error("Payment is already in progress");
        }

        if (existingPaymentIntent.status === "SUCCESS") {

            const existingTransaction =
                await Transaction.findById(
                    existingPaymentIntent.transactionId
                );

            if (!existingTransaction) {
                throw new Error(
                    "PaymentIntent points to a missing transaction"
                );
            }

            return existingTransaction;
        }

        if (existingPaymentIntent.status === "FAILED") {
            throw new Error("Payment has already failed");
        }

        throw new Error("Unknown payment intent status");
    }


    /*
     * IDENTIFY
     *
     * Identify the sender and receiver before creating the
     * durable PaymentIntent.
     *
     * senderUserId comes from authentication middleware.
     * The client does not choose the sender.
     */

    const senderUser = await User.findById(senderUserId);

    if (!senderUser) {
        throw new Error("No such user found");
    }


    const senderAccount = await Account.findOne({
        userId: senderUser._id,
        accountType: "USER_WALLET",
        status: "ACTIVE"
    });

    if (!senderAccount) {
        throw new Error("Sender account not found");
    }


    const senderWallet = await Wallet.findOne({
        userId: senderUser._id,
        accountId: senderAccount._id
    });

    if (!senderWallet) {
        throw new Error("Sender wallet not found");
    }


    const receiverAccount = await Account.findOne({
        _id: receiverAccountId,
        accountType: "USER_WALLET",
        status: "ACTIVE"
    });

    if (!receiverAccount) {
        throw new Error("Receiver account not found");
    }


    const receiverWallet = await Wallet.findOne({
        accountId: receiverAccount._id
    });

    if (!receiverWallet) {
        throw new Error("Receiver wallet not found");
    }


    // VALIDATE

    /*
     * Prevent transferring money to the same account.
     */

    if (senderAccount._id.equals(receiverAccount._id)) {
        throw new Error(
            "Cannot transfer money to your own account"
        );
    }


    /*
     * CREATE PAYMENT INTENT
     *
     * PaymentIntent is deliberately created outside the financial
     * MongoDB transaction.
     *
     * This record must survive even if the financial transaction
     * later rolls back or its commit result becomes unknown.
     */

    let paymentIntent;

    try {

        paymentIntent = await PaymentIntent.create({
            userId: senderUserId,

            senderAccountId: senderAccount._id,

            receiverAccountId: receiverAccount._id,

            amount,

            currency: "INR",

            idempotencyKey,

            status: "PROCESSING"
        });

    } catch (err) {

        /*
         * Another concurrent request created the same PaymentIntent
         * first.
         *
         * The unique index on:
         *
         *     { userId, idempotencyKey }
         *
         * allows only one request to become the owner of the
         * payment.
         */

        if (err.code === 11000) {

            const existingPaymentIntent =
                await PaymentIntent.findOne({
                    userId: senderUserId,
                    idempotencyKey
                });

            if (!existingPaymentIntent) {
                throw new Error(
                    "PaymentIntent was not found after duplicate-key error"
                );
            }


            if (
                existingPaymentIntent.status === "PROCESSING"
            ) {

                throw new Error(
                    "Payment is already in progress"
                );
            }


            if (
                existingPaymentIntent.status === "SUCCESS"
            ) {

                const existingTransaction =
                    await Transaction.findById(
                        existingPaymentIntent.transactionId
                    );

                if (!existingTransaction) {
                    throw new Error(
                        "PaymentIntent points to a missing transaction"
                    );
                }

                return existingTransaction;
            }


            if (
                existingPaymentIntent.status === "FAILED"
            ) {

                throw new Error(
                    "Payment has already failed"
                );
            }


            throw new Error(
                "Unknown payment intent status"
            );
        }

        throw err;
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

            /*
             * Re-read the sender and receiver inside the transaction.
             *
             * These reads are part of the financial transaction and
             * therefore participate in MongoDB's transaction isolation.
             */

            const transactionSenderUser =
                await User
                    .findById(senderUserId)
                    .session(session);

            if (!transactionSenderUser) {
                throw new Error("No such user found");
            }


            const transactionSenderAccount =
                await Account.findOne({
                    userId: transactionSenderUser._id,
                    accountType: "USER_WALLET",
                    status: "ACTIVE"
                }).session(session);

            if (!transactionSenderAccount) {
                throw new Error("Sender account not found");
            }


            const transactionSenderWallet =
                await Wallet.findOne({
                    userId: transactionSenderUser._id,
                    accountId: transactionSenderAccount._id
                }).session(session);

            if (!transactionSenderWallet) {
                throw new Error("Sender wallet not found");
            }


            const transactionReceiverAccount =
                await Account.findOne({
                    _id: receiverAccountId,
                    accountType: "USER_WALLET",
                    status: "ACTIVE"
                }).session(session);

            if (!transactionReceiverAccount) {
                throw new Error("Receiver account not found");
            }


            const transactionReceiverWallet =
                await Wallet.findOne({
                    accountId: transactionReceiverAccount._id
                }).session(session);

            if (!transactionReceiverWallet) {
                throw new Error("Receiver wallet not found");
            }


            // VALIDATE

            /*
             * Prevent transferring money to the same account.
             */

            if (
                transactionSenderAccount._id.equals(
                    transactionReceiverAccount._id
                )
            ) {
                throw new Error(
                    "Cannot transfer money to your own account"
                );
            }


            // CREATE TRANSACTION

            /*
             * Create the Transaction record.
             *
             * Transaction = business event.
             * LedgerEntry = accounting consequence.
             *
             * The transaction starts as INITIATED and becomes
             * SUCCESS only after all financial operations succeed.
             */

            const transaction = await Transaction.create(
                [{
                    transactionId:
                        `TXN-${Date.now()}-${Math.floor(
                            Math.random() * 100000
                        )}`,

                    type: "P2P_TRANSFER",

                    senderAccountId:
                        transactionSenderAccount._id,

                    receiverAccountId:
                        transactionReceiverAccount._id,

                    amount,

                    currency: "INR",

                    status: "INITIATED"
                }],
                { session }
            );


            /*
             * create() returns an array when called with an array,
             * so we extract the created Transaction document.
             */

            const createdTransaction = transaction[0];


            /*
             * Store the Transaction reference in the PaymentIntent.
             *
             * IMPORTANT:
             *
             * This update is part of the financial transaction.
             *
             * If the financial transaction rolls back,
             * this transactionId update also rolls back.
             *
             * The PaymentIntent itself remains because it was created
             * outside this transaction.
             */

            paymentIntent.transactionId =
                createdTransaction._id;

            await paymentIntent.save({ session });


            // MOVE

            /*
             * Atomic conditional debit.
             *
             * MongoDB checks:
             *
             *     availableBalance >= amount
             *
             * and decrements the balance as one operation.
             *
             * This prevents the READ → CHECK → WRITE race.
             */

            const senderDebit = await Wallet.updateOne(
                {
                    _id: transactionSenderWallet._id,

                    availableBalance: {
                        $gte: amount
                    }
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

            const receiverCredit =
                await Wallet.updateOne(
                    {
                        _id: transactionReceiverWallet._id
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
                    transactionId:
                        createdTransaction._id,

                    accountId:
                        transactionSenderAccount._id,

                    entryType: "DEBIT",

                    amount,

                    currency: "INR"
                }],
                { session }
            );


            await LedgerEntry.create(
                [{
                    transactionId:
                        createdTransaction._id,

                    accountId:
                        transactionReceiverAccount._id,

                    entryType: "CREDIT",

                    amount,

                    currency: "INR"
                }],
                { session }
            );


            // COMPLETE

            /*
             * The financial transaction has completed all of its
             * operations successfully.
             *
             * The SUCCESS status itself is still part of the
             * MongoDB transaction and therefore is not durable
             * until COMMIT succeeds.
             */

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
                        )
                    ) {

                        /*
                         * We don't know whether the commit
                         * succeeded.
                         *
                         * Retry ONLY COMMIT.
                         */

                        if (
                            commitAttempt <
                            MAX_COMMIT_ATTEMPTS
                        ) {
                            continue;
                        }


                        /*
                         * We have exhausted our commit retries.
                         *
                         * The financial transaction may have
                         * committed or may have rolled back.
                         *
                         * Do NOT retry the payment.
                         */

                        err.code =
                            "TRANSACTION_COMMIT_UNKNOWN";

                        err.transactionId =
                            createdTransaction.transactionId;

                        err.idempotencyKey =
                            idempotencyKey;

                        throw err;
                    }


                    throw err;
                }
            }


            /*
             * COMMIT succeeded.
             *
             * The financial transaction is now definitely durable.
             *
             * Update the PaymentIntent outside the financial
             * transaction.
             */

            try {

                await PaymentIntent.findByIdAndUpdate(
                    paymentIntent._id,
                    {
                        status: "SUCCESS",
                        transactionId: createdTransaction._id
                    }
                );

            } catch (err) {

                /*
                 * The payment itself has already committed.
                 *
                 * Therefore, a failure while updating the
                 * PaymentIntent must NOT cause the payment to
                 * be executed again.
                 *
                 * The PaymentIntent can be repaired later by
                 * reconciliation.
                 */

            }


            return createdTransaction;

        } catch (err) {

            /*
             * Commit outcome is unknown.
             *
             * Do NOT retry the payment and do NOT start
             * another transaction.
             *
             * PaymentIntent remains PROCESSING until its
             * final outcome is resolved.
             */

            if (
                err.code ===
                "TRANSACTION_COMMIT_UNKNOWN"
            ) {
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
             *
             * The financial transaction is aborted and the
             * PaymentIntent is marked FAILED outside the
             * financial transaction.
             */

            if (session.inTransaction()) {
                await session.abortTransaction();
            }


            try {

                await PaymentIntent.findByIdAndUpdate(
                    paymentIntent._id,
                    {
                        status: "FAILED"
                    }
                );

            } catch (paymentIntentError) {

                /*
                 * The payment itself was rolled back.
                 *
                 * Failure to update the PaymentIntent does not
                 * change the financial outcome.
                 */

            }


            throw err;

        } finally {

            await session.endSession();
        }
    }


    /*
     * All transaction attempts were exhausted.
     *
     * Every transient transaction attempt was aborted.
     *
     * Therefore, no financial transaction from these attempts
     * was committed.
     */

    try {

        await PaymentIntent.findByIdAndUpdate(
            paymentIntent._id,
            {
                status: "FAILED"
            }
        );

    } catch (err) {

        /*
         * The financial transaction attempts have already
         * been exhausted and rolled back.
         *
         * PaymentIntent reconciliation can repair this record
         * if this update itself fails.
         */

    }


    throw new Error(
        "Payment could not be completed after multiple attempts"
    );
};


module.exports = { createP2P };