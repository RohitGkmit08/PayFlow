const User = require("../models/User.js");
const Account = require("../models/Accounts.js");
const Wallet = require("../models/Wallet.js");
const Transaction = require("../models/Transaction.js");
const LedgerEntry = require("../models/LedgerEntry.js");

// IDENTIFY --> VALIDATE --> CREATE --> MOVE --> RECORD --> COMPLETE

const createP2P = async ({ senderUserId, receiverAccountId, amount }) => {

    // find sender 
    const senderUser = await User.findById(senderUserId);
    if (!senderUser) {
        throw new Error("No such user found");
    }

    // find sender account
    const senderAccount = await Account.findOne({
        userId: senderUser._id,
        accountType: "USER_WALLET",
        status: "ACTIVE"
    });
    if (!senderAccount) {
        throw new Error("Sender account not found");
    }

    // find sender wallet
    const senderWallet = await Wallet.findOne({
        userId: senderUser._id,
        accountId: senderAccount._id
    });
    if (!senderWallet) {
        throw new Error("Sender wallet not found");
    }

    // find receiver account
    const receiverAccount = await Account.findOne({
        _id: receiverAccountId,
        accountType: "USER_WALLET",
        status: "ACTIVE"
    });
    if (!receiverAccount) {
        throw new Error("Receiver account not found");
    }

    // find receiver wallet
    const receiverWallet = await Wallet.findOne({
        accountId: receiverAccount._id
    });
    if (!receiverWallet) {
        throw new Error("Receiver wallet not found");
    }

    // prevent self transfer 
    if (senderAccount._id.equals(receiverAccount._id)) {
        throw new Error("Cannot transfer money to your own account");
    }

    // check sender balance
    if (senderWallet.availableBalance < amount) {
        throw new Error("Insufficient balance");
    }

    // Create transaction
    const transaction = await Transaction.create({
        transactionId: `TXN-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
        type: "P2P_TRANSFER",
        senderAccountId: senderAccount._id,
        receiverAccountId: receiverAccount._id,
        amount,
        currency: "INR",
        status: "INITIATED"
    });

    // debit sender wallet 
    senderWallet.availableBalance -= amount;

    await senderWallet.save();

    // credit receiver wallet
    receiverWallet.availableBalance += amount;

    await receiverWallet.save();

    // Create debit ledger entry
    await LedgerEntry.create({
        transactionId: transaction._id,
        accountId: senderAccount._id,
        entryType: "DEBIT",
        amount,
        currency: "INR"
    });

    // create credit ledger entry 
    await LedgerEntry.create({
        transactionId: transaction._id,
        accountId: receiverAccount._id,
        entryType: "CREDIT",
        amount,
        currency: "INR"
    });

    // mark successful transaction 
    transaction.status = "SUCCESS";

    await transaction.save();

    return transaction;
};

module.exports = { createP2P };