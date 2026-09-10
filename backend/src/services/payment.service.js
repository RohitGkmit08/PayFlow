const mongoose = require("mongoose");
const User = require("../models/User.js");
const Account = require("../models/Accounts.js");
const Wallet = require("../models/Wallet.js");
const Transaction = require("../models/Transaction.js");
const LedgerEntry = require("../models/LedgerEntry.js");

// IDENTIFY --> VALIDATE --> CREATE --> MOVE --> RECORD --> COMPLETE

const createP2P = async ({ senderUserId, receiverAccountId, amount }) => {

    /*
     * A MongoDB session represents the transaction context.
     *
     * session.startTransaction() starts a transaction using this session.
     *
     * Every database operation that should belong to this transaction
     * must explicitly use this same session.
     *
     * READ:
     *     .session(session)
     *
     * WRITE:
     *     { session }
     */
    const session = await mongoose.startSession();

    try {

        session.startTransaction();

        // identify
        const senderUser = await User.findById(senderUserId).session(session);

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


        // validate

        // Prevent transferring money to the same account.
        if (senderAccount._id.equals(receiverAccount._id)) {
            throw new Error("Cannot transfer money to your own account");
        }

        /*
         * We no longer perform the balance check here.
         *
         * Instead, the balance check will be performed atomically
         * together with the debit operation below.
         *
         * This prevents the following race:
         *
         *     READ balance
         *          ↓
         *     CHECK balance
         *          ↓
         *     another request changes balance
         *          ↓
         *     WRITE balance
         *
         * The condition:
         *
         *     availableBalance >= amount
         *
         * will now be part of the same database operation
         * that performs the deduction.
         */


        // create

        /*
         * Create the Transaction record.
         *
         * Transaction represents the business event:
         * "Sender is transferring this amount to receiver."
         *
         * create() uses an array here because Mongoose's
         * transaction-aware create syntax accepts:
         *
         *     Model.create([document], { session })
         *
         * The { session } tells Mongoose to create this document
         * inside the current transaction.
         */
        const transaction = await Transaction.create([{
            transactionId: `TXN-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
            type: "P2P_TRANSFER",
            senderAccountId: senderAccount._id,
            receiverAccountId: receiverAccount._id,
            amount,
            currency: "INR",
            status: "INITIATED"
        }], { session });

        // create() returns an array when called with an array,
        // so we extract the created Transaction document.
        const createdTransaction = transaction[0];


        // move

        /*
         * Debit the sender using an atomic conditional update.
         *
         * MongoDB will perform these two things as one atomic
         * document update:
         *
         *     1. Check whether balance >= amount
         *     2. Subtract amount from balance
         *
         * $gte means "greater than or equal to".
         *
         * $inc means "increment/decrement the existing value".
         * Using -amount therefore subtracts the amount.
         *
         * { session } makes this operation part of our
         * existing MongoDB transaction.
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

        /*
         * If modifiedCount is 0, the wallet was not updated.
         *
         * In this case, the most likely reason is that the sender
         * does not have enough balance.
         *
         * Throwing an error causes the transaction to enter
         * the catch block, where abortTransaction() rolls back
         * the Transaction record and any other changes.
         */
        if (senderDebit.modifiedCount === 0) {
            throw new Error("Insufficient balance");
        }


        /*
         * Credit the receiver using $inc.
         *
         * Unlike the sender, we don't need a balance condition
         * because receiving money does not require sufficient
         * existing balance.
         *
         * $inc performs:
         *
         *     receiver balance + amount
         *
         * as an atomic database update.
         *
         * The same session is used so this credit belongs
         * to the same transaction as the sender debit.
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

        /*
         * The receiver wallet should have been found earlier.
         *
         * If the update somehow does not modify a document,
         * treat it as a failure and abort the entire transaction.
         */
        if (receiverCredit.modifiedCount === 0) {
            throw new Error("Failed to credit receiver wallet");
        }


        // record

        /*
         * Create DEBIT ledger entry.
         *
         * DEBIT means money left the sender's account.
         */
        await LedgerEntry.create([{
            transactionId: createdTransaction._id,
            accountId: senderAccount._id,
            entryType: "DEBIT",
            amount,
            currency: "INR"
        }], { session });


        /*
         * Create CREDIT ledger entry.
         *
         * CREDIT means money entered the receiver's account.
         */
        await LedgerEntry.create([{
            transactionId: createdTransaction._id,
            accountId: receiverAccount._id,
            entryType: "CREDIT",
            amount,
            currency: "INR"
        }], { session });


        // complete

        /*
         * All financial operations have succeeded:
         *
         *     Sender debited
         *     Receiver credited
         *     Debit ledger created
         *     Credit ledger created
         *
         * Mark the transaction as SUCCESS.
         */
        createdTransaction.status = "SUCCESS";
        await createdTransaction.save({ session });


        /*
         * COMMIT
         *
         * Make all changes performed using this session permanent.
         */
        await session.commitTransaction();

        return createdTransaction;


    } catch (err) {

        /*
         * ABORT
         *
         * If anything fails before commit, rollback all changes
         * that belong to this transaction.
         */
        await session.abortTransaction();

        throw err;


    } finally {

        /*
         * End the MongoDB session after the transaction
         * has either been committed or aborted.
         */
        await session.endSession();
    }
};

module.exports = { createP2P };

