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
     * ─────────────────────────────────────────────
     * IDEMPOTENCY CHECK
     * ─────────────────────────────────────────────
     *
     * First check whether this user has already used
     * this idempotency key.
     *
     * Same key = same logical payment.
     *
     * This check happens before starting the payment
     * transaction because an existing payment does not
     * need a new transaction.
     */

    const existingKey = await IdempotencyKey.findOne({
        userId: senderUserId,
        key: idempotencyKey
    });

    if (existingKey) {

        /*
         * The idempotency record points to the transaction
         * created for this payment attempt.
         */

        const existingTransaction = await Transaction.findById(
            existingKey.transactionId
        );

        if (!existingTransaction) {
            throw new Error(
                "Idempotency record points to a missing transaction"
            );
        }

        /*
         * Another request is already processing this payment.
         *
         * Do not create another transaction.
         */

        if (
            existingTransaction.status === "INITIATED" ||
            existingTransaction.status === "PROCESSING"
        ) {
            throw new Error("Payment is already in progress");
        }

        /*
         * The payment has already reached a final state.
         *
         * Return the result of the original payment attempt.
         */

        if (
            existingTransaction.status === "SUCCESS" ||
            existingTransaction.status === "FAILED"
        ) {
            return existingTransaction;
        }

        throw new Error("Unknown transaction status");
    }


    /*
     *
     * START TRANSACTION
     */

    const session = await mongoose.startSession();

    try {

        session.startTransaction();


       
        // IDENTIFY
        
        /*
         * Identify the sender and receiver accounts/wallets.
         *
         * senderUserId comes from authentication middleware.
         * The client does not choose the sender.
         */

        const senderUser = await User.findById(senderUserId)
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
        
        /*
         * Prevent transferring money to the same account.
         */

        if (senderAccount._id.equals(receiverAccount._id)) {
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

        const transaction = await Transaction.create([{
            transactionId:
                `TXN-${Date.now()}-${Math.floor(Math.random() * 100000)}`,

            type: "P2P_TRANSFER",

            senderAccountId: senderAccount._id,
            receiverAccountId: receiverAccount._id,

            amount,
            currency: "INR",

            status: "INITIATED"

        }], { session });


        /*
         * create() returns an array when called with an array,
         * so we extract the created Transaction document.
         */

        const createdTransaction = transaction[0];

        // CREATE IDEMPOTENCY RECORD
        
        /*
         * Connect the idempotency key to the transaction.
         *
         *     IdempotencyKey → Transaction
         *
         * The unique index on (userId, key) prevents two
         * concurrent requests from creating the same key.
         */

        try {

            await IdempotencyKey.create([{
                userId: senderUserId,
                key: idempotencyKey,

                transactionId: createdTransaction._id,

                expiresAt: new Date(
                    Date.now() + 24 * 60 * 60 * 1000
                )

            }], { session });

        } catch (err) {

            /*
             * Another concurrent request created the same
             * idempotency key first.
             */

            if (err.code === 11000) {

                /*
                 * This transaction belongs to the losing request.
                 * It must not continue.
                 */

                await session.abortTransaction();


                /*
                 * Look up the idempotency record created by
                 * the winning request.
                 *
                 * No new transaction is required here because
                 * we are only reading the existing result.
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
                 * Find the transaction associated with the
                 * winning request.
                 */

                const existingTransaction = await Transaction.findById(
                    existingKey.transactionId
                );


                if (!existingTransaction) {
                    throw new Error(
                        "Idempotency record points to a missing transaction"
                    );
                }


                /*
                 * The original request may still be processing.
                 */

                if (
                    existingTransaction.status === "INITIATED" ||
                    existingTransaction.status === "PROCESSING"
                ) {
                    throw new Error("Payment is already in progress");
                }


                /*
                 * The original request has already finished.
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


                throw new Error("Unknown transaction status");
            }

            throw err;
        }
       
        // MOVE
        
        /*
         * Debit the sender using an atomic conditional update.
         *
         * MongoDB performs:
         *
         *     1. Check balance >= amount
         *     2. Subtract amount
         *
         * as one atomic update.
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
         * Credit the receiver using $inc.
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
            throw new Error("Failed to credit receiver wallet");
        }

        // RECORD
        
        /*
         * DEBIT → money left the sender's account.
         */

        await LedgerEntry.create([{
            transactionId: createdTransaction._id,
            accountId: senderAccount._id,

            entryType: "DEBIT",

            amount,
            currency: "INR"

        }], { session });


        /*
         * CREDIT → money entered the receiver's account.
         */

        await LedgerEntry.create([{
            transactionId: createdTransaction._id,
            accountId: receiverAccount._id,

            entryType: "CREDIT",

            amount,
            currency: "INR"

        }], { session });

        // COMPLETE

        /*
         * All financial operations have succeeded:
         *
         *     Sender debited
         *     Receiver credited
         *     Debit ledger created
         *     Credit ledger created
         *
         * Now mark the transaction as SUCCESS.
         */

        createdTransaction.status = "SUCCESS";

        await createdTransaction.save({ session });

        // COMMIT
       
        /*
         * Make all changes performed using this session
         * permanent.
         */

        await session.commitTransaction();


        return createdTransaction;


    } catch (err) {

        /*
         * If anything fails before commit, rollback all
         * changes belonging to this transaction.
         */

        if (session.inTransaction()) {
            await session.abortTransaction();
        }

        throw err;


    } finally {

        /*
         * End the MongoDB session after commit or rollback.
         */

        await session.endSession();
    }
};


module.exports = { createP2P };
