const User = require("../models/User.js");
const Account = require("../models/Accounts.js");
const Wallet = require("../models/Wallet.js");
const Transaction = require("../models/Transaction.js");
const LedgerEntry = require("../models/LedgerEntry.js");

// IDENTIFY --> VALIDATE --> CREATE --> MOVE --> RECORD --> COMPLETE

const addMoney = async({userId, amount}) => {
    
    // find user
    const user = await User.findById(userId);
    if(!user){
        throw new Error("User not found");
    }

    // find user's account
    const userAccount = await Account.findOne({
        userId: user._id,
        accountType: "USER_WALLET",
        status: "ACTIVE"
    });
    if(!userAccount){
        throw new Error("User account not found");
    }

    // find user's wallet
    const userWallet = await Wallet.findOne({
        userId: user._id,
        accountId: userAccount._id
    });
    if(!userWallet){
        throw new Error("User wallet not found");
    }

    // find platform's bank suspense account (this is the external source)
    let bankSuspenseAccount = await Account.findOne({
        accountType: "BANK_SUSPENSE",
        status: "ACTIVE"
    });
    if (!bankSuspenseAccount) {
        bankSuspenseAccount = await Account.create({
            accountType: "BANK_SUSPENSE",
            currency: "INR",
            status: "ACTIVE"
        });
    }
    // till here, we know the answers for following questions-
    // 1. Who is receiving the money?
    // 2. Which Account receives it?
    // 3. Which Wallet receives it?
    // 4. Which system Account represents the source?
    
    // Now we will add money from external source

    // validation before adding money 
    const MAX_ADD_MONEY = 5000000;       // ₹50,000
    const DAILY_ADD_MONEY_LIMIT = 10000000; // ₹1,00,000
    const MAX_WALLET_BALANCE = 20000000;    // ₹2,00,000

    // pre-transaction
    if (amount > MAX_ADD_MONEY) {
        throw new Error("Transaction amount limit exceeded");
    }

    // wallet balance limit
    const newBalance = userWallet.availableBalance + amount;

    if (newBalance > MAX_WALLET_BALANCE) {
        throw new Error("Wallet balance limit exceeded");
    }

    // daily limit 
    const now = new Date();

    const startOfDay = new Date(now);
    startOfDay.setHours(0,0,0,0);

    const endOfDay = new Date(now);
    endOfDay.setHours(23, 59, 59, 999);

    const todayTransaction = await Transaction.find({
        type: "ADD_MONEY",
        receiverAccountId: userAccount._id,
        status: "SUCCESS",
        createdAt: {
            $gte: startOfDay,
            $lt: endOfDay
        }
    });

    let todayTotal = 0;

    for(const transaction of todayTransaction){
        todayTotal += transaction.amount;
    }

    if(todayTotal + amount > DAILY_ADD_MONEY_LIMIT){
        throw new Error("Daily add-money limit exceeded");
    }

    // create 
    const transaction = await Transaction.create({
        transactionId: `TXN-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
        type: "ADD_MONEY",
        senderAccountId: bankSuspenseAccount._id,
        receiverAccountId: userAccount._id,
        amount,
        currency: "INR",
        status: "INITIATED"
    });

    // move
    userWallet.availableBalance += amount;
    await userWallet.save();

    // Debit BANK_SUSPENSE
    await LedgerEntry.create({
        transactionId: transaction._id,
        accountId: bankSuspenseAccount._id,
        entryType: "DEBIT",
        amount,
        currency: "INR"
    });

    // Credit user's account
    await LedgerEntry.create({
        transactionId: transaction._id,
        accountId: userAccount._id,
        entryType: "CREDIT",
        amount,
        currency: "INR"
    });

    // complete
    transaction.status = "SUCCESS";
    await transaction.save();
    return transaction;
};

module.exports = {addMoney};