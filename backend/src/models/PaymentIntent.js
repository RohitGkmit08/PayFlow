const mongoose = require("mongoose");

const paymentIntentSchema = new mongoose.Schema(
    {
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
        },

        senderAccountId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Account",
            required: true,
        },

        receiverAccountId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Account",
            required: true,
        },

        amount: {
            type: Number,
            required: true,
            min: 1,
            validate: {
                validator: Number.isInteger,
                message: "Amount must be an integer representing paise",
            },
        },

        currency: {
            type: String,
            required: true,
            default: "INR",
            uppercase: true,
        },

        idempotencyKey: {
            type: String,
            required: true,
        },

        transactionId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Transaction",
            default: null,
        },

        status: {
            type: String,
            enum: [
                "RECEIVED",
                "PROCESSING",
                "SUCCESS",
                "FAILED",
            ],
            default: "RECEIVED",
        },
    },
    { timestamps: true }
);

paymentIntentSchema.index(
    { userId: 1, idempotencyKey: 1 },
    { unique: true }
);

module.exports = mongoose.model(
    "PaymentIntent",
    paymentIntentSchema
);