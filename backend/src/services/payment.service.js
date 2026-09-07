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

        if (senderAccount._id.equals(receiverAccount._id)) {
            throw new Error("Cannot transfer money to your own account");
        }

        if (senderWallet.availableBalance < amount) {
            throw new Error("Insufficient balance");
        }

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

        senderWallet.availableBalance -= amount;
        await senderWallet.save({ session });

        receiverWallet.availableBalance += amount;
        await receiverWallet.save({ session });

        await LedgerEntry.create([{
            transactionId: createdTransaction._id,
            accountId: senderAccount._id,
            entryType: "DEBIT",
            amount,
            currency: "INR"
        }], { session });

        await LedgerEntry.create([{
            transactionId: createdTransaction._id,
            accountId: receiverAccount._id,
            entryType: "CREDIT",
            amount,
            currency: "INR"
        }], { session });

        createdTransaction.status = "SUCCESS";
        await createdTransaction.save({ session });

        await session.commitTransaction();

        return createdTransaction;

    } catch (err) {

        await session.abortTransaction();

        throw err;

    } finally {

        await session.endSession();
    }
};

module.exports = {createP2P}
